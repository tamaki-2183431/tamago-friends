/**
 * 親端末のデータ操作（家族・子ども・点数・監査・ごほうび・バックアップ）。
 * 画面（js/ui/parent-*.js）はこのモジュールだけを呼ぶ。
 */
import * as db from '../db.js';
import { STORES, PARENT_STORES } from '../db.js';
import { applyDelta, applyTotal, sumPoints, validatePointsInput, summarize } from '../game/points.js';
import {
  BACKUP_FAILED_MESSAGE,
  FACTORY_RESET_STORES,
  PIN_EMPTY_MESSAGE,
  PIN_FORMAT_MESSAGE,
  PIN_MISMATCH_MESSAGE,
  factoryResetSnapshotLabel,
} from '../game/factory-reset.js';
import {
  KINDS,
  buildSplits,
  generateParentKeys,
  randomToken,
  signParentEnvelope,
  verifyEnvelope,
} from '../qr/payload.js';

const META_KEY = 'family';
/** バックアップ／復元の対象ストア（自動退避データ自体は含めない・消さない） */
const DATA_STORES = PARENT_STORES.filter((store) => store !== STORES.P_SNAPSHOTS);
const PIN_ITERATIONS = 120000;
const BACKUP_APP = 'tamago-friends';
const BACKUP_SCHEMA = 1;

/* ------------------------------------------------------------ 小道具 */

function uid(prefix = 'id') {
  return `${prefix}_${randomToken(9)}`;
}

function now() {
  return new Date().toISOString();
}

function hex(bytes = 5) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ PIN */

async function derivePinHash(pin, saltBase64, iterations = PIN_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0)), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits), (value) => value.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const buffer = new Uint8Array(16);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer));
}

export function isValidPinFormat(pin) {
  return /^\d{4}$/.test(String(pin ?? ''));
}

/* ------------------------------------------------------------ 家族 */

export async function getFamily() {
  return (await db.get(STORES.P_META, META_KEY)) ?? null;
}

export async function familyExists() {
  return Boolean(await getFamily());
}

/** 家族を作る（初回のみ）。PIN と署名鍵をここで作る。 */
export async function createFamily({ familyName, pin }) {
  if (!familyName || !String(familyName).trim()) throw new Error('家族の名前を入力してください');
  if (!isValidPinFormat(pin)) throw new Error('PIN は4桁の数字で入力してください');
  if (await familyExists()) throw new Error('すでに家族が登録されています');

  const keys = await generateParentKeys();
  const salt = randomSalt();
  const family = {
    k: META_KEY,
    v: 1,
    familyId: hex(5),
    familyName: String(familyName).trim(),
    createdAt: now(),
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    secretB64url: randomToken(32),
    pin: { alg: 'PBKDF2-SHA256', salt, iterations: PIN_ITERATIONS, hash: await derivePinHash(pin, salt) },
  };
  await db.put(STORES.P_META, family);
  await addAudit({ type: 'family_create', childId: null, note: family.familyName });
  return family;
}

/** PIN 照合（セッション解錠は UI 側で保持） */
export async function verifyPin(pin) {
  const family = await getFamily();
  if (!family?.pin) return false;
  if (!isValidPinFormat(pin)) return false;
  const hash = await derivePinHash(pin, family.pin.salt, family.pin.iterations);
  return hash === family.pin.hash;
}

export async function changePin({ currentPin, newPin }) {
  if (!(await verifyPin(currentPin))) throw new Error('現在のPINが違います');
  if (!isValidPinFormat(newPin)) throw new Error('新しいPINは4桁の数字で入力してください');
  const family = await getFamily();
  const salt = randomSalt();
  family.pin = { alg: 'PBKDF2-SHA256', salt, iterations: PIN_ITERATIONS, hash: await derivePinHash(newPin, salt) };
  family.pinChangedAt = now();
  await db.put(STORES.P_META, family);
  await addAudit({ type: 'pin_change', childId: null });
}

export async function renameFamily(name) {
  const family = await getFamily();
  if (!family) throw new Error('家族が登録されていません');
  const before = family.familyName;
  family.familyName = String(name).trim() || before;
  await db.put(STORES.P_META, family);
  await addAudit({ type: 'family_rename', childId: null, before: { familyName: before }, after: { familyName: family.familyName } });
}

