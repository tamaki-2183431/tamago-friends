/**
 * コインの台帳（純関数・時刻は引数）。
 * - 孵化 +30 / 成長 +50 / お世話 +1（1日20枚まで）
 * - ミニゲーム +1〜+7（**ゲーム共通で1日30枚まで**・Phase 3-3）
 * - 残高・履歴・その日の獲得数・ゲームの累計を持つ
 */
import { CARE_COIN_DAILY_CAP, HATCH_COIN, STAGE_UP_COIN } from '../../data/pets.js';
import { PLAY_ID_KEEP } from '../../data/games.js';

export const COIN_RULES = Object.freeze({
  hatch: HATCH_COIN,
  stageUp: STAGE_UP_COIN,
  care: 1,
  careDailyCap: CARE_COIN_DAILY_CAP,
});

/** 端末のローカル日付キー */
export function dayKey(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * ゲームの累計（Phase 3-3）。
 * - playCount / bestByGame / lastPlayedAt は**日付では消さない**（累計）
 * - playIds は直近のプレイID（二重付与の防止）・lastResult は結果画面の再表示用
 * - perfectCount は「ミス0で全ペア」の回数（v32・累計・**新しいストアは作らない**＝
 *   コイン台帳の games に載せるので、既存のバックアップ／復元／自動退避にそのまま入る）
 */
export function createGameStats() {
  return { playCount: 0, bestByGame: {}, lastPlayedAt: null, playIds: [], lastResult: null, perfectCount: 0 };
}

function normalizeGameStats(value) {
  const base = value && typeof value === 'object' ? value : {};
  const best = base.bestByGame && typeof base.bestByGame === 'object' ? base.bestByGame : {};
  const bestByGame = {};
  for (const [gameId, score] of Object.entries(best)) {
    const number = Number(score);
    if (Number.isFinite(number)) bestByGame[gameId] = Math.max(0, Math.round(number));
  }
  const ids = Array.isArray(base.playIds)
    ? base.playIds.filter((id) => typeof id === 'string' && id).slice(0, PLAY_ID_KEEP)
    : [];
  const lastPlayedAt = Number(base.lastPlayedAt);
  return {
    playCount: Math.max(0, Math.round(Number(base.playCount) || 0)),
    bestByGame,
    lastPlayedAt: Number.isFinite(lastPlayedAt) && lastPlayedAt > 0 ? lastPlayedAt : null,
    playIds: ids,
    lastResult: base.lastResult && typeof base.lastResult === 'object' ? base.lastResult : null,
    perfectCount: Math.max(0, Math.round(Number(base.perfectCount) || 0)),
  };
}

export function createLedger(now = Date.now()) {
  return {
    balance: 0,
    history: [],
    daily: { date: dayKey(now), care: 0, game: 0 },
    games: createGameStats(),
  };
}

function normalized(ledger, now) {
  const base = ledger && typeof ledger === 'object' ? ledger : createLedger(now);
  const today = dayKey(now);
  // 日付が変わったら その日の獲得数だけを戻す（累計 games は消さない）
  const daily = base.daily?.date === today
    ? {
      date: today,
      care: Math.max(0, Math.round(Number(base.daily.care) || 0)),
      game: Math.max(0, Math.round(Number(base.daily.game) || 0)),
    }
    : { date: today, care: 0, game: 0 };
  return {
    balance: Math.max(0, Number(base.balance) || 0),
    history: Array.isArray(base.history) ? base.history.slice(0, 60) : [],
    daily,
    games: normalizeGameStats(base.games),
  };
}

/**
 * 台帳をこの瞬間の形にそろえる（ゲームの付与・残量計算が使う）。
 * @param {object} ledger
 * @param {number} now
 */
export function normalizeLedger(ledger, now = Date.now()) {
  return normalized(ledger, now);
}

function pushHistory(ledger, entry) {
  return [entry, ...ledger.history].slice(0, 60);
}

/** 理由つきで加算する */
export function addCoins(ledger, amount, reason, now, label = '') {
  const base = normalized(ledger, now);
  const value = Math.max(0, Math.round(Number(amount) || 0));
  if (!value) return base;
  return {
    ...base,
    balance: base.balance + value,
    history: pushHistory(base, { at: now, delta: value, reason, label }),
  };
}

/** お世話1回分（1日20枚まで） */
export function addCareCoin(ledger, now) {
  const base = normalized(ledger, now);
  if (base.daily.care >= CARE_COIN_DAILY_CAP) {
    return { ledger: base, granted: false, remaining: 0 };
  }
  const next = {
    ...base,
    balance: base.balance + COIN_RULES.care,
    daily: { ...base.daily, care: base.daily.care + 1 },
    history: pushHistory(base, { at: now, delta: COIN_RULES.care, reason: 'care', label: 'おせわ' }),
  };
  return { ledger: next, granted: true, remaining: CARE_COIN_DAILY_CAP - next.daily.care };
}

export function careCoinsRemaining(ledger, now) {
  const base = normalized(ledger, now);
  return CARE_COIN_DAILY_CAP - base.daily.care;
}

/** 購入（残高不足なら ok:false・台帳は変えない） */
export function spendCoins(ledger, amount, reason, now, label = '') {
  const base = normalized(ledger, now);
  const value = Math.max(0, Math.round(Number(amount) || 0));
  if (value > base.balance) {
    return { ok: false, ledger: base, shortfall: value - base.balance };
  }
  if (!value) return { ok: true, ledger: base, shortfall: 0 };
  return {
    ok: true,
    shortfall: 0,
    ledger: {
      ...base,
      balance: base.balance - value,
      history: pushHistory(base, { at: now, delta: -value, reason, label }),
    },
  };
}

export function recentHistory(ledger, limit = 8) {
  const base = Array.isArray(ledger?.history) ? ledger.history : [];
  return base.slice(0, limit);
}

/**
 * 履歴の各件に「その操作のあとの残高」を付けて返す（新しい順のまま）。
 * 古い履歴には balance が入っていないので、いまの残高から逆算する。
 */
export function historyWithBalances(ledger, limit = 20) {
  const history = Array.isArray(ledger?.history) ? ledger.history : [];
  const rows = history.slice(0, Math.max(0, limit));
  let balance = Math.max(0, Number(ledger?.balance) || 0);
  const out = [];
  for (const entry of rows) {
    out.push({ ...entry, balance });
    balance = Math.max(0, balance - (Number(entry.delta) || 0));
  }
  return out;
}
