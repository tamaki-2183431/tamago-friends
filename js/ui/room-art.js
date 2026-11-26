/**
 * 部屋セット（room-set-01.md）のドット絵を描く。
 *
 * - 論理 264×176 ドット → 実寸 528×352px（1ドット = 2×2px の矩形を打つ）
 * - 背景（壁紙・幅木・床・ラグ・固定の小物・窓・空・天気・サッシ・カーテン・ドア・マット）は
 *   1枚の canvas にまとめて描く（描画順は仕様 §7）
 * - 家具は「動かせる」ので、アイテムごとの小さな canvas に描く（同じドット絵）
 * - 掛け時計の針は別レイヤー（毎分描き直す・アンチエイリアス禁止）
 */

import { GLASS, ROOM_DOTS, ROOM_PARTS } from '../../data/room-set.js';
import { SHOP_ART } from '../../data/shop-set.js';
import { OWNED_ART } from '../../data/owned-set.js';

/** 家具の点データ（ショップ商品＋所持品）。ID は重複しない */
const ITEM_ART = Object.freeze({ ...SHOP_ART, ...OWNED_ART });

const S = ROOM_DOTS.scale; // 1ドット = 2px
/** 背景の描画キャッシュ（同じ条件なら canvas を再利用） */
const BACKGROUND_CACHE = new Map();
export const ART_WIDTH = ROOM_DOTS.width * S;
export const ART_HEIGHT = ROOM_DOTS.height * S;

/** 時間帯 → 空の部品 */
export const SKY_PART = Object.freeze({
  morning: 'skyMorning',
  day: 'skyDay',
  evening: 'skyEvening',
  night: 'skyNight',
});

/** 天気 → ガラスに重ねる部品（はれは重ねなし） */
export const WEATHER_PART = Object.freeze({
  sunny: null,
  cloudy: 'weatherCloudy',
  rain: 'weatherRain',
  snow: 'weatherSnow',
});

/**
 * 掛け時計（ドット座標）。room-set §3.21a: 文字盤22ドット・目盛り半径7.8・長針7・短針5。
 * x176..197 / y1..22（= px 352..395 / 2..45）。絵画Bの框は x198 から。
 */
export const CLOCK = Object.freeze({ x: 176, y: 1, size: 22, cx: 187, cy: 12, hourHand: 5, minuteHand: 7 });

/**
 * 針を持つ時計の幾何（**セル内のドット座標**）。
 * 初期の掛け時計（clock-1）と、ショップで買う「とけい」（tokei・18×18の文字盤）は
 * 同じ針レイヤー（1ドット・アンチエイリアスなし・分境界で更新）で描く。
 * - clock-1: 部品 clock は 264×176 の部屋座標 x176,y1。セル原点は c8r0（=x176,y0）
 *   なので中心は (0+11, 1+11) = (11,12)。針は長7・短5（§3.21a）
 * - tokei: 文字盤の白い面はセル x5..16 / y5..16（12×12）。中心は (11,10)。
 *   12方位の目盛り（A）は半径5にあるので、針は長4・短3（先端が目盛りに触れない）
 */
export const CLOCK_SPECS = Object.freeze({
  'clock-1': { cx: 11, cy: 12, minuteHand: 7, hourHand: 5, color: '#C28F60' },
  tokei: { cx: 11, cy: 10, minuteHand: 4, hourHand: 3, color: '#9C6B45' },
});

/** アイテムが針を持つ時計なら幾何を返す（持たなければ null） */
export function clockSpecOf(item) {
  if (!item?.clock) return null;
  return CLOCK_SPECS[item.id] ?? null;
}

/** とけい（tokei）の固定の針セル（＝絵からは描かない） */
export const TOKEI_HAND_RADIUS = 4.5;

/**
 * とけい（tokei）の文字盤に焼き込まれた針のセルか。
 * 仕様 §2.11 の絵は 2:00 ごろの針が O（#9C6B45）で描かれている。12方位の目盛り（A）は
 * 中心から半径5以上なので、中心から半径 4.5 以内の O だけが「焼き込まれた針」。
 * @param {number} x セル内のドット座標
 * @param {number} y セル内のドット座標
 * @param {string} char 点の記号
 */
export function isTokeiHandCell(x, y, char) {
  if (char !== 'O') return false;
  return Math.hypot(x - CLOCK_SPECS.tokei.cx, y - CLOCK_SPECS.tokei.cy) <= TOKEI_HAND_RADIUS;
}

