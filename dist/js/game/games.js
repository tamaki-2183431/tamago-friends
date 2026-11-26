/**
 * ミニゲームの共通基盤（Phase 3-3 パスA）＝**純関数だけ**。
 * DOM / IndexedDB / Date.now() に依存しない（乱数と時刻は引数で受け取る）。
 *
 * ここに載っているもの:
 * - 成績 → コイン（`rewardFor`・報酬表は data/games.js の GAME_CONFIG）
 * - コインの日次上限30（ゲーム共通・`min(報酬, 30 - 当日獲得)`）
 * - 1プレイ1回の付与ガード（playId）
 * - 抽選（当選2%・対象は商品34点・重複は +10/+30 で**上限の外**）
 * - 神経衰弱の山札（所持ペット優先・不足は未発見種から）
 *
 * 残り4ゲーム（ごはんキャッチ・さがせ・リズム・ジャンプ）も、
 * 成績を数値にして `applyGameResult` に渡せば同じ報酬・上限・抽選に載る。
 */
import { SHOP_ITEMS } from '../../data/shop.js';
import { SPECIES } from '../../data/pets.js';
import {
  DUPLICATE_COINS,
  GAME_CONFIG,
  GAME_DAILY_CAP,
  LOTTERY_CHANCE,
  PLAY_ID_KEEP,
  RARE_PRICE_MIN,
  gameName,
} from '../../data/games.js';
import { addCoins, normalizeLedger } from './coins.js';

/* ------------------------------------------------------------ 報酬 */

/**
 * 成績に応じたコイン（日次上限はかけない素の報酬）。
 * 表は data/games.js の GAME_CONFIG[game].rewards（スコアが max 以下なら coins）。
 * @param {string} gameId
 * @param {number} score
 * @returns {number}
 */
export function rewardFor(gameId, score) {
  const rewards = GAME_CONFIG[gameId]?.rewards;
  if (!Array.isArray(rewards) || !rewards.length) return 0;
  const value = Math.max(0, Math.round(Number(score) || 0));
  for (const band of rewards) {
    if (value <= band.max) return Math.max(0, Math.round(Number(band.coins) || 0));
  }
  return Math.max(0, Math.round(Number(rewards[rewards.length - 1].coins) || 0));
}

/** レア区分（価格で決める。60/100=レア、20/40=通常） */
export function rarityFor(price) {
  const value = Number(price) || 0;
  return value >= RARE_PRICE_MIN ? 'rare' : 'normal';
}

/** 重複アイテムをコインに変えたときの額（通常10／レア30） */
export function duplicateCoinsFor(item) {
  if (!item) return 0;
  return DUPLICATE_COINS[rarityFor(item.price)] ?? 0;
}

/* ------------------------------------------------------------ 抽選 */

/**
 * 抽選の対象＝**価格 > 0 の全商品**（家具28点＋ぼうし6点＝34点）。
 * 初期家具（price 0）と、価格を持たない所持品（ごはんばち・ボール）は対象外。
 */
export const LOTTERY_ITEMS = Object.freeze(
  SHOP_ITEMS.filter((item) => typeof item.price === 'number' && item.price > 0)
);

/**
 * 抽選を1回ぶん引く（純関数・rng 注入）。
 * rng は 0以上1未満を返す関数。**1回目＝当選判定（2%）／2回目＝商品の選択**の順に使う。
 *
 * `lotteryChance` は**テスト用の入口**（省略時は data/games.js の LOTTERY_CHANCE＝本番 0.02）。
 * 本番の確率は data/games.js の1か所だけで持つ。
 *
 * @param {{rng?: () => number, inventory?: string[], lotteryChance?: number}} options
 * @returns {{hit:boolean, item:object|null, owned:boolean, coins:number}}
 */
