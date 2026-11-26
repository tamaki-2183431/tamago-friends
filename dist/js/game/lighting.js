/**
 * 部屋の照明オーバーレイ（時間帯・天気）の形（純関数・DOM 非依存）。
 *
 * 不具合（v18 で修正）: 以前は画面（screen）ごとに「窓の左・右・下」の3枚を作り、
 * しかも左/右は `left:0` / `right:0` を基準にしていたため、画面数ぶんの全幅矩形が
 * 同じ位置に重なっていた（実測: 1画面=6枚 / 4匹=12枚 / 7匹=18枚 / 19匹=42枚）。
 * opacity が合成されて部屋全体が白っぽく（夜は紺に）潰れる。
 *
 * 正しい形: 矩形は**部屋全体（world 幅）に対して1組だけ**作る。窓ガラス（GLASS）だけを
 * 避けるので、縦に3つに区切れば足りる（画面数に依存しない）。
 *   1. top    : y 0 .. 窓の上端（全幅）
 *   2. band   : y 窓の上端 .. 窓の下端（全幅・窓の列だけ穴）
 *   3. bottom : y 窓の下端 .. 部屋の下端（全幅）
 * 3枚は縦に並ぶだけで重ならない（＝重なり0）。窓と窓のあいだの壁は 2 の帯で塗られる。
 *
 * `band` は DOM では `repeating-linear-gradient` の穴あき背景で描く（1要素のまま）。
 */

import { GLASS, ROOM_DOTS } from '../../data/room-set.js';
import { TILE } from '../../data/room.js';

/** 画面1枚ぶんのドット幅 */
export const SCREEN_DOTS = ROOM_DOTS.width;

/** オーバーレイは常に3枚（時間帯・天気で同じ形を使う）。画面数に依存しない */
export const LAYER_COUNT = 3;

/**
 * 照明の矩形（ドット座標・部屋全体に対して1組）。
 * @param {{screens?:number, glass?:{x:number,y:number,w:number,h:number}, width?:number, height?:number}} options
 * @returns {Array<{id:'top'|'band'|'bottom', top:number, height:number, holes:boolean}>}
 */
export function lightLayers({
  screens = 1,
  glass = GLASS,
  width = ROOM_DOTS.width,
  height = ROOM_DOTS.height,
} = {}) {
  const count = Math.max(1, Math.round(Number(screens) || 1));
  // 幅は画面数から決まる（呼び出し側の width より画面数を優先しない: 画面数が正）
  const worldWidth = width * count;
  const bottomTop = glass.y + glass.h;
  return [
    { id: 'top', left: 0, width: worldWidth, top: 0, height: glass.y, holes: false },
    { id: 'band', left: 0, width: worldWidth, top: glass.y, height: glass.h, holes: true },
    { id: 'bottom', left: 0, width: worldWidth, top: bottomTop, height: Math.max(0, height - bottomTop), holes: false },
  ];
}

/** そのドットが窓ガラスか（画面ごとに繰り返す） */
export function isGlassCell(x, y, { glass = GLASS, screenWidth = SCREEN_DOTS } = {}) {
  if (y < glass.y || y >= glass.y + glass.h) return false;
  const local = ((x % screenWidth) + screenWidth) % screenWidth;
  return local >= glass.x && local < glass.x + glass.w;
}

/**
 * 1枚の矩形が、そのドットを覆うか。
 * @param {{top:number,height:number,holes:boolean,left?:number,width?:number}} layer
 */
export function layerCovers(layer, x, y, { glass = GLASS, screenWidth = SCREEN_DOTS } = {}) {
  if (!layer) return false;
  if (y < layer.top || y >= layer.top + layer.height) return false;
  if (layer.left !== undefined && (x < layer.left || x >= layer.left + layer.width)) return false;
  if (layer.holes && isGlassCell(x, y, { glass, screenWidth })) return false;
  return true;
}

/**
 * そのドットを覆う矩形の枚数（0=窓ガラス / 1=正常 / 2以上=重なり）。
 * まとめて計算するので、テストでは全ドット走査に使う。
 */
export function coverageMap({ screens = 1, glass = GLASS, width = ROOM_DOTS.width, height = ROOM_DOTS.height } = {}) {
  const layers = lightLayers({ screens, glass, width, height });
  const worldWidth = width * Math.max(1, Math.round(Number(screens) || 1));
  const map = new Uint8Array(worldWidth * height);
  for (const layer of layers) {
    for (let y = layer.top; y < layer.top + layer.height; y += 1) {
      for (let x = layer.left; x < layer.left + layer.width; x += 1) {
        if (layer.holes && isGlassCell(x, y, { glass, screenWidth: width })) continue;
        map[y * worldWidth + x] += 1;
      }
    }
  }
  return { layers, map, worldWidth, height };
}

