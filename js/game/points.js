/**
 * 点数の累計と孵化権の計算（副作用なし・DOM/DB 非依存）。
 *
 * ルール（Phase 1 確定仕様）
 * - 点数は累計にそのまま加算する。
 * - 累計 1,000 点ごとに孵化権 1。余りは次の 1,000 点へ繰り越す。
 * - 1 回で複数の 1,000 点を超えたら、超えた数だけ付与する。
 * - 累計の最高到達点 (highWaterMark) を保存し、そこからの超過分だけ付与する。
 *   → 訂正で累計が下がっても付与済みの孵化権は減らず、再び超えても二重付与にならない。
 * - 累計は 0 未満にしない（0 で頭打ち）。
 */

export const POINTS_PER_HATCH = 1000;

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

/** 欠損や壊れた値から常に使える状態を作る */
export function createState(init = {}) {
  const total = Math.max(0, toInt(init.total));
  return {
    total,
    highWaterMark: Math.max(total, toInt(init.highWaterMark)),
    hatchTokens: Math.max(0, toInt(init.hatchTokens)),
  };
}

/** 点数を1件足す（＝差分を適用する）。訂正は負の差分として渡す。 */
export function applyDelta(state, delta) {
  const before = createState(state);
  const amount = toInt(delta);
  const total = Math.max(0, before.total + amount);
  const highWaterMark = Math.max(before.highWaterMark, total);
  const granted =
    Math.floor(highWaterMark / POINTS_PER_HATCH) - Math.floor(before.highWaterMark / POINTS_PER_HATCH);
  const hatchTokens = before.hatchTokens + granted;

  return {
    before,
    state: { total, highWaterMark, hatchTokens },
    requestedDelta: amount,
    appliedDelta: total - before.total,
    granted,
    clamped: total - before.total !== amount,
  };
}

/** 累計を「この値にする」形で更新する（訂正・削除の再計算用） */
export function applyTotal(state, nextTotal) {
  const before = createState(state);
  return applyDelta(before, Math.max(0, toInt(nextTotal)) - before.total);
}

/** 記録（点数）の一覧から累計を求める。有効なものだけを合計する。 */
export function sumPoints(records) {
  return (records ?? []).reduce((sum, record) => {
    if (!record || record.deleted) return sum;
    return sum + toInt(record.points);
  }, 0);
}

/** 画面表示用の要約（次の孵化までの進捗など） */
export function summarize(state) {
  const current = createState(state);
  const remainder = current.total % POINTS_PER_HATCH;
  return {
    ...current,
    remainder,
    nextHatchNeed: POINTS_PER_HATCH - remainder,
    progress: remainder / POINTS_PER_HATCH,
    earnedHatches: Math.floor(current.highWaterMark / POINTS_PER_HATCH),
  };
}

/** 孵化権が増えた回数（演出用に、跨いだ 1,000 点の一覧を返す） */
export function crossedThresholds(beforeState, afterTotal) {
  const before = createState(beforeState);
  const total = Math.max(before.highWaterMark, Math.max(0, toInt(afterTotal)));
  const from = Math.floor(before.highWaterMark / POINTS_PER_HATCH);
  const to = Math.floor(total / POINTS_PER_HATCH);
  const list = [];
  for (let index = from + 1; index <= to; index += 1) list.push(index * POINTS_PER_HATCH);
  return list;
}

/**
 * 点数の入力チェック（親画面・テストで共用）。
 * 仕様: 0 以上 100,000 以下の整数のみ（マイナス・小数は不可）。
 */
export function validatePointsInput(points) {
  const value = Number(points);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: '点数は 0〜100,000 の整数で入力してください（小数は不可）' };
  }
  if (value < 0) return { ok: false, message: '点数は 0 以上で入力してください（マイナスは不可）' };
  if (value > 100000) return { ok: false, message: '1回の入力は 100,000 点までです' };
  return { ok: true, value };
}
