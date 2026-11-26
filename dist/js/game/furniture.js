/**
 * 家具の配置ロジック（純関数・DOM/DB 非依存）。
 *
 * 保存する形（c_room.furniture の1件）:
 *   { itemId, col, row, layer }
 * カタログ（data/shop.js）から w/h/kind/name を引いて使う。
 *
 * ルール:
 * - 部屋は 12×8 マス×画面数。マス外には置けない
 * - 壁掛け（wall）は壁面の行（0〜WALL_ROWS-1）に収める
 * - **同一レイヤーどうしはセルが重なってはいけない**（じゅうたんとベッドの重なりは許可）
 */

import { FLOOR_ROW, FURNITURE, ROOM_ROWS, SCREEN_COLS, UNPLACED_ITEM_IDS } from '../../data/room.js';
import {
  DEFAULT_FLOOR,
  DEFAULT_ITEM_IDS,
  DEFAULT_WALLPAPER,
  LAYERS,
  WALL_ROWS,
  findShopItem,
} from '../../data/shop.js';

/**
 * 保存形式の1件を作る（余計なキーを持たせない）。
 * 照明（v21）: **光源を持つ家具だけ**、手動の点灯状態（`lit` と、その夜の `lightWindow`）を
 * そのまま持ち回る。自動点灯は記録しない（記録が無い＝自動点灯）。
 */
export function makePlacement(itemId, col, row, layer, extra = {}) {
  const item = findShopItem(itemId);
  const placement = {
    itemId,
    col: Math.round(Number(col) || 0),
    row: Math.round(Number(row) || 0),
    layer: layer ?? item?.layer ?? LAYERS.FLOOR,
  };
  if (item?.light) {
    if (typeof extra?.lit === 'boolean') placement.lit = extra.lit;
    if (typeof extra?.lightWindow === 'string' && extra.lightWindow) placement.lightWindow = extra.lightWindow;
  }
  return placement;
}

/**
 * 保存形式の家具 → 表示用（カタログの w/h/kind/name を足す）。
 * カタログに無い itemId は捨てる（古いデータ・壊れたデータで落ちないように）。
 */
export function resolveFurniture(furniture = []) {
  const out = [];
  for (const entry of furniture) {
    const item = findShopItem(entry?.itemId);
    if (!item) continue;
    out.push({
      ...item, // part / partOffset / clock / look など、描画に必要な情報をそのまま渡す
      itemId: item.id,
      id: item.id, // 3-1 互換（DOM の dataset.id）
      kind: item.kind ?? item.id,
      name: item.name,
      layer: entry.layer ?? item.layer,
      col: Math.round(Number(entry.col) || 0),
      row: Math.round(Number(entry.row) || 0),
      w: item.w ?? 1,
      h: item.h ?? 1,
      // 照明（v21）: 手動の点灯状態（無ければ「自動」）
      ...(typeof entry.lit === 'boolean' ? { lit: entry.lit } : {}),
      ...(typeof entry.lightWindow === 'string' && entry.lightWindow ? { lightWindow: entry.lightWindow } : {}),
    });
  }
  return out;
}

