/**
 * ショップの商品カタログ（**データだけ**）。UI・購入・配置のロジックは data/shop.js / js/ui/shop.js。
 *
 * 正 = `art/shop-spec-01.md`（アートディレクターのショップ設計仕様 v1）＋ `data/shop-set.js`
 * （同仕様から `tools/parse-shop-set.mjs` が生成したドット絵）。
 *
 * 各商品の形:
 *   id / name / category / layer（floor|wall|rug|surface）/ w,h（マス）/ price
 *   art?          data/shop-set.js（SHOP_ART）の点ID。あればドット絵で描く
 *   part?         部屋セット（data/room-set.js）の部品ID（初期家具だけ）
 *   partOffset?   部品の bbox 原点 − 配置セル原点（ドット）
 *   light?        **光源**（電球／傘の中心）。配置セルの左上を原点とするドット座標。
 *                 これを持つ家具だけが夜に部屋を照らす（v21）。持たない家具は光源にしない。
 *                 半径・強さは機種で変えない（すべて同じ 88px・同じ濃さ。js/game/lighting.js）
 *   surface?      wallpaper | floor（タイルを敷く商品）
 *   hat?          帽子の文字グリッド（ペットの24×24に重ねる別レイヤー）
 *
 * 28点＋帽子6点＝34商品（v44 で照明5点を追加）。商品の追加は仕様（art/shop-spec-01.md）の範囲だけ。
 * ベクターのフォールバックは無い（絵を持たない商品は置けない）。
 */

