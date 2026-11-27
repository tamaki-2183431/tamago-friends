/**
 * アプリの版（表示用）。**版の出どころは ここ1か所**。
 *
 * - `APP_VERSION` は `sw.js` の `VERSION` と同じ値にする。手で二重管理しない。
 *   食い違ったら `tests/version.test.mjs` が落ちる。
 * - 表示しているのは「いま開いている画面のコードの版」。古いキャッシュが残る端末では
 *   古い値が出るのが正しい（＝見たいのは“いま動いている版”）。
 * - 「さいよみこみ」（`js/ui/reload.js`）の判定（稼働中の SW の版 ⇔ サーバーの sw.js の版）
 *   とは独立。統合しない。
 */

export const APP_VERSION = 'v47';
export const BUILD_DATE = '2026-11-27';

/** 子ども画面「せってい」の最下部に出す1行 */
export const CHILD_VERSION_LABEL = `ばーじょん ${APP_VERSION}`;
/** 親画面の最下部に出す1行 */
export const PARENT_VERSION_LABEL = `${APP_VERSION}（${BUILD_DATE}）`;