/* ------------------------------------------------------------ 子ども */

export async function listChildren() {
  const children = await db.getAll(STORES.P_CHILDREN);
  return children
    .filter((child) => !child.deleted)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function getChild(childId) {
  return db.get(STORES.P_CHILDREN, childId);
}

export async function addChild({ name, emoji = '🐣', color = 'mint' }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('子どもの名前を入力してください');
  if (trimmed.length > 20) throw new Error('名前は20文字までにしてください');
  const children = await listChildren();
  if (children.length >= 8) throw new Error('子どもは8人まで登録できます');

  const child = {
    id: uid('c'),
    name: trimmed,
    emoji,
    color,
    createdAt: now(),
    updatedAt: now(),
    total: 0,
    highWaterMark: 0,
    hatchTokens: 0,
    deleted: false,
  };
  await db.put(STORES.P_CHILDREN, child);
  await addAudit({ type: 'child_add', childId: child.id, after: { name: child.name } });
  return child;
}

export async function updateChild(childId, { name, emoji, color }) {
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');
  const before = { name: child.name, emoji: child.emoji, color: child.color };
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new Error('名前を入力してください');
    child.name = trimmed;
  }
  if (emoji !== undefined) child.emoji = emoji;
  if (color !== undefined) child.color = color;
  child.updatedAt = now();
  await db.put(STORES.P_CHILDREN, child);
  await addAudit({ type: 'child_edit', childId, before, after: { name: child.name, emoji: child.emoji, color: child.color } });
  return child;
}

/**
 * 子どもの削除（親PIN解錠後のみ到達）。点数・ごほうび・申請・未送信訂正も消す。
 * 子端末側のデータは端末内にあるため、この操作では消えない（仕様どおり子端末からは実行不可）。
 */
export async function deleteChild(childId) {
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');
  const childStores = [STORES.P_SCORES, STORES.P_REWARDS, STORES.P_REQUESTS, STORES.P_OUTBOX];
  for (const store of childStores) {
    const rows = await db.getAllByIndex(store, 'childId', childId);
    for (const row of rows) await db.del(store, row.id);
  }
  await db.del(STORES.P_CHILDREN, childId);
  await addAudit({ type: 'child_delete', childId, before: { name: child.name, total: child.total } });
}

/* ------------------------------------------------------------ 点数 */

function scoreSnapshot(score) {
  if (!score) return null;
  return { testName: score.testName, date: score.date, points: score.points };
}

