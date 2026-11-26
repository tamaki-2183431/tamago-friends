/**
 * 親画面「危険な操作 > 家族データを初期化」の純粋な部分（v29）。
 *
 * - 消すストアの一覧（**子端末のストアは含めない**）
 * - 画面と store が共有する文言（文言の二重管理をしない・テストで固定する）
 * - 入力の検証（PIN の形式と確認チェックだけ。PIN の照合は store 側）
 *
 * ここは IndexedDB も DOM も触らない（単体テストで固定できる）。
 */
import { STORES, PARENT_STORES } from '../db.js';

/** 初期化で消すストア（親端末のすべて・自動退避も含む） */
export const FACTORY_RESET_STORES = Object.freeze(PARENT_STORES.slice());

/** 初期化の画面見出し・説明 */
export const FACTORY_RESET_TITLE = '危険な操作';
export const FACTORY_RESET_LABEL = '家族データを初期化（アプリを いれた 直後の 状態に もどす）';
export const FACTORY_RESET_DESCRIPTION =
  'この端末の 家族・こども・点数・監査・ごほうび・メモ・PIN を すべて 消して、アプリを いれた 直後の 状態に もどします。';

/** 消えるものの一覧（画面に出す） */
export const FACTORY_RESET_ERASED = Object.freeze([
  '家族の名前・PIN・署名鍵',
  'こども',
  '点数',
  '監査履歴',
  'ごほうび・ごほうび申請',
  'ごほうびメモ',
  '端末内の自動退避',
]);

export const FACTORY_RESET_CONFIRM_TEXT = 'この操作は もとへ もどせません';
export const FACTORY_RESET_CHILD_NOTICE = 'こどもの端末は かぞくQRで つなぎ直してね';
export const FACTORY_RESET_CHILD_OPTION = 'こどもの端末も 初期化する（かぞくQRで つなぎ直す）';
export const FACTORY_RESET_CHILD_NOTE = 'ONにすると、消す前に こどもごとの 初期化QR（完全初期化）を 表示します。';

export const PIN_EMPTY_MESSAGE = 'PIN を 4桁 いれてください';
export const PIN_FORMAT_MESSAGE = 'PIN は 4桁の 数字です';
export const PIN_MISMATCH_MESSAGE = 'PIN が ちがいます';
export const CONFIRM_REQUIRED_MESSAGE = `「${FACTORY_RESET_CONFIRM_TEXT}」に チェックを いれてください`;
export const NO_BACKUP_LABEL = 'ダウンロードが はじまらない 端末なので、バックアップなしで つづける';

/* ---- v31: 初期化前の「バックアップを 保存しましたか？」の手動ステップ ---- */

/** 手動ステップの見出し・案内・ボタン・チェック */
export const SAVE_STEP_TITLE = 'バックアップを のこす';
export const SAVE_STEP_LEAD = '初期化すると データは もどせません。さきに JSON を のこして おいて ください。';
export const SAVE_STEP_SHARE = '共有して保存';
export const SAVE_STEP_COPY = 'コピー';
export const SAVED_LABEL = 'バックアップを 保存できた';
export const SAVE_STEP_NOTE = `「${SAVE_STEP_SHARE}」か「${SAVE_STEP_COPY}」を つかうと、「${SAVED_LABEL}」に チェックできます。`;
export const SAVE_STEP_LOCKED_NOTE = 'チェックするまで 初期化は できません（保存できていないのに 消さない ため）。';
export const SAVED_REQUIRED_MESSAGE = `「${SAVED_LABEL}」に チェックを いれてください（保存が むずかしい端末は「${NO_BACKUP_LABEL}」に チェック）`;

/** 自動バックアップ（JSON ダウンロード）・端末内スナップショットの失敗 */
export const BACKUP_FAILED_MESSAGE = 'バックアップを つくれなかったので、初期化しません（データは そのままです）';
export const BACKUP_DOWNLOAD_FAILED_MESSAGE = 'バックアップの ダウンロードを はじめられませんでした';
export const BACKUP_DOWNLOAD_RETRY_MESSAGE = `${BACKUP_DOWNLOAD_FAILED_MESSAGE}（データは そのままです）。「${NO_BACKUP_LABEL}」に チェックして、もういちど おしてください。`;
export const RESET_FAILED_MESSAGE = '初期化できませんでした';

/** バックアップ JSON のファイル名（既存 exportBackup と同じ形式） */
export const BACKUP_FILE_PREFIX = 'tamago-friends-backup';

export function isBackupFileName(name) {
  return /^tamago-friends-backup-[\dT-]+\.json$/.test(String(name ?? ''));
}

/**
 * 実行前の入力チェック（PIN の**照合はしない**。照合は store.prepareFamilyReset）。
 * 空・形式・確認チェックの順に見て、最初の1件だけ返す。
 */
export function validateFactoryResetInput({ pin, confirmed = false, noBackup = false, saved = false } = {}) {
  const value = String(pin ?? '');
  if (!value) return { ok: false, message: PIN_EMPTY_MESSAGE };
  if (!/^\d{4}$/.test(value)) return { ok: false, message: PIN_FORMAT_MESSAGE };
  if (!confirmed) return { ok: false, message: CONFIRM_REQUIRED_MESSAGE };
  // v31: 保存できた（または「バックアップなしで つづける」を明示選択）まで初期化しない
  if (!saved && !noBackup) return { ok: false, message: SAVED_REQUIRED_MESSAGE };
  return { ok: true, message: '', noBackup: Boolean(noBackup), saved: Boolean(saved) };
}

/** 端末内スナップショットのラベル（既存の自動退避と同じ形） */
export function factoryResetSnapshotLabel(date = new Date()) {
  return `初期化前の自動退避（${date.toLocaleString('ja-JP')}）`;
}

/** 初期化後に案内する家族未作成のセットアップ画面の見出し */
export const FACTORY_RESET_DONE_TOAST = '家族データを 初期化しました';

/** 子端末のストア（初期化では触らない）— テストで「触っていない」ことを固定する */
export const CHILD_STORES_UNTOUCHED = Object.freeze(
  Object.values(STORES).filter((name) => name.startsWith('c_'))
);
