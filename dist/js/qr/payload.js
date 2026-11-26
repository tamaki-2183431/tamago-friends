/**
 * QR ペイロードの生成・署名・検証（純粋なデータ層）。
 *
 * 形式: TG1.<base64url(JSON)>.<base64url(署名)>
 *   - 親 → 子（点数・訂正・ごほうび・承認）: ECDSA P-256 署名。子端末は親の公開鍵だけを持つ。
 *     → 子端末が鍵を持っていても点数QRを偽造できない。
 *   - 子 → 親（ごほうび申請）: 家族キーによる HMAC-SHA-256（ペアリングで共有）。
 *   - 初回ペアリングだけは信頼の起点なので署名なし（親画面は PIN 解錠後のみ表示）。
 */

export const MAGIC = 'TG1';

export const KINDS = Object.freeze({
  PAIR: 'pair',
  SCORES: 'scores',
  CORRECTION: 'correction',
  REWARDS: 'rewards',
  REWARD_REQUEST: 'reward_request',
  REWARD_DECISION: 'reward_decision',
  RESET: 'reset',
});

/** 親が発行する種類（ECDSA 署名） */
export const PARENT_SIGNED_KINDS = Object.freeze([
  KINDS.SCORES,
  KINDS.CORRECTION,
  KINDS.REWARDS,
  KINDS.REWARD_DECISION,
  KINDS.RESET,
]);

/* ------------------------------------------------------------ base64url */

export function bytesToB64url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function b64urlEncode(text) {
  return bytesToB64url(new TextEncoder().encode(text));
}

export function b64urlDecode(text) {
  return new TextDecoder().decode(b64urlToBytes(text));
}

export function randomToken(bytes = 16) {
  const buffer = new Uint8Array(bytes);
  webCrypto().getRandomValues(buffer);
  return bytesToB64url(buffer);
}

/* ------------------------------------------------------------ canonical JSON */

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

/** キー順を固定した JSON（署名対象の再現性のため） */
export function canonicalJSON(value) {
  return JSON.stringify(sortValue(value));
}

/* ------------------------------------------------------------ crypto */

function webCrypto() {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error('この環境では暗号処理を利用できません（https または localhost で開いてください）');
  }
  return crypto;
}

/** 家族作成時に一度だけ作る親の鍵ペア（P-256 / ECDSA） */
export async function generateParentKeys() {
  const subtle = webCrypto().subtle;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
  const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKeyJwk: { kty: privateKeyJwk.kty, crv: privateKeyJwk.crv, d: privateKeyJwk.d, x: privateKeyJwk.x, y: privateKeyJwk.y },
    publicKeyJwk: { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y },
  };
}

async function importEcdsaPrivate(jwk) {
  return webCrypto().subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function importEcdsaPublic(jwk) {
  return webCrypto().subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

async function importHmacKey(secretB64url, usages) {
  return webCrypto().subtle.importKey('raw', b64urlToBytes(secretB64url), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/* ------------------------------------------------------------ envelope */

/** エンベロープ本文（署名対象になる文字列）を作る */
export function encodeBody(payload) {
  return b64urlEncode(canonicalJSON(payload));
}

export function joinEnvelope(body, signature = '') {
  return `${MAGIC}.${body}.${signature}`;
}

/** QR 文字列を分解する（署名検証はしない） */
export function parseEnvelope(text) {
  const raw = String(text ?? '').trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, reason: 'empty', message: 'QRコードが空です' };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== MAGIC) {
    return { ok: false, reason: 'format', message: 'たまごフレンズのQRコードではありません' };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return { ok: false, reason: 'decode', message: 'QRコードを読み取れませんでした' };
  }
  if (!payload || typeof payload !== 'object' || payload.v !== 1) {
    return { ok: false, reason: 'version', message: '対応していないQRコードです（アプリを更新してください）' };
  }
  return { ok: true, payload, body: parts[1], signature: parts[2] || '', raw };
}

/** 親の秘密鍵で署名した QR 文字列を作る */
export async function signParentEnvelope(privateKeyJwk, payload) {
  const body = encodeBody(payload);
  const key = await importEcdsaPrivate(privateKeyJwk);
  const signature = await webCrypto().subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body));
  return joinEnvelope(body, bytesToB64url(signature));
}