export async function listScores(childId, { includeDeleted = false } = {}) {
  const scores = await db.getAllByIndex(STORES.P_SCORES, 'childId', childId);
  return scores
    .filter((score) => includeDeleted || !score.deleted)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 未送信（QR 未表示）の点数だけ。訂正前の編集に使う。 */
export async function pendingScores(childId) {
  const scores = await listScores(childId);
  return scores.filter((score) => !score.sentAt);
}

/**
 * 点数を1件追加する。累計・最高到達点・孵化権を更新し、監査履歴を残す。
 * 戻り値: { score, child, granted }
 */
export async function addScore({ childId, testName, date, points }) {
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');
  const validation = validatePointsInput(points);
  if (!validation.ok) throw new Error(validation.message);
  const trimmedName = String(testName ?? '').trim();
  if (!trimmedName) throw new Error('テスト名を入力してください');
  const dateValue = String(date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw new Error('日付を選んでください');

  const score = {
    id: uid('s'),
    childId,
    testName: trimmedName,
    date: dateValue,
    points: validation.value,
    rev: 1,
    createdAt: now(),
    sentAt: null,
    deleted: false,
  };
  const result = applyDelta(child, validation.value);
  await db.put(STORES.P_SCORES, score);
  await db.put(STORES.P_CHILDREN, { ...child, ...result.state, updatedAt: now() });
  await addAudit({
    type: 'score_add',
    childId,
    scoreId: score.id,
    before: null,
    after: scoreSnapshot(score),
    delta: validation.value,
    totalBefore: result.before.total,
    totalAfter: result.state.total,
  });
  return { score, child: { ...child, ...result.state }, granted: result.granted };
}

/** 点数の訂正。累計を再計算し、既に子端末へ送っていたら訂正QR用イベントを作る。 */
export async function editScore(scoreId, { testName, date, points }) {
  const original = await db.get(STORES.P_SCORES, scoreId);
  if (!original || original.deleted) throw new Error('点数記録が見つかりません');
  const child = await getChild(original.childId);
  if (!child) throw new Error('子どもが見つかりません');

  const next = { ...original };
  if (testName !== undefined) {
    const trimmed = String(testName).trim();
    if (!trimmed) throw new Error('テスト名を入力してください');
    next.testName = trimmed;
  }
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('日付を選んでください');
    next.date = String(date);
  }
  if (points !== undefined) {
    const validation = validatePointsInput(points);
    if (!validation.ok) throw new Error(validation.message);
    next.points = validation.value;
  }
  next.updatedAt = now();
  next.rev = (Number(original.rev) || 1) + 1;

  const before = scoreSnapshot(original);
  await db.put(STORES.P_SCORES, next);

  const deltaPoints = next.points - original.points;
  const childUpdate = await recomputeChildTotal(original.childId);
  await addAudit({
    type: 'score_edit',
    childId: original.childId,
    scoreId,
    before,
    after: scoreSnapshot(next),
    delta: deltaPoints,
    totalBefore: childUpdate.before.total,
    totalAfter: childUpdate.state.total,
  });

  if (original.sentAt && deltaPoints !== 0) {
    await enqueueCorrection({
      childId: original.childId,
      scoreId: original.id,
      rev: next.rev,
      points: next.points,
      reason: 'edit',
      testName: next.testName,
      date: next.date,
      targetTotal: childUpdate.state.total,
    });
  }
  return { score: next, child: { ...child, ...childUpdate.state }, granted: childUpdate.granted };
}

/** 点数の削除（論理削除）。累計を再計算し、訂正イベントを作る。 */
export async function deleteScore(scoreId) {
  const original = await db.get(STORES.P_SCORES, scoreId);
  if (!original || original.deleted) throw new Error('点数記録が見つかりません');
  const next = { ...original, deleted: true, deletedAt: now(), rev: (Number(original.rev) || 1) + 1 };
  await db.put(STORES.P_SCORES, next);

  const childUpdate = await recomputeChildTotal(original.childId);
  await addAudit({
    type: 'score_delete',
    childId: original.childId,
    scoreId,
    before: scoreSnapshot(original),
    after: null,
    delta: -original.points,
    totalBefore: childUpdate.before.total,
    totalAfter: childUpdate.state.total,
  });

  if (original.sentAt) {
    await enqueueCorrection({
      childId: original.childId,
      scoreId: original.id,
      rev: next.rev,
      points: 0,
      reason: 'delete',
      testName: original.testName,
      date: original.date,
      targetTotal: childUpdate.state.total,
    });
  }
  return { child: childUpdate.state };
}

/** 記録から累計を再計算し、最高到達点ルールで孵化権を更新する */
export async function recomputeChildTotal(childId) {
  const child = await getChild(childId);
  const scores = await listScores(childId);
  const total = sumPoints(scores);
  const result = applyTotal(child, total);
  await db.put(STORES.P_CHILDREN, { ...child, ...result.state, updatedAt: now() });
  return result;
}

/* ------------------------------------------------------------ 訂正イベント（子端末へ送る） */

async function enqueueCorrection({ childId, scoreId, rev, points, reason, testName, date, targetTotal }) {
  const event = {
    id: uid('x'),
    childId,
    scoreId,
    rev,
    points,
    reason,
    testName,
    date,
    targetTotal,
    createdAt: now(),
    deliveredAt: null,
  };
  await db.put(STORES.P_OUTBOX, event);
  return event;
}

/** 訂正イベントの全履歴（送信済みも含む・新しい順） */
export async function listCorrections(childId) {
  const rows = await db.getAllByIndex(STORES.P_OUTBOX, 'childId', childId);
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listPendingCorrections(childId) {
  const rows = await db.getAllByIndex(STORES.P_OUTBOX, 'childId', childId);
  return rows.filter((row) => !row.deliveredAt);
}

/* ------------------------------------------------------------ 監査履歴 */

export async function addAudit(entry) {
  const record = {
    id: uid('a'),
    at: now(),
    type: entry.type,
    childId: entry.childId ?? null,
    scoreId: entry.scoreId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    delta: entry.delta ?? null,
    totalBefore: entry.totalBefore ?? null,
    totalAfter: entry.totalAfter ?? null,
    note: entry.note ?? null,
  };
  await db.put(STORES.P_AUDIT, record);
  return record;
}

export async function listAudit({ childId = null, limit = 100 } = {}) {
  const rows = childId
    ? await db.getAllByIndex(STORES.P_AUDIT, 'childId', childId)
    : await db.getAll(STORES.P_AUDIT);
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/* ------------------------------------------------------------ QR 生成 */

async function requireFamily() {
  const family = await getFamily();
  if (!family) throw new Error('家族が登録されていません');
  return family;
}

function basePayload(family, kind, childId, extra = {}) {
  return { v: 1, kind, fid: family.familyId, cid: childId, iss: 'parent', iat: Date.now(), ...extra };
}

/** 初回ペアリング用「かぞくQR」（PIN 解錠後のみ表示） */
export async function buildPairingQr(childId) {
  const family = await requireFamily();
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');
  const payload = basePayload(family, KINDS.PAIR, childId, {
    familyName: family.familyName,
    childName: child.name,
    publicKeyJwk: family.publicKeyJwk,
    secretB64url: family.secretB64url,
  });
  const { joinEnvelope, encodeBody } = await import('../qr/payload.js');
  return { qrs: [joinEnvelope(encodeBody(payload), '')], payload, count: 1 };
}

/**
 * 点数を QR 化する（件数に応じて分割）。表示した時点で「送信済み」に印を付ける。
 * - 既定: 未送信の点数だけ
 * - all: 送信済みも含めた全履歴（子端末の入れ替え・読み取り失敗時の再送用）
 * - scoreIds: 指定した点数だけ（履歴からの再表示用）
 * 子端末はイベントIDで重複排除するため、再送しても二重加算されない。
 */
export async function buildScoreQr(childId, { all = false, scoreIds = null, ...splitOptions } = {}) {
  const family = await requireFamily();
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');

  let scores;
  if (Array.isArray(scoreIds) && scoreIds.length) {
    const rows = await Promise.all(scoreIds.map((scoreId) => db.get(STORES.P_SCORES, scoreId)));
    scores = rows.filter((score) => score && !score.deleted && score.childId === childId);
  } else if (all) {
    scores = await listScores(childId);
  } else {
    scores = await pendingScores(childId);
  }
  if (!scores.length) return { qrs: [], count: 0 };

  const events = scores.map((score) => ({
    lineId: score.id,
    rev: Number(score.rev) || 1,
    points: score.points,
    testName: score.testName,
    date: score.date,
    at: score.createdAt,
  }));
  const base = basePayload(family, KINDS.SCORES, childId, {
    grp: randomToken(6),
    familyName: family.familyName,
    childName: child.name,
    st: { tokens: child.hatchTokens ?? 0, high: child.highWaterMark ?? 0 },
  });
  const splits = buildSplits(base, events, splitOptions);
  const qrs = [];
  for (const split of splits) qrs.push(await signParentEnvelope(family.privateKeyJwk, split));

  const stamp = now();
  for (const score of scores) {
    if (!score.sentAt) await db.put(STORES.P_SCORES, { ...score, sentAt: stamp });
  }

  return { qrs, count: events.length, total: child.total, payloads: splits, grp: base.grp };
}

/**
 * 訂正QR（マイナス差分イベント）を作る。
 * 既定は未送信の訂正のみ。all / eventIds を指定すると送信済みも再表示できる。
 */
export async function buildCorrectionQr(childId, { all = false, eventIds = null, ...splitOptions } = {}) {
  const family = await requireFamily();
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');

  let rows;
  if (Array.isArray(eventIds) && eventIds.length) {
    const allRows = await listCorrections(childId);
    const wanted = new Set(eventIds);
    rows = allRows.filter((row) => wanted.has(row.id));
  } else if (all) {
    rows = await listCorrections(childId);
  } else {
    rows = await listPendingCorrections(childId);
  }
  if (!rows.length) return { qrs: [], count: 0 };

  const events = rows.map((row) => ({
    lineId: row.scoreId,
    rev: Number(row.rev) || 1,
    points: row.points,
    deleted: row.reason === 'delete',
    reason: row.reason,
    testName: row.testName,
    date: row.date,
    at: row.createdAt,
  }));
  const base = basePayload(family, KINDS.CORRECTION, childId, {
    grp: randomToken(6),
    childName: child.name,
    st: { tokens: child.hatchTokens ?? 0, high: child.highWaterMark ?? 0 },
  });
  const splits = buildSplits(base, events, splitOptions);
  const qrs = [];
  for (const split of splits) qrs.push(await signParentEnvelope(family.privateKeyJwk, split));

  const stamp = now();
  for (const row of rows) {
    if (!row.deliveredAt) await db.put(STORES.P_OUTBOX, { ...row, deliveredAt: stamp });
  }
  return { qrs, count: events.length, payloads: splits };
}

/** ごほうび一覧を子端末へ渡す QR */
export async function buildRewardsQr(childId) {
  const family = await requireFamily();
  const rewards = await listRewards(childId);
  const items = rewards
    .filter((reward) => !reward.archived)
    .map((reward) => ({ rewardId: reward.id, title: reward.title, note: reward.note ?? '' }));
  if (!items.length) return { qrs: [], count: 0 };
  const base = basePayload(family, KINDS.REWARDS, childId, { grp: randomToken(6) });
  const splits = buildSplits(base, items, { maxBytes: 800, maxItems: 4 });
  const qrs = [];
  for (const split of splits) qrs.push(await signParentEnvelope(family.privateKeyJwk, split));
  return { qrs, count: items.length, payloads: splits };
}

/* ------------------------------------------------------------ ごほうび */

export async function listRewards(childId) {
  const rows = await db.getAllByIndex(STORES.P_REWARDS, 'childId', childId);
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function addReward({ childId, title, note = '' }) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) throw new Error('ごほうびの内容を入力してください');
  const reward = { id: uid('r'), childId, title: trimmed, note: String(note).trim(), createdAt: now(), archived: false };
  await db.put(STORES.P_REWARDS, reward);
  await addAudit({ type: 'reward_add', childId, after: { title: reward.title } });
  return reward;
}

export async function updateReward(rewardId, { title, note, archived }) {
  const reward = await db.get(STORES.P_REWARDS, rewardId);
  if (!reward) throw new Error('ごほうびが見つかりません');
  const before = { title: reward.title, note: reward.note };
  const next = {
    ...reward,
    title: title !== undefined ? String(title).trim() : reward.title,
    note: note !== undefined ? String(note).trim() : reward.note,
    archived: archived !== undefined ? Boolean(archived) : reward.archived,
  };
  await db.put(STORES.P_REWARDS, next);
  await addAudit({ type: 'reward_edit', childId: reward.childId, before, after: { title: next.title, note: next.note } });
  return next;
}

export async function deleteReward(rewardId) {
  const reward = await db.get(STORES.P_REWARDS, rewardId);
  if (!reward) return;
  await db.del(STORES.P_REWARDS, rewardId);
  await addAudit({ type: 'reward_delete', childId: reward.childId, before: { title: reward.title } });
}

export async function listRequests({ childId = null, limit = 100 } = {}) {
  const rows = childId
    ? await db.getAllByIndex(STORES.P_REQUESTS, 'childId', childId)
    : await db.getAll(STORES.P_REQUESTS);
  return rows.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))).slice(0, limit);
}