export function drawLottery({ rng = Math.random, inventory = [], lotteryChance = LOTTERY_CHANCE } = {}) {
  const roll = Number(rng());
  if (!(roll < lotteryChance)) return { hit: false, item: null, owned: false, coins: 0 };
  const size = LOTTERY_ITEMS.length;
  const pick = Number(rng());
  const index = Math.min(size - 1, Math.max(0, Math.floor((Number.isFinite(pick) ? pick : 0) * size)));
  const item = LOTTERY_ITEMS[index];
  const owned = Array.isArray(inventory) && inventory.includes(item.id);
  return { hit: true, item, owned, coins: owned ? duplicateCoinsFor(item) : 0 };
}

/* ------------------------------------------------------------ パーフェクト（v32） */

/**
 * パーフェクト＝**1プレイ中に不一致（ミス）が0回**で、**全ペアをそろえて**終わった。
 * 時間切れでそろっていない場合は対象外（`score` が全ペアに届かないため自然に外れる）。
 * 判定はここ1か所だけ（画面は結果をそのまま出す）。
 *
 * @param {string} gameId
 * @param {{score?:number, misses?:number}} input
 * @returns {boolean}
 */
export function isPerfectClear(gameId, { score, misses } = {}) {
  const pairs = Math.max(0, Math.round(Number(GAME_CONFIG[gameId]?.pairs) || 0));
  if (pairs <= 0) return false;
  const value = Math.max(0, Math.round(Number(score) || 0));
  const missCount = Number(misses);
  return value >= pairs && Number.isFinite(missCount) && missCount === 0;
}

/* ------------------------------------------------------------ 付与（上限・二重付与） */

/** その playId がもう付与済みか */
export function playAlreadyGranted(ledger, playId) {
  if (typeof playId !== 'string' || !playId) return false;
  const ids = Array.isArray(ledger?.games?.playIds) ? ledger.games.playIds : [];
  return ids.includes(playId);
}

/** 今日あと何コインもらえるか（ゲーム共通の上限30） */
export function gameCoinsRemaining(ledger, now = Date.now()) {
  const base = normalizeLedger(ledger, now);
  return Math.max(0, GAME_DAILY_CAP - (base.daily.game || 0));
}

/**
 * 1プレイぶんの結果を台帳に反映する。
 * - 付与は `min(報酬, 30 - 当日獲得)`。上限に当たったら `capped:true`（コインは増えない）
 * - **同じ playId は1回だけ**（結果画面の再表示・リロードで二重に付与しない）
 * - 抽選の重複変換（+10/+30）は日次上限の**外**（daily.game を増やさない）
 *
 * - `perfect` は「ミス0で全ペア」のときだけ true（v32）。台帳の `games.perfectCount` を1増やす
 *   （**コインは増やさない**＝経済は変えない）
 *
 * @param {object} ledger コイン台帳
 * @param {{gameId:string, score:number, playId:string, now?:number, lottery?:object|null, perfect?:boolean}} input
 * @returns {{ledger:object, duplicate:boolean, result:object|null}}
 */