/** 矩形が重なるか（セル単位・境界は重ならない） */
export function rectsOverlap(a, b) {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** 壁掛けか */
export function isWall(entry) {
  return entry?.layer === LAYERS.WALL;
}

/**
 * 置けるか判定する。
 * @param {Array} furniture いま置いてある家具（保存形式）
 * @param {{itemId:string,col:number,row:number,layer?:string}} candidate
 * @param {{cols?:number,rows?:number}} options
 * @returns {{ok:boolean, reason?:'unknown'|'bounds'|'wall-area'|'overlap', conflictId?:string}}
 */
export function canPlace(furniture, candidate, { cols = SCREEN_COLS, rows = ROOM_ROWS } = {}) {
  const item = findShopItem(candidate?.itemId);
  if (!item) return { ok: false, reason: 'unknown' };
  const w = item.w ?? 1;
  const h = item.h ?? 1;
  const layer = candidate.layer ?? item.layer;
  const col = Math.round(Number(candidate.col) || 0);
  const row = Math.round(Number(candidate.row) || 0);

  if (col < 0 || row < 0 || col + w > cols || row + h > rows) return { ok: false, reason: 'bounds' };
  if (layer === LAYERS.WALL && row + h > WALL_ROWS) return { ok: false, reason: 'wall-area' };

  const mine = { col, row, w, h, layer };
  for (const entry of furniture) {
    if (entry.itemId === candidate.itemId) continue; // 自分の移動は自分と重ならない
    const other = findShopItem(entry.itemId);
    if (!other) continue;
    const otherLayer = entry.layer ?? other.layer;
    if (otherLayer !== layer) continue; // レイヤーが違えば重ねられる
    if (rectsOverlap(mine, { col: entry.col, row: entry.row, w: other.w ?? 1, h: other.h ?? 1 })) {
      return { ok: false, reason: 'overlap', conflictId: entry.itemId };
    }
  }
  return { ok: true };
}

/** 家具を動かす（置けなければ元の配列をそのまま返す） */
export function moveFurniture(furniture, itemId, col, row, options = {}) {
  const entry = furniture.find((row_) => row_.itemId === itemId);
  if (!entry) return { ok: false, reason: 'unknown', furniture };
  const candidate = { itemId, col, row, layer: entry.layer };
  const check = canPlace(furniture, candidate, options);
  if (!check.ok) return { ...check, furniture };
  return {
    ok: true,
    furniture: furniture.map((row_) => (row_.itemId === itemId ? { ...row_, col: Math.round(col), row: Math.round(row) } : row_)),
  };
}

/** 家具を所持へ戻す（配列から取り除くだけ。売却・返金はしない） */
export function removeFurniture(furniture, itemId) {
  return { ok: true, furniture: furniture.filter((entry) => entry.itemId !== itemId) };
}

/**
 * 空いている場所に置く（ショップで「おく」を押したとき）。
 * 下のほうから探す＝床置き家具が壁ぎわに寄りすぎない。
 */
export function freeSpotFor(furniture, itemId, { cols = SCREEN_COLS, rows = ROOM_ROWS } = {}) {
  const item = findShopItem(itemId);
  if (!item) return null;
  const w = item.w ?? 1;
  const h = item.h ?? 1;
  const rowsOrder = [];
  const maxRow = item.layer === LAYERS.WALL ? WALL_ROWS : rows;
  for (let row = maxRow - h; row >= 0; row -= 1) rowsOrder.push(row);
  for (const row of rowsOrder) {
    for (let col = 1; col + w <= cols - 1; col += 1) {
      const check = canPlace(furniture, { itemId, col, row, layer: item.layer }, { cols, rows });
      if (check.ok) return { col, row };
    }
  }
  return null;
}

/**
 * 3-1 の家具（id/kind/col/row/w/h）→ 3-2 の保存形式。
 * すでに itemId を持つものはそのまま（レイヤーだけ補う）。
 */
export function migrateFurniture(list = []) {
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const itemId = entry?.itemId ?? entry?.id;
    const item = findShopItem(itemId);
    if (!item || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push(makePlacement(itemId, entry.col ?? 0, entry.row ?? 0, entry.layer ?? item.layer, entry));
  }
  return out;
}

/** 初期配置（room-set-01.md §4） */
export function initialFurniture() {
  return FURNITURE.map((item) => makePlacement(item.id, item.col, item.row, item.layer ?? LAYERS.FLOOR));
}

/** 初期の所持品（置いてある6点＋ごはんばち・ボール＝所持のみ） */
export function initialInventory() {
  return [...DEFAULT_ITEM_IDS, ...UNPLACED_ITEM_IDS];
}

/**
 * 旧カタログ（3-2 の暫定商品）で選んでいた壁紙・床 → 仕様のタイル。
 * 商品IDが変わっただけで、子どもが選んだ「もようがえ」を消さないための移行表。
 */
const LEGACY_SURFACES = Object.freeze({
  'wal-sky': 'mizutama',
  'wal-night': 'hoshizora',
  'flr-wood': 'kinoyuka',
});

/**
 * 装着品（帽子）の正規化。**1アイテムは1匹だけ**（v18）。
 * 既存データに同じ帽子が複数ペットへ付いていたら、先に見つかった1匹だけ残す。
 * 帽子以外・カタログに無いIDは落とす（描けないものを装着状態として残さない）。
 * 読み込み（migrateRoomRecord）と保存（saveRoom）の両方を通るので、
 * バックアップ復元で重複したデータが入っても次の読み込みで1匹に戻る。
 * @param {Record<string,string>} accessories petId → itemId
 */
export function normalizeAccessories(accessories = {}) {
  const out = {};
  const used = new Set();
  for (const [petId, itemId] of Object.entries(accessories ?? {})) {
    if (!petId || typeof itemId !== 'string' || !itemId) continue;
    if (used.has(itemId)) continue;
    const item = findShopItem(itemId);
    if (!item || item.category !== 'hat') continue;
    used.add(itemId);
    out[petId] = itemId;
  }
  return out;
}

/** その帽子を着けているペット（exceptPetId は除く）。いなければ null */
export function wearerOf(accessories, itemId, exceptPetId = null) {
  for (const [petId, wornId] of Object.entries(accessories ?? {})) {
    if (wornId !== itemId) continue;
    if (petId === exceptPetId) continue;
    return petId;
  }
  return null;
}

/**
 * 部屋のレコードを 3-2 の形に整える（既存データを壊さない）。
 * - furniture が無い/古い形 → 初期5点に置き換え（このときだけ初期化）
 * - inventory が無い → 初期5点を所持
 * - wallpaper / floor / accessories が無い → 既定値
 */
export function migrateRoomRecord(record = {}) {
  const base = { ...record };
  // v2 = ドット絵の部屋セット（room-set-01.md）。v1 以前は家具の配置だけ新レイアウトへ移行する
  // （ペット・コイン・点数・所持品は消さない）
  const version = Number(base.roomVersion) || 1;
  const furniture = version >= 2 && Array.isArray(base.furniture)
    ? migrateFurniture(base.furniture)
    : initialFurniture();
  const inventory = version >= 2 && Array.isArray(base.inventory)
    ? base.inventory.filter((id) => findShopItem(id))
    : initialInventory();
  // 所持品（ごはんばち・ボール）はショップで買えないので、既存の保存に無ければ所持として補う
  for (const id of UNPLACED_ITEM_IDS) if (!inventory.includes(id)) inventory.push(id);
  // 置いてある家具は必ず所持している状態にする（古いデータの取りこぼし対策）
  for (const entry of furniture) if (!inventory.includes(entry.itemId)) inventory.push(entry.itemId);

  const legacyWallpaper = LEGACY_SURFACES[base.wallpaper] && !findShopItem(base.wallpaper)
    ? LEGACY_SURFACES[base.wallpaper]
    : base.wallpaper;
  const legacyFloor = LEGACY_SURFACES[base.floor] && !findShopItem(base.floor)
    ? LEGACY_SURFACES[base.floor]
    : base.floor;

  return {
    ...base,
    roomVersion: 2,
    furniture,
    inventory,
    wallpaper: typeof legacyWallpaper === 'string' ? legacyWallpaper : DEFAULT_WALLPAPER,
    floor: typeof legacyFloor === 'string' ? legacyFloor : DEFAULT_FLOOR,
    accessories: normalizeAccessories(base.accessories),
    weather: base.weather && typeof base.weather === 'object' ? { ...base.weather } : { code: null, fetchedAt: 0 },
    prefecture: typeof base.prefecture === 'string' ? base.prefecture : '',
    floorRow: FLOOR_ROW,
  };
}

/** レイヤーごとの並び（描画順の確認・テスト用） */
export const LAYER_ORDER = Object.freeze([LAYERS.RUG, LAYERS.FLOOR, LAYERS.WALL]);
