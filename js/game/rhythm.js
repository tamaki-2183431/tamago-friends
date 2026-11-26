/**
 * リズムあそび（v38）の**純関数エンジン**。
 * DOM / IndexedDB / Date.now() に依存しない（乱数と時刻は引数で受け取る）。
 *
 * 流れ:
 * 1. 4つのランプ（ド・ミ・ソ・ド）が、決まった順番で1音ずつ光る（`noteMs` 光って `gapMs` 空く）
 * 2. 光り終わると入力の番（`phase:'input'`）。同じ順でタップする
 * 3. 全部正しく押せたら段階クリア（スコア＋1）。**音が1つ増えて**また再生する（最大 `maxLength` 音）
 * 4. 1音でも間違えたら即終了（その時点のクリア段階がスコア）。40秒の時間切れでも終了
 *
 * タイマーは持たない。画面が `stepRhythm(run, now)` を呼び、返ってきたイベントで
 * ランプを光らせる・音を鳴らす（テストは時刻を渡して同じ関数を通せる）。
 */

/** 0以上1未満の乱数に丸める */
function unit(rng) {
  const value = Number(typeof rng === 'function' ? rng() : rng);
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

/** 0〜padCount-1 のランプを1つ選ぶ */
export function randomPad(rng = Math.random, padCount = 4) {
  const pads = Math.max(1, Math.round(Number(padCount) || 4));
  return Math.floor(unit(rng) * pads);
}

/**
 * 1段目の順番をつくる（startLength 音・重複あり）。
 * @param {{length?:number, pads?:number, rng?:() => number}} options
 * @returns {number[]}
 */
export function buildFirstSequence({ length = 2, pads = 4, rng = Math.random } = {}) {
  const count = Math.max(1, Math.round(Number(length) || 1));
  return Array.from({ length: count }, () => randomPad(rng, pads));
}

/**
 * 1プレイぶんのリズムを始める。最初の段階の再生は `leadMs` 後から。
 * @param {{config:object, rng?:()=>number, now?:number}} input
 */
export function createRhythmRun({ config, rng = Math.random, now = 0 } = {}) {
  const startedAt = Number(now) || 0;
  const notes = Number(config?.noteMs) || 450;
  const gaps = Number(config?.gapMs) || 150;
  const sequence = buildFirstSequence({
    length: config?.startLength ?? 2,
    pads: config?.pads ?? 4,
    rng,
  });
  return {
    config,
    rng,
    startedAt,
    endsAt: startedAt + (Number(config?.seconds) || 40) * 1000,
    lastAt: startedAt,
    /** クリアした段階数＝スコア */
    stage: 0,
    /** いま挑戦している段階の音数 */
    length: sequence.length,
    sequence,
    phase: 'play',
    /** 次に光らせる音の位置 */
    playIndex: 0,
    /** いま光っているランプ（null なら消えている） */
    litPad: null,
    litUntil: 0,
    /** 次の音を光らせる時刻 */
    nextNoteAt: startedAt + (Number(config?.leadMs) || 450),
    /** 入力の位置（phase==='input' のとき） */
    inputIndex: 0,
    wrongTaps: 0,
    ended: false,
  };
}

/** 1音ぶんの長さ（光っている時間＋間） */
export function rhythmSlotMs(config) {
  return (Number(config?.noteMs) || 450) + (Number(config?.gapMs) || 150);
}

/**
 * 再生を進める。返るイベント:
 * - {type:'lit', pad, index, length}  … ランプを光らせる（音を鳴らす）
 * - {type:'off', pad}                 … ランプを消す
 * - {type:'input', stage, length}     … 入力の番になった
 * - {type:'end', reason:'time', stage} … 時間切れ
 * @returns {Array<object>}
 */
export function stepRhythm(run, now) {
  const events = [];
  if (!run || run.ended) return events;
  const at = Number(now) || 0;
  if (at >= run.endsAt) {
    run.ended = true;
    if (run.litPad !== null) {
      events.push({ type: 'off', pad: run.litPad });
      run.litPad = null;
    }
    run.phase = 'done';
    events.push({ type: 'end', reason: 'time', stage: run.stage });
    return events;
  }
  if (run.phase !== 'play') return events;

  const noteMs = Number(run.config?.noteMs) || 450;
  const gapMs = Number(run.config?.gapMs) || 150;
  let guard = 0;
  // 1回の呼び出しで「消す→次を光らせる」まで進める（タイマーが遅れても追いつく）
  while (guard < 32) {
    guard += 1;
    if (run.litPad !== null) {
      if (at < run.litUntil) break;
      events.push({ type: 'off', pad: run.litPad });
      run.litPad = null;
    }
    if (run.playIndex < run.sequence.length) {
      if (at < run.nextNoteAt) break;
      // タブ復帰などで大きく遅れたら、過去の音をまとめて光らせず「いま」から再開する
      if (at - run.nextNoteAt > noteMs + gapMs) run.nextNoteAt = at;
      run.litPad = run.sequence[run.playIndex];
      run.litUntil = run.nextNoteAt + noteMs;
      run.nextNoteAt = run.nextNoteAt + noteMs + gapMs;
      run.playIndex += 1;
      events.push({ type: 'lit', pad: run.litPad, index: run.playIndex - 1, length: run.sequence.length });
      break;
    }
    // 全部光った → 入力の番
    run.phase = 'input';
    run.inputIndex = 0;
    events.push({ type: 'input', stage: run.stage, length: run.sequence.length });
    break;
  }
  return events;
}

/**
 * 入力（ランプのタップ）。
 * - 正解: 次の音へ。最後まで押せたら段階クリア（`cleared:true`・`stage` が＋1）
 *   - まだ続くなら、1音足して再生をやり直す（`phase:'play'` に戻る）
 *   - 最大 `maxLength` 音をクリアしたら終了（`ended:true`）
 * - 不正解: **即終了**（`ended:true`・スコアはその時点の `stage`）
 *
 * @returns {{ok:boolean, correct?:boolean, cleared?:boolean, stage?:number, ended?:boolean, reason?:string}}
 */
export function tapRhythm(run, pad, now = 0) {
  if (!run || run.ended) return { ok: false, reason: 'ended' };
  const at = Number(now) || 0;
  if (at >= run.endsAt) {
    run.ended = true;
    run.phase = 'done';
    return { ok: false, reason: 'ended', stage: run.stage };
  }
  if (run.phase !== 'input') return { ok: false, reason: 'play' };

  const expected = run.sequence[run.inputIndex];
  if (pad !== expected) {
    run.ended = true;
    run.phase = 'done';
    run.wrongTaps += 1;
    return { ok: true, correct: false, ended: true, stage: run.stage, expected };
  }

  run.inputIndex += 1;
  if (run.inputIndex < run.sequence.length) {
    return { ok: true, correct: true, cleared: false, ended: false, stage: run.stage, index: run.inputIndex };
  }

  // 段階クリア
  run.stage += 1;
  const cleared = {
    ok: true,
    correct: true,
    cleared: true,
    stage: run.stage,
    length: run.sequence.length,
    ended: false,
  };
  if (run.sequence.length >= (Number(run.config?.maxLength) || 10)) {
    run.ended = true;
    run.phase = 'done';
    return { ...cleared, ended: true };
  }

  // 音を1つ足して、次の段階の再生へ（間をすこし置く）
  const growth = Math.max(1, Math.round(Number(run.config?.growth) || 1));
  for (let index = 0; index < growth; index += 1) {
    run.sequence.push(randomPad(run.rng, run.config?.pads ?? 4));
  }
  run.length = run.sequence.length;
  run.phase = 'play';
  run.playIndex = 0;
  run.litPad = null;
  run.inputIndex = 0;
  run.nextNoteAt = at + (Number(run.config?.restartMs) || 500);
  return cleared;
}

/** スコア＝クリアした段階数 */
export function rhythmScore(run) {
  return Math.max(0, Math.round(Number(run?.stage) || 0));
}

/** 入力の進み具合（画面の「3 / 5おん」に使う） */
export function rhythmProgress(run) {
  return {
    input: Math.max(0, Math.round(Number(run?.inputIndex) || 0)),
    length: Math.max(0, Math.round(Number(run?.length) || 0)),
  };
}
