/**
 * ペットの帽子・アクセサリー（Phase 3-2）。
 *
 * - data/pet-designs.js の 24×24 グリッドは**変更しない**。帽子は別レイヤー（別 canvas）で
 *   ペットの上に重ねるだけ
 * - 装着位置は段階（baby / child / adult）ごとの頭の上端 HEAD_TOP を基準に計算する
 * - 帽子のデータは data/shop.js の hat（小さな文字グリッド＋色）
 */

import { HEAD_TOP } from './pet-sprite.js';
import { findShopItem } from '../../data/shop.js';

/** 目の上端は頭の上端 + 4（js/ui/pet-sprite.js と同じ規則） */
const EYE_OFFSET = 4;
/** 頭にどれだけ重ねるか（行）。帽子が浮いて見えないように 2 行ぶん重ねる */
const HEAD_OVERLAP = 2;

function stageOf(stage) {
  return HEAD_TOP[stage] ? stage : 'child';
}

/**
 * 帽子の置き場所（24×24 グリッド内のセル）。
 * @returns {{x0:number,y0:number,w:number,h:number,headTop:number,stage:string}|null}
 */
export function hatPlacement(item, stage = 'child') {
  const hat = item?.hat;
  if (!hat || !Array.isArray(hat.rows) || !hat.rows.length) return null;
  const stageId = stageOf(stage);
  const headTop = HEAD_TOP[stageId];
  const h = hat.rows.length;
  const w = Math.max(...hat.rows.map((row) => String(row).length), 1);
  const offset = Number(hat.anchor?.[stageId]) || 0;
  const y0 = hat.slot === 'eyes' ? headTop + EYE_OFFSET + offset : headTop - h + HEAD_OVERLAP + offset;
  return { x0: Math.round((24 - w) / 2), y0, w, h, headTop, stage: stageId };
}

/** 描くセル（x, y, 色）。24×24 の外は落とす（テストで枠内を保証する） */
export function hatCells(item, stage = 'child') {
  const place = hatPlacement(item, stage);
  if (!place) return [];
  const hat = item.hat;
  const colors = hat.colors ?? {};
  const cells = [];
  hat.rows.forEach((row, index) => {
    const text = String(row);
    for (let xIndex = 0; xIndex < text.length; xIndex += 1) {
      const char = text[xIndex];
      const color = colors[char];
      if (!color) continue;
      const x = place.x0 + xIndex;
      const y = place.y0 + index;
      if (x < 0 || y < 0 || x > 23 || y > 23) continue;
      cells.push({ x, y, color, char });
    }
  });
  return cells;
}

/**
 * 帽子だけを canvas に描く（ペットの canvas と同じサイズ計算にして重ねる）。
 * @param {HTMLCanvasElement} canvas
 * @param {object} item ショップアイテム（hat を持つ）
 * @param {{size?:number, stage?:string}} options
 */
export function drawHat(canvas, item, { size = 42, stage = 'child' } = {}) {
  const dpr = globalThis.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((size * dpr) / 24));
  const dimension = 24 * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  canvas.style.width = `${dimension / dpr}px`;
  canvas.style.height = `${dimension / dpr}px`;
  canvas.dataset.hat = item?.id ?? '';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dimension, dimension);
  ctx.imageSmoothingEnabled = false;
  for (const cell of hatCells(item, stage)) {
    ctx.fillStyle = cell.color;
    ctx.fillRect(cell.x * scale, cell.y * scale, scale, scale);
  }
  return { dimension, placement: hatPlacement(item, stage) };
}

/** ペットに付いている帽子のアイテム（無ければ null） */
export function accessoryOf(room, petId) {
  const itemId = room?.accessories?.[petId];
  return itemId ? findShopItem(itemId) : null;
}

/** 帽子のラベル（ボタン用） */
export function accessoryLabel(item) {
  return item?.name ?? 'なし';
}

/** ショップのサムネ用（帽子の形だけを枠いっぱいに描く） */
export function drawHatThumb(canvas, item, { size = 44 } = {}) {
  const cells = hatCells(item, 'child');
  const dpr = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (!cells.length) return;
  const minX = Math.min(...cells.map((cell) => cell.x));
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y));
  const maxY = Math.max(...cells.map((cell) => cell.y));
  const cellW = maxX - minX + 1;
  const cellH = maxY - minY + 1;
  const scale = Math.max(1, Math.floor(Math.min(size / cellW, size / cellH) * 0.8));
  const offsetX = (size - cellW * scale) / 2;
  const offsetY = (size - cellH * scale) / 2;
  ctx.imageSmoothingEnabled = false;
  for (const cell of cells) {
    ctx.fillStyle = cell.color;
    ctx.fillRect(offsetX + (cell.x - minX) * scale, offsetY + (cell.y - minY) * scale, scale, scale);
  }
}