/** 背景に固定で描く要素（家具ではない） */
const FIXED_DECOR = ['paintingA', 'paintingB', 'wallShelf'];

function eachRun(part, callback) {
  for (const [char, rows] of Object.entries(part.runs)) {
    for (const [y, x1, x2] of rows) callback(char, y, x1, x2);
  }
}

/**
 * 部品を1つ描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} part
 * @param {{dx?:number, dy?:number, palette?:object, skip?:(x:number,y:number)=>boolean}} options
 */
export function paintPart(ctx, part, { dx = 0, dy = 0, palette = null, skip = null } = {}) {
  eachRun(part, (char, y, x1, x2) => {
    const color = (palette && palette[char]) ?? part.colors[char];
    if (!color) return;
    ctx.fillStyle = color;
    if (!skip) {
      ctx.fillRect((x1 + dx) * S, (y + dy) * S, (x2 - x1 + 1) * S, S);
      return;
    }
    for (let x = x1; x <= x2; x += 1) {
      if (skip(x, y, char)) continue;
      ctx.fillRect((x + dx) * S, (y + dy) * S, S, S);
    }
  });
}

/** ショップのタイル（22×22）を敷く（runs は点のバウンディングボックス原点） */
export function paintTile(ctx, tile, { dx = 0, dy = 0 } = {}) {
  paintRuns(ctx, tile, { dx, dy });
}

/** 時計の針のセル（＝部屋の絵に含めない）。12方位の目盛りは残す */
export function isClockHandCell(x, y) {
  const dx = x - CLOCK.cx;
  const dy = y - CLOCK.cy;
  const radius = Math.hypot(dx, dy);
  if (radius >= 6.5) return false;
  if (radius >= 5.5) {
    const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    if (Math.abs(((angle + 15) % 30) - 15) <= 8) return false; // 目盛りは残す
  }
  return true;
}

/**
 * 背景を描く（1枚 canvas）。
 * @param {HTMLCanvasElement} canvas
 * @param {{period?:string, weather?:string, screens?:number, wallpaper?:object|null, floor?:object|null}} options
 */
