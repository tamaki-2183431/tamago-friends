/**
 * ペットのドット絵（24×24）。data/pet-designs.js の文字グリッド（designs-20.md が唯一の正）を
 * そのまま使い、段階（baby / child / adult）と表情に応じたグリッドを組み立てて canvas に描く。
 *
 * - 枠は 24×24 固定・足元は y=21 固定・描画は整数倍（`scale = floor(size × dpr / 24)` + NEAREST）
 * - 段階差は「頭10行固定＋胴4/6/7行」（designs-20.md §4）。頭は y8/6/5 に置き、
 *   胴はこども段階の6行を 4/6/7 行へ伸縮、付属物は段階で伸びる（上端は y0 以上）
 * - 顔は目型A〜E×口型1〜4の座標式で描く（designs-20.md §2〜§5）。
 *   通常の表情は設計グリッドと完全一致する（データと実装の一致をテストで固定）
 * - 色は5役割だけ: O=ink / B=body / L,H=highlight / A=accent / C=cheek
 */

import { EYE_TYPES, MOUTH_TYPES, PET_DESIGNS, SPECIES_INTROS, STAGE_IDS } from '../../data/pet-designs.js';

export { STAGE_IDS, EYE_TYPES, MOUTH_TYPES };

export const SPRITE_SIZE = 24;
/** 足元（全段階・全種で固定） */
export const FOOT_ROW = 21;
/** 体の高さ（ベビー14 / こども16 / おとな17）。足元は動かさない */
export const STAGE_HEIGHTS = Object.freeze({ baby: 14, child: 16, adult: 17 });
/** 頭の行数（全段階で固定。designs-20.md §4） */
export const HEAD_ROWS = 10;
/** 胴の行数（ベビー4 / こども6 / おとな7） */
export const BODY_ROWS = Object.freeze({ baby: 4, child: 6, adult: 7 });
// 付属物の段階行数は §1 グリッド基準（§4 の表より優先。例: トノ 4/5/5・ホシ 2/3/4）。
/** 頭の上端（ベビー y8 / こども y6 / おとな y5） */
export const HEAD_TOP = Object.freeze({ baby: 8, child: 6, adult: 5 });

/** 設計グリッドは「こども段階」＝ 頭 y6..15 / 胴 y16..21 / 付属物 y0..5 */
const SOURCE_HEAD_TOP = 6;
const SOURCE_BODY_ROWS = 6;
/** 目の上端 = 頭の上端 + 4（designs-20.md §4） */
const EYE_OFFSET = 4;
/** 目と口の間の体色1ドット（designs-20.md §3） */
const MOUTH_GAP = 1;
/** これ以上の長さの O の横一列は「構造線」（角型の首の線など）として表情で消さない */
const STRUCTURAL_RUN = 6;

/* ------------------------------------------------------------ 下ごしらえ */

function blankGrid() {
  return Array.from({ length: SPRITE_SIZE }, () => Array(SPRITE_SIZE).fill('.'));
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < SPRITE_SIZE && y < SPRITE_SIZE;
}

function put(grid, x, y, value) {
  if (!inBounds(x, y)) return;
  grid[y][x] = value;
}

const rowText = (row) => row.join('');

/**
 * 行の配列をほかの行数へ。
 * - 増やす: 上端と下端を固定して内側を引き伸ばす（段階で付属物が伸びる）
 * - 減らす: 上から順に残す（頭に接する側の輪郭は頭の輪郭と重なるので落とせる）
 * - 1行: 真ん中の行（色が乗っている行）を使う
 */
function resampleRows(rows, count) {
  if (count <= 0 || rows.length === 0) return [];
  if (rows.length === count) return rows.map((row) => [...row]);
  if (count === 1) return [[...rows[Math.ceil((rows.length - 1) / 2)]]];
  if (count < rows.length) return rows.slice(0, count).map((row) => [...row]);
  return Array.from({ length: count }, (_, index) => {
    const at = Math.round((index * (rows.length - 1)) / (count - 1));
    return [...rows[at]];
  });
}

