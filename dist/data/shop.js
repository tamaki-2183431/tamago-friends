/**
 * ショップと家具のカタログ（Phase 3-2）。
 *
 * - 商品は **28点＋帽子6点**（`art/shop-spec-01.md` v1 ＋ v44 の照明5点・カタログは data/shop-catalog.js）
 * - 初期家具6点（ベッド・つくえ・ほんだな・植木・掛け時計・はじまりのラグ）は price 0・最初から所持
 * - 価格は 20 / 40 / 60 / 100 の4帯だけ（コインの獲得量は増やさない）
 * - 外部画像なし。家具は仕様から生成したドット絵（data/shop-set.js / js/ui/furniture-art.js）、
 *   帽子は 24×24 の文字グリッド（js/ui/pet-accessory.js）で描く
 *
 * 配置レイヤーは3種類だけ:
 *   rug（じゅうたん・床下） < floor（床置き） < wall（壁掛け）
 * 同一レイヤーどうしはセルが重なってはいけない。レイヤーが違えば重ねられる。
 * 壁紙・床（surface）は配置ではなく「敷く」商品なので、置ける対象ではない。
 */

/** 配置レイヤー */
export const LAYERS = Object.freeze({ RUG: 'rug', FLOOR: 'floor', WALL: 'wall' });

/** 壁掛けを置ける行（0〜2行目が壁面） */
export const WALL_ROWS = 3;

/** 価格の4帯（この4つ以外は使わない） */
export const PRICE_TIERS = Object.freeze([20, 40, 60, 100]);

/** ショップのカテゴリ（表示順＝仕様の7分類＋ぼうし） */
export const CATEGORIES = Object.freeze([
  { id: 'sit', label: 'すわる' },
  { id: 'place', label: 'おく' },
  { id: 'sleep', label: 'ねる' },
  { id: 'decor', label: 'かざる' },
  { id: 'green', label: 'みどり' },
  { id: 'rug', label: 'じゅうたん' },
  { id: 'surface', label: 'かべとゆか' },
  { id: 'hat', label: 'ぼうし' },
]);

/** 初期家具（無料・最初から所持・初期配置済み） */
export const DEFAULT_ITEM_IDS = Object.freeze(['hajimari-rug', 'bed-1', 'desk-1', 'bookshelf-1', 'plant-1', 'clock-1']);

/**
 * 所持だけして置いていない家具（初期状態）。
 * ごはんばち・ボールは**商品ではない**（`art/bowl-ball-spec-01.md`）ので、ここで所持にだけ入れる。
 * ペットの自動行動「ごはん」「あそぶ」の対象は、床に置かれているときだけ。
 */
export const UNPLACED_ITEM_IDS = Object.freeze(['gohanbachi', 'ball']);

import { ALL_ITEMS, INITIAL_ITEMS, OWNED_ITEMS, SHOP_ITEMS } from './shop-catalog.js';

export { SHOP_ITEMS, INITIAL_ITEMS, OWNED_ITEMS, ALL_ITEMS };

const BY_ID = new Map(ALL_ITEMS.map((item) => [item.id, item]));

export function findShopItem(itemId) {
  return BY_ID.get(itemId) ?? null;
}

export function itemsByCategory(categoryId) {
  return SHOP_ITEMS.filter((item) => item.category === categoryId);
}

/** 帽子（アクセサリー）だけ */
export const HAT_ITEMS = Object.freeze(SHOP_ITEMS.filter((item) => item.category === 'hat'));

/** 壁紙・床（タイルを敷く商品） */
export const WALLPAPER_ITEMS = Object.freeze(SHOP_ITEMS.filter((item) => item.surface === 'wallpaper'));
export const FLOOR_ITEMS = Object.freeze(SHOP_ITEMS.filter((item) => item.surface === 'floor'));

/** 初期状態の壁紙・床（商品ではない基本の見た目） */
export const DEFAULT_WALLPAPER = 'wall-default';
export const DEFAULT_FLOOR = 'floor-default';

/** 家具として部屋に置ける商品か（surface / accessory は置かない・絵が無いものも置かない） */
export function isPlaceable(item) {
  if (!item) return false;
  if (item.layer !== LAYERS.FLOOR && item.layer !== LAYERS.WALL && item.layer !== LAYERS.RUG) return false;
  return Boolean(item.art || item.part);
}

/** カテゴリの表示名 */
export function categoryLabel(categoryId) {
  return CATEGORIES.find((category) => category.id === categoryId)?.label ?? '';
}
