/**
 * 子端末のデータ操作（ペアリング・受け取り・ごほうび申請）。
 * 子端末側の操作は「受け取る」だけで、家族データの削除・移行・復元はできない。
 */
import * as db from '../db.js';
import { CHILD_STORES, STORES } from '../db.js';
import { applyDelta, createState, summarize } from '../game/points.js';
import { createRoomState, roomScreensFor } from '../game/room.js';
import { fetchWeather } from '../game/weather.js';
import {
  canPlace,
  freeSpotFor,
  makePlacement,
  migrateRoomRecord,
  moveFurniture,
  normalizeAccessories,
  removeFurniture,
} from '../game/furniture.js';
import {
  DEFAULT_FLOOR,
  DEFAULT_WALLPAPER,
  findShopItem,
  isPlaceable,
} from '../../data/shop.js';
import { ROOM_ROWS } from '../../data/room.js';
import { KINDS, parseEnvelope, randomToken, signHmacEnvelope, verifyEnvelope } from '../qr/payload.js';

const META_KEY = 'pairing';
const STATE_KEY = 'state';

export async function getPairing() {
  return (await db.get(STORES.C_META, META_KEY)) ?? null;
}

export async function isPaired() {
  return Boolean(await getPairing());
}

function sanitizeName(value, fallback = '') {
  return String(value ?? fallback).slice(0, 30);
}

/**
 * 初回ペアリング（かぞくQR）。家族ID・子どもID・親の公開鍵・家族キーを保存する。
 * QR は PIN 解錠後の親画面だけが表示できる（信頼の起点）。
 */
export async function pair(text) {
  const parsed = await verifyEnvelope(text, {});
  if (!parsed.ok) throw new Error(parsed.message);
  if (parsed.payload.kind !== KINDS.PAIR) throw new Error('かぞくQRではありません');
  const payload = parsed.payload;
  if (!payload.fid || !payload.cid || !payload.publicKeyJwk || !payload.secretB64url) {
    throw new Error('かぞくQRの内容が不足しています');
  }

  const existing = await getPairing();
  if (existing && (existing.familyId !== payload.fid || existing.childId !== payload.cid)) {
    throw new Error('この端末は別の家族とペアリング済みです。切り替えは親画面から行ってください');
  }

  const pairing = {
    k: META_KEY,
    familyId: String(payload.fid),
    childId: String(payload.cid),
    childName: sanitizeName(payload.childName, 'こども'),
    familyName: sanitizeName(payload.familyName, 'かぞく'),
    publicKeyJwk: payload.publicKeyJwk,
    secretB64url: payload.secretB64url,
    pairedAt: new Date().toISOString(),
    reissuedAt: payload.iat ? new Date(payload.iat).toISOString() : null,
  };
  await db.put(STORES.C_META, pairing);
  return pairing;
}

export async function getState() {
  const record = await db.get(STORES.C_STATE, STATE_KEY);
  return { ...createState(record ?? {}), hatchSpent: Number(record?.hatchSpent) || 0 };
}