const templateCache = new WeakMap();

/** 設計グリッドを 付属物 / 頭10行 / 胴6行 に切り分ける（結果はキャッシュ） */
function templateOf(design) {
  const cached = templateCache.get(design);
  if (cached) return cached;
  const rows = (design.grid ?? []).map((row) => [...String(row).padEnd(SPRITE_SIZE, '.')]);
  while (rows.length < SPRITE_SIZE) rows.push(Array(SPRITE_SIZE).fill('.'));
  const head = rows.slice(SOURCE_HEAD_TOP, SOURCE_HEAD_TOP + HEAD_ROWS);
  const body = rows.slice(SOURCE_HEAD_TOP + HEAD_ROWS, SOURCE_HEAD_TOP + HEAD_ROWS + SOURCE_BODY_ROWS);
  const above = rows.slice(0, SOURCE_HEAD_TOP);
  const firstAccessoryRow = above.findIndex((row) => row.some((char) => char !== '.'));
  const accessoryRows = firstAccessoryRow < 0 ? [] : above.slice(firstAccessoryRow);
  const template = { head, body, accessoryRows };
  templateCache.set(design, template);
  return template;
}

/* ------------------------------------------------------------ デザイン解決 */

const LEGACY_SHAPE = Object.freeze({ round: 'S1', egg: 'S7', tall: 'S5', wide: 'S2', blob: 'S8' });

/** 既存 shape データから暫定のグリッドを作る（実データでは使わないフォールバック） */
const LEGACY_PROFILES = Object.freeze({
  round: [0.3, 0.52, 0.68, 0.8, 0.9, 0.96, 1, 1, 1, 0.98, 0.94, 0.86, 0.74, 0.56, 0.34],
  egg: [0.22, 0.36, 0.5, 0.62, 0.73, 0.82, 0.89, 0.95, 0.99, 1, 1, 0.97, 0.9, 0.74, 0.48],
  wide: [0.42, 0.64, 0.8, 0.92, 0.98, 1, 1, 1, 1, 1, 1, 0.99, 0.94, 0.8, 0.56],
  tall: [0.3, 0.5, 0.62, 0.7, 0.76, 0.8, 0.82, 0.84, 0.84, 0.83, 0.8, 0.74, 0.65, 0.52, 0.34],
  blob: [0.32, 0.6, 0.8, 0.93, 1, 1, 1, 1, 0.99, 0.96, 0.9, 0.8, 0.66, 0.46, 0.24],
});
const LEGACY_HALF = Object.freeze({ round: 7, egg: 6, wide: 8, tall: 5, blob: 7 });

function provisionalGrid(shape) {
  const legacy = shape?.body ?? 'round';
  const profile = LEGACY_PROFILES[legacy] ?? LEGACY_PROFILES.round;
  const maxHalf = LEGACY_HALF[legacy] ?? 7;
  const grid = blankGrid();
  const rows = resampleRows(
    Array.from({ length: profile.length }, (_, index) => [profile[index]]),
    FOOT_ROW - SOURCE_HEAD_TOP + 1,
  ).map(([value]) => value);
  rows.forEach((value, index) => {
    const y = SOURCE_HEAD_TOP + index;
    const half = Math.max(2, Math.round(value * maxHalf));
    for (let x = 12 - half - 1; x <= 11 + half + 1; x += 1) put(grid, x, y, 'O');
    for (let x = 12 - half; x <= 11 + half; x += 1) put(grid, x, y, 'B');
    if (index >= 2 && index <= 4) {
      for (let x = 12 - half + 1; x <= 12 - half + 2; x += 1) put(grid, x, y, 'L');
    }
  });
  // 耳（付属物）: 上端が枠内に収まる範囲で
  const ears = shape?.ears ?? 'none';
  if (ears !== 'none') {
    const tall = ears === 'long' ? 4 : 2;
    const top = SOURCE_HEAD_TOP - tall;
    for (const side of [-1, 1]) {
      const base = 12 + side * 4 - (side < 0 ? 1 : 0);
      for (let step = 0; step < tall; step += 1) {
        const width = ears === 'pointy' ? Math.max(1, 2 - Math.floor(step / 2)) : 2;
        for (let k = 0; k < width; k += 1) put(grid, base + side * (wideRow(step)) + k, top + step, step === 0 ? 'O' : 'B');
      }
    }
  }
  return grid.map(rowText);
}

