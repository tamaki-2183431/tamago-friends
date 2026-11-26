/**
 * ペットルームの純関数（DOM・DB 非依存）。
 * 位置はセル座標（float）。1セル = data/room.js の TILE px。
 */

import {
  EXPAND_AFTER,
  EXPAND_BY,
  FLOOR_ROW,
  FURNITURE,
  PERIODS,
  ROOM_ROWS,
  SCREEN_COLS,
  WEATHERS,
} from '../../data/room.js';

/** ペット数から部屋の画面数（横12マス × 画面数）を求める */
export function roomScreensFor(petCount) {
  const count = Math.max(0, Number(petCount) || 0);
  if (count <= EXPAND_AFTER) return 1;
  return 1 + Math.ceil((count - EXPAND_AFTER) / EXPAND_BY);
}

export function roomColsFor(petCount) {
  return SCREEN_COLS * roomScreensFor(petCount);
}

/** 天気をランダムに選ぶ（重み付き） */
export function pickWeather(rng = Math.random) {
  const total = WEATHERS.reduce((sum, weather) => sum + weather.weight, 0);
  let ticket = rng() * total;
  for (const weather of WEATHERS) {
    ticket -= weather.weight;
    if (ticket <= 0) return weather.id;
  }
  return WEATHERS[0].id;
}

/** 実時刻 → 時間帯（4時・10時・16時・19時で切り替え） */
export function periodFor(now = Date.now()) {
  const hour = new Date(now).getHours();
  let current = PERIODS[PERIODS.length - 1].id; // 19時以降は夜
  for (const period of PERIODS) {
    if (hour >= period.from) current = period.id;
  }
  if (hour < PERIODS[0].from) current = 'night';
  return current;
}

/** 性格（tempo は小さいほど活発）→ 1秒あたりの移動セル数 */
export function speedFor(tempo = 1) {
  const scale = Math.min(2, Math.max(0.5, Number(tempo) || 1));
  return 1.15 / scale;
}

/** 次の行動までの待ち時間（ms）。tempo が小さいほど短い */
export function behaviourDelay(tempo = 1, rng = Math.random) {
  const scale = Math.min(2, Math.max(0.5, Number(tempo) || 1));
  return Math.round((900 + rng() * 1500) * scale);
}

/** 部屋の初期状態 */
export function createRoomState({ petCount = 0, rng = Math.random, now = Date.now(), tutorialDone = false } = {}) {
  return {
    id: 'room',
    screens: roomScreensFor(petCount),
    weather: pickWeather(rng),
    tutorialDone: Boolean(tutorialDone),
    furniture: FURNITURE.map((item) => ({ ...item })),
    pickedAt: now,
    updatedAt: new Date(now).toISOString(),
  };
}

/** 家具の占有セル（重なり判定用） */
export function furnitureCells(furniture = FURNITURE) {
  const cells = [];
  for (const item of furniture) {
    cells.push({ x: item.col, y: item.row, w: item.w ?? 1, h: item.h ?? 1, id: item.id, kind: item.kind });
  }
  return cells;
}

/** そのセルが家具の中か（余白 0.15 セルぶん広めに取る） */
export function insideFurniture(x, y, furniture = FURNITURE) {
  return furniture.some((item) => {
    // じゅうたんは敷いてあるだけで、ペットは上を歩ける
    if (item.layer === 'rug') return false;
    const w = item.w ?? 1;
    const h = item.h ?? 1;
    return (
      x > item.col - 0.15 &&
      x < item.col + w + 0.15 &&
      y > item.row - 0.15 &&
      y < item.row + h + 0.15
    );
  });
}

/** ペットの絵（44px＝1マス）の半分＋余白。画面のふちで見切れないようにする */
export const EDGE_MARGIN = 0.62;

