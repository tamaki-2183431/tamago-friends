/**
 * バックアップ JSON の保存（v31）— 実行側（DOM を触る）。
 *
 * 実機のホーム画面 PWA では `downloadFile`（`<a download>`＋blob URL）が
 * 何も起きずに終わることがあり、しかも失敗を検知できない。そこで
 * **共有シート → ダウンロード → コピー** の3段構えにして、どの結果もトーストで伝える。
 *
 * 呼び出し側は「ユーザーの手元に JSON が渡ったか」だけを見ればよい
 * （戻り値 `ok`。共有のキャンセルだけは `cancelled: true`）。
 */
import {
  SAVE_COPY_ACTION,
  SAVE_COPY_CLOSE,
  SAVE_COPY_DESCRIPTION,
  SAVE_COPY_FILE_LABEL,
  SAVE_COPY_HINT,
  SAVE_COPY_SELECTED_TOAST,
  SAVE_COPY_SUCCESS_TOAST,
  SAVE_COPY_TITLE,
  SAVE_DOWNLOAD_FAILED_TOAST,
  SAVE_DOWNLOAD_TOAST,
  SAVE_SHARE_CANCEL_TOAST,
  SAVE_SHARE_FAILED_TOAST,
  SAVE_SHARE_SUCCESS_TOAST,
  isShareCancel,
  planSaveModes,
} from '../game/backup-save.js';
import { downloadFile, el, openSheet, toast } from './dom.js';

/** 保存する JSON を File にする（共有シートに渡すため） */
export function makeJsonFile(filename, text, type = 'application/json') {
  return new File([text], filename, { type });
}

/** この端末が「ファイルの共有」に対応しているか（iOS/Android はここが真になる） */
export function canShareFile(file) {
  try {
    if (typeof navigator === 'undefined') return false;
    if (typeof navigator.share !== 'function') return false;
    if (typeof navigator.canShare !== 'function') return false;
    return Boolean(navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

async function copyText(textarea, text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* クリップボード API が無い・拒否された → 全選択に落とす */
  }
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (typeof document.execCommand === 'function') return Boolean(document.execCommand('copy'));
  } catch {
    /* 全選択だけでもしておく */
  }
  return false;
}

/**
 * JSON 全文を出して「コピー」できるシート。
 * 「うまく保存できない」ときの逃げ道（メモアプリに貼って保存）。
 */
export function openCopySheet({ filename, text, title = SAVE_COPY_TITLE, description = SAVE_COPY_DESCRIPTION }) {
  const textarea = el('textarea', {
    class: 'input input--area',
    rows: 12,
    readonly: true,
    value: text,
    id: 'backupCopyText',
    'aria-label': 'バックアップJSON',
  });
  const sheet = openSheet({
    title,
    description,
    size: 'wide',
    content: el('div', { class: 'stack' }, [
      el('p', { class: 'muted small', text: SAVE_COPY_FILE_LABEL(filename) }),
      textarea,
      el('p', { class: 'muted small', text: SAVE_COPY_HINT }),
    ]),
    actions: [
      {
        label: SAVE_COPY_ACTION,
        variant: 'primary',
        onClick: async () => {
          const ok = await copyText(textarea, text);
          toast(ok ? SAVE_COPY_SUCCESS_TOAST : SAVE_COPY_SELECTED_TOAST, { tone: ok ? 'success' : 'error' });
        },
      },
      { label: SAVE_COPY_CLOSE, onClick: (close) => close() },
    ],
  });
  return sheet;
}

/**
 * バックアップ JSON を3段構えで保存する。
 *
 * @param {{filename:string, text:string, type?:string, copyOnly?:boolean}} input
 * @returns {Promise<{mode:'share'|'download'|'copy', ok:boolean, cancelled?:boolean}>}
 *   `ok: true` は「JSON がユーザーの手元に渡った（またはコピー用に全文が出た）」。
 */
export async function saveBackupJson({ filename, text, type = 'application/json', copyOnly = false }) {
  const file = makeJsonFile(filename, text, type);
  const modes = planSaveModes({ canShare: !copyOnly && canShareFile(file), copyOnly });

  for (const mode of modes) {
    if (mode === 'share') {
      try {
        await navigator.share({ files: [file], title: filename });
        toast(SAVE_SHARE_SUCCESS_TOAST, { tone: 'success' });
        return { mode, ok: true };
      } catch (error) {
        if (isShareCancel(error)) {
          toast(SAVE_SHARE_CANCEL_TOAST, { tone: 'error' });
          return { mode, ok: false, cancelled: true };
        }
        toast(SAVE_SHARE_FAILED_TOAST, { tone: 'error' });
        // 共有できなかった → ダウンロードへ落ちる
      }
    } else if (mode === 'download') {
      try {
        downloadFile(filename, text, type);
        toast(SAVE_DOWNLOAD_TOAST, { tone: 'success' });
        return { mode, ok: true };
      } catch {
        toast(SAVE_DOWNLOAD_FAILED_TOAST, { tone: 'error' });
        // ダウンロードできない → コピーへ落ちる
      }
    }
  }

  openCopySheet({ filename, text });
  return { mode: 'copy', ok: true };
}