/** 子端末のごほうび申請 QR を読み取り、承認待ちとして登録する */
export async function ingestRewardRequest(text) {
  const family = await requireFamily();
  const result = await verifyEnvelope(text, { secretB64url: family.secretB64url });
  if (!result.ok) throw new Error(result.message);
  const payload = result.payload;
  if (payload.kind !== KINDS.REWARD_REQUEST) throw new Error('ごほうび申請のQRコードではありません');
  if (payload.fid !== family.familyId) throw new Error('別の家族のQRコードです');
  const child = await getChild(payload.cid);
  if (!child) throw new Error('登録されていない子どものQRコードです');

  const existing = await db.get(STORES.P_REQUESTS, payload.requestId);
  if (existing) return { request: existing, duplicate: true };

  const request = {
    id: payload.requestId,
    childId: payload.cid,
    rewardId: payload.rewardId ?? null,
    title: String(payload.title ?? 'ごほうび').slice(0, 60),
    note: String(payload.note ?? '').slice(0, 200),
    requestedAt: payload.iat ? new Date(payload.iat).toISOString() : now(),
    status: 'pending',
    decidedAt: null,
  };
  await db.put(STORES.P_REQUESTS, request);
  await addAudit({ type: 'reward_request', childId: payload.cid, after: { title: request.title } });
  return { request, duplicate: false };
}