function wideRow(step) {
  return Math.floor(step / 2);
}

/** 既存 shape データ（体・耳・しっぽ・模様）から暫定デザインを作る */
export function provisionalDesign(species) {
  const palette = species?.palette ?? {};
  const body = palette.body ?? '#ffe3ec';
  const accent = palette.accent ?? '#ffb0c6';
  const dark = palette.dark ?? '#c97f96';
  return {
    id: species?.id ?? 'provisional',
    provisional: true,
    motif: '暫定',
    shape: LEGACY_SHAPE[species?.shape?.body] ?? 'S1',
    status: 'provisional',
    face: { eye: 'A', mouth: 1 },
    palette: { ink: dark, body, highlight: '#fffaf4', accent, cheek: accent },
    grid: provisionalGrid(species?.shape),
  };
}

/** 種データ → 設計データ（final → 暫定の順に解決） */
export function resolveDesign(species) {
  if (species?.design) return species.design;
  if (species?.id && PET_DESIGNS[species.id]) return PET_DESIGNS[species.id];
  return provisionalDesign(species);
}

/** 種の1行紹介 */
export function speciesIntro(species) {
  return species?.intro ?? SPECIES_INTROS[species?.id] ?? '';
}

function stageIndexOf(stage) {
  const index = STAGE_IDS.indexOf(stage);
  return index < 0 ? 1 : index;
}

/* ------------------------------------------------------------ 段階の組み立て */

/**
 * 設計グリッド（こども段階）から、指定段階の「顔を除く」ベースを作る。
 * 頭10行はそのまま、胴6行は 4/6/7 行へ伸縮、付属物は段階の高さへ伸縮して
 * 頭の上端に接するように置く（上端は y0 以上）。
 */
function composeBase(design, stageIndex) {
  const template = templateOf(design);
  const stage = STAGE_IDS[stageIndex] ?? 'child';
  const headTop = HEAD_TOP[stage];
  const bodyRows = BODY_ROWS[stage];
  const grid = blankGrid();

  for (let index = 0; index < HEAD_ROWS; index += 1) grid[headTop + index] = [...template.head[index]];
  const bodyTop = headTop + HEAD_ROWS;
  resampleRows(template.body, bodyRows).forEach((row, index) => {
    grid[bodyTop + index] = row;
  });

  let accessory = null;
  if (template.accessoryRows.length) {
    const source = template.accessoryRows.length;
    const wanted = design.accessory?.heights?.[stageIndex] ?? source + (stageIndex - 1);
    const height = Math.max(1, Math.min(headTop, wanted));
    const rows = resampleRows(template.accessoryRows, height);
    const top = headTop - height;
    rows.forEach((row, index) => {
      grid[top + index] = row;
    });
    accessory = { top, height };
  }

  return { grid, headTop, bodyTop, bodyRows, accessory, stage, stageIndex };
}

/* ------------------------------------------------------------ 顔（目型×口型） */

/** 目型A〜E（designs-20.md §2。左目・幅×高は全種共通） */
const EYE_SHAPES = Object.freeze({
  A: ['.OO.', 'OHOO', 'OOOO', '.OO.'],
  B: ['OOO', 'OHO', 'OOO', 'OOO'],
  C: ['OOOO', 'OHOO', 'OOOO', '.OO.'],
  D: ['.OO.', 'OHHO', '.OO.'],
  E: ['OHHO', 'OHHO', 'OOOO', 'OOHO'],
});

/** 口型1〜4（designs-20.md §3。左端 x=10） */
const MOUTH_SHAPES = Object.freeze({
  1: ['O..O', '.OO.'],
  2: ['OCCO', 'OOOO'],
  3: ['OOOO'],
  4: ['.OO.', 'O..O'],
});