/**
 * 端末ピクセルに合わせて丸める（v19）。
 * ペットの位置は float なので、そのまま transform に書くと半端な座標で合成される。
 * ブラウザは合成レイヤーを端末ピクセルにスナップしないことがあり、その場合は
 * ドット絵が補間されて色が濁る（＝「グレーがかった子」）。
 * 位置そのもの（ゲージ・当たり判定）は変えず、描画のときだけ丸める。
 * @param {number} value px
 * @param {number} dpr devicePixelRatio（1未満・NaN は 1 とみなす）
 */
export function snapToDevicePixel(value, dpr = 1) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const px = Number(value);
  if (!Number.isFinite(px)) return 0;
  return Math.round(px * ratio) / ratio;
}

/** 部屋の外に出ない範囲に丸める */
/** 歩けるのは床（3行目以降）だけ。壁（0〜2行目）には立てない */
export const FLOOR_MIN_Y = FLOOR_ROW + 0.05;
export const FLOOR_MAX_Y = ROOM_ROWS - 0.55;

export function clampToRoom(x, y, cols) {
  return {
    x: Math.min(cols - EDGE_MARGIN, Math.max(EDGE_MARGIN, x)),
    y: Math.min(FLOOR_MAX_Y, Math.max(FLOOR_MIN_Y, y)),
  };
}

/**
 * ペットごとの歩行帯（部屋の高さを3つに分けて散らす）。
 * 全員が同じ高さに集まると「部屋の下が空いて見える」ので、初期配置の帯を分ける。
 */
export function bandFor(index, rows = ROOM_ROWS) {
  const bands = 3;
  const slot = ((Number(index) || 0) % bands + bands) % bands;
  const top = FLOOR_MIN_Y;
  const bottom = Math.min(rows - 0.55, FLOOR_MAX_Y);
  const span = (bottom - top) / bands;
  const minY = top + slot * span;
  return { minY, maxY: Math.min(bottom, minY + span) };
}

/** 立っていられるセルか */
export function isFreeCell(x, y, cols, furniture = FURNITURE) {
  if (x < 0.55 || x > cols - 0.55) return false;
  if (y < FLOOR_MIN_Y || y > ROOM_ROWS - 0.5) return false;
  return !insideFurniture(x, y, furniture);
}