export function applyGameResult(ledger, { gameId, score, playId, now = Date.now(), lottery = null, perfect = false } = {}) {
  const base = normalizeLedger(ledger, now);
  const id = typeof playId === 'string' && playId ? playId : null;
  if (id && playAlreadyGranted(base, id)) {
    return { ledger: base, duplicate: true, result: base.games.lastResult ?? null };
  }

  const value = Math.max(0, Math.round(Number(score) || 0));
  const baseCoins = rewardFor(gameId, value);
  const remaining = Math.max(0, GAME_DAILY_CAP - (base.daily.game || 0));
  const coins = Math.min(baseCoins, remaining);
  const capped = coins < baseCoins;

  let next = coins > 0
    ? addCoins(base, coins, 'game', now, `ゲーム: ${gameName(gameId)}`)
    : base;
  next = { ...next, daily: { ...next.daily, game: (next.daily.game || 0) + coins } };

  // パーフェクトは「全ペアをそろえた」ときだけ成立させる（時間切れ・未コンプリートは対象外）
  const pairs = Math.max(0, Math.round(Number(GAME_CONFIG[gameId]?.pairs) || 0));
  const isPerfect = perfect === true && pairs > 0 && value >= pairs;

  const prize = lottery && lottery.hit && lottery.item ? lottery : null;
  const duplicateCoins = prize && prize.owned ? Math.max(0, Math.round(Number(prize.coins) || 0)) : 0;
  // 重複の変換は上限の外（daily.game に足さない）
  if (duplicateCoins > 0) next = addCoins(next, duplicateCoins, 'gameItem', now, `かぶり: ${prize.item.name}`);

  const result = {
    playId: id,
    gameId,
    score: value,
    base: baseCoins,
    coins,
    capped,
    remainingToday: Math.max(0, GAME_DAILY_CAP - (next.daily.game || 0)),
    perfect: isPerfect,
    perfectCount: isPerfect ? next.games.perfectCount + 1 : next.games.perfectCount,
    at: now,
    lottery: prize
      ? { itemId: prize.item.id, name: prize.item.name, owned: prize.owned, coins: duplicateCoins }
      : null,
  };

  next = {
    ...next,
    games: {
      ...next.games,
      playCount: next.games.playCount + 1,
      bestByGame: {
        ...next.games.bestByGame,
        [gameId]: Math.max(Number(next.games.bestByGame[gameId]) || 0, value),
      },
      lastPlayedAt: now,
      playIds: id ? [id, ...next.games.playIds].slice(0, PLAY_ID_KEEP) : next.games.playIds,
      perfectCount: result.perfectCount,
      lastResult: result,
    },
  };

  return { ledger: next, duplicate: false, result };
}

/* ------------------------------------------------------------ 神経衰弱の山札 */

function shuffle(list, rng) {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const roll = Number(rng());
    const ratio = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
    const swap = Math.floor(ratio * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/**
 * 神経衰弱の山札（12枚＝6種×2・シャッフル済み）。
 * **所持しているペットの種を優先**し、6種に満たない分だけ未発見の種からランダムに足す。
 * 同じ種を2組にはしない（種の重複なし）。
 *
 * @param {{ownedSpecies?: string[], rng?: () => number, pairs?: number}} options
 * @returns {Array<{key:string, speciesId:string}>}
 */
export function buildMemoryDeck({ ownedSpecies = [], rng = Math.random, pairs = GAME_CONFIG.memory.pairs } = {}) {
  const all = SPECIES.map((species) => species.id);
  const known = new Set(all);
  const count = Math.max(1, Math.round(Number(pairs) || GAME_CONFIG.memory.pairs));
  const chosen = [];
  for (const speciesId of ownedSpecies ?? []) {
    if (chosen.length >= count) break;
    if (!known.has(speciesId) || chosen.includes(speciesId)) continue;
    chosen.push(speciesId);
  }
  const rest = shuffle(all.filter((id) => !chosen.includes(id)), rng);
  while (chosen.length < count && rest.length) chosen.push(rest.shift());
  // 全種を持っていて足りない場合の保険（20種 > 6 なので通常は通らない）
  if (chosen.length < count) {
    for (const id of shuffle(all, rng)) {
      if (chosen.length >= count) break;
      if (!chosen.includes(id)) chosen.push(id);
    }
  }

  const cards = [];
  for (const speciesId of chosen) {
    cards.push({ key: `${speciesId}#1`, speciesId });
    cards.push({ key: `${speciesId}#2`, speciesId });
  }
  return shuffle(cards, rng);
}

/** 2枚が同じ種の別カードか（一致判定） */
export function memoryCardsMatch(a, b) {
  if (!a || !b) return false;
  if (a.key === b.key) return false;
  return a.speciesId === b.speciesId;
}

/** 状態から山札を引く前の「所持している種」をまとめる（重複なし・出現順） */
export function ownedSpeciesOf(pets = []) {
  const out = [];
  for (const pet of pets) {
    const speciesId = pet?.speciesId;
    if (!speciesId || out.includes(speciesId)) continue;
    out.push(speciesId);
  }
  return out;
}