/** 表情の置換マトリクス（designs-20.md §5） */
const HAPPY_EYES = ['.OO.', 'O..O'];
const CLOSED_EYES = ['.OO.'];
const STRAIGHT_MOUTH = ['OOOO'];
const OPEN_MOUTH = ['OCCO', 'OOOO'];
const SLEEP_MOUTH = ['OC'];

const BODY_CHARS = new Set(['B', 'L', 'C']);

function faceGeometry(design, base) {
  const face = design.face ?? {};
  const key = EYE_SHAPES[face.eye] ? face.eye : 'A';
  const rows = EYE_SHAPES[key];
  const eyeWidth = rows[0].length;
  const eyeHeight = rows.length;
  const eyeLeft = face.eyeLeft ?? 11 - eyeWidth;
  const slotLeft = face.eyeLeft ?? 7;
  const eyeTop = base.headTop + EYE_OFFSET;
  const mouthType = MOUTH_SHAPES[face.mouth] ? face.mouth : 1;
  return {
    key,
    rows,
    eyeWidth,
    eyeHeight,
    eyeLeft,
    slotLeft,
    slotRight: 20 - slotLeft,
    eyeTop,
    mouthType,
    mouthTop: eyeTop + eyeHeight + MOUTH_GAP,
  };
}

/** 表情ごとの目の行列（side: -1=左目 / +1=右目。外側の向き） */
function eyeMatrixFor(geometry, expression, blink, side) {
  if (blink || expression === 'sleep') {
    return { rows: CLOSED_EYES, shift: Math.round((geometry.eyeHeight - 1) / 2) };
  }
  if (expression === 'happy') {
    return { rows: HAPPY_EYES, shift: Math.round((geometry.eyeHeight - 2) / 2) };
  }
  if (expression === 'tired') {
    // 最上段を削って1行下げる（半目）
    return { rows: geometry.rows.slice(1), shift: 1 };
  }
  if (expression === 'good' || expression === 'bad') {
    const rows = geometry.rows.map((row) => [...row]);
    const last = rows.length - 1;
    const cells = rows[last];
    const outer = side < 0 ? cells.indexOf('O') : cells.lastIndexOf('O');
    if (outer >= 0) cells[outer] = expression === 'good' ? 'H' : '.';
    return { rows: rows.map(rowText), shift: 0 };
  }
  return { rows: geometry.rows, shift: 0 };
}

/** 表情ごとの口の行列 */
function mouthMatrixFor(geometry, expression) {
  if (expression === 'happy') return OPEN_MOUTH;
  if (expression === 'tired') return STRAIGHT_MOUTH;
  if (expression === 'bad') return MOUTH_SHAPES[4];
  if (expression === 'sleep') return SLEEP_MOUTH;
  return MOUTH_SHAPES[geometry.mouthType];
}

/** 構造線（角型の首の線など、幅6以上の O の横一列）は表情で消さない */
function structuralCells(grid) {
  const cells = new Set();
  for (let y = 0; y < SPRITE_SIZE; y += 1) {
    let run = 0;
    for (let x = 0; x <= SPRITE_SIZE; x += 1) {
      const ink = x < SPRITE_SIZE && grid[y][x] === 'O';
      if (ink) {
        run += 1;
        continue;
      }
      if (run >= STRUCTURAL_RUN) {
        for (let k = x - run; k < x; k += 1) cells.add(`${y}:${k}`);
      }
      run = 0;
    }
  }
  return cells;
}

function stamp(grid, rows, left, top, structural) {
  rows.forEach((row, dy) => {
    [...row].forEach((char, dx) => {
      if (char === '.') return;
      const x = left + dx;
      const y = top + dy;
      if (!inBounds(x, y)) return;
      if (structural?.has(`${y}:${x}`)) return;
      if (grid[y][x] === '.') return;
      put(grid, x, y, char);
    });
  });
}

/**
 * 顔（目・口）を描く。designs-20.md §5 のとおり、目と口のセルだけを差し替え、
 * 体・輪郭・ほっぺの位置は動かさない。normal を渡すと設計グリッドと一致する。
 */