/** 承認・却下して、子端末へ渡す判定QRを作る */
export async function decideRequest(requestId, decision, note = '') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('判定が不正です');
  const family = await requireFamily();
  const request = await db.get(STORES.P_REQUESTS, requestId);
  if (!request) throw new Error('申請が見つかりません');
  const next = { ...request, status: decision, decidedAt: now(), decisionNote: String(note).trim() };
  await db.put(STORES.P_REQUESTS, next);
  await addAudit({ type: `reward_${decision}`, childId: request.childId, before: { status: request.status }, after: { status: decision, title: request.title } });

  const payload = basePayload(family, KINDS.REWARD_DECISION, request.childId, {
    items: [
      {
        requestId: request.id,
        rewardId: request.rewardId,
        title: request.title,
        decision,
        at: next.decidedAt,
        note: next.decisionNote,
      },
    ],
    idx: 1,
    tot: 1,
  });
  const qr = await signParentEnvelope(family.privateKeyJwk, payload);
  return { request: next, qrs: [qr], count: 1 };
}

/* ------------------------------------------------------------ 端末の初期化（Phase 2 後半） */

export const RESET_MODES = Object.freeze({
  keepPets: 'keep-pets',
  factory: 'factory',
});

export const RESET_MODE_LABELS = Object.freeze({
  'keep-pets': 'ペットを残す（点数・累計・進捗・孵化権・ごほうび・ペアリングを消す）',
  factory: '完全初期化（ペット・コイン・音の設定も消す）',
});