async function saveState(state) {
  await db.put(STORES.C_STATE, {
    k: STATE_KEY,
    ...createState(state),
    hatchSpent: Number(state?.hatchSpent) || 0,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 受け取り済みの「点数行」の一覧（1つの点数記録＝1行）。
 * 訂正は行の値を更新するので行は増えない（履歴が二重にならない）。
 */
export async function listLines() {
  const rows = await db.getAll(STORES.C_EVENTS);
  return rows.filter((row) => !row.deleted).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.appliedAt).localeCompare(String(a.appliedAt)));
}

/** デバッグ・検証用: 削除済みも含めた全行 */
export async function listAllLines() {
  const rows = await db.getAll(STORES.C_EVENTS);
  return rows.sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
}

export async function listCatalog() {
  const rows = await db.getAll(STORES.C_CATALOG);
  return rows.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'));
}

export async function listRequests() {
  const rows = await db.getAll(STORES.C_REQUESTS);
  return rows.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
}

/**
 * QR を1枚処理する。
 * 点数・訂正は「イベントIDで重複排除 → 1件ずつ順番に適用」し、件ごとの結果を返す。
 * 戻り値: { ok, kind, applied: [{...}], duplicates, granted, summary, message }
 */
export async function ingest(text) {
  const pairing = await getPairing();
  if (!pairing) return { ok: false, reason: 'unpaired', message: '先に「かぞくQR」を読み取ってください' };

  const verified = await verifyEnvelope(text, {
    publicKeyJwk: pairing.publicKeyJwk,
    secretB64url: pairing.secretB64url,
  });
  if (!verified.ok) return { ok: false, reason: verified.reason, message: verified.message };

  const payload = verified.payload;
  if (payload.fid !== pairing.familyId) return { ok: false, reason: 'family', message: '別の家族のQRコードです' };
  if (payload.cid !== pairing.childId) return { ok: false, reason: 'child', message: 'この端末（別の子ども）宛てのQRコードです' };

  if (payload.kind === KINDS.PAIR) {
    return { ok: false, reason: 'pair', message: 'この端末はすでにペアリング済みです' };
  }
  if (payload.kind === KINDS.SCORES || payload.kind === KINDS.CORRECTION) {
    return applyScorePayload(payload);
  }
  if (payload.kind === KINDS.REWARDS) {
    return applyRewardCatalog(payload);
  }
  if (payload.kind === KINDS.REWARD_DECISION) {
    return applyRewardDecision(payload);
  }
  return { ok: false, reason: 'kind', message: '対応していないQRコードです' };
}

/**
 * 点数QR・訂正QRの適用。
 *
 * 1つの点数記録を「行（lineId = 点数記録のID）」として扱い、`rev`（版番号）で更新する。
 * - 未受信の行 → その値で新規作成
 * - 受信済みで rev が新しい → 差分（新しい値 - いまの値）だけ適用
 * - rev が同じ・古い → 二重処理として無視（再送・再読しても増えない）
 * - 未受信の行に対する「削除」の訂正 → 適用しない（何も消せないため）
 *
 * 累計は 0 未満にならない。親の付与済み孵化権・最高到達点は QR の st で受け取り、
 * 取りこぼしがあっても子端末の表示が親とずれないようにする（減らさない）。
 */
async function applyScorePayload(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return { ok: false, reason: 'empty', message: '点数が入っていません' };

  const stateBefore = await getState();
  let state = stateBefore;
  const applied = [];
  const skipped = [];
  let duplicates = 0;
  let clamped = 0;

  for (const item of items) {
    const lineId = String(item.lineId ?? item.eventId ?? '');
    if (!lineId) continue;
    const rev = Number(item.rev ?? 1) || 1;
    const existing = await db.get(STORES.C_EVENTS, lineId);
    const isCorrection = payload.kind === KINDS.CORRECTION;

    if (existing && rev <= (Number(existing.rev) || 1)) {
      duplicates += 1;
      applied.push({ lineId, duplicate: true, points: 0, rev, totalAfter: state.total });
      continue;
    }
    if (!existing && (item.deleted || isCorrection)) {
      // 元の点数を受け取っていない訂正は適用しない
      skipped.push({ lineId, rev, points: Number(item.points) || 0, reason: 'unknown-line' });
      continue;
    }

    const previousPoints = Number(existing?.points) || 0;
    const nextPoints = item.deleted ? 0 : Number(item.points) || 0;
    const delta = nextPoints - previousPoints;
    // applyDelta は total / highWaterMark / hatchTokens しか返さないので、
    // 消費数（hatchSpent）は必ず引き継ぐ（落とすと消費がリセットされる）
    const spentBefore = Number(state.hatchSpent) || 0;
    const result = applyDelta(state, delta);
    state = { ...result.state, hatchSpent: spentBefore };
    if (result.clamped) clamped += 1;

    const line = {
      id: lineId,
      rev,
      childId: payload.cid,
      points: nextPoints,
      deleted: Boolean(item.deleted),
      testName: String(item.testName ?? 'てんすう').slice(0, 40),
      date: String(item.date ?? '').slice(0, 10),
      reason: item.reason ?? null,
      grp: payload.grp ?? null,
      appliedAt: new Date().toISOString(),
      totalAfter: result.state.total,
    };
    await db.put(STORES.C_EVENTS, line);
    applied.push({
      lineId,
      rev,
      duplicate: false,
      points: delta,
      nextPoints,
      testName: line.testName,
      date: line.date,
      totalAfter: result.state.total,
      grantedNow: result.granted,
      clamped: result.clamped,
    });
  }

  // 親が持つ付与済みの値を下限として取り込む（減らさない）
  const snapshot = payload.st && typeof payload.st === 'object' ? payload.st : null;
  if (snapshot) {
    // 消費数はこの端末だけが持つ事実。QRの内容で上書きしない
    const spent = Number(state.hatchSpent) || 0;
    // 親が付与した合計（granted）と、この端末で消費した数を分けて持つ
    const granted = Math.max((Number(state.hatchTokens) || 0) + spent, Number(snapshot.tokens) || 0);
    state = {
      total: state.total,
      highWaterMark: Math.max(state.highWaterMark, Number(snapshot.high) || 0),
      hatchTokens: Math.max(0, granted - spent),
      hatchSpent: spent,
    };
  }

  await saveState(state);
  const summary = summarize(state);
  const fresh = applied.filter((entry) => !entry.duplicate);
  const tokensGained = state.hatchTokens - stateBefore.hatchTokens;
  const parts = [];
  if (fresh.length) {
    parts.push(payload.kind === KINDS.CORRECTION ? `訂正を${fresh.length}件うけとりました` : `${fresh.length}件の点数をうけとりました`);
  }
  if (skipped.length) parts.push(`まだ受け取っていない点数への訂正です（${skipped.length}件は適用していません）`);
  if (!fresh.length && !skipped.length) parts.push('このQRコードはすでに受け取り済みです（二重加算はしていません）');
  if (clamped) parts.push('累計がマイナスにならないよう調整しました');

  return {
    ok: true,
    kind: payload.kind,
    applied,
    fresh,
    skipped,
    duplicates,
    granted: tokensGained,
    clamped,
    summary,
    split: { idx: payload.idx ?? 1, tot: payload.tot ?? 1 },
    message: parts.join('。'),
  };
}

async function applyRewardCatalog(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  let updated = 0;
  for (const item of items) {
    if (!item.rewardId) continue;
    await db.put(STORES.C_CATALOG, {
      id: String(item.rewardId),
      title: String(item.title ?? 'ごほうび').slice(0, 40),
      note: String(item.note ?? '').slice(0, 120),
      updatedAt: new Date().toISOString(),
    });
    updated += 1;
  }
  return { ok: true, kind: KINDS.REWARDS, updated, message: `ごほうびを${updated}件うけとりました` };
}

async function applyRewardDecision(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  let updated = 0;
  const decisions = [];
  for (const item of items) {
    if (!item.requestId) continue;
    const existing = await db.get(STORES.C_REQUESTS, String(item.requestId));
    const record = {
      id: String(item.requestId),
      rewardId: item.rewardId ? String(item.rewardId) : null,
      title: String(item.title ?? existing?.title ?? 'ごほうび').slice(0, 40),
      requestedAt: existing?.requestedAt ?? new Date().toISOString(),
      status: item.decision === 'approved' ? 'approved' : 'rejected',
      decidedAt: item.at ?? new Date().toISOString(),
      note: String(item.note ?? '').slice(0, 120),
    };
    await db.put(STORES.C_REQUESTS, record);
    decisions.push(record);
    updated += 1;
  }
  return {
    ok: true,
    kind: KINDS.REWARD_DECISION,
    updated,
    decisions,
    message: decisions.some((decision) => decision.status === 'approved')
      ? 'ごほうびが しょうにん されました！'
      : 'ごほうびは みおくられました',
  };
}

/** ごほうび申請QR を作る（親が読み取って承認・却下する） */
export async function createRewardRequest({ rewardId = null, title, note = '' }) {
  const pairing = await getPairing();
  if (!pairing) throw new Error('親とペアリングされていません');
  const trimmed = String(title ?? '').trim();
  if (!trimmed) throw new Error('ごほうびを選んでください');

  const requestId = `req_${randomToken(9)}`;
  const payload = {
    v: 1,
    kind: KINDS.REWARD_REQUEST,
    fid: pairing.familyId,
    cid: pairing.childId,
    iss: 'child',
    iat: Date.now(),
    requestId,
    rewardId,
    title: trimmed.slice(0, 40),
    note: String(note).slice(0, 120),
  };
  const qr = await signHmacEnvelope(pairing.secretB64url, payload);
  const record = {
    id: requestId,
    rewardId,
    title: payload.title,
    note: payload.note,
    requestedAt: new Date().toISOString(),
    status: 'requested',
    decidedAt: null,
  };
  await db.put(STORES.C_REQUESTS, record);
  return { qr, request: record, qrs: [qr] };
}

/** 画面表示用（累計・進捗・孵化権） */
export async function getDashboard() {
  const pairing = await getPairing();
  const state = await getState();
  const lines = await listLines();
  return {
    pairing,
    state,
    summary: summarize(state),
    events: lines.slice(0, 50),
    eventCount: lines.length,
  };
}

/* ================================================================
 * Phase 2: ペット・コイン・設定（子端末のみに保存。親端末へは送らない）
 * ================================================================ */
import {
  CARE_ACTIONS,
  applyCare as applyCareLogic,
  canCare as canCareLogic,
  createPet,
  displayGauges,
  pickSpecies,
  stageFor,
  tick as tickLogic,
  toggleSleep as toggleSleepLogic,
  updateStage,
} from '../game/pet.js';
import { addCareCoin, addCoins, createLedger, spendCoins } from '../game/coins.js';
import { NIGHT_CARE_TEXT, applyNightRest, isNightRest, nightRecoveryWindow } from '../game/night.js';
import { BASIC_FOOD, CARE_COIN_DAILY_CAP, HATCH_COIN, STAGE_UP_COIN, findFood } from '../../data/pets.js';
import { applyGameResult, drawLottery, gameCoinsRemaining, playAlreadyGranted } from '../game/games.js';
import { GAME_DAILY_CAP } from '../../data/games.js';
import {
  DEX_NIGHT_ACTION_TEXT,
  diaryRecord,
  diaryText,
  firstMetAtFor,
  growRecord,
  hatchRecord,
  migrateSpeciesMap,
  normalizeRecordText,
  recordDate,
  shouldWriteDiary,
  sortRecords,
  stageRank,
  userRecord,
} from '../game/dex.js';

const APP_KEY = 'app';
const COINS_KEY = 'ledger';
const SETTINGS_KEY = 'sound';

// 音の初期値: BGM はオフ、効果音はオン。customized は「利用者が自分で切り替えたか」
const DEFAULT_SETTINGS = { bgm: false, se: true, customized: false };

/**
 * 画面用: 設定（音）。
 * 以前のバージョン（customized フラグなし）のレコードは、**一度だけ**新しい既定値へ移行する。
 * 自分で切り替えた端末はその設定を尊重する。
 */
export async function getSettings() {
  const record = await db.get(STORES.C_SETTINGS, SETTINGS_KEY);
  const value = record?.value;
  if (!value) return { ...DEFAULT_SETTINGS };
  if (value.customized === undefined) {
    const migrated = { ...DEFAULT_SETTINGS };
    await db.put(STORES.C_SETTINGS, { k: SETTINGS_KEY, value: migrated });
    return migrated;
  }
  return { ...DEFAULT_SETTINGS, ...value };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, customized: true };
  await db.put(STORES.C_SETTINGS, { k: SETTINGS_KEY, value: next });
  return next;
}

