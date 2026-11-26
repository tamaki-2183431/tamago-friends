/**
 * アーケード系ミニゲーム（v34）の**コード描画**の絵。外部画像は追加しない。
 *
 * 24×24 の論理ドットを、`drawPet` と同じ考え方（整数倍・NEAREST）で canvas に描く。
 * - ごはんキャッチの食べもの: リンゴ・バナナ・クッキー・プリン・ケーキ
 *   （クッキー/プリン/ケーキは既存の「たべもの」データと同じ名前・同じ色づかい）
 * - ジャンプチャレンジの障害物: 植木鉢・ブロック・おもちゃ
 *
 * **新しい画像ファイルは作らない**（すべて canvas の矩形で描く）。
 */

/** 論理ドット数（ペットのドット絵と同じ 24×24） */
export const ART_SIZE = 24;

/** 1マスずつ色を決めて描く（fill は 0..23 の座標で色か null を返す） */
function paint(canvas, size, fill) {
  const dpr = globalThis.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((size * dpr) / ART_SIZE));
  const dimension = ART_SIZE * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  canvas.style.width = `${dimension / dpr}px`;
  canvas.style.height = `${dimension / dpr}px`;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, dimension, dimension);
  context.imageSmoothingEnabled = false;
  for (let y = 0; y < ART_SIZE; y += 1) {
    for (let x = 0; x < ART_SIZE; x += 1) {
      const color = fill(x, y);
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

/** 円の内側か（中心・半径はドット座標） */
function inCircle(x, y, cx, cy, r) {
  return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
}

/** 楕円の内側か */
function inEllipse(x, y, cx, cy, rx, ry) {
  return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
}

/* ------------------------------------------------------------ たべもの */

const FOODS = {
  /** リンゴ: 赤い丸・ヘタ・葉・ハイライト */
  apple: (x, y) => {
    if (inCircle(x, y, 12, 14, 8)) {
      if (inCircle(x, y, 12, 14, 8) && !inCircle(x, y, 12, 14, 6.9)) return '#a8292c';
      if (inCircle(x, y, 8.6, 11.4, 2.1)) return '#ff9a90';
      return '#e8473f';
    }
    if (x >= 11 && x <= 12 && y >= 4 && y <= 7) return '#7a4a25';
    if (inEllipse(x, y, 15.5, 5.2, 3.2, 1.9)) return '#5cb85c';
    return null;
  },
  /** バナナ: 下向きの三日月・両端は濃い黄色 */
  banana: (x, y) => {
    if (!inCircle(x, y, 12, 9, 9.2)) return null;
    if (inCircle(x, y, 12, 2.8, 7.6)) return null;
    if (x <= 4 || x >= 19) return '#b98a1e';
    if (y <= 13) return '#ffe985';
    return '#ffd95e';
  },
  /** クッキー: 焼き色の丸・チョコチップ */
  cookie: (x, y) => {
    if (!inCircle(x, y, 12, 12, 8.4)) return null;
    const chips = [[8, 9], [14, 8], [10, 14], [16, 13], [7, 13]];
    if (chips.some(([cx, cy]) => (x === cx && y === cy) || (x === cx + 1 && y === cy))) return '#5a3b1e';
    if (!inCircle(x, y, 12, 12, 7.5)) return '#a9713a';
    return '#d9a05b';
  },
  /** プリン: 台の上のプリン・カラメル・ハイライト */
  pudding: (x, y) => {
    if (y >= 19 && y <= 21 && inEllipse(x, y, 12, 20, 9.5, 2.2)) return '#c7d2e0';
    if (y >= 8 && y <= 19) {
      const half = 3.6 + (y - 8) * 0.42;
      if (Math.abs(x + 0.5 - 12) <= half) {
        if (y <= 10) return '#c9762e';
        if (x >= 9 && x <= 10 && y >= 12 && y <= 15) return '#fff3c4';
        return '#ffe08a';
      }
    }
    if (y === 7 && Math.abs(x + 0.5 - 12) <= 3.4) return '#a85c22';
    return null;
  },
  /** 石ころ: 彩度の低いグレーの岩（食べものと一目で区別する・v35） */
  rock: (x, y) => {
    const cx = 12;
    const cy = 15;
    const body = ((x + 0.5 - cx) / 8.2) ** 2 + ((y + 0.5 - cy) / 6.4) ** 2 <= 1;
    if (!body) return null;
    // 下は平ら（地面に落ちた石）
    if (y >= 20) return '#5f646d';
    // 上端を少し ごつごつさせる
    if (y <= 9 && (x + y) % 5 === 0) return null;
    if (y <= 11) return '#b9bec6';
    if (y >= 18) return '#767c85';
    if (x <= 8 && y <= 17) return '#a7adb5';
    // ひび
    if ((x === 12 && y >= 10 && y <= 13) || (x === 13 && y >= 13 && y <= 15)) return '#5f646d';
    return '#8d939c';
  },
  /** ケーキ: 苺のショートケーキ（三角）・クリーム・苺 */
  cake: (x, y) => {
    const top = 7;
    const bottom = 21;
    if (y < top - 2 || y > bottom) return null;
    const shrink = (y - top) * 0.32;
    const left = 5 + shrink;
    const right = 19 - shrink;
    if (y >= top && y <= bottom && x + 0.5 >= left && x + 0.5 <= right) {
      if (y >= 13 && y <= 15) return '#f2727f';
      if (y === 16) return '#fff7ec';
      if (y >= 19) return '#e8c48e';
      return '#fff0d8';
    }
    // 上のクリームと苺
    if (inEllipse(x, y, 12, top - 1.2, 3.4, 1.6)) return '#ffffff';
    if (inCircle(x, y, 12, top - 3, 2)) return '#e8473f';
    return null;
  },
};

/* ------------------------------------------------------------ 障害物 */

const OBSTACLES = {
  /** 岩（v35・地上の障害物）。石ころと同じ絵を大きく使う */
  rock: FOODS.rock,
  /** 植木鉢: 茶色の鉢・縁・葉 */
  pot: (x, y) => {
    if (inEllipse(x, y, 12, 8, 3, 2.4) || inEllipse(x, y, 8.5, 9.5, 2.6, 1.9) || inEllipse(x, y, 15.5, 9.5, 2.6, 1.9)) return '#6fbf73';
    if (y === 12 && x >= 4 && x <= 19) return '#8a5334';
    if (y >= 13 && y <= 21) {
      const half = 7.2 - (y - 13) * 0.35;
      if (Math.abs(x + 0.5 - 12) <= half) return y <= 15 ? '#d98a5f' : '#c1764d';
    }
    return null;
  },
  /** ブロック: 青い積み木・上面・2つのポッチ */
  block: (x, y) => {
    if (y >= 10 && y <= 21 && x >= 4 && x <= 19) {
      if (y <= 12) return '#9cc7ff';
      if (y === 13) return '#5b93d6';
      return '#6aa9f0';
    }
    if (inCircle(x, y, 8, 8.5, 1.4) || inCircle(x, y, 15, 8.5, 1.4)) return '#9cc7ff';
    return null;
  },
  /** おもちゃ: しましまのボール */
  toy: (x, y) => {
    if (!inCircle(x, y, 12, 13, 8.2)) return null;
    if (y === 7 || y === 9) return '#fff6fb';
    if (y === 11 || y === 13) return '#7ed0c0';
    if (!inCircle(x, y, 12, 13, 7.4)) return '#c76a94';
    return '#f2a3c7';
  },
};

/** カラス: 空を飛ぶ黒い鳥（v35・ジャンプ中だけ当たる） */
const CROW = (x, y) => {
  // 体
  if (inEllipse(x, y, 12, 14, 6.4, 4.4)) {
    if (x >= 14 && y <= 12 && inCircle(x, y, 17, 10.5, 2.9)) return '#3b3f4a';
    if (x >= 18 && x <= 21 && y >= 10 && y <= 11) return '#f0a23c'; // くちばし
    if (x === 15 && y === 10) return '#ffffff'; // 目
    return '#31353f';
  }
  // 頭
  if (inCircle(x, y, 17, 10.5, 2.9)) {
    if (x === 17 && y === 10) return '#ffffff';
    return '#3b3f4a';
  }
  // 羽（左右に広げる）
  if (y >= 6 && y <= 10 && x >= 2 && x <= 9 && (x + y) % 2 === 0) return '#23262e';
  if (y >= 12 && y <= 16 && x >= 2 && x <= 7) return '#23262e';
  // 尾
  if (y >= 13 && y <= 16 && x >= 18 && x <= 21) return '#23262e';
  return null;
};

/** 食べものの絵を描く（知らない id はリンゴ） */
export function drawFood(canvas, foodId, { size = 46 } = {}) {
  const fill = FOODS[foodId] ?? FOODS.apple;
  canvas.dataset.food = foodId;
  paint(canvas, size, fill);
  return canvas;
}

/**
 * カラスの絵（24ドット）が実際に塗られる範囲の**下の余白**（ドット数）。
 * `CROW` は 16行目までしか塗らないので、17〜23行（7ドット）が空く（v36）。
 * 空を飛ぶ帯（`crowMinPx`〜`crowMaxPx`）に絵の胴体を合わせるために使う。
 */
export const CROW_ART_GAP_ROWS = ART_SIZE - 16 - 1;

/** カラスの絵を描く（サイズだけ指定・24×24 のコード描画） */
export function drawCrow(canvas, { size = 30 } = {}) {
  paint(canvas, size, CROW);
  return canvas;
}

/** 障害物の絵を描く（知らない種類は植木鉢） */
export function drawObstacle(canvas, kind, { size = 34 } = {}) {
  const fill = OBSTACLES[kind] ?? OBSTACLES.pot;
  canvas.dataset.obstacle = kind;
  paint(canvas, size, fill);
  return canvas;
}

/** 食べものの名前（読み上げ用） */
export const FOOD_LABELS = Object.freeze({
  apple: 'りんご',
  banana: 'バナナ',
  cookie: 'クッキー',
  pudding: 'プリン',
  cake: 'ケーキ',
  rock: 'いしころ',
});

/** 障害物の名前（読み上げ用） */
export const OBSTACLE_LABELS = Object.freeze({
  pot: 'うえきばち',
  block: 'ブロック',
  toy: 'おもちゃ',
});