/** 空いているセルを探す（見つからなければ現在地） */
export function findFreeCell(cols, rng = Math.random, furniture = FURNITURE, tries = 24, range = null) {
  const minX = Math.max(0.6, range?.minX ?? 0.6);
  const maxX = Math.min(cols - 0.6, range?.maxX ?? cols - 0.6);
  const span = Math.max(0.6, maxX - minX);
  // 歩けるのは床（3行目以降）。帯が指定されていればその中
  const minY = Math.max(FLOOR_MIN_Y, range?.minY ?? FLOOR_MIN_Y);
  const maxY = Math.min(FLOOR_MAX_Y, range?.maxY ?? FLOOR_MAX_Y);
  const spanY = Math.max(0.4, maxY - minY);
  for (let index = 0; index < tries; index += 1) {
    const x = minX + rng() * span;
    const y = minY + rng() * spanY;
    if (isFreeCell(x, y, cols, furniture)) return { x, y };
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** 部屋に出すペット（アクター）を作る */
export function createActor(pet, index, cols, rng = Math.random, spawnCols = SCREEN_COLS, band = null) {
  const walkBand = band ?? bandFor(index);
  const spot = findFreeCell(Math.min(cols, spawnCols), rng, FURNITURE, 24, walkBand);
  return {
    id: pet.id,
    name: pet.name,
    speciesId: pet.speciesId ?? pet.species,
    stage: pet.stage ?? 'child',
    personality: pet.traits?.personality ?? pet.personality ?? 'bright',
    tempo: pet.traits?.tempo ?? 1,
    x: spot.x,
    y: index === 0 ? spot.y : spot.y,
    target: null,
    // ねる じかん（22:00〜06:59）に作った子は、最初のフレームから寝ている
    state: pet.sleeping === true ? 'sleep' : 'idle',
    until: 0,
    facing: rng() < 0.5 ? 1 : -1,
    furnitureId: null,
    expression: pet.sleeping === true ? 'sleep' : 'normal',
    chattingWith: null,
    band: walkBand,
    // 就寝中は**位置も状態も変えない**（歩行・家具・交流のループから外す）
    sleeping: pet.sleeping === true,
  };
}

/** ダブルタップで集まる範囲（チェビシェフ距離・マス） */
export const GATHER_RADIUS = 2;
/** 一度に集まる上限（匹） */
export const GATHER_LIMIT = 5;
/** ダブルタップとみなす間隔（ms） */
export const DOUBLE_TAP_MS = 400;

/**
 * 床のダブルタップで「近くの子」をタップ地点の周囲1マスへ集める計画（純関数）。
 * - 対象は タップ地点から半径 radius（チェビシェフ距離）以内の子だけ。近い順に最大 limit 匹
 * - 行き先は タップ地点の**周囲1マス（8マス）**のうち、歩けるマス（床・家具の上でない）
 * - 同じマスに2匹は行かせない（重ならない）／行き先が無ければその子は来ない
 * - 先に別の子が立っているマスは使わない（重ならない）
 * - **ゲージ・コイン・なつき度・保存データには一切触らない**（計画を返すだけ）
 * @returns {{movers:Array<{id:string,target:{x:number,y:number,kind:'gather'}}>, freeSlots:number}}
 */
export function gatherPlan({
  actors = [],
  cell,
  cols = SCREEN_COLS,
  furniture = FURNITURE,
  radius = GATHER_RADIUS,
  limit = GATHER_LIMIT,
} = {}) {
  // タップはマスの中心に落ちるので、そのマスは **切り捨て** で決める（6.5 → 6）
  const cx = Math.floor(Number(cell?.x) || 0);
  const cy = Math.floor(Number(cell?.y) || 0);
  const chebyshev = (actor) => Math.max(Math.abs(actor.x - cx), Math.abs(actor.y - cy));

  const candidates = actors
    .filter((actor) => actor && actor.sleeping !== true && chebyshev(actor) <= radius + 0.0001)
    .map((actor) => ({ actor, d: chebyshev(actor), e: Math.hypot(actor.x - cx, actor.y - cy) }))
    .sort((a, b) => a.d - b.d || a.e - b.e || String(a.actor.id).localeCompare(String(b.actor.id)));

  // 周囲1マスを「上から時計回り」の決まった順にする（乱数を使わない＝テストで固定できる）
  const ring = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      ring.push({ x: cx + dx, y: cy + dy, angle: Math.atan2(dx, -dy) });
    }
  }
  ring.sort((a, b) => a.angle - b.angle || a.y - b.y || a.x - b.x);

  const movingIds = new Set(candidates.map((row) => row.actor.id));
  const occupied = (slot) =>
    actors.some((actor) => !movingIds.has(actor.id) && Math.hypot(actor.x - slot.x, actor.y - slot.y) < 0.6);
  const slots = ring.filter(
    (slot) => isFreeCell(slot.x, slot.y, cols, furniture) && !occupied(slot)
  );

  const movers = [];
  for (const row of candidates) {
    if (movers.length >= limit) break;
    const slot = slots.shift();
    if (!slot) break;
    movers.push({ id: row.actor.id, target: { x: slot.x, y: slot.y, kind: 'gather' } });
  }
  return { movers, freeSlots: slots.length };
}

/** 家具のそば（使える位置）を返す */
export function spotNearFurniture(item, cols, rng = Math.random) {
  const candidates = [
    { x: item.col + (item.w ?? 1) / 2, y: item.row + (item.h ?? 1) + 0.45 },
    { x: item.col - 0.45, y: item.row + (item.h ?? 1) / 2 },
    { x: item.col + (item.w ?? 1) + 0.45, y: item.row + (item.h ?? 1) / 2 },
    { x: item.col + (item.w ?? 1) / 2, y: item.row - 0.45 },
  ].filter((spot) => isFreeCell(spot.x, spot.y, cols));

  if (!candidates.length) return null;
  return candidates[Math.floor(rng() * candidates.length) % candidates.length];
}