/** UI の状態（選択中のペット） */
export async function getUiState() {
  const record = await db.get(STORES.C_META, APP_KEY);
  return { selectedPetId: record?.selectedPetId ?? null };
}

export async function setSelectedPet(petId) {
  const current = await getUiState();
  await db.put(STORES.C_META, { k: APP_KEY, ...current, selectedPetId: petId });
}

async function loadLedger(now) {
  const record = await db.get(STORES.C_COINS, COINS_KEY);
  return record?.value ?? createLedger(now);
}

async function saveLedger(ledger) {
  await db.put(STORES.C_COINS, { k: COINS_KEY, value: ledger });
}

export async function getCoins(now = Date.now()) {
  const ledger = await loadLedger(now);
  const careRemaining = Math.max(0, CARE_COIN_DAILY_CAP - (ledger.daily?.date === dayOf(now) ? (ledger.daily.care || 0) : 0));
  const gameRemaining = gameCoinsRemaining(ledger, now);
  return {
    ...ledger,
    careRemaining,
    gameRemaining,
    gameCap: GAME_DAILY_CAP,
  };
}

/**
 * ミニゲーム1回ぶんの結果を保存する（Phase 3-3 パスA）。
 *
 * - コインは `min(報酬, 30 - 当日獲得)`。上限でもプレイ自体は成立する（`capped:true`・付与0）
 * - 抽選は1プレイ2%。当選して未所持なら持ち物へ追加、所持済みなら +10/+30（上限の外）
 * - **playId で二重付与を防ぐ**（結果画面の再表示・リロードで同じ playId を渡しても増えない）
 * - `perfect`（ミス0で全ペア・v32）は台帳の `games.perfectCount` を1増やすだけ。コインは増やさない
 *
 * @param {{gameId:string, score:number, playId:string, now?:number, rng?:() => number, perfect?:boolean}} input
 * @returns {Promise<{ok:boolean, duplicate:boolean, result:object|null, coins:object, room:object|null}>}
 */
export async function finishGame({ gameId, score, playId, now = Date.now(), rng = Math.random, lotteryChance, perfect = false } = {}) {
  const ledger = await loadLedger(now);
  // 付与済みの playId は何も読まずに返す（抽選も引き直さない）
  if (playAlreadyGranted(ledger, playId)) {
    return { ok: true, duplicate: true, result: ledger.games?.lastResult ?? null, coins: ledger, room: null };
  }
  const room = await getRoom({ now });
  const inventory = Array.isArray(room.inventory) ? room.inventory : [];
  // lotteryChance はテスト用の入口（省略時は data/games.js の LOTTERY_CHANCE）
  const lottery = drawLottery({ rng, inventory, lotteryChance });
  const applied = applyGameResult(ledger, { gameId, score, playId, now, lottery, perfect });
  if (applied.duplicate) {
    return { ok: true, duplicate: true, result: applied.result, coins: applied.ledger, room: null };
  }
  await saveLedger(applied.ledger);

  let nextRoom = null;
  if (lottery.hit && lottery.item && !lottery.owned) {
    nextRoom = await saveRoom({ inventory: [...inventory, lottery.item.id] });
  }
  return { ok: true, duplicate: false, result: applied.result, coins: applied.ledger, room: nextRoom };
}