/**
 * 重なりの検査（テスト・受入用）。
 * @returns {{overlaps:number, holes:number, glassCells:number, worldWidth:number}}
 */
export function auditLayers({ screens = 1, glass = GLASS, width = ROOM_DOTS.width, height = ROOM_DOTS.height } = {}) {
  const worldWidth = width * Math.max(1, Math.round(Number(screens) || 1));
  const { map } = coverageMap({ screens, glass, width, height });
  let overlaps = 0;
  let holes = 0;
  let glassCells = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < worldWidth; x += 1) {
      const count = map[y * worldWidth + x];
      if (isGlassCell(x, y, { glass, screenWidth: width })) {
        glassCells += 1;
        if (count !== 0) holes += 1;
        continue;
      }
      if (count === 0) holes += 1;
      if (count > 1) overlaps += 1;
    }
  }
  return { overlaps, holes, glassCells, worldWidth };
}

/* ================================================================ v21: 実照明（ランプ） */

/**
 * 夜の時間帯オーバーレイ（`#1F2A57`）の不透明度。**変えない**（仕様§1）。
 * ランプはこのオーバーレイの不透明度を**下げる**（暗さを薄くする）だけで、光を足さない。
 */
export const NIGHT_OPACITY = 0.45;

/** 光の半径（px）。1マス44px なので 2マス＝88px */
export const LIGHT_RADIUS_PX = 88;

/**
 * 光源中心で残す暗さ（オーバーレイの透過率）。
 * 0.45 × 0.18 ≒ **0.081**（仕様の 0.05〜0.10 の中央付近）。
 */
export const LIGHT_CENTER_TRANSMISSION = 0.18;

/**
 * 中心の平板（半径に対する割合）。この内側は同じ濃さにする。
 * 88px × 0.52 ≒ 46px なので、ランプの真下にいる子（顔まで 40〜50px）も十分に照らされ、
 * 残りの 46→88px で smoothstep でふわっと元の暗さへ戻す（硬い円にしない）。
 */
export const LIGHT_CORE = 0.52;

/** グラデーションの刻み（多いほど縁が滑らか）。平板の外は両端で傾き0の smoothstep を刻む */
const LIGHT_STOPS = 20;

const pad2 = (value) => String(value).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/**
 * 「いまの夜」の名前。夜は 19:00〜翌 3:59 なので、0〜3時台は**前日**の日付を返す。
 * 手動の点灯/消灯はこのキーに対して覚える＝境界（4:00・19:00）で自動に戻る。
 * @param {number|Date} now
 * @returns {string} 'YYYY-MM-DD'
 */
export function nightWindowKey(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getHours() < 4) {
    const prev = new Date(date.getTime());
    prev.setDate(prev.getDate() - 1);
    return dayKey(prev);
  }
  return dayKey(date);
}

/**
 * その家具が「いま点いているか」。
 * - 夜（19:00〜3:59）だけ点く。朝・昼・夕方は、手動でも点かない（仕様§3）
 * - 手動の記録が**同じ夜**に無ければ自動点灯（既存セーブはこれ＝点灯で初期化）
 * - 手動の記録が同じ夜にあればそれに従う（夜にOFF→朝までOFF）
 * - ランプ以外（カタログに `light` を持たない家具）は常に消灯
 * @param {{light?:{cx:number,cy:number},lit?:boolean,lightWindow?:string}} entry
 * @param {{period?:string, windowKey?:string}} options
 */
export function lampIsLit(entry, { period, windowKey } = {}) {
  if (!entry?.light) return false;
  if (period !== 'night') return false;
  if (typeof entry.lit !== 'boolean') return true; // 手動の記録なし＝自動点灯
  if (!entry.lightWindow) return true;
  if (entry.lightWindow !== windowKey) return true; // 前の夜の手動状態は持ち越さない
  return entry.lit;
}

/**
 * タップで点灯/消灯する。**夜だけ**効く（昼・夕方・朝は「点かない」ので何も変えない）。
 * @returns {{changed:boolean, reason:null|'not-lamp'|'daytime', lit:boolean, lightWindow?:string}}
 */
export function toggleLamp(entry, { period, windowKey } = {}) {
  if (!entry?.light) return { changed: false, reason: 'not-lamp', lit: false };
  if (period !== 'night') return { changed: false, reason: 'daytime', lit: false };
  return { changed: true, reason: null, lit: !lampIsLit(entry, { period, windowKey }), lightWindow: windowKey };
}

/**
 * 光源の透過率（0=真っ暗なまま / 1=オーバーレイをそのまま掛ける）。
 * - 中心から `core`（半径の28%）までは `center` のまま（＝中心付近でも 0.45×(0.05〜0.10)）
 * - そこから半径 `radius` まで smoothstep で 1（元の暗さ）へ戻す。両端で傾き0＝**硬い円にしない**
 * @param {number} distance 光源中心からの距離（px）
 */
