/**
 * バックアップ JSON の保存（v31）— DOM を触らない部分。
 *
 * 実機のホーム画面 PWA（iOS のスタンドアロンなど）では `<a download>` が
 * **黙って何も起きない**ことがある。失敗を検知できないのが問題なので、保存手段を
 * 3段構えにして、どの経路も結果をトーストで返す（`js/ui/save-backup.js` が実行側）。
 *
 *   1) 共有シート（`navigator.share({ files })`）— タップ直後に呼ぶ
 *   2) ダウンロード（`downloadFile`）
 *   3) コピー（JSON 全文をシートに出して `clipboard.writeText`／不可なら全選択）
 *
 * ここは文言と順番だけを持つ（単体テストで固定する）。
 */

/** 保存手段の順番（この順に試す） */
export const SAVE_TIERS = Object.freeze(['share', 'download', 'copy']);

/** トースト（経路ごとに結果を明示する） */
export const SAVE_SHARE_SUCCESS_TOAST = '共有しました。保存先を えらんで ください';
export const SAVE_SHARE_CANCEL_TOAST = 'キャンセルしました（保存していません）';
export const SAVE_SHARE_FAILED_TOAST = '共有できませんでした。ダウンロードで 保存します';
export const SAVE_DOWNLOAD_TOAST = 'ダウンロードを はじめました。ファイルに 入ったか かくにんして ください';
export const SAVE_DOWNLOAD_FAILED_TOAST = 'ダウンロードできませんでした。コピーで 保存できます';
export const SAVE_COPY_SUCCESS_TOAST = 'コピーしました。メモアプリに はりつけて 保存できます';
export const SAVE_COPY_SELECTED_TOAST = '全選択しました。「コピー」を おして ください';

/** コピー用シート */
export const SAVE_COPY_TITLE = 'バックアップを コピー';
export const SAVE_COPY_ACTION = 'コピー';
export const SAVE_COPY_CLOSE = 'とじる';
export const SAVE_COPY_DESCRIPTION =
  '中身を ぜんぶ コピーして、メモアプリに はりつけると 保存できます（あとで 復元に つかえます）。';
export const SAVE_COPY_HINT = 'メモアプリに はりつけて 保存できます';
export const SAVE_COPY_FILE_LABEL = (name) => `ファイル名: ${name}`;

/**
 * どの順で保存を試すか（純関数）。
 * `canShare` が偽なら共有は飛ばす。`copyOnly` は「コピー」ボタンから呼ばれたとき。
 */
export function planSaveModes({ canShare = false, shareFailed = false, copyOnly = false } = {}) {
  if (copyOnly) return ['copy'];
  const modes = [];
  if (canShare && !shareFailed) modes.push('share');
  modes.push('download');
  modes.push('copy');
  return modes;
}

/** 共有シートの「キャンセル」か（失敗と区別する。キャンセルはダウンロードへ落とさない） */
export function isShareCancel(error) {
  if (!error) return false;
  const name = String(error.name ?? '');
  if (name === 'AbortError') return true;
  return false;
}