function dayOf(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 孵化権（残り）と、消費済みの数 */
export async function getHatchTokens() {
  const state = await getState();
  return { tokens: state.hatchTokens ?? 0, spent: state.hatchSpent ?? 0 };
}

export async function listPets() {
  const pets = await db.getAll(STORES.C_PETS);
  return pets.sort((a, b) => Number(a.hatchedAt) - Number(b.hatchedAt));
}

export async function getPet(petId) {
  return db.get(STORES.C_PETS, petId);
}

async function savePet(pet) {
  await db.put(STORES.C_PETS, pet);
  return pet;
}

/**
 * 孵化: 孵化権を1消費してペットを作る。
 * @returns {{ok:boolean, pet?:object, coins?:object, reason?:string}}
 */
export async function hatchPet({ name, now = Date.now(), rng = Math.random, speciesId: forced = null } = {}) {
  const state = await getState();
  if ((state.hatchTokens ?? 0) <= 0) return { ok: false, reason: 'no-tokens' };

  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'name-required' };

  const speciesId = forced ?? pickSpecies(rng);
  // であった日（Z3-1）を孵化の瞬間に個体へ持たせる。以後変更しない
  const pet = { ...createPet({ speciesId, name: trimmed.slice(0, 10), now, rng }), firstMetAt: now };
  await savePet(pet);
  // ずかん（v42）: (a) 種の発見登録 (b) 孵化の記録 (c) であった日
  await recordHatchInDex(pet, now);

  // 孵化権を1消費（親の付与数は state 側で保持し、消費済みを別に数える）
  await saveState({
    ...state,
    hatchTokens: Math.max(0, (state.hatchTokens ?? 0) - 1),
    hatchSpent: (state.hatchSpent ?? 0) + 1,
  });

  let ledger = await loadLedger(now);
  ledger = addCoins(ledger, HATCH_COIN, 'hatch', now, 'ふか');
  await saveLedger(ledger);

  const ui = await getUiState();
  if (!ui.selectedPetId) await setSelectedPet(pet.id);

  return { ok: true, pet, coins: ledger, speciesId };
}

export async function renamePet(petId, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('なまえを いれてね');
  if (trimmed.length > 10) throw new Error('なまえは 10もじまで');
  const pet = await db.get(STORES.C_PETS, petId);
  if (!pet) throw new Error('ペットが みつかりません');
  const next = { ...pet, name: trimmed };
  await savePet(next);
  return next;
}

/** 時間経過を反映（起動直後は resume:true で、閉じていた分は減らさない） */
export async function syncPets(now = Date.now(), { resume = false } = {}) {
  const pets = await listPets();
  const events = [];
  for (const pet of pets) {
    let next = tickLogic(pet, now, { resume }).pet;
    const staged = updateStage(next, now);
    next = staged.pet;
    if (staged.up) {
      events.push({ type: 'stage', petId: pet.id, stage: staged.stage, petName: pet.name });
      let ledger = await loadLedger(now);
      ledger = addCoins(ledger, STAGE_UP_COIN, 'stageUp', now, 'そだち');
      await saveLedger(ledger);
      // ずかん（v42）: 段階アップの自動記録（移行後の成長のみ・既存個体は遡らない）
      await recordGrowthInDex(pet.stage, next, now);
    }
    if (JSON.stringify(next) !== JSON.stringify(pet)) await savePet(next);
  }
  return events;
}

/**
 * 起動時（v25）: 閉じていた夜の たいりょく 回復。
 * 昼に開いたとき、夜を跨いで閉じていた子（その時は おきていた）にも
 * 「22:00〜7:00 は寝ていた」ぶんの回復を与える。夜に開いたときは何もしない。
 */
export async function recoverClosedNight(now = Date.now()) {
  const pets = await listPets();
  const updates = [];
  for (const pet of pets) {
    const window = nightRecoveryWindow(pet, now);
    if (!window) continue;
    // 既存の睡眠回復（tick の resume・睡眠中だけ たいりょく が増える）をそのまま使う
    const probe = tickLogic({ ...pet, sleeping: true, lastTickAt: window.from }, window.to, { resume: true }).pet;
    if (JSON.stringify(probe.gauges) === JSON.stringify(pet.gauges)) continue;
    updates.push({ ...pet, gauges: probe.gauges });
  }
  for (const pet of updates) await savePet(pet);
  return updates;
}

/**
 * 就寝・起床の自動化（v25）。実時刻に合わせて全ペットの `sleeping` をそろえて保存する。
 *
 * - `prev` は**前回の判定時刻**（アプリを開いている間の1分ごとの判定）。
 *   境界を跨いだ1回だけ `entered` / `left` が true になる（トーストを1回だけ出すため）。
 * - `prev = null`（起動時・リロード）は状態だけ実時刻に合わせる（トーストは出さない）。
 * - 保存するのは変わったペットだけ。フィールドは既存の `sleeping` / `sleepingSince` のみ。
 *
 * @param {number} now
 * @param {number|null} prev
 * @returns {{pets:Array<object>, changed:boolean, night:boolean, entered:boolean, left:boolean, startAt:number|null, count:number}}
 */
export async function syncNightRest(now = Date.now(), prev = null) {
  const pets = await listPets();
  const result = applyNightRest(pets, now, prev);
  for (const pet of result.updates) await savePet(pet);
  return { ...result, count: pets.length };
}