export function paintRoomBackground(canvas, {
  period = 'day',
  weather = 'sunny',
  screens = 1,
  wallpaper = null,
  floor = null,
} = {}) {
  const count = Math.max(1, Number(screens) || 1);
  // 壁紙・床は「商品（タイル）」か null（＝部屋セットの既定）
  const wallTile = wallpaper?.tile ? SHOP_ART[wallpaper.tile] : null;
  const floorTile = floor?.tile ? SHOP_ART[floor.tile] : null;
  const key = `${period}|${weather}|${count}|${wallTile?.name ?? ''}|${floorTile?.name ?? ''}`;
  // 同じ条件の絵は使い回す（再描画のたびに1万個の矩形を打たない）
  const cached = BACKGROUND_CACHE.get(key);
  if (cached && cached !== canvas) {
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.style.width = `${ART_WIDTH * count}px`;
    canvas.style.height = `${ART_HEIGHT}px`;
    const ctxCached = canvas.getContext('2d');
    ctxCached.imageSmoothingEnabled = false;
    ctxCached.clearRect(0, 0, canvas.width, canvas.height);
    ctxCached.drawImage(cached, 0, 0);
    return { width: canvas.width, height: canvas.height, cached: true };
  }
  canvas.width = ART_WIDTH * count;
  canvas.height = ART_HEIGHT;
  canvas.style.width = `${ART_WIDTH * count}px`;
  canvas.style.height = `${ART_HEIGHT}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const parts = ROOM_PARTS;
  const skyPart = parts[SKY_PART[period] ?? 'skyDay'];
  const weatherPart = WEATHER_PART[weather] ? parts[WEATHER_PART[weather]] : null;

  const glassX = GLASS.x * S;
  const glassY = GLASS.y * S;
  const glassW = GLASS.w * S;
  const glassH = GLASS.h * S;

  for (let screen = 0; screen < count; screen += 1) {
    const dx = screen * ROOM_DOTS.width;

    // 0 壁紙（12列×3行に敷き詰め）。買ったタイルはそのまま22ドット周期で敷く
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        if (wallTile) paintTile(ctx, wallTile, { dx: dx + col * 22, dy: row * 22 });
        else paintPart(ctx, parts.wallpaper, { dx: dx + col * 22, dy: row * 22 });
      }
    }
    // 1 幅木
    for (let col = 0; col < 12; col += 1) paintPart(ctx, parts.baseboard, { dx: dx + col * 22, dy: 61 });
    // 2 床（12列×5行）＋ 88ドットごとの縦の継ぎ（仕様 §3.2 メモ）
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        if (floorTile) paintTile(ctx, floorTile, { dx: dx + col * 22, dy: 66 + row * 22 });
        else paintPart(ctx, parts.floor, { dx: dx + col * 22, dy: 66 + row * 22 });
      }
      if (floorTile) continue; // タイルは継ぎ目を自分で持つ（境界線を足さない）
      // 縦の継ぎ: 22×22のタイルに入っていないので、板（11ドット）ごとに位相を44ずらして引く
      ctx.fillStyle = '#EBC59A';
      const top = 66 + row * 22;
      for (const joint of [88, 176]) ctx.fillRect((dx + joint) * S, (top + 2) * S, S, 9 * S);
      for (const joint of [44, 132, 220]) ctx.fillRect((dx + joint) * S, (top + 12) * S, S, 10 * S);
    }
    // 天井際の1ドット陰（壁の最上段）
    ctx.fillStyle = '#F2E1C2';
    ctx.fillRect(dx * S, 0, 264 * S, S);
    // 3 じゅうたん（背景には焼き込まない。初期の「はじまりのラグ」は家具レイヤーで描く）
    // 6 壁の小物（絵画A → 絵画B → 壁の棚）
    for (const id of FIXED_DECOR) paintPart(ctx, parts[id], { dx });
    // 7 窓枠
    paintPart(ctx, parts.windowFrame, { dx });
    // 8 空（ガラス面にだけ）
    if (skyPart) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(glassX + dx * S, glassY, glassW, glassH);
      ctx.clip();
      paintPart(ctx, skyPart, { dx });
      // 9 天気（同じ矩形にクリップ）
      if (weatherPart) paintPart(ctx, weatherPart, { dx });
      ctx.restore();
    }
    // 10 サッシ → カーテンレール → カーテン
    paintPart(ctx, parts.sash, { dx });
    paintPart(ctx, parts.curtainRail, { dx });
    paintPart(ctx, parts.curtain, { dx });
    // 11 ドア → ドアマット（ドアは1画面目だけ）
    if (screen === 0) {
      paintPart(ctx, parts.door);
      paintPart(ctx, parts.mat);
    }
  }
  // 同じ canvas 要素をキャッシュに入れると、2回目の描画で「自分自身をクリアして
  // 自分へ描く」ことになり背景が真っ白になる。**複製**を保存する。
  try {
    const snapshot = globalThis.document?.createElement('canvas') ?? new OffscreenCanvas(canvas.width, canvas.height);
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    BACKGROUND_CACHE.set(key, snapshot);
  } catch {
    // 複製できない環境ではキャッシュしない（毎回描く）
  }
  return { width: canvas.width, height: canvas.height };
}

/**
 * 家具1点の canvas。部屋セットの部品（part）か、ショップ仕様の点（art）を描く。
 * どちらも無ければ false（ベクターのフォールバックは無い）。
 */
export function paintItemArt(canvas, item, { cellWidth, cellHeight }) {
  const part = item?.part ? ROOM_PARTS[item.part] : null;
  const art = item?.art ? ITEM_ART[item.art] : null;
  if (!part && !art) return false;
  canvas.width = cellWidth;
  canvas.height = cellHeight;
  canvas.style.width = `${cellWidth}px`;
  canvas.style.height = `${cellHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cellWidth, cellHeight);
  const [ox, oy] = item.partOffset ?? [0, 0];

  if (part) {
    // 部品の runs は部屋の絶対ドット座標なので、セル原点からの相対へずらす
    const dx = ox - part.x;
    const dy = oy - part.y;

    // 4 接地影（家具の下・床の面取り色）。参考画像では床置き家具は同じ行に影が付く
    if (!item.clock && item.layer !== 'wall' && item.part !== 'rug') {
      const shadowTop = 38; // セル基準（r3 の 38ドット目 = 絶対 y104）
      ctx.fillStyle = '#EBC59A';
      ctx.fillRect((ox + 2) * S, shadowTop * S, Math.max(2, part.w - 4) * S, 2 * S);
    }

    paintPart(ctx, part, {
      dx,
      dy,
      skip: item.part === 'clock' ? (x, y, char) => char === 'C' && isClockHandCell(x, y) : null,
    });
    return true;
  }

  // ショップ仕様の点（runs は点のバウンディングボックス原点）
  const dx = art.dots?.x ?? 0;
  const dy = art.dots?.y ?? 0;
  // 仕様 §6: 床置きの点には、置いたときに床色の1ドット影を付ける（点自体には描いていない）。
  // 影をスプライトに内包している点（所持品のごはんばち・ボール＝`shadow: false`）は引かない
  if (item.layer === 'floor' && item.shadow !== false) {
    ctx.fillStyle = '#EBC59A';
    ctx.fillRect((dx + 1) * S, (dy + art.dots.h) * S, Math.max(2, art.dots.w - 2) * S, S);
  }
  // 針つきの時計は、絵に焼き込まれた針を描かない（実時刻の針レイヤーが上に乗る）。
  // 外したセルは文字盤の色で埋める（透明にすると壁紙が透けて穴になる）
  const skip = item.clock && item.art === 'tokei' ? isTokeiHandCell : null;
  paintRuns(ctx, art, { dx, dy, skip, skipFill: skip ? art.colors.L ?? null : null });
  return true;
}