/**
 * 子どもの端末を初期化するための QR を作る（親の PIN 解錠後のみ）。
 * 子端末はこの署名を検証してから実行する。
 */
export async function buildResetQr(childId, mode = RESET_MODES.keepPets) {
  const family = await requireFamily();
  const child = await getChild(childId);
  if (!child) throw new Error('子どもが見つかりません');
  if (!Object.values(RESET_MODES).includes(mode)) throw new Error('初期化モードが不正です');

  const payload = basePayload(family, KINDS.RESET, childId, {
    mode,
    childName: child.name,
    familyName: family.familyName,
  });
  const qr = await signParentEnvelope(family.privateKeyJwk, payload);
  await addAudit({ type: 'device_reset_issued', childId, note: RESET_MODE_LABELS[mode], after: { mode } });
  return { qrs: [qr], count: 1, mode };
}

/* ------------------------------------------------------------ ごほうびメモ（Phase 2 後半） */

/**
 * 1,000点達成ごとの「ごほうびメモ」。
 * 行は達成点から自動で作り、内容は親があとから書ける（書かなくてもよい）。
 * 既存のごほうび／申請データ（p_rewards / p_requests）は消さずに残す。
 */
export async function listMemos(childId) {
  const rows = await db.getAllByIndex(STORES.P_MEMOS, 'childId', childId);
  return rows.sort((a, b) => Number(b.points) - Number(a.points));
}