/** お世話（クールダウン判定・成長カウント・コイン付与まで） */
export async function carePet(petId, actionId, { now = Date.now(), foodId = null, rng = Math.random } = {}) {
  const pet = await db.get(STORES.C_PETS, petId);
  if (!pet) throw new Error('ペットが みつかりません');

  const synced = tickLogic(pet, now).pet;
  // 夜間ロック（v25）: 22:00〜06:59 は おせわ（ねかせる／おこす を含む）を受け付けない。
  // 画面のボタンと同じ文言を返す（画面側でも押下を止めているが、保存の入口でも守る）。
  if (CARE_ACTIONS[actionId] && isNightRest(now)) {
    return { ok: false, reason: 'night', message: NIGHT_CARE_TEXT, pet: synced };
  }
  const check = canCareLogic(synced, actionId, now);
  if (!check.ok) return { ok: false, ...check, pet: synced };

  let ledger = await loadLedger(now);
  let spentFood = null;

  if (actionId === 'food') {
    const food = foodId ? findFood(foodId) : BASIC_FOOD;
    if (!food) return { ok: false, reason: 'food', message: 'その エサは ありません', pet: synced };
    if (food.price > 0) {
      const purchase = spendCoins(ledger, food.price, 'food', now, food.name);
      if (!purchase.ok) {
        return { ok: false, reason: 'coins', message: `コインが たりないよ（あと ${food.price - ledger.balance}まい）`, pet: synced, coins: ledger };
      }
      ledger = purchase.ledger;
      spentFood = food;
    }
    const result = applyCareLogic(synced, 'food', { now, food });
    let next = updateStage(result.pet, now);
    await savePet(next.pet);
    // ずかん（v42）: 段階アップ＋ペット日記（おせわの差分から・確率発火）
    await recordGrowthInDex(pet.stage, next.pet, now);
    await recordDiaryInDex(next.pet, 'food', { now, rng });

    if (result.growth) {
      const care = addCareCoin(ledger, now);
      ledger = care.ledger;
    }
    await saveLedger(ledger);
    if (next.up) {
      ledger = addCoins(ledger, STAGE_UP_COIN, 'stageUp', now, 'そだち');
      await saveLedger(ledger);
    }
    return {
      ok: true,
      pet: next.pet,
      growth: result.growth,
      stageUp: next.up ? next.stage : null,
      coins: ledger,
      food: spentFood,
      message: result.message,
    };
  }

  const result = applyCareLogic(synced, actionId, { now });
  let next = updateStage(result.pet, now);
  await savePet(next.pet);
  // ずかん（v42）: 段階アップ＋ペット日記（ねかせる も「ねむったよ」の話題になる）
  await recordGrowthInDex(pet.stage, next.pet, now);
  await recordDiaryInDex(next.pet, actionId, { now, rng });

  // お世話1回 +1（種類を問わず無条件・1日20枚まで）
  const care = addCareCoin(ledger, now);
  ledger = care.ledger;
  const careGranted = care.granted;
  if (next.up) ledger = addCoins(ledger, STAGE_UP_COIN, 'stageUp', now, 'そだち');
  await saveLedger(ledger);

  return {
    ok: true,
    pet: next.pet,
    growth: result.growth,
    careGranted,
    stageUp: next.up ? next.stage : null,
    coins: ledger,
    message: result.message,
  };
}

/** 画面用のまとめ（ペット・ゲージ・段階・コイン） */
export async function getPetDashboard(now = Date.now()) {
  const [pets, coins, settings, ui, tokens, pairing] = await Promise.all([
    listPets(),
    getCoins(now),
    getSettings(),
    getUiState(),
    getHatchTokens(),
    getPairing(),
  ]);
  const rows = pets.map((pet) => ({
    ...pet,
    gaugesShown: displayGauges(pet),
    stage: stageFor(pet, now),
  }));
  const selected = rows.find((row) => row.id === ui.selectedPetId) ?? rows[0] ?? null;
  // 帽子の装着状態・所持品は部屋（c_room）に持つ
  const room = await getRoom({ petCount: rows.length, now });
  return { pairing, pets: rows, selected, coins, settings, tokens, now, room };
}

/* ------------------------------------------------------------ ペットルーム */

/** 部屋の状態（広さ・天気・チュートリアル・家具・所持品・もようがえ・装着品） */
export async function getRoom({ petCount = 0, rng = Math.random, now = Date.now() } = {}) {
  const record = await db.get(STORES.C_ROOM, 'room');
  const base = record ?? createRoomState({ petCount, rng, now });
  const room = migrateRoomRecord(base);
  // petCount が渡されていないときは保存済みの広さを保つ（勝手に縮めない）
  const screens = petCount > 0 ? roomScreensFor(petCount) : (record?.screens ?? room.screens ?? 1);
  const changed =
    !record ||
    record.screens !== screens ||
    !Array.isArray(record.furniture) ||
    record.furniture.some((entry) => !entry?.itemId || !entry?.layer) ||
    !Array.isArray(record.inventory) ||
    record.wallpaper === undefined ||
    record.floor === undefined ||
    !record.accessories ||
    // 帽子の重複（1アイテム1匹）を読み込み時に正規化して保存し直す
    JSON.stringify(record.accessories ?? {}) !== JSON.stringify(room.accessories);
  const next = { ...room, id: 'room', screens, updatedAt: changed ? new Date(now).toISOString() : room.updatedAt };
  if (changed) await db.put(STORES.C_ROOM, next);
  return next;
}

export async function saveRoom(patch = {}) {
  const record = await db.get(STORES.C_ROOM, 'room');
  const current = migrateRoomRecord(record ?? createRoomState({}));
  const next = { ...current, ...patch, id: 'room', updatedAt: new Date().toISOString() };
  // 装着品は保存のどの経路でも「1アイテム1匹」に揃える
  next.accessories = normalizeAccessories(next.accessories);
  await db.put(STORES.C_ROOM, next);
  return next;
}

/** 部屋の列数（画面数×12） */
function roomColsOf(room) {
  return (room.screens ?? 1) * 12;
}

/**
 * ショップで買う。コインを減らし、所持品に追加する（インベントリは itemId の配列）。
 * 同じ商品は1つまで（所持済みは買えない）。
 */
export async function purchaseItem(itemId, now = Date.now()) {
  const item = findShopItem(itemId);
  if (!item) return { ok: false, reason: 'unknown' };
  // 所持品（ごはんばち・ボール）は商品ではない＝価格を持たない・買えない
  if (typeof item.price !== 'number') return { ok: false, reason: 'not-for-sale' };
  const room = await getRoom();
  if (room.inventory.includes(itemId)) return { ok: false, reason: 'owned' };

  const ledger = await loadLedger(now);
  const purchase = spendCoins(ledger, item.price, 'shop', now, `こうにゅう: ${item.name}`);
  if (!purchase.ok) {
    return { ok: false, reason: 'coins', shortfall: purchase.shortfall, balance: ledger.balance };
  }
  await saveLedger(purchase.ledger);
  const next = await saveRoom({ inventory: [...room.inventory, itemId] });
  return { ok: true, item, room: next, coins: purchase.ledger };
}

