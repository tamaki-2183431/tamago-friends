/**
 * ゲーム中の画面拡大を止める（v40）。
 *
 * オーナー報告（8555459）: 神経衰弱のプレイ中にピンチアウト相当の拡大がたびたび起きる。
 * **ゲームのシートを開いている間だけ**拡大を封じる（部屋・親画面の拡大は妨げない）。
 *
 * - CSS（`css/child.css` の `.game-zoom-lock` / `body.game-open`）で
 *   ゲームのルートに `touch-action: none`、ボタンに `manipulation` を当てる。
 * - それだけでは iOS Safari のスタンドアロンPWAで漏れることがあるため、
 *   `gesturestart` / `gesturechange` / `gestureend` と、2本指以上の `touchmove` も
 *   イベント側で `preventDefault` する。
 * - **タップの反応は遅らせない**: 300ms 遅延やダブルタップ待ちは入れない
 *   （`touch-action` はタップを遅らせずにダブルタップ拡大だけを切る）。
 *
 * 使い方（全ゲーム共通・今後のゲームも同じ関数を使う）:
 *   const releaseZoom = lockGameZoom(sheet.root);
 *   …シートを閉じるとき（openSheet の onClose）に releaseZoom() を呼ぶ。
 *
 * @param {HTMLElement} root ゲームのルート（ゲームシートのパネル）
 * @returns {() => void} 解除する関数（二重に呼んでも安全）
 */

/** iOS Safari のピンチ（独自イベント）。Chrome では発火しないが登録しても無害 */
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];

/** いま開いているゲームの数（結果画面を挟んでも1つ・将来の重なりに備える） */
let activeLocks = 0;

export function lockGameZoom(root) {
  if (!root || typeof document === 'undefined') return () => {};

  const prevent = (event) => event.preventDefault();
  const onTouchMove = (event) => {
    // 2本指以上のときだけ止める（1本指のスクロールはゲーム画面では使わないが、
    // 誤って指が2本乗っただけで拡大・スクロールしないようにする）
    if ((event.touches?.length ?? 0) >= 2) event.preventDefault();
  };
  /** capture で拾う＝ゲーム内のどの要素の上でも先に止める */
  const capture = { passive: false, capture: true };

  for (const type of GESTURE_EVENTS) document.addEventListener(type, prevent, capture);
  document.addEventListener('touchmove', onTouchMove, capture);

  root.classList.add('game-zoom-lock');
  activeLocks += 1;
  document.body.classList.add('game-open');

  let released = false;
  return function releaseGameZoom() {
    if (released) return;
    released = true;
    root.classList.remove('game-zoom-lock');
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, prevent, capture);
    document.removeEventListener('touchmove', onTouchMove, capture);
    activeLocks = Math.max(0, activeLocks - 1);
    if (activeLocks === 0) document.body.classList.remove('game-open');
  };
}
