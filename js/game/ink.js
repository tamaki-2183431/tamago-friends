/**
 * 家具の当たり判定（純関数・DOM 非依存）。
 *
 * 「絵の範囲だけを押せる」ようにするための判定。家具のセルは 22×44 ドットでも、
 * 絵はその中の一部（例: らんぷは 16×33 ドット）しか塗られていない。セル全体を当たりに
 * すると、見えない余白を押しても反応してしまう（仕様§4）。
 *
 * 塗りは data/room-set.js（部屋セットの部品）と data/shop-set.js / owned-set.js
 * （ショップ・所持品の点）の `runs`（行ごとの連続区間）そのもの。
 * 座標は**配置セルの左上を原点とするドット座標**（1ドット = 2px）。
 */

import { ROOM_PARTS } from '../../data/room-set.js';
import { SHOP_ART } from '../../data/shop-set.js';
import { OWNED_ART } from '../../data/owned-set.js';

/** 家具の点データ（room-art.js と同じ引き方）。ID は重複しない */
const ITEM_ART = Object.freeze({ ...SHOP_ART, ...OWNED_ART });

/**
 * runs（[y, x1, x2] の配列）が、セル内ドット (x, y) を塗っているか。
 * @param {Record<string, number[][]>} runs
 * @param {number} x セル内ドット
 * @param {number} y セル内ドット
 * @param {{dx?:number, dy?:number}} offset runs の原点 → セル内ドットへの平行移動
 */
function runsInkAt(runs, x, y, { dx = 0, dy = 0 } = {}) {
  if (!runs || typeof runs !== 'object') return false;
  for (const rows of Object.values(runs)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [ry, x1, x2] = row;
      if (ry + dy === y && x >= x1 + dx && x <= x2 + dx) return true;
    }
  }
  return false;
}

/**
 * その家具の絵が、セル内ドット (dotX, dotY) を塗っているか。
 * @param {object} item data/shop-catalog.js の商品（part か art を持つ）
 * @param {number} dotX セル内ドット座標（0 = セルの左端）
 * @param {number} dotY セル内ドット座標（0 = セルの上端）
 * @returns {boolean}
 */
export function itemInkAt(item, dotX, dotY) {
  if (!item) return false;
  const x = Math.floor(Number(dotX));
  const y = Math.floor(Number(dotY));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  // 部屋セットの部品（初期家具）。runs は部屋の絶対ドット座標なので、
  // 描画（js/ui/room-art.js の paintItemArt）と同じく partOffset − bbox 原点 でずらす
  const part = item.part ? ROOM_PARTS[item.part] : null;
  if (part) {
    const [ox, oy] = item.partOffset ?? [0, 0];
    return runsInkAt(part.runs, x, y, { dx: ox - part.x, dy: oy - part.y });
  }

  // ショップ仕様の点・所持品。runs は点のバウンディングボックス原点
  const art = item.art ? ITEM_ART[item.art] : null;
  if (!art) return false;
  return runsInkAt(art.runs, x, y, { dx: art.dots?.x ?? 0, dy: art.dots?.y ?? 0 });
}

/**
 * その家具の絵がセル内ドット (dotX, dotY) を塗っているか（複数アイテム）。
 * @param {Array<{item:object, col:number, row:number}>} entries 配置（セル座標）
 * @param {{x:number, y:number}} cell タップ位置（セル座標・float）
 * @param {number} tile 1マスの px
 * @returns {object|null} 当たった配置
 */
export function hitOf(entries, cell, tile = 44) {
  if (!Array.isArray(entries) || !cell) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry?.item) continue;
    const dotX = (cell.x - entry.col) * (tile / 2);
    const dotY = (cell.y - entry.row) * (tile / 2);
    if (dotX < 0 || dotY < 0) continue;
    if (itemInkAt(entry.item, dotX, dotY)) return entry;
  }
  return null;
}