/** 達成点の一覧（最高到達点から作る）と、その達成日をスコア履歴から推定する */
export async function ensureMemos(childId) {
  const child = await getChild(childId);
  if (!child) return [];
  const milestones = Math.floor((Number(child.highWaterMark) || 0) / 1000);
  if (milestones <= 0) return listMemos(childId);

  const scores = (await listScores(childId))
    .filter((score) => !score.deleted)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));

  const existing = await listMemos(childId);
  const known = new Map(existing.map((row) => [Number(row.points), row]));

  let running = 0;
  const achievedAt = new Map();
  for (const score of scores) {
    running += Number(score.points) || 0;
    const index = Math.floor(running / 1000);
    for (let milestone = 1; milestone <= index; milestone += 1) {
      if (!achievedAt.has(milestone * 1000)) achievedAt.set(milestone * 1000, score.date);
    }
  }

  for (let index = 1; index <= milestones; index += 1) {
    const points = index * 1000;
    if (known.has(points)) continue;
    const row = {
      id: `memo_${childId}_${points}`,
      childId,
      points,
      achievedAt: achievedAt.get(points) ?? scores.at(-1)?.date ?? null,
      content: '',
      createdAt: now(),
      updatedAt: now(),
    };
    await db.put(STORES.P_MEMOS, row);
    known.set(points, row);
  }
  return listMemos(childId);
}