export function lightTransmission(distance, { radius = LIGHT_RADIUS_PX, center = LIGHT_CENTER_TRANSMISSION, core = LIGHT_CORE } = {}) {
  const r = Number(radius) > 0 ? Number(radius) : LIGHT_RADIUS_PX;
  const c = Math.min(0.9, Math.max(0.02, Number(center) || LIGHT_CENTER_TRANSMISSION));
  const k = Math.min(0.9, Math.max(0, Number(core)));
  const d = Number(distance);
  if (!Number.isFinite(d) || d <= 0) return c;
  if (d >= r) return 1;
  const u = d / r;
  if (u <= k) return c;
  const v = (u - k) / (1 - k);
  return c + (1 - c) * (v * v * (3 - 2 * v));
}

/**
 * 点いている光源の一覧（px 座標）。`light` を持たない家具は**光源にしない**。
 * @param {Array<{itemId?:string,col?:number,row?:number,light?:object,lit?:boolean,lightWindow?:string}>} entries
 * @param {{tile?:number, period?:string, windowKey?:string}} options
 *   period を渡すと `lampIsLit` で点灯を判定する（省略時は `lit === true` だけを見る）
 * @returns {Array<{itemId:string,x:number,y:number}>}
 */
export function lightSourcesOf(entries = [], { tile = TILE, period, windowKey } = {}) {
  const step = Number(tile) > 0 ? Number(tile) : TILE;
  const out = [];
  for (const entry of entries ?? []) {
    const light = entry?.light;
    if (!light || !Number.isFinite(light.cx) || !Number.isFinite(light.cy)) continue;
    const lit = period === undefined
      ? entry.lit === true
      : lampIsLit(entry, { period, windowKey });
    if (!lit) continue;
    out.push({
      itemId: entry.itemId ?? '',
      x: (Number(entry.col) || 0) * step + light.cx * 2,
      y: (Number(entry.row) || 0) * step + light.cy * 2,
    });
  }
  return out;
}

const px = (value) => Number(Number(value).toFixed(2));

/**
 * 夜オーバーレイに掛けるマスク（`mask-image`）。
 * - 光源1件＝radial-gradient **1枚**（マスクは世界で1枚。要素は光源の数だけ増やさない）
 * - 光源が無ければ '' を返す＝マスクを外す（現行と同じ見た目）
 * - 中心の alpha が小さいほど「暗さが消える」。縁は smoothstep で滑らかに 1 へ戻る
 * @param {Array<{x:number,y:number}>} sources
 * @returns {string} CSS の `mask-image` 値（複数光源はカンマ区切りで `mask-composite: intersect`）
 */
export function lightMaskImage(sources = [], { radius = LIGHT_RADIUS_PX, center = LIGHT_CENTER_TRANSMISSION } = {}) {
  const list = (sources ?? []).filter((source) => Number.isFinite(source?.x) && Number.isFinite(source?.y));
  if (!list.length) return '';
  return list
    .map((source) => {
      const stops = [];
      for (let k = 0; k <= LIGHT_STOPS; k += 1) {
        const u = k / LIGHT_STOPS;
        const alpha = lightTransmission(u * radius, { radius, center });
        stops.push(`rgba(0, 0, 0, ${alpha.toFixed(3)}) ${((u * 100)).toFixed(2)}%`);
      }
      return `radial-gradient(${radius}px ${radius}px at ${px(source.x)}px ${px(source.y)}px, ${stops.join(', ')})`;
    })
    .join(', ');
}

/**
 * 光の中だけに薄い暖色を乗せるマスク（中心で濃く、半径で0）。
 * 夜オーバーレイのマスクの**逆**（1 − 透過率）。足すのは暖色だけで白は足さない。
 */
export function warmMaskImage(sources = [], { radius = LIGHT_RADIUS_PX, center = LIGHT_CENTER_TRANSMISSION } = {}) {
  const list = (sources ?? []).filter((source) => Number.isFinite(source?.x) && Number.isFinite(source?.y));
  if (!list.length) return '';
  return list
    .map((source) => {
      const stops = [];
      for (let k = 0; k <= LIGHT_STOPS; k += 1) {
        const u = k / LIGHT_STOPS;
        const alpha = 1 - lightTransmission(u * radius, { radius, center });
        stops.push(`rgba(0, 0, 0, ${alpha.toFixed(3)}) ${(u * 100).toFixed(2)}%`);
      }
      return `radial-gradient(${radius}px ${radius}px at ${px(source.x)}px ${px(source.y)}px, ${stops.join(', ')})`;
    })
    .join(', ');
}