/**
 * 次の行動を決める。
 * @returns {{state:string, target:object|null, until:number, furnitureId:string|null, expression:string}}
 */
export function nextBehaviour(actor, { cols, now, rng = Math.random, furniture = FURNITURE, view = null }) {
  const roll = rng();
  const tempo = actor.tempo ?? 1;

  // ねる
  if (roll < 0.12) {
    return { state: 'sleep', target: null, until: now + 4000 + rng() * 5000, furnitureId: null, expression: 'sleepy' };
  }
  // 家具を使う
  if (roll < 0.42) {
    const item = furniture[Math.floor(rng() * furniture.length) % furniture.length];
    const spot = item ? spotNearFurniture(item, cols, rng) : null;
    if (spot) {
      return {
        state: 'walk',
        target: { ...spot, kind: 'furniture', furnitureId: item.id, itemKind: item.kind },
        until: 0,
        furnitureId: item.id,
        expression: 'normal',
      };
    }
  }
  // あそぶ（その場でぴょこぴょこ）
  if (roll < 0.58) {
    return { state: 'play', target: null, until: now + 1400 + rng() * 1600, furnitureId: null, expression: 'happy' };
  }
  // ぶらぶら歩く
  if (roll < 0.9) {
    const range = {
      minX: view?.minX,
      maxX: view?.maxX,
      minY: actor.band?.minY ?? view?.minY,
      maxY: actor.band?.maxY ?? view?.maxY,
    };
    const spot = findFreeCell(cols, rng, furniture, 24, range);
    return { state: 'walk', target: { ...spot, kind: 'idle' }, until: 0, furnitureId: null, expression: 'normal' };
  }
  // ぼーっとする
  return { state: 'idle', target: null, until: now + behaviourDelay(tempo, rng), furnitureId: null, expression: 'normal' };
}

/** 1フレーム進める（歩行・到着・状態の切り替え）。actor を直接更新して返す */
export function advanceActor(actor, dtMs, ctx) {
  const { cols, now, rng = Math.random, furniture = FURNITURE } = ctx;
  const dt = Math.min(0.1, Math.max(0, dtMs / 1000));

  // 就寝中（v25）: 歩かない・家具を使わない・交流しない・位置も動かさない。
  // 起床は applyNightRest 側（ペットの sleeping）で決まるので、ここでは状態を寝姿に固定するだけ。
  if (actor.sleeping) {
    actor.state = 'sleep';
    actor.expression = 'sleep';
    actor.target = null;
    actor.furnitureId = null;
    actor.pendingGreet = null;
    actor.chattingWith = null;
    actor.walkStartedAt = 0;
    return actor;
  }

  if (actor.state === 'walk' && actor.target) {
    const speed = speedFor(actor.tempo);
    const dx = actor.target.x - actor.x;
    const dy = actor.target.y - actor.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.06) {
      actor.x = actor.target.x;
      actor.y = actor.target.y;
      actor.state = actor.target.kind === 'furniture' ? 'use' : 'idle';
      actor.walkStartedAt = 0;
      actor.until = now + (actor.target.kind === 'furniture' ? 2600 + rng() * 2200 : behaviorIdle(tempoSafe(actor.tempo), rng));
      actor.expression = actor.target.kind === 'furniture' ? furnitureExpression(actor.target.itemKind) : 'normal';
      if (actor.target.kind !== 'furniture') actor.furnitureId = null;
      actor.target = null;
    } else {
      if (!actor.walkStartedAt) actor.walkStartedAt = now;
      // 8秒たっても着けない（家具に阻まれている）ときは目標をあきらめる
      if (now - actor.walkStartedAt > 8000) {
        // たどり着けなくても、タップした子どうしの ふれあいは成立させる
        // （pendingGreet は残す＝次のフレームで resolveGreet が走る）
        actor.state = 'idle';
        actor.target = null;
        actor.walkStartedAt = 0;
        actor.until = now + 600 + rng() * 700;
        return actor;
      }
      const step = Math.min(distance, speed * dt);
      const stepX = (dx / distance) * step;
      const stepY = (dy / distance) * step;
      // 家具の中には入らない（入りそうなら片軸だけ進んで回り込む）
      if (!insideFurniture(actor.x + stepX, actor.y + stepY, furniture)) {
        actor.x += stepX;
        actor.y += stepY;
      } else if (!insideFurniture(actor.x + stepX, actor.y, furniture)) {
        actor.x += stepX;
      } else if (!insideFurniture(actor.x, actor.y + stepY, furniture)) {
        actor.y += stepY;
      } else {
        actor.state = 'idle';
        actor.target = null;
        actor.walkStartedAt = 0;
        actor.until = now + 500;
        return actor;
      }
      if (Math.abs(dx) > 0.02) actor.facing = dx > 0 ? 1 : -1;
      const clamped = clampToRoom(actor.x, actor.y, cols);
      actor.x = clamped.x;
      actor.y = clamped.y;
    }
    return actor;
  }

  if (actor.state === 'chat') {
    if (now >= actor.until) {
      actor.state = 'idle';
      actor.expression = 'normal';
      actor.chattingWith = null;
      actor.until = now + 400 + rng() * 600;
    }
    return actor;
  }

  if (now >= (actor.until ?? 0)) {
    const next = nextBehaviour(actor, { cols, now, rng, furniture, view: ctx.view });
    actor.state = next.state;
    actor.target = next.target;
    actor.until = next.until;
    actor.furnitureId = next.furnitureId;
    actor.expression = next.expression;
    if (next.state !== 'walk') actor.target = null;
  }
  return actor;
}

