/**
 * 全ゲーム共通の「よーい…、スタート！」（v36）。
 *
 * 3つのゲーム（神経衰弱・ごはんキャッチ・ジャンプ）が同じものを使う。
 * これから増えるゲームも `runCountdown()` を呼ぶだけで同じ手触りになる。
 *
 * - 「よーい…」0.8秒 → 「スタート！」0.7秒（合図と同時に SE `start`）
 * - **演出中はゲームを止めておく**（呼び出し側は `onStart` が来るまで操作もタイマーも動かさない）
 * - 秒数は `data/games.js` の `COUNTDOWN` の1か所だけ（ゲームごとに変えない）
 * - reduced-motion では文字だけ（拡大・点滅させない）
 *
 * 返り値の `cancel()` をシートを閉じたとき・やり直すときに呼ぶ（タイマーと表示を片付ける）。
 */
import { COUNTDOWN } from '../../data/games.js';
import { el } from './dom.js';
import { playSe } from './sound.js';

/**
 * @param {HTMLElement} container 演出を載せる場所（ゲームの view。position:relative が要る）
 * @param {{onStart?: () => void, readyMs?: number, startMs?: number}} options
 * @returns {{cancel: () => void, started: boolean}}
 */
export function runCountdown(container, { onStart = null, readyMs = COUNTDOWN.readyMs, startMs = COUNTDOWN.startMs } = {}) {
  const text = el('p', { class: 'countdown__text', text: 'よーい…' });
  const layer = el('div', {
    class: 'countdown',
    id: 'gameCountdown',
    role: 'status',
    'aria-live': 'polite',
    'aria-label': 'よーい、スタート',
  }, [text]);
  container.append(layer);

  let canceled = false;
  const timers = [];
  const later = (fn, ms) => {
    const id = window.setTimeout(() => {
      if (canceled) return;
      fn();
    }, ms);
    timers.push(id);
    return id;
  };

  const handle = {
    started: false,
    /** 片付ける（もういちど・閉じる） */
    cancel() {
      canceled = true;
      while (timers.length) window.clearTimeout(timers.pop());
      layer.remove();
    },
  };

  // 「よーい…」→「スタート！」（合図の SE もここ）
  later(() => {
    text.textContent = 'スタート！';
    layer.classList.add('countdown--go');
    playSe('start');
  }, readyMs);

  // 1.5秒たってからゲームを始める（タイマーも操作もここから）
  later(() => {
    handle.started = true;
    layer.remove();
    onStart?.();
  }, readyMs + startMs);

  return handle;
}
