/**
 * ペットルーム（Phase 3-1）の定数と家具データ。
 * 家具は「id・種類・セル座標・サイズ」だけを持つ（3-2 でドラッグ移動・ショップに対応できる形）。
 */

/** 1マスの大きさ（px）。CSS の --tile と合わせる */
export const TILE = 44;

/** 1画面ぶんの列数・行数 */
export const SCREEN_COLS = 12;
export const ROOM_ROWS = 8;

/** この匹数を超えたら、3匹ごとに横1画面ぶん広がる */
export const EXPAND_AFTER = 3;
export const EXPAND_BY = 3;

/**
 * 初期配置（room-set-01.md §4）。col/row は左上セル、w/h はセル数。
 * ラグは背景に焼き込まず「はじまりのラグ」として動かせる家具にする（じゅうたんレイヤー）。
 * 掛け時計だけ壁掛け。
 */
export const FURNITURE = Object.freeze([
  { id: 'hajimari-rug', kind: 'rug', name: 'はじまりのラグ', col: 4, row: 5, w: 4, h: 2, layer: 'rug' },
  { id: 'bed-1', kind: 'bed', name: 'ベッド', col: 2, row: 3, w: 3, h: 2, layer: 'floor' },
  { id: 'desk-1', kind: 'desk', name: 'つくえ', col: 5, row: 3, w: 2, h: 2, layer: 'floor' },
  { id: 'bookshelf-1', kind: 'bookshelf', name: 'ほんだな', col: 8, row: 3, w: 2, h: 2, layer: 'floor' },
  { id: 'plant-1', kind: 'plant', name: 'かんよう しょくぶつ', col: 10, row: 3, w: 2, h: 2, layer: 'floor' },
  { id: 'clock-1', kind: 'clock', name: 'かけどけい', col: 8, row: 0, w: 1, h: 2, layer: 'wall' },
]);

/** 所持だけして置いていない家具（ごはんばち・ボール＝商品ではない。data/shop.js と同じ値） */
export const UNPLACED_ITEM_IDS = Object.freeze(['gohanbachi', 'ball']);

/** 床の開始行（壁は0〜2行目） */
export const FLOOR_ROW = 3;

/** 天気（起動ごとにランダム）。weight は出現しやすさ */
export const WEATHERS = Object.freeze([
  { id: 'sunny', label: 'はれ', icon: '☀️', weight: 40 },
  { id: 'cloudy', label: 'くもり', icon: '☁️', weight: 24 },
  { id: 'rain', label: 'あめ', icon: '🌧️', weight: 16 },
  { id: 'snow', label: 'ゆき', icon: '❄️', weight: 10 },
  { id: 'star', label: 'ほしぞら', icon: '🌙', weight: 10 },
]);

/** 時間帯（4時・10時・16時・19時で切り替え） */
export const PERIODS = Object.freeze([
  { id: 'morning', label: 'あさ', from: 4 },
  { id: 'day', label: 'ひる', from: 10 },
  { id: 'evening', label: 'ゆうがた', from: 16 },
  { id: 'night', label: 'よる', from: 19 },
]);

/** 家具の種類ごとの見た目パラメータ（描画用） */
export const FURNITURE_LOOKS = Object.freeze({
  bed: { body: '#c9b6ff', accent: '#8f79d8', pillow: '#fff6e5' },
  bowl: { body: '#ffb3c7', accent: '#e06a90', food: '#ffcf6b' },
  ball: { body: '#7fd6c6', accent: '#2f9d8b' },
  plant: { body: '#7bbf6a', accent: '#3f8a3c', pot: '#d99b6c' },
  lamp: { body: '#ffe08a', accent: '#d9a73a', pole: '#b08a5a' },
});

/** チュートリアル（初回のみ3枚） */
export const TUTORIAL = Object.freeze([
  {
    title: 'ここは みんなの へや',
    body: 'ペットたちが じぶんで あるいたり ねたり しているよ。',
    art: 'room',
  },
  {
    title: 'ペットを タップすると おせわ',
    body: 'ごはん・あそぶ・なでる など、シートで おせわできるよ。',
    art: 'care',
  },
  {
    title: 'ミニゲームで あそべるよ',
    body: 'したの「あそぶ」から ゲーム、「ずかん」から ペットの ずかんを ひらけるよ。',
    art: 'future',
  },
]);