function tempoSafe(tempo) {
  return Number(tempo) || 1;
}

function behaviorIdle(tempo, rng) {
  return behaviourDelay(tempo, rng);
}

function furnitureExpression(kind) {
  if (kind === 'bed') return 'sleepy';
  if (kind === 'bowl') return 'happy';
  if (kind === 'ball') return 'happy';
  if (kind === 'lamp') return 'normal';
  return 'normal';
}

/** 2匹が近いか（セル距離） */
export function isNear(a, b, distance = 1.25) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= distance;
}

/**
 * 2匹の組み合わせで出る演出を判定する。
 * @returns {{type:'special'|'friend', reason:'species'|'personality'|null}}
 */
export function pairEvent(a, b) {
  if (a.speciesId && a.speciesId === b.speciesId) return { type: 'special', reason: 'species' };
  if (a.personality && a.personality === b.personality) return { type: 'special', reason: 'personality' };
  return { type: 'friend', reason: null };
}

/** 相手の近く（となり）の立つ位置を返す */
export function spotNextTo(actor, partner, cols, rng = Math.random) {
  const offsets = [
    { x: partner.x - 0.9, y: partner.y },
    { x: partner.x + 0.9, y: partner.y },
    { x: partner.x, y: partner.y + 0.9 },
    { x: partner.x, y: partner.y - 0.9 },
  ];
  const free = offsets.filter((spot) => isFreeCell(spot.x, spot.y, cols));
  if (!free.length) return null;
  return free[Math.floor(rng() * free.length) % free.length];
}

/** いちばん近い相手（距離無制限・寝ている子は除く） */
export function closestActor(actor, actors) {
  let best = null;
  let bestDistance = Infinity;
  for (const other of actors) {
    if (other === actor || other.id === actor.id) continue;
    const gap = Math.hypot(actor.x - other.x, actor.y - other.y);
    if (gap < bestDistance) {
      best = other;
      bestDistance = gap;
    }
  }
  return best;
}

/** 近くの相手を探す（いなければ null） */
export function nearestNeighbour(actor, actors, distance = 1.25) {
  let best = null;
  let bestDistance = Infinity;
  for (const other of actors) {
    if (other === actor || other.id === actor.id) continue;
    if (other.state === 'sleep') continue;
    const gap = Math.hypot(actor.x - other.x, actor.y - other.y);
    if (gap <= distance && gap < bestDistance) {
      best = other;
      bestDistance = gap;
    }
  }
  return best;
}