export async function saveMemo(childId, points, content) {
  const id = `memo_${childId}_${points}`;
  const existing = await db.get(STORES.P_MEMOS, id);
  const row = {
    id,
    childId,
    points: Number(points),
    achievedAt: existing?.achievedAt ?? null,
    content: String(content ?? '').slice(0, 60),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  await db.put(STORES.P_MEMOS, row);
  await addAudit({ type: 'memo_save', childId, after: { points: row.points, content: row.content } });
  return row;
}

/** メモの内容だけを消す（達成の行は残す） */
export async function clearMemo(childId, points) {
  return saveMemo(childId, points, '');
}

/* ------------------------------------------------------------ バックアップ */

export async function exportBackup() {
  const data = {};
  for (const store of DATA_STORES) data[store] = await db.getAll(store);
  return {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    role: 'parent',
    exportedAt: now(),
    data,
  };
}

export function backupFileName(prefix = 'tamago-friends-backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${stamp}.json`;
}

function countRecords(data) {
  return Object.entries(data ?? {}).reduce((sum, [store, rows]) => {
    if (!Array.isArray(rows)) return sum;
    return sum + rows.length;
  }, 0);
}

/**
 * バックアップから復元する。
 * - 形式を検証してから書き込む（不正なファイルは何も変更しない）
 * - 書き込み前に現在のデータを p_snapshots へ自動退避する（消さない）
 */
export async function restoreBackup(input) {
  let backup = input;
  if (typeof input === 'string') {
    try {
      backup = JSON.parse(input);
    } catch {
      throw new Error('JSONとして読み取れませんでした');
    }
  }
  if (!backup || backup.app !== BACKUP_APP) throw new Error('たまごフレンズのバックアップではありません');
  if (backup.schema > BACKUP_SCHEMA) throw new Error('新しい形式のバックアップです（アプリを更新してください）');
  if (backup.role && backup.role !== 'parent') throw new Error('親画面のバックアップではありません');
  if (!backup.data || typeof backup.data !== 'object') throw new Error('バックアップの中身が空です');
  if (!Array.isArray(backup.data[STORES.P_META]) || backup.data[STORES.P_META].length === 0) {
    throw new Error('家族情報が含まれていないバックアップです');
  }

  const current = await exportBackup();
  const snapshot = {
    id: uid('snap'),
    at: now(),
    reason: 'restore',
    label: `復元前の自動退避（${new Date().toLocaleString('ja-JP')}）`,
    counts: countRecords(current.data),
    data: current.data,
  };
  await db.put(STORES.P_SNAPSHOTS, snapshot);

  const payload = {};
  for (const store of DATA_STORES) payload[store] = Array.isArray(backup.data[store]) ? backup.data[store] : [];
  await db.importAll(payload, { clearFirst: true });
  return {
    ok: true,
    snapshotId: snapshot.id,
    replaced: countRecords(current.data),
    restored: countRecords(payload),
    exportedAt: backup.exportedAt ?? null,
  };
}

export async function listSnapshots() {
  const rows = await db.getAll(STORES.P_SNAPSHOTS);
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 自動退避したデータへ戻す（戻す前の状態も退避する） */
export async function restoreSnapshot(snapshotId) {
  const snapshot = await db.get(STORES.P_SNAPSHOTS, snapshotId);
  if (!snapshot) throw new Error('退避データが見つかりません');
  const current = await exportBackup();
  const safety = {
    id: uid('snap'),
    at: now(),
    reason: 'restore-snapshot',
    label: `退避データを戻す前の自動退避（${new Date().toLocaleString('ja-JP')}）`,
    counts: countRecords(current.data),
    data: current.data,
  };
  await db.put(STORES.P_SNAPSHOTS, safety);
  const payload = {};
  for (const store of DATA_STORES) payload[store] = snapshot.data?.[store] ?? [];
  await db.importAll(payload, { clearFirst: true });
  return { ok: true, snapshotId: safety.id };
}

export async function deleteSnapshot(snapshotId) {
  await db.del(STORES.P_SNAPSHOTS, snapshotId);
}

/* ------------------------------------------------------------ 家族データの初期化（v29） */

/** 直前の初期化前準備の記録（画面・E2E が実測に使う。中身の JSON は保持しない） */
let lastResetInfo = null;

export function lastFactoryResetInfo() {
  return lastResetInfo;
}

/**
 * 初期化の**前準備**。何も消さない。
 * 1. 現在の PIN を照合する（空・形式・不一致はここで止める）
 * 2. 既存 exportBackup() と同じ形式でバックアップを作り、JSON 文字列まで作る
 * 3. 端末内に自動退避を1件つくる（既存 P_SNAPSHOTS と同じ仕組み）＋読み戻して確認
 * どれかが失敗したら throw する（呼び出し側は消さずに中止する）。
 */
export async function prepareFamilyReset({ pin } = {}) {
  const value = String(pin ?? '');
  if (!value) throw new Error(PIN_EMPTY_MESSAGE);
  if (!isValidPinFormat(value)) throw new Error(PIN_FORMAT_MESSAGE);
  if (!(await verifyPin(value))) throw new Error(PIN_MISMATCH_MESSAGE);

  let backup;
  let json;
  try {
    backup = await exportBackup();
    json = JSON.stringify(backup, null, 2);
  } catch {
    throw new Error(BACKUP_FAILED_MESSAGE);
  }

  const snapshot = {
    id: uid('snap'),
    at: now(),
    reason: 'factory-reset',
    label: factoryResetSnapshotLabel(new Date()),
    counts: countRecords(backup.data),
    data: backup.data,
  };
  try {
    await db.put(STORES.P_SNAPSHOTS, snapshot);
    const saved = await db.get(STORES.P_SNAPSHOTS, snapshot.id);
    if (!saved || !saved.data) throw new Error('empty snapshot');
  } catch {
    throw new Error(BACKUP_FAILED_MESSAGE);
  }

  const snapshots = await listSnapshots();
  lastResetInfo = {
    at: now(),
    fileName: backupFileName(),
    bytes: json.length,
    counts: countRecords(backup.data),
    snapshotId: snapshot.id,
    snapshotCount: snapshots.length,
  };
  return { ...lastResetInfo, json };
}

/**
 * 初期化の**実行**。親端末の全ストア（自動退避を含む）を空にする。
 * 子端末のストアはこの端末に無く、触れない。
 */
export async function factoryReset() {
  return db.clearStores(FACTORY_RESET_STORES);
}

/* ------------------------------------------------------------ 画面用のまとめ */

export async function childSummary(childId) {
  const child = await getChild(childId);
  if (!child) return null;
  return { ...child, summary: summarize(child) };
}

export async function overview() {
  const children = await listChildren();
  const rows = [];
  for (const child of children) {
    const scores = await listScores(child.id);
    rows.push({
      ...child,
      summary: summarize(child),
      scoreCount: scores.length,
      pendingCount: scores.filter((score) => !score.sentAt).length,
      correctionCount: (await listPendingCorrections(child.id)).length,
      pendingRequests: (await listRequests({ childId: child.id })).filter((request) => request.status === 'pending').length,
    });
  }
  return rows;
}