/**
 * runs（点のバウンディングボックス原点）を 1ドット=2px で描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{colors:object, runs:object, dots?:object}} node
 * @param {{dx?:number, dy?:number, skip?:((x:number,y:number,char:string)=>boolean)|null, skipFill?:string|null}} options
 *   skip は**セル内のドット座標**（dx/dy を足した後）で呼ぶ。skipFill を渡すと、
 *   外したセルをその色で埋める（文字盤の針を消した跡を白い面にする）
 */
export function paintRuns(ctx, node, { dx = 0, dy = 0, skip = null, skipFill = null } = {}) {
  for (const [char, rows] of Object.entries(node.runs)) {
    const color = node.colors[char];
    if (!color) continue;
    ctx.fillStyle = color;
    for (const [y, x1, x2] of rows) {
      if (!skip) {
        ctx.fillRect((x1 + dx) * S, (y + dy) * S, (x2 - x1 + 1) * S, S);
        continue;
      }
      for (let x = x1; x <= x2; x += 1) {
        if (skip(x + dx, y + dy, char)) {
          if (skipFill) {
            ctx.fillStyle = skipFill;
            ctx.fillRect((x + dx) * S, (y + dy) * S, S, S);
            ctx.fillStyle = color;
          }
          continue;
        }
        ctx.fillRect((x + dx) * S, (y + dy) * S, S, S);
      }
    }
  }
}

/* ------------------------------------------------------------ 掛け時計の針 */

/** 時計の針の角度（0度=12時・時計回り） */
export function clockAngles(now = Date.now()) {
  const date = new Date(now);
  const minutes = date.getMinutes();
  const hours = date.getHours() % 12;
  return {
    hour: (hours * 30 + minutes * 0.5) % 360,
    minute: (minutes * 6) % 360,
  };
}

/**
 * 針を1ドットずつ矩形で描く（アンチエイリアス禁止）。
 * @param {HTMLCanvasElement} canvas 家具のセル全体の大きさ（width × height px）
 * @param {number} now
 * @param {{cx:number,cy:number,minuteHand:number,hourHand:number,color:string}} spec
 *   セル内のドット座標（CLOCK_SPECS）
 * @param {{width?:number, height?:number}} size px
 */
export function paintClockHands(canvas, now = Date.now(), spec = CLOCK_SPECS['clock-1'], { width = 22 * S, height = 22 * S } = {}) {
  const geometry = spec ?? CLOCK_SPECS['clock-1'];
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = geometry.color ?? ROOM_PARTS.clock.colors.C ?? '#C28F60';

  const cx = geometry.cx;
  const cy = geometry.cy;
  const { hour, minute } = clockAngles(now);

  const drawHand = (angle, length) => {
    const rad = (angle * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    for (let step = 1; step <= length; step += 1) {
      const x = Math.round(cx + sin * step);
      const y = Math.round(cy - cos * step);
      ctx.fillRect(x * S, y * S, S, S);
    }
  };

  // 長針 → 短針の順（短針が上に重なる）。仕様 §3.21a: 長針7ドット・短針5ドット
  drawHand(minute, geometry.minuteHand);
  drawHand(hour, geometry.hourHand);
  // 中心1ドット
  ctx.fillRect(cx * S, cy * S, S, S);
  return { hour, minute, cx, cy };
}

/** 次の分境界までのミリ秒 */
export function msToNextMinute(now = Date.now()) {
  return 60000 - (now % 60000);
}
