/**
 * 家具のドット絵（Phase 3-2）。外部画像は使わず canvas だけで描く。
 * 絵のデータは `data/shop-set.js`（art/shop-spec-01.md から生成）・
 * `data/owned-set.js`（art/bowl-ball-spec-01.md から生成）・`data/room-set.js`（room-set-01.md から生成）だけ。
 * **ベクターのフォールバックは無い**。
 *
 * このファイルはショップのサムネ用（部屋の実寸は js/ui/room-art.js が描く）。
 */

import { SHOP_ART } from '../../data/shop-set.js';
import { OWNED_ART } from '../../data/owned-set.js';
import { ROOM_PARTS } from '../../data/room-set.js';

/** 部屋と同じ 1ドット = 2px */
const S = 2;

/** 記号の runs を1ドットずつ矩形で描く（runs は点のバウンディングボックス原点） */
function drawRuns(ctx, node, { scale, dx = 0, dy = 0 }) {
  for (const [char, rows] of Object.entries(node.runs)) {
    const color = node.colors[char];
    if (!color) continue;
    ctx.fillStyle = color;
    for (const [y, x1, x2] of rows) {
      ctx.fillRect((x1 + dx) * scale, (y + dy) * scale, (x2 - x1 + 1) * scale, scale);
    }
  }
}

/** 商品の絵（ショップの点 → 部屋セットの部品の順に解決する） */
function artOf(item) {
  if (item?.art && (SHOP_ART[item.art] ?? OWNED_ART[item.art])) return SHOP_ART[item.art] ?? OWNED_ART[item.art];
  if (item?.part && ROOM_PARTS[item.part]) {
    const part = ROOM_PARTS[item.part];
    // 部品は部屋の絶対座標なので、バウンディングボックス原点へ直して返す
    const runs = {};
    for (const [char, rows] of Object.entries(part.runs)) {
      runs[char] = rows.map(([y, x1, x2]) => [y - part.y, x1 - part.x, x2 - part.x]);
    }
    return { colors: part.colors, runs, dots: { x: 0, y: 0, w: part.w, h: part.h } };
  }
  return null;
}

/**
 * 商品の絵をサムネ用に描く（縦横比を保って箱に収める）。
 * 等倍以上なら整数倍でくっきり、縮小なら 2px/ドットで描いた1枚を縮小する。
 */
export function paintFurniture(canvas, item, { maxWidth = 44, maxHeight = 44, dpr = globalThis.devicePixelRatio || 1 } = {}) {
  const art = artOf(item);
  const dotsW = art?.dots?.w ?? 22;
  const dotsH = art?.dots?.h ?? 22;
  canvas.width = Math.max(1, Math.round(maxWidth * dpr));
  canvas.height = Math.max(1, Math.round(maxHeight * dpr));
  canvas.style.width = `${maxWidth}px`;
  canvas.style.height = `${maxHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, maxWidth, maxHeight);
  ctx.imageSmoothingEnabled = false;
  if (!art) {
    canvas.dataset.kind = '';
    return { width: maxWidth, height: maxHeight };
  }

  const fit = Math.min(maxWidth / dotsW, maxHeight / dotsH);
  const scale = Math.floor(fit);
  if (scale >= 1) {
    const w = dotsW * scale;
    const h = dotsH * scale;
    const ox = Math.floor((maxWidth - w) / 2);
    const oy = Math.floor((maxHeight - h) / 2);
    drawRuns(ctx, art, { scale, dx: ox / scale, dy: oy / scale });
  } else {
    // 縮小: 2px/ドットで描いた1枚を等倍縮小（ドットの粒は残さない）
    const buffer = document.createElement('canvas');
    buffer.width = dotsW * S;
    buffer.height = dotsH * S;
    const bctx = buffer.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    drawRuns(bctx, art, { scale: S });
    const w = Math.max(1, Math.round(dotsW * fit));
    const h = Math.max(1, Math.round(dotsH * fit));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buffer, Math.floor((maxWidth - w) / 2), Math.floor((maxHeight - h) / 2), w, h);
  }
  canvas.dataset.kind = item?.id ?? '';
  return { width: maxWidth, height: maxHeight };
}

/** 壁紙・床のサムネ（22ドットのタイルをそのまま敷く） */
export function paintSurfaceSwatch(canvas, item, { size = 44, dpr = globalThis.devicePixelRatio || 1 } = {}) {
  const tile = item?.tile ? SHOP_ART[item.tile] : null;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (!tile) return { width: size, height: size };
  ctx.imageSmoothingEnabled = false;
  const scale = size / 22;
  drawRuns(ctx, tile, { scale });
  return { width: size, height: size };
}