/** 所持している家具を部屋に置く（空きセルを自動で探す） */
export async function placeItem(itemId, { now = Date.now() } = {}) {
  // 夜間ロック（v25）: 家具を置くのは もようがえ扱い＝22:00〜06:59 は不可（UI でも先に弾く）
  if (isNightRest(now)) return { ok: false, reason: 'night', message: NIGHT_CARE_TEXT };
  const item = findShopItem(itemId);
  if (!isPlaceable(item)) return { ok: false, reason: 'not-placeable' };
  const room = await getRoom({ now });
  if (!room.inventory.includes(itemId)) return { ok: false, reason: 'not-owned' };
  if (room.furniture.some((entry) => entry.itemId === itemId)) return { ok: false, reason: 'already-placed' };

  // 仕様の「配置セル案」があればそこへ（空いていないときは空きセルを探す）
  const preferred = item.defaultCell;
  const preferredOk =
    preferred &&
    canPlace(room.furniture, { itemId, col: preferred.col, row: preferred.row, layer: item.layer }, { cols: roomColsOf(room), rows: ROOM_ROWS }).ok;
  const spot = preferredOk ? { col: preferred.col, row: preferred.row } : freeSpotFor(room.furniture, itemId, { cols: roomColsOf(room), rows: ROOM_ROWS });
  if (!spot) return { ok: false, reason: 'no-space' };
  const furniture = [...room.furniture, makePlacement(itemId, spot.col, spot.row, item.layer)];
  const next = await saveRoom({ furniture });
  return { ok: true, room: next, spot };
}

/** 家具を動かす（置けない位置なら保存しない） */
export async function moveItem(itemId, col, row, { now = Date.now() } = {}) {
  const room = await getRoom({ now });
  const result = moveFurniture(room.furniture, itemId, col, row, { cols: roomColsOf(room), rows: ROOM_ROWS });
  if (!result.ok) return { ok: false, reason: result.reason, conflictId: result.conflictId ?? null };
  const next = await saveRoom({ furniture: result.furniture });
  return { ok: true, room: next };
}

/**
 * ランプの点灯/消灯を保存する（v21 照明）。
 * - **光源を持つ家具（カタログの `light`）だけ**・置いてある家具だけ
 * - 手動の状態は「その夜」（`lightWindow` = 19:00 から始まった夜の日付）に対して覚える。
 *   次の境界（4:00 / 19:00）では記録が一致しないので自動（夜は点灯・朝は消灯）に戻る。
 * - 照明は端末の時計で決まるので、`lit` だけを保存する（バックアップJSONにもそのまま載る）
 */
export async function setLampState(itemId, { lit, lightWindow } = {}, { now = Date.now() } = {}) {
  const item = findShopItem(itemId);
  if (!item?.light) return { ok: false, reason: 'not-lamp' };
  const room = await getRoom({ now });
  if (!room.furniture.some((entry) => entry.itemId === itemId)) return { ok: false, reason: 'not-placed' };
  const furniture = room.furniture.map((entry) => (
    entry.itemId === itemId
      ? { ...entry, lit: Boolean(lit), lightWindow: String(lightWindow ?? '') }
      : entry
  ));
  const next = await saveRoom({ furniture });
  return { ok: true, room: next };
}

/** 「かたづける」: 部屋から下げて所持へ戻す（売却・返金はしない） */
export async function storeItem(itemId) {
  const room = await getRoom();
  const result = removeFurniture(room.furniture, itemId);
  const next = await saveRoom({ furniture: result.furniture });
  return { ok: true, room: next };
}

/** 壁紙・床を切り替える（surface = 'wallpaper' | 'floor'） */
export async function setSurface(surface, itemId) {
  if (surface !== 'wallpaper' && surface !== 'floor') return { ok: false, reason: 'unknown-surface' };
  const room = await getRoom();
  const fallback = surface === 'wallpaper' ? DEFAULT_WALLPAPER : DEFAULT_FLOOR;
  if (itemId !== fallback) {
    const item = findShopItem(itemId);
    if (!item || item.surface !== surface) return { ok: false, reason: 'unknown' };
    if (!room.inventory.includes(itemId)) return { ok: false, reason: 'not-owned' };
  }
  const next = await saveRoom(surface === 'wallpaper' ? { wallpaper: itemId } : { floor: itemId });
  return { ok: true, room: next };
}

/**
 * ペットに帽子を付ける（itemId が null なら外す）。
 * **1アイテムは1匹だけ**: 他のペットが着けていたら、その子から外して付け替える
 * （UI 側で「◯◯が つけているよ。つけかえる？」の確認を出してから呼ぶ）。
 */
export async function setPetAccessory(petId, itemId, { now = Date.now() } = {}) {
  // 夜間ロック（v25）: ぼうしの着脱も部屋の変更＝22:00〜06:59 は不可（UI でも先に弾く）
  if (isNightRest(now)) return { ok: false, reason: 'night', message: NIGHT_CARE_TEXT };
  const room = await getRoom();
  if (itemId) {
    const item = findShopItem(itemId);
    if (!item || item.category !== 'hat') return { ok: false, reason: 'unknown' };
    if (!room.inventory.includes(itemId)) return { ok: false, reason: 'not-owned' };
  }
  const accessories = { ...room.accessories };
  if (itemId) {
    for (const [otherId, wornId] of Object.entries(accessories)) {
      if (wornId === itemId && otherId !== petId) delete accessories[otherId];
    }
    accessories[petId] = itemId;
  } else {
    delete accessories[petId];
  }
  const next = await saveRoom({ accessories: normalizeAccessories(accessories) });
  return { ok: true, room: next };
}

/**
 * 天気を取りに行って保存する（実API）。
 * 失敗・未設定・オフラインのときは**保存値をそのまま残す**（無ければ「くもり」表示）。
 */
export async function refreshWeather({ now = Date.now(), fetchImpl = undefined } = {}) {
  const room = await getRoom({ now });
  if (!room.prefecture) return { ok: false, reason: 'no-prefecture', room };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline', room };
  }
  const result = await fetchWeather(room.prefecture, { fetchImpl, now: () => now });
  if (!result.ok) return { ok: false, reason: result.reason, room };
  const next = await saveRoom({ weather: { code: result.code, fetchedAt: result.fetchedAt } });
  return { ok: true, kind: result.kind, room: next };
}

/** 都道府県（天気の地域）を保存する */
export async function setPrefecture(prefectureId) {
  const room = await getRoom();
  const next = await saveRoom({ prefecture: String(prefectureId ?? '') });
  return { ok: true, room: next };
}

