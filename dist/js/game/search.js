/**
 * ペットをさがせ！（v38）の**純関数エンジン**。
 * DOM / IndexedDB / Date.now() に依存しない（乱数と時刻は引数で受け取る）。
 *
 * ここに載っているもの:
 * - 出てくるペットを組む（所持している子を優先・足りない分は未出演の種から）
 * - さがす子（3匹）の抽選
 * - 歩き回り（左右に歩いて立ち止まる・端で折り返す）
 * - **家具の後ろ＝半透明**（家具の矩形と重なっているかを毎フレーム判定する）
 * - タップの判定（指定の子＝発見＋1／ちがう子＝penaltyMs のあいだ操作不可）
 * - 3匹みつけたら達成で終了・40秒で時間切れ
 *
 * 報酬・日次上限・抽選・二重付与は既存の `js/game/games.js`（applyGameResult）と
 * `childStore.finishGame` をそのまま通す。このファイルは「成績を数値にする」まで。
 *
 * 座標はフィールドの px（左上が 0,0）。家具の矩形も px で受け取る（画面が測って渡す）。
 */

import { SPECIES } from '../../data/pets.js';

/** 0以上1未満の乱数に丸める（rng が壊れていても落ちない） */
function unit(rng) {
  const value = Number(typeof rng === 'function' ? rng() : rng);
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

/** min〜max（両端を含む）の整数 */
function intBetween(min, max, rng) {
  const lo = Math.max(0, Math.round(Number(min) || 0));
  const hi = Math.max(lo, Math.round(Number(max) || lo));
  return lo + Math.floor(unit(rng) * (hi - lo + 1));
}

/**
 * 1プレイに出てくるペットの数（petMin〜petMax）。
 * @param {object} config GAME_CONFIG.search
 * @param {() => number} rng
 */
export function searchPetCount(config, rng = Math.random) {
  return intBetween(config?.petMin ?? 5, config?.petMax ?? 8, rng);
}

/**
 * 出てくるペットを組む。
 * **所持している子を優先**して入れ、足りない分はまだ出ていない種から足す（種は重複しない）。
 * 名前は所持している子なら その子の名前、それ以外は種の名前。
 *
 * @param {{owned?: Array<object>, count?: number, rng?: () => number}} options
 * @returns {Array<{id:string, name:string, speciesId:string, stage:string, owned:boolean}>}
 */
export function buildSearchPets({ owned = [], count = 6, rng = Math.random } = {}) {
  const want = Math.max(1, Math.round(Number(count) || 1));
  const out = [];
  const usedSpecies = new Set();

  for (const pet of Array.isArray(owned) ? owned : []) {
    if (out.length >= want) break;
    const speciesId = pet?.speciesId;
    if (!speciesId || usedSpecies.has(speciesId)) continue;
    usedSpecies.add(speciesId);
    out.push({
      id: String(pet.id ?? `owned-${speciesId}`),
      name: String(pet.name ?? speciesId),
      speciesId,
      stage: pet.stage ?? 'child',
      owned: true,
    });
  }

  // 足りない分は未出演の種から（順番はシャッフルして毎回ちがう顔ぶれにする）
  const rest = SPECIES.filter((species) => !usedSpecies.has(species.id));
  for (let index = rest.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(unit(rng) * (index + 1));
    [rest[index], rest[swap]] = [rest[swap], rest[index]];
  }
  for (const species of rest) {
    if (out.length >= want) break;
    out.push({
      id: `wild-${species.id}`,
      name: species.name,
      speciesId: species.id,
      stage: 'child',
      owned: false,
    });
  }
  return out;
}

/**
 * さがす子（targetCount 匹）を選ぶ。**重複なし**・出てくる順はランダム。
 * @param {Array<object>} pets buildSearchPets の結果
 * @param {number} targetCount
 * @param {() => number} rng
 * @returns {string[]} ペットID（見つける順）
 */
export function pickSearchTargets(pets, targetCount, rng = Math.random) {
  const ids = (Array.isArray(pets) ? pets : []).map((pet) => pet.id);
  const want = Math.min(ids.length, Math.max(0, Math.round(Number(targetCount) || 0)));
  // 部分シャッフル（先頭 want 件だけ決めればよい）
  for (let index = 0; index < want; index += 1) {
    const swap = index + Math.floor(unit(rng) * (ids.length - index));
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  return ids.slice(0, want);
}

/** ペットの矩形（左上と大きさ）。x/y は左上 */
export function petBox(pet) {
  return {
    left: Number(pet?.x) || 0,
    top: Number(pet?.y) || 0,
    right: (Number(pet?.x) || 0) + (Number(pet?.w) || 0),
    bottom: (Number(pet?.y) || 0) + (Number(pet?.h) || 0),
  };
}

/**
 * そのペットが家具の後ろにいるか（矩形が重なっているか）。
 * 家具は `hide:false` で「隠さない飾り」にできる（壁掛けなど）。
 * @param {object} pet
 * @param {Array<{left:number,right:number,top?:number,bottom?:number,hide?:boolean}>} furniture
 */
export function isBehindFurniture(pet, furniture = []) {
  const box = petBox(pet);
  return (Array.isArray(furniture) ? furniture : []).some((item) => {
    if (!item || item.hide === false) return false;
    const left = Number(item.left);
    const right = Number(item.right);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return false;
    if (box.right <= left || box.left >= right) return false;
    // 上下も指定されていれば見る（既定は床の同じ帯に立っている）
    const top = Number(item.top);
    const bottom = Number(item.bottom);
    if (Number.isFinite(top) && Number.isFinite(bottom)) {
      if (box.bottom <= top || box.top >= bottom) return false;
    }
    return true;
  });
}

/**
 * 1プレイぶんの「さがせ」を始める。
 * @param {{config:object, width:number, height:number, pets:Array<object>, furniture?:Array<object>, rng?:()=>number, now?:number}} input
 *   pets は buildSearchPets の結果（id/name/speciesId/stage）。furniture は px の矩形。
 */
export function createSearchRun({
  config,
  width,
  height,
  pets = [],
  furniture = [],
  rng = Math.random,
  now = 0,
} = {}) {
  const startedAt = Number(now) || 0;
  const fieldWidth = Math.max(1, Number(width) || 1);
  const fieldHeight = Math.max(1, Number(height) || 1);
  const size = Math.max(32, Number(config?.petPx) || 44);
  const margin = Math.max(0, Number(config?.marginPx) || 0);
  const list = (Array.isArray(pets) ? pets : []).slice();
  const count = Math.max(1, list.length);
  const usable = Math.max(0, fieldWidth - size - margin * 2);
  /** 足元はフィールドの下から少し上（家具と同じ床のライン）。5匹以上は前後の2列に分かれる */
  const laneCount = count > 4 ? 2 : 1;
  const laneGap = 28;
  const floorInset = Math.max(0, Number(config?.floorInsetPx) || 0);
  const baseY = fieldHeight - size - floorInset;

  const actors = list.map((pet, index) => {
    const lane = index % laneCount;
    const sameLane = list.filter((_, row) => row % laneCount === lane).length;
    const order = Math.floor(index / laneCount);
    const slot = sameLane > 1 ? usable / (sameLane - 1) : usable / 2;
    const spread = sameLane > 1 ? (order / (sameLane - 1)) * usable : usable / 2;
    const jitter = (unit(rng) - 0.5) * Math.min(24, slot * 0.5);
    const x = Math.min(usable + margin, Math.max(margin, margin + spread + jitter));
    const y = baseY - lane * laneGap;
    const speed = intBetween(config?.speedMinPxPerSec ?? 16, config?.speedMaxPxPerSec ?? 30, rng);
    return {
      id: pet.id,
      name: pet.name,
      speciesId: pet.speciesId,
      stage: pet.stage ?? 'child',
      owned: pet.owned === true,
      x,
      y,
      lane,
      w: size,
      h: size,
      dir: unit(rng) < 0.5 ? -1 : 1,
      speed,
      pauseUntil: startedAt + Math.round(unit(rng) * 900),
      walkUntil: startedAt + 1200 + Math.round(unit(rng) * 1400),
      hidden: false,
    };
  });

  for (const actor of actors) actor.hidden = isBehindFurniture(actor, furniture);

  // 隠れ方が伝わるように、**最初から家具の後ろにいる子を1匹**つくる
  if (furniture.length && !actors.some((actor) => actor.hidden)) {
    const cover = [...furniture]
      .filter((item) => item && item.hide !== false)
      .sort((a, b) => (Number(b.right) - Number(b.left)) - (Number(a.right) - Number(a.left)))[0];
    const victim = actors[actors.length - 1];
    if (cover && victim) {
      const left = Number(cover.left) || 0;
      const right = Number(cover.right) || left + size;
      victim.x = Math.min(usable + margin, Math.max(margin, (left + right) / 2 - size / 2));
      victim.hidden = isBehindFurniture(victim, furniture);
    }
  }

  // 全員が家具の後ろだと「探す」遊びにならないので、1匹は開いている所へ移す
  if (furniture.length && actors.length && actors.every((actor) => actor.hidden)) {
    const first = actors[0];
    for (let x = margin; x <= usable + margin; x += 4) {
      if (!isBehindFurniture({ ...first, x }, furniture)) {
        first.x = x;
        first.hidden = false;
        break;
      }
    }
  }

  const targets = pickSearchTargets(actors, config?.targetCount ?? 3, rng);
  return {
    config,
    width: fieldWidth,
    height: fieldHeight,
    rng,
    startedAt,
    endsAt: startedAt + (Number(config?.seconds) || 40) * 1000,
    lastAt: startedAt,
    pets: actors,
    furniture: Array.isArray(furniture) ? furniture : [],
    targets,
    targetIndex: 0,
    found: 0,
    wrong: 0,
    penaltyUntil: 0,
    ended: false,
  };
}

/** いま さがしている子（全員みつけたら null） */
export function currentSearchTarget(run) {
  if (!run) return null;
  const id = run.targets?.[run.targetIndex];
  if (!id) return null;
  return run.pets.find((pet) => pet.id === id) ?? null;
}

/** スコア＝みつけた数 */
export function searchScore(run) {
  return Math.max(0, Math.round(Number(run?.found) || 0));
}

/**
 * さがせを dt ぶん進める（歩く・隠れ判定・時間切れ）。
 * イベント: {type:'end', reason:'time'|'clear'}
 * @returns {Array<object>}
 */
export function stepSearch(run, now) {
  const events = [];
  if (!run || run.ended) return events;
  const at = Number(now) || 0;
  if (at >= run.endsAt) {
    run.ended = true;
    return [{ type: 'end', reason: 'time' }];
  }
  // 長い停止（タブ復帰など）で瞬間移動しないよう dt を上限で切る
  const dt = Math.min(0.1, Math.max(0, (at - run.lastAt) / 1000));
  run.lastAt = at;
  const config = run.config ?? {};
  const margin = Math.max(0, Number(config.marginPx) || 0);
  const minX = margin;
  const maxX = Math.max(minX, run.width - (run.pets[0]?.w ?? 44) - margin);

  for (const pet of run.pets) {
    if (at < pet.pauseUntil) continue;
    if (at >= pet.walkUntil) {
      // 立ち止まる → しばらくして歩き出す（向きは半分の確率で変える）
      const pause = intBetween(config.pauseMsMin ?? 500, config.pauseMsMax ?? 1600, run.rng);
      pet.pauseUntil = at + pause;
      pet.walkUntil = pet.pauseUntil + 900 + intBetween(400, 1800, run.rng);
      if (unit(run.rng) < 0.5) pet.dir *= -1;
      continue;
    }
    pet.x += pet.dir * pet.speed * dt;
    if (pet.x <= minX) {
      pet.x = minX;
      pet.dir = 1;
    } else if (pet.x >= maxX) {
      pet.x = maxX;
      pet.dir = -1;
    }
    pet.hidden = isBehindFurniture(pet, run.furniture);
  }
  return events;
}

/**
 * タップ。
 * - さがしている子 → 発見＋1・次の指定へ。3匹で `ended:true`（達成）
 * - ちがう子 → 操作できない時間を `penaltyMs` ぶん作る（`penalty:true`）
 * - ペナルティ中・終了後・時間切れ → `ok:false`
 *
 * @returns {{ok:boolean, hit?:boolean, found?:number, ended?:boolean, penalty?:boolean, reason?:string}}
 */
export function tapSearch(run, petId, now = 0) {
  if (!run || run.ended) return { ok: false, reason: 'ended' };
  const at = Number(now) || 0;
  if (at >= run.endsAt) return { ok: false, reason: 'ended' };
  if (at < (Number(run.penaltyUntil) || 0)) return { ok: false, reason: 'penalty' };
  const pet = run.pets.find((entry) => entry.id === petId);
  if (!pet) return { ok: false, reason: 'unknown' };

  if (petId !== run.targets[run.targetIndex]) {
    run.wrong += 1;
    // 秒ではなく ms で持つ（0.8秒＝800ms）。「その場で操作できない」時間
    run.penaltyUntil = at + Math.max(0, Number(run.config?.penaltyMs) || 800);
    return { ok: true, hit: false, penalty: true, found: run.found, penaltyUntil: run.penaltyUntil };
  }

  run.found += 1;
  run.targetIndex += 1;
  const cleared = run.found >= (Number(run.config?.targetCount) || 3);
  if (cleared) run.ended = true;
  return { ok: true, hit: true, found: run.found, ended: cleared };
}

/** ペナルティ中か（画面の「操作できない」表示に使う） */
export function searchLocked(run, now = 0) {
  if (!run) return false;
  return Number(now) < (Number(run.penaltyUntil) || 0);
}