function paintFace(grid, design, base, expression, blink) {
  const geometry = faceGeometry(design, base);
  const structural = structuralCells(grid);
  const clear = (x0, y0, width, height) => {
    for (let y = y0; y < y0 + height; y += 1) {
      for (let x = x0; x < x0 + width; x += 1) {
        if (!inBounds(x, y)) continue;
        if (grid[y][x] === '.') continue;
        if (structural.has(`${y}:${x}`)) continue;
        put(grid, x, y, 'B');
      }
    }
  };
  // 目は4幅スロット、口は4幅（寝顔は2幅）を消してから描く
  clear(geometry.slotLeft, geometry.eyeTop, 4, geometry.eyeHeight);
  clear(geometry.slotRight, geometry.eyeTop, 4, geometry.eyeHeight);
  clear(10, geometry.mouthTop, 4, 2);

  for (const side of [-1, 1]) {
    const { rows, shift } = eyeMatrixFor(geometry, expression, blink, side);
    const width = rows[0].length;
    // 目型と同じ幅なら目型の位置、4幅の表情行列ならスロットの左端
    const left = width === geometry.eyeWidth ? geometry.eyeLeft : geometry.slotLeft;
    const start = side < 0 ? left : 23 - (left + width - 1);
    stamp(grid, rows, start, geometry.eyeTop + shift, structural);
    if (expression === 'bad') {
      // 目尻に差し色1ドット（体の外・輪郭の上には置かない）
      const outerX = side < 0 ? geometry.slotLeft - 1 : geometry.slotRight + 4;
      const cornerY = geometry.eyeTop + geometry.eyeHeight - 2;
      const notchX = side < 0 ? geometry.slotLeft : geometry.slotRight + 3;
      const notchY = geometry.eyeTop + geometry.eyeHeight - 1;
      if (inBounds(outerX, cornerY) && BODY_CHARS.has(grid[cornerY][outerX])) put(grid, outerX, cornerY, 'A');
      else if (inBounds(notchX, notchY) && BODY_CHARS.has(grid[notchY][notchX])) put(grid, notchX, notchY, 'A');
    }
  }

  const mouthRows = mouthMatrixFor(geometry, expression);
  const mouthWidth = mouthRows[0].length;
  stamp(grid, mouthRows, Math.round(11.5 - mouthWidth / 2), geometry.mouthTop, structural);
}

/* ------------------------------------------------------------ 組み立て */

/**
 * 種データ → 24×24 の文字グリッド（純関数）
 * @param {object} species
 * @param {{stage?:string, expression?:string, blink?:boolean}} options
 */
export function buildGrid(species, { stage = 'child', expression = 'normal', blink = false } = {}) {
  const design = resolveDesign(species);
  const base = composeBase(design, stageIndexOf(stage));
  paintFace(base.grid, design, base, expression, blink);
  return base.grid.map(rowText);
}

/** 体だけの寸法（テスト・レポート用）。段階ごとの体高 14/16/17 を検証する */
export function measureBody(species, stage = 'child') {
  const design = resolveDesign(species);
  const base = composeBase(design, stageIndexOf(stage));
  let maxHalf = 0;
  for (let y = base.headTop; y <= FOOT_ROW; y += 1) {
    const row = base.grid[y] ?? [];
    for (let x = 0; x < SPRITE_SIZE; x += 1) {
      if (row[x] === '.') continue;
      maxHalf = Math.max(maxHalf, Math.abs(x - 11.5));
    }
  }
  return {
    top: base.headTop,
    bottom: FOOT_ROW,
    height: FOOT_ROW - base.headTop + 1,
    maxHalf,
    bodyTop: base.bodyTop,
    bodyRows: base.bodyRows,
  };
}