export async function completeTutorial() {
  return saveRoom({ tutorialDone: true });
}

/* ------------------------------------------------------------ 端末の初期化 */

/** 初期化QRを検証する（署名・家族ID・子どもID）。UIは確認を出してから実行する。 */
export async function verifyResetQr(qrText) {
  const pairing = await getPairing();
  if (!pairing) throw new Error('先に かぞくQRで ペアリングしてください');

  const result = await verifyEnvelope(qrText, { publicKeyJwk: pairing.publicKeyJwk });
  if (!result.ok) throw new Error(result.message);
  if (result.payload.kind !== KINDS.RESET) throw new Error('初期化QRではありません');
  if (result.payload.fid !== pairing.familyId || result.payload.cid !== pairing.childId) {
    throw new Error('この端末の 初期化QRではありません');
  }
  const mode = result.payload.mode === 'factory' ? 'factory' : 'keep-pets';
  return { mode, issuedAt: result.payload.iat ?? null, childName: result.payload.childName ?? null };
}

/**
 * 初期化を実行する。
 * keep-pets: 点数・累計・進捗・孵化権・ごほうび・ペアリングを消す（ペット・コイン・音の設定は残す）
 * factory:   子端末のデータをすべて消す
 */
export async function performChildReset(mode, approval = null) {
  if (!approval || approval.via !== 'reset-qr') throw new Error('初期化には 親の 初期化QRが ひつようです');
  const normalized = mode === 'factory' ? 'factory' : 'keep-pets';

  if (normalized === 'factory') {
    await db.clearStores(CHILD_STORES);
    return { mode: normalized, cleared: 'all' };
  }

  // ペット・コイン・音の設定は残す
  await db.clearStores([STORES.C_EVENTS, STORES.C_STATE, STORES.C_CATALOG, STORES.C_REQUESTS]);
  await db.del(STORES.C_META, META_KEY); // ペアリング情報
  await db.del(STORES.C_META, APP_KEY); // 選択中のペット
  return { mode: normalized, cleared: 'scores-and-pairing' };
}

/* ------------------------------------------------------------ Phase 2 のバックアップ */

export async function exportChildBackup(now = Date.now()) {
  const data = {};
  for (const store of CHILD_STORES) data[store] = await db.getAll(store);
  return {
    app: 'tamago-friends',
    schema: 2,
    role: 'child',
    exportedAt: new Date(now).toISOString(),
    data,
  };
}

