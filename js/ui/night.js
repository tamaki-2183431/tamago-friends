/**
 * 夜間ロック（22:00〜06:59）の見た目と押下の共通処理。
 *
 * - **disable 属性は使わない**。ネイティブの `disabled` はクリックを捨ててしまい、
 *   仕様の「押したら いまは ねる じかん だよ…」を出せないため。
 *   `aria-disabled="true"` ＋ `data-night-locked="true"` ＋ `.is-night-locked` で
 *   「無効（薄い）」を表し、押下は各画面が文言をトーストして何もしない。
 * - クールダウンなど**別の理由**の無効化は従来どおり `disabled` を使う。
 */
import { NIGHT_CARE_TEXT, NIGHT_GAME_TEXT } from '../game/night.js';

export { NIGHT_CARE_TEXT, NIGHT_GAME_TEXT };

/** その入口の夜間の文言（おせわ系＝同じ文言／ゲームだけ別） */
export function nightLockText(kind = 'care') {
  return kind === 'game' ? NIGHT_GAME_TEXT : NIGHT_CARE_TEXT;
}

/**
 * ボタンの夜間ロック表示を切り替える。
 * @param {HTMLElement|null} node
 * @param {boolean} locked
 */
export function setNightLocked(node, locked) {
  if (!node) return;
  const value = Boolean(locked);
  node.classList.toggle('is-night-locked', value);
  node.dataset.nightLocked = value ? 'true' : 'false';
  node.setAttribute('aria-disabled', value ? 'true' : 'false');
}