/** 段階ごとの寸法（頭行数・胴行数・目型・口型）。数値レポート用 */
export function measureDesign(species, stage = 'child') {
  const design = resolveDesign(species);
  const stageIndex = stageIndexOf(stage);
  const base = composeBase(design, stageIndex);
  const geometry = faceGeometry(design, base);
  return {
    stage: STAGE_IDS[stageIndex],
    headTop: base.headTop,
    headRows: HEAD_ROWS,
    bodyTop: base.bodyTop,
    bodyRows: base.bodyRows,
    bodyHeight: FOOT_ROW - base.headTop + 1,
    footRow: FOOT_ROW,
    eye: geometry.key,
    eyeLeft: geometry.eyeLeft,
    eyeRight: 23 - (geometry.eyeLeft + geometry.eyeWidth - 1),
    eyeWidth: geometry.eyeWidth,
    eyeHeight: geometry.eyeHeight,
    eyeTop: geometry.eyeTop,
    mouth: geometry.mouthType,
    mouthTop: geometry.mouthTop,
    accessory: base.accessory,
  };
}

/** 外から渡したグリッドに顔だけ描く（たまごの絵など） */
export function applyFaceToGrid(rows, species, { stage = 'child', expression = 'normal', blink = false } = {}) {
  const design = resolveDesign(species);
  const grid = rows.map((row) => [...row]);
  const top = grid.findIndex((row) => row.some((char) => char !== '.'));
  const base = {
    grid,
    headTop: top < 0 ? HEAD_TOP[stageIndexOf(stage)] : top,
    bodyTop: top < 0 ? HEAD_TOP[stageIndexOf(stage)] + HEAD_ROWS : top + HEAD_ROWS,
  };
  paintFace(grid, design, base, expression, blink);
  return grid.map(rowText);
}

/** 表情の一覧（テスト・確認用） */
export function expressionList() {
  return ['happy', 'good', 'normal', 'tired', 'bad', 'sleep'];
}

/* ------------------------------------------------------------ 描画 */

/** グリッド文字 → 色の役割。新（O/B/L/H/A/C）と旧（b/d/w/a/i）の両方を受ける */
const CHAR_ROLES = Object.freeze({
  O: 'ink',
  B: 'body',
  L: 'highlight',
  H: 'highlight',
  A: 'accent',
  C: 'cheek',
  i: 'ink',
  b: 'body',
  d: 'shade',
  w: 'highlight',
  a: 'accent',
});

function paletteOf(design) {
  const palette = design.palette ?? {};
  return {
    ink: palette.ink ?? '#332a44',
    body: palette.body ?? '#ffe3ec',
    highlight: palette.highlight ?? '#ffffff',
    accent: palette.accent ?? '#ffb0c6',
    cheek: palette.cheek ?? palette.accent ?? '#ff8fa0',
    shade: palette.shade ?? palette.ink ?? '#332a44',
  };
}

/**
 * canvas にペットを描く。
 * @param {HTMLCanvasElement} canvas
 * @param {object} species
 * @param {{expression?:string, blink?:boolean, size?:number, stage?:string, grid?:string[]}} options
 */
export function drawPet(canvas, species, {
  expression = 'normal',
  blink = false,
  size = 120,
  stage = 'child',
  grid = null,
} = {}) {
  const design = resolveDesign(species);
  const rows = grid
    ? applyFaceToGrid(grid, species, { stage, expression, blink })
    : buildGrid(species, { stage, expression, blink });
  const dpr = globalThis.devicePixelRatio || 1;
  // 整数デバイスpxスナップ（24 で割り切れる倍率だけを使う）
  const scale = Math.max(1, Math.floor((size * dpr) / SPRITE_SIZE));
  const dimension = SPRITE_SIZE * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  canvas.style.width = `${dimension / dpr}px`;
  canvas.style.height = `${dimension / dpr}px`;
  canvas.dataset.species = species?.id ?? '';
  canvas.dataset.stage = stage;

  const context = canvas.getContext('2d');
  context.clearRect(0, 0, dimension, dimension);
  context.imageSmoothingEnabled = false;

  const palette = paletteOf(design);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const color = palette[CHAR_ROLES[row[x]] ?? 'none'];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x * scale, y * scale, scale, scale);
    }
  });

  return { grid: rows, dimension };
}