function countChild(records) {
  return Object.values(records ?? {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
}

/**
 * 復元の親承認。かぞくQR（pair）を読み取り、いまのペアリングと一致するときだけ承認を返す。
 * 仕様§6「復元などの重要操作には親の承認を必要とする」に対応する。
 */
export async function approveRestoreWithFamilyQr(qrText) {
  const pairing = await getPairing();
  if (!pairing) throw new Error('先に かぞくQRで ペアリングしてください');

  const parsed = parseEnvelope(qrText);
  if (!parsed.ok) throw new Error('かぞくQRではありません（親の しょうにんが ひつようです）');
  if (parsed.payload.kind !== KINDS.PAIR) {
    throw new Error('かぞくQRではありません（親の しょうにんが ひつようです）');
  }
  if (parsed.payload.fid !== pairing.familyId || parsed.payload.cid !== pairing.childId) {
    throw new Error('この端末の かぞくQRではありません');
  }
  return { familyId: pairing.familyId, childId: pairing.childId, at: Date.now(), via: 'family-qr' };
}

/**
 * 子端末のバックアップから復元する。
 * - **親の承認（かぞくQRの再読み取り）が必須**
 * - 家族ID・子どもIDが一致するときだけ復元できる（別の子への誤移行を防ぐ）
 * - 復元前に現在のデータを自動退避する
 */
export async function restoreChildBackup(input, now = Date.now(), approval = null) {
  const pairingForApproval = await getPairing();
  if (!approval || approval.via !== 'family-qr' || !pairingForApproval) {
    throw new Error('復元には 親の しょうにん（かぞくQR）が ひつようです');
  }
  if (approval.familyId !== pairingForApproval.familyId || approval.childId !== pairingForApproval.childId) {
    throw new Error('この端末の かぞくQRではありません');
  }
  let backup = input;
  if (typeof input === 'string') {
    try {
      backup = JSON.parse(input);
    } catch {
      throw new Error('JSONとして読み取れませんでした');
    }
  }
  if (!backup || backup.app !== 'tamago-friends') throw new Error('たまごフレンズのバックアップではありません');
  if (backup.role && backup.role !== 'child') throw new Error('子端末のバックアップではありません');
  if (!backup.data || typeof backup.data !== 'object') throw new Error('バックアップの中身が空です');

  const pairing = await getPairing();
  const meta = (backup.data[STORES.C_META] ?? []).find((row) => row.k === 'pairing');
  if (pairing && meta && (meta.familyId !== pairing.familyId || meta.childId !== pairing.childId)) {
    throw new Error('別の家族・別の子どものバックアップです（この端末には復元できません）');
  }

  const current = await exportChildBackup(now);
  const snapshot = {
    k: 'snapshot',
    id: `snap_${now.toString(36)}`,
    at: new Date(now).toISOString(),
    label: `復元前の自動退避（${new Date(now).toLocaleString('ja-JP')}）`,
    counts: countChild(current.data),
    data: current.data,
  };
  await db.put(STORES.C_SNAPSHOTS, snapshot);

  // バックアップに含まれるストアだけを置き換える（古い形式のバックアップで
  // ペットなどが消えないようにする）
  const payload = {};
  for (const store of CHILD_STORES) {
    if (!Object.prototype.hasOwnProperty.call(backup.data, store)) continue;
    payload[store] = Array.isArray(backup.data[store]) ? backup.data[store] : [];
  }
  if (!Object.keys(payload).length) throw new Error('復元できるデータが入っていません');
  await db.importAll(payload, { clearFirst: true });
  return { ok: true, restored: countChild(payload), replaced: countChild(current.data), snapshotId: snapshot.id };
}

/* ================================================================
 * Phase 3-3: ずかん（ペット図鑑・v42）
 *
 * 保存するのは「種の発見」「おきにいり」「成長の記録」だけ。
 * 個体そのもの（名前・段階）は既存の c_pets が唯一の正で、表示のときに petId で結合する
 * （図鑑用にコピーを作らない＝混同・上書きが構造的に起きない）。
 * ================================================================ */

const DEX_KEY = 'dex';

function emptyDex() {
  return { k: DEX_KEY, species: {}, favorites: {} };
}

function normalizeDex(record) {
  if (!record || typeof record !== 'object') return emptyDex();
  return {
    k: DEX_KEY,
    species: record.species && typeof record.species === 'object' ? { ...record.species } : {},
    favorites: record.favorites && typeof record.favorites === 'object' ? { ...record.favorites } : {},
  };
}

async function readDex() {
  return normalizeDex(await db.get(STORES.C_DEX, DEX_KEY));
}

async function writeDex(dex) {
  const next = { ...dex, k: DEX_KEY };
  await db.put(STORES.C_DEX, next);
  return next;
}

/**
 * 既存データの移行（何度呼んでも安全）。
 * - `firstMetAt` が無い個体は「孵化した時刻（無ければ移行日）」で埋める（Z3-2・plan §2 ②）
 * - ペットがいるのに種の発見が無いときは、その個体から種の発見を作り直す
 *   （旧バックアップの復元・v41 からの移行で ずかんが空でも壊れない）
 * @returns {Promise<{dex:object, pets:Array<object>}>}
 */
export async function ensureDex({ now = Date.now() } = {}) {
  const [record, pets] = await Promise.all([db.get(STORES.C_DEX, DEX_KEY), listPets()]);
  const dex = normalizeDex(record);
  const filled = [];
  for (const pet of pets) {
    if (Number(pet.firstMetAt) > 0) {
      filled.push(pet);
      continue;
    }
    const next = { ...pet, firstMetAt: firstMetAtFor(pet, now) };
    await savePet(next);
    filled.push(next);
  }
  const migrated = migrateSpeciesMap(dex.species, filled, now);
  const next = { ...dex, species: migrated.species };
  if (!record || migrated.changed) await writeDex(next);
  return { dex: next, pets: filled };
}

/** ずかん1画面ぶん（種・個体・記録・夜かどうか） */
export async function getDex({ now = Date.now() } = {}) {
  const { dex, pets } = await ensureDex({ now });
  const records = sortRecords(await db.getAll(STORES.C_DEX_RECORDS));
  return { dex, pets, records, night: isNightRest(now), now };
}

/** 画面用（個体に現在の段階を添える） */
export async function getDexDashboard({ now = Date.now() } = {}) {
  const data = await getDex({ now });
  return { ...data, pets: data.pets.map((pet) => ({ ...pet, stage: stageFor(pet, now) })) };
}

/** 種の発見を1件登録する（最初の発見だけ・discoveredAt は保持） */
async function registerSpeciesInDex(pet, now) {
  const dex = await readDex();
  if (dex.species[pet.speciesId]) return dex;
  const next = {
    ...dex,
    species: {
      ...dex.species,
      [pet.speciesId]: {
        discoveredAt: recordDate(firstMetAtFor(pet, now)),
        firstPetId: pet.id,
      },
    },
  };
  return writeDex(next);
}

/** 孵化: 種の発見＋「たまごから うまれたよ」＋であった日（Z3-1・Z6-7） */
async function recordHatchInDex(pet, now) {
  await ensureDex({ now });
  await registerSpeciesInDex(pet, now);
  await db.put(STORES.C_DEX_RECORDS, hatchRecord({
    petId: pet.id,
    stage: pet.stage ?? 'baby',
    now: Number(pet.hatchedAt) || now,
    createdAt: now,
  }));
}

/** 段階アップ: 上がった段階の記録を1件（同じ段階は二重に書かない・既存個体は遡らない） */
async function recordGrowthInDex(beforeStage, pet, now) {
  if (!pet?.id || stageRank(pet.stage) <= stageRank(beforeStage)) return null;
  await ensureDex({ now });
  await registerSpeciesInDex(pet, now);
  const record = growRecord({ petId: pet.id, stage: pet.stage, now });
  await db.put(STORES.C_DEX_RECORDS, record);
  return record;
}

/**
 * ペット日記（Z6-9）: おせわの差分から、ペット目線の一文を自動で記録する。
 * 1個体1日1件まで・確率発火・テンプレート方式（AI・新規通信なし）。
 */
async function recordDiaryInDex(pet, careType, { now, rng = Math.random } = {}) {
  if (!pet?.id) return null;
  const date = recordDate(now);
  const records = await db.getAllByIndex(STORES.C_DEX_RECORDS, 'petId', pet.id);
  if (!shouldWriteDiary({ records, petId: pet.id, date, rng })) return null;
  const text = diaryText({
    speciesId: pet.speciesId,
    personality: pet.traits?.personality,
    careType,
    seed: Number(date.replace(/-/g, '')) % 97 + records.length,
  });
  const record = diaryRecord({ petId: pet.id, stage: pet.stage, text, now });
  await db.put(STORES.C_DEX_RECORDS, record);
  return record;
}

/** 成長の記録を1件足す（本人の記録。夜は不可・Z9） */
export async function addDexRecord({ petId, text, now = Date.now() } = {}) {
  if (isNightRest(now)) return { ok: false, reason: 'night', message: DEX_NIGHT_ACTION_TEXT };
  const value = normalizeRecordText(text);
  if (!value) return { ok: false, reason: 'empty', message: 'できごとを かいてね' };
  const pet = await db.get(STORES.C_PETS, petId);
  if (!pet) return { ok: false, reason: 'pet', message: 'ペットが みつかりません' };
  const recordId = `user_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const record = userRecord({ recordId, petId, stage: stageFor(pet, now), text: value, now });
  await db.put(STORES.C_DEX_RECORDS, record);
  return { ok: true, record };
}

/** おきにいり（個体ごと・独立。Z5-4）。夜は不可（Z9） */
export async function setDexFavorite(petId, favorite, { now = Date.now() } = {}) {
  if (isNightRest(now)) return { ok: false, reason: 'night', message: DEX_NIGHT_ACTION_TEXT };
  const pet = await db.get(STORES.C_PETS, petId);
  if (!pet) return { ok: false, reason: 'pet', message: 'ペットが みつかりません' };
  const { dex } = await ensureDex({ now });
  const favorites = { ...dex.favorites };
  if (favorite) favorites[petId] = true;
  else delete favorites[petId];
  const next = await writeDex({ ...dex, favorites });
  return { ok: true, favorites: next.favorites };
}