/** 帽子のドット絵。仕様 §3 の実寸（幅×高さ）と色数に合わせる。K=ふち A=メイン B=サブ W=白 */
const HATS = Object.freeze({
  'hat-cap': {
    slot: 'head',
    rows: [
      '.....AAAAA.....',
      '...AAAAAAAAA...',
      '..AAAAAAAAAAA..',
      '.AAAAAAAAAAAAA.',
      'KKKKKKKKKKKKKKK',
      '...............',
    ],
    colors: { A: '#7fb3ff', K: '#3f6fd8' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
  'hat-ribbon': {
    slot: 'head',
    rows: [
      '...AA....AA...',
      '..AABA..ABAA..',
      '.AAABBBBBBAAA.',
      '..AABA..ABAA..',
      '...AA....AA...',
    ],
    colors: { A: '#ff8fb0', B: '#ffd0dd' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
  'hat-flower-crown': {
    slot: 'head',
    rows: [
      '.ABA.ABA.ABA...',
      'AAABABBBABBAAA.',
      '.ABA.ABA.ABA...',
      '..C...C...C....',
    ],
    colors: { A: '#ff9ec4', B: '#ffd166', C: '#8fd18a' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
  'hat-star-cap': {
    slot: 'head',
    rows: [
      '.....A......',
      '....AAA.....',
      '..AAAAAAA...',
      '.AAWWWWWAA..',
      'KKKKKKKKKKKK',
      '............',
    ],
    colors: { A: '#6f86d8', K: '#4557a8', W: '#ffe9a8' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
  'hat-crown': {
    slot: 'head',
    rows: [
      '.A..A..A..A...',
      '.AA.AA.AA.AA..',
      '.AAAAAAAAAAAA.',
      '.AAAAAAAAAAAA.',
      'KKKKKKKKKKKKKK',
    ],
    colors: { A: '#ffd166', K: '#d9a73a' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
  'hat-snow-cap': {
    slot: 'head',
    rows: [
      '.....AAAAA...',
      '...AAAAAAAAA.',
      '..AAAAAAAAAAA',
      '.AAWWAAWWAAAA',
      'KKKKKKKKKKKKK',
      '...BBBBBB....',
    ],
    colors: { A: '#bcd9f3', W: '#fffdf6', K: '#7fa9cc', B: '#e9f3ff' },
    anchor: { baby: -1, child: -1, adult: -1 },
  },
});

/**
 * 初期家具（無料・最初から所持・初期配置済み）。部屋セット（room-set-01）の部品で描く。
 * ショップの8カテゴリには並べない（もともと持っているもの）。
 * 「はじまりのラグ」は部屋セットのピンクの丸ラグ。背景に焼き込まず、動かせる家具として持つ。
 */
export const INITIAL_ITEMS = Object.freeze([
  { id: 'hajimari-rug', name: 'はじまりのラグ', category: 'initial', layer: 'rug', kind: 'rug', w: 4, h: 2, price: 0, free: true, initial: true, part: 'rug', partOffset: [1, 0] },
  { id: 'bed-1', name: 'ベッド', category: 'initial', layer: 'floor', kind: 'bed', w: 3, h: 2, price: 0, free: true, initial: true, part: 'bed', partOffset: [1, 0] },
  { id: 'desk-1', name: 'つくえ', category: 'initial', layer: 'floor', kind: 'desk', w: 2, h: 2, price: 0, free: true, initial: true, part: 'desk', partOffset: [1, 3], light: { cx: 9, cy: 8 } },
  { id: 'bookshelf-1', name: 'ほんだな', category: 'initial', layer: 'floor', kind: 'bookshelf', w: 2, h: 2, price: 0, free: true, initial: true, part: 'bookshelf', partOffset: [0, 4] },
  { id: 'plant-1', name: 'かんよう しょくぶつ', category: 'initial', layer: 'floor', kind: 'plant', w: 2, h: 2, price: 0, free: true, initial: true, part: 'plant', partOffset: [-1, -1] },
  { id: 'clock-1', name: 'かけどけい', category: 'initial', layer: 'wall', kind: 'clock', w: 1, h: 2, price: 0, free: true, initial: true, part: 'clock', partOffset: [0, 1], clock: true },
]);

/**
 * 所持品（ごはんばち・ボール）。**商品ではない**。
 * - 正 = `art/bowl-ball-spec-01.md`（ごはんばち16×10／ボール12×12・床置きz1・1×1・4色）
 * - `price` を**持たない**＝ショップに並ばない・購入できない・コインの増減も無い
 * - 初期から所持（床には置かない）。配置モード（もちもの）で置く・動かす・かたづける
 * - カテゴリ `toy` は shop.js の CATEGORIES に無いので、商品タブには出ない
 * - `defaultCell` は仕様 §4 の配置セル案（初めて置くとき、空いていればここへ置く）
 */
export const OWNED_ITEMS = Object.freeze([
  { id: 'gohanbachi', name: 'ごはんばち', category: 'toy', layer: 'floor', w: 1, h: 1, art: 'gohanbachi', shadow: false, owned: true, defaultCell: { col: 5, row: 7 } },
  { id: 'ball', name: 'ボール', category: 'toy', layer: 'floor', w: 1, h: 1, art: 'ball', shadow: false, owned: true, defaultCell: { col: 7, row: 7 } },
]);

/** 仕様の28点（購入できる商品）。id は仕様の種IDそのまま・名前も仕様のまま */
const SHOP_PRODUCTS = Object.freeze([
  /* すわる（1点目〜3点目） */
  { id: 'maruiisu', name: 'まるいす', category: 'sit', layer: 'floor', w: 1, h: 1, price: 20, art: 'maruiisu' },
  { id: 'zabuton', name: 'ざぶとん', category: 'sit', layer: 'floor', w: 1, h: 1, price: 20, art: 'zabuton' },
  { id: 'mori-no-isu', name: 'もりのいす', category: 'sit', layer: 'floor', w: 1, h: 2, price: 40, art: 'mori-no-isu' },

  /* おく（4点目〜7点目） */
  { id: 'tsukue', name: 'つくえ', category: 'place', layer: 'floor', w: 2, h: 2, price: 60, art: 'tsukue' },
  { id: 'ochadai', name: 'おちゃだい', category: 'place', layer: 'floor', w: 2, h: 1, price: 40, art: 'ochadai' },
  { id: 'hondana', name: 'ほんだな', category: 'place', layer: 'floor', w: 2, h: 2, price: 60, art: 'hondana' },
  { id: 'tansu', name: 'たんす', category: 'place', layer: 'floor', w: 2, h: 2, price: 60, art: 'tansu' },

  /* ねる（8点目〜10点目） */
  { id: 'nedoko', name: 'ねどこ', category: 'sleep', layer: 'floor', w: 2, h: 2, price: 60, art: 'nedoko' },
  { id: 'futon', name: 'ふとん', category: 'sleep', layer: 'floor', w: 3, h: 1, price: 40, art: 'futon' },
  { id: 'yumemakura', name: 'ゆめまくら', category: 'sleep', layer: 'floor', w: 1, h: 1, price: 20, art: 'yumemakura' },

  /* かざる（11点目〜14点目） */
  // clock: 実時刻の針を別レイヤーで描く（絵に焼き込まれた針は描かない・CLOCK_SPECS.tokei）
  { id: 'tokei', name: 'とけい', category: 'decor', layer: 'wall', w: 1, h: 1, price: 20, art: 'tokei', clock: true },
  { id: 'oekaki', name: 'おえかき', category: 'decor', layer: 'wall', w: 1, h: 1, price: 20, art: 'oekaki' },
  { id: 'hanabin', name: 'はなびん', category: 'decor', layer: 'floor', w: 1, h: 2, price: 40, art: 'hanabin' },
  { id: 'ranpu', name: 'らんぷ', category: 'decor', layer: 'floor', w: 1, h: 2, price: 40, art: 'ranpu', light: { cx: 11.5, cy: 17 } },
  // 照明5点（v44）。`light` を持つだけで夜の自動点灯・タップON/OFF・朝4時消灯が効く（半径・強さは既存と共通）
  { id: 'kinoko-ranpu', name: 'きのこらんぷ', category: 'decor', layer: 'floor', w: 1, h: 1, price: 40, art: 'kinoko-ranpu', light: { cx: 11, cy: 12 } },
  { id: 'tamago-ranpu', name: 'たまごらんぷ', category: 'decor', layer: 'floor', w: 1, h: 1, price: 100, art: 'tamago-ranpu', light: { cx: 11, cy: 13 } },
  { id: 'hotaru-bin', name: 'ほたるびん', category: 'decor', layer: 'floor', w: 1, h: 1, price: 20, art: 'hotaru-bin', light: { cx: 11, cy: 14 } },
  { id: 'mikaduki-ranpu', name: 'みかづきらんぷ', category: 'decor', layer: 'floor', w: 1, h: 2, price: 60, art: 'mikaduki-ranpu', light: { cx: 10, cy: 10 } },
  { id: 'pengin-light', name: 'ぺんぎんライト', category: 'decor', layer: 'floor', w: 1, h: 1, price: 60, art: 'pengin-light', light: { cx: 11, cy: 18 } },

  /* みどり（15点目〜17点目） */
  { id: 'happa', name: 'はっぱ', category: 'green', layer: 'floor', w: 1, h: 2, price: 40, art: 'happa' },
  { id: 'saboten', name: 'さぼてん', category: 'green', layer: 'floor', w: 1, h: 1, price: 20, art: 'saboten' },
  { id: 'hana', name: 'はな', category: 'green', layer: 'floor', w: 1, h: 1, price: 20, art: 'hana' },

  /* じゅうたん（18点目・19点目） */
  { id: 'maruragu', name: 'まるらぐ', category: 'rug', layer: 'rug', w: 4, h: 2, price: 60, art: 'maruragu' },
  { id: 'shimaragu', name: 'しまらぐ', category: 'rug', layer: 'rug', w: 3, h: 2, price: 40, art: 'shimaragu' },

  /* かべとゆか（20点目〜23点目・22ドットのタイルをそのまま敷く） */
  { id: 'hoshizora', name: 'ほしぞら', category: 'surface', layer: 'surface', surface: 'wallpaper', tile: 'hoshizora', w: 1, h: 1, price: 100, art: 'hoshizora' },
  { id: 'mizutama', name: 'みずたま', category: 'surface', layer: 'surface', surface: 'wallpaper', tile: 'mizutama', w: 1, h: 1, price: 40, art: 'mizutama' },
  { id: 'kinoyuka', name: 'きのゆか', category: 'surface', layer: 'surface', surface: 'floor', tile: 'kinoyuka', w: 1, h: 1, price: 40, art: 'kinoyuka' },
  { id: 'ishinoyuka', name: 'いしのゆか', category: 'surface', layer: 'surface', surface: 'floor', tile: 'ishinoyuka', w: 1, h: 1, price: 60, art: 'ishinoyuka' },

  /* ぼうし（6点）。価格は4帯のうち20/40/60だけを使い、合計220（28点1240＋220＝1460） */
  { id: 'hat-cap', name: 'ぼうし', category: 'hat', layer: 'accessory', price: 20, hat: HATS['hat-cap'] },
  { id: 'hat-ribbon', name: 'りぼん', category: 'hat', layer: 'accessory', price: 20, hat: HATS['hat-ribbon'] },
  { id: 'hat-flower-crown', name: 'はなかんむり', category: 'hat', layer: 'accessory', price: 40, hat: HATS['hat-flower-crown'] },
  { id: 'hat-star-cap', name: 'ほしのぼうし', category: 'hat', layer: 'accessory', price: 40, hat: HATS['hat-star-cap'] },
  { id: 'hat-crown', name: 'おうかん', category: 'hat', layer: 'accessory', price: 60, hat: HATS['hat-crown'] },
  { id: 'hat-snow-cap', name: 'ゆきのぼうし', category: 'hat', layer: 'accessory', price: 40, hat: HATS['hat-snow-cap'] },
]);

/** ショップに並ぶ商品（初期家具は含めない） */
export const SHOP_ITEMS = SHOP_PRODUCTS;

/** カタログ全体（初期家具・所持品・ショップ商品）。IDから引く用 */
export const ALL_ITEMS = Object.freeze([...INITIAL_ITEMS, ...OWNED_ITEMS, ...SHOP_PRODUCTS]);