/** 子の家族キーで署名した QR 文字列を作る（ごほうび申請） */
export async function signHmacEnvelope(secretB64url, payload) {
  const body = encodeBody(payload);
  const key = await importHmacKey(secretB64url, ['sign']);
  const signature = await webCrypto().subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return joinEnvelope(body, bytesToB64url(signature));
}

const PARENT_KIND_SET = new Set(PARENT_SIGNED_KINDS);

export function expectedSigner(kind) {
  if (kind === KINDS.PAIR) return 'none';
  if (kind === KINDS.REWARD_REQUEST) return 'child';
  return PARENT_KIND_SET.has(kind) ? 'parent' : 'unknown';
}

/**
 * QR 文字列を検証して payload を返す。
 * keys: { publicKeyJwk, secretB64url }（子端末は両方、親端末は secretB64url のみで足りる）
 */
export async function verifyEnvelope(text, keys = {}) {
  const parsed = parseEnvelope(text);
  if (!parsed.ok) return parsed;
  const { payload, body, signature } = parsed;
  const signer = expectedSigner(payload.kind);

  if (signer === 'unknown') {
    return { ok: false, reason: 'kind', message: '対応していないQRコードです' };
  }
  if (signer === 'none') {
    return { ...parsed, signer };
  }
  if (!signature) {
    return { ok: false, reason: 'unsigned', message: 'このQRコードは署名されていません' };
  }

  const data = new TextEncoder().encode(body);
  try {
    if (signer === 'parent') {
      if (!keys.publicKeyJwk) return { ok: false, reason: 'nokey', message: 'この端末は家族とペアリングされていません' };
      const key = await importEcdsaPublic(keys.publicKeyJwk);
      const valid = await webCrypto().subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(signature), data);
      if (!valid) return { ok: false, reason: 'signature', message: 'QRコードが改ざんされています（署名が一致しません）' };
    } else {
      if (!keys.secretB64url) return { ok: false, reason: 'nokey', message: '家族のペアリング情報がありません' };
      const key = await importHmacKey(keys.secretB64url, ['verify']);
      const valid = await webCrypto().subtle.verify('HMAC', key, b64urlToBytes(signature), data);
      if (!valid) return { ok: false, reason: 'signature', message: 'QRコードが改ざんされています（署名が一致しません）' };
    }
  } catch {
    return { ok: false, reason: 'verify', message: 'QRコードを検証できませんでした' };
  }

  return { ...parsed, signer };
}

/* ------------------------------------------------------------ split */

export function envelopeSize(payload) {
  return encodeBody(payload).length;
}

/**
 * 複数件の点数を QR に分割する（1 枚に詰めすぎると読み取りづらいため）。
 * 各 QR は独立して署名され、イベントIDで重複処理を防ぐ。
 */
export function buildSplits(basePayload, items, { maxBytes = 800, maxItems = 3 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const groups = [];
  let current = [];

  for (const item of items) {
    const candidate = [...current, item];
    const probe = { ...basePayload, idx: 9, tot: 9, items: candidate };
    const tooBig = envelopeSize(probe) > maxBytes || candidate.length > maxItems;
    if (tooBig && current.length > 0) {
      groups.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);

  return groups.map((group, index) => ({ ...basePayload, idx: index + 1, tot: groups.length, items: group }));
}

/** 分割された QR を並べ替えるための検証（欠番チェック） */
export function missingSplitIndexes(payload, received = []) {
  const total = Number(payload?.tot ?? 1);
  const have = new Set(received);
  const missing = [];
  for (let index = 1; index <= total; index += 1) if (!have.has(index)) missing.push(index);
  return missing;
}
