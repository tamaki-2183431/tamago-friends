/** QR を読み取るシート（カメラ・写真・コード貼り付け） */
import { el, openSheet, toast } from './dom.js';
import { decodeCanvas, decodeImageFile, startCameraScan, stopCameraScan } from '../qr/scan.js';

/**
 * @param {{title:string, description?:string, onText:(text:string)=>Promise<any>|any, onClosed?:(outcome:any)=>void,
 *          continuous?:boolean, continuousHint?:string, formatResult?:(outcome:any)=>string, doneLabel?:string}} options
 *
 * continuous: true のときは、1枚読み取ってもシートを閉じずにカメラを動かしたままにする。
 * リカバリーQR（何枚も続けて読む）ように、読み取り結果をログに積み、最後に「おわる」で閉じる。
 * 閉じるときの onClosed には { continuous: true, results: [...] } が渡る。
 */
export function openScanSheet({
  title,
  description = '',
  onText,
  onClosed = null,
  continuous = false,
  continuousHint = '',
  formatResult = null,
  doneLabel = 'よみとりを おわる',
}) {
  const video = el('video', { class: 'scanner__video', playsinline: true, muted: true });
  const hint = el('p', { class: 'muted scanner__hint', text: continuous
    ? (continuousHint || 'よみとれたら、つぎのQRへ そのまま カメラを むけてね。')
    : 'カメラを起動して、QRコードを画面に写してください。' });

  const startButton = el('button', { class: 'btn btn--primary', type: 'button', text: '📷 カメラを起動' });
  const stopButton = el('button', { class: 'btn btn--ghost', type: 'button', text: 'カメラを止める', hidden: true });

  const cameraBox = el('div', { class: 'scanner__camera' }, [video]);

  const results = [];
  const logList = el('ul', { class: 'scan-log', id: 'scanLog' });
  const logEmpty = el('p', { class: 'scan-log__empty muted small', id: 'scanLogEmpty', text: continuous ? 'まだ よみとった QR はありません。' : '' });
  const countChip = el('span', { class: 'scan-log__count muted small', id: 'scanCount', text: continuous ? 'よみとり 0 まい' : '' });
  const logBox = continuous ? el('div', { class: 'scan-log-box' }, [el('div', { class: 'scan-log-box__head' }, [countChip]), logEmpty, logList]) : null;

  const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  const pickButton = el('button', { class: 'btn btn--ghost', type: 'button', text: '🖼 写真から読み取る' });

  const pasteField = el('textarea', { class: 'input input--area', rows: 3, placeholder: 'TG1.…（QRコードのコード文字列）', 'aria-label': 'QRコードのコード文字列' });
  const pasteButton = el('button', { class: 'btn btn--ghost', type: 'button', text: '貼り付けたコードを読み取る' });
  const doneButton = continuous
    ? el('button', { class: 'btn btn--primary', type: 'button', id: 'scanDone', text: doneLabel })
    : null;

  const content = el('div', { class: 'scanner' }, [
    cameraBox,
    el('div', { class: 'scanner__actions' }, [startButton, stopButton]),
    hint,
    logBox,
    el('div', { class: 'scanner__divider', text: 'カメラが使えないとき' }),
    el('div', { class: 'scanner__actions' }, [pickButton, fileInput]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'コードを貼り付け' }), pasteField]),
    pasteButton,
    doneButton,
  ].filter(Boolean));

  let busy = false;
  let finished = false;
  const sheet = openSheet({
    title,
    description,
    content,
    size: 'wide',
    // 連続モードで ✕ を押したときも、読み取ったぶんは捨てずに反映する（子が読み直さなくて済む）
    onClose: () => {
      stopCameraScan();
      if (!finished) {
        finished = true;
        if (continuous && results.length) onClosed?.({ continuous: true, results: [...results] });
      }
    },
  });

  function finish() {
    if (finished) return;
    finished = true;
    stopCameraScan();
    sheet.close();
    onClosed?.(results.length ? { continuous: true, results: [...results] } : null);
  }

  function appendLog(outcome) {
    results.push(outcome);
    logEmpty.hidden = true;
    countChip.textContent = `よみとり ${results.length} まい`;
    let line = '';
    try {
      line = formatResult ? formatResult(outcome) : (outcome?.message ?? 'よみとりました');
    } catch {
      line = outcome?.message ?? 'よみとりました';
    }
    logList.append(el('li', { class: 'scan-log__item' }, [
      el('span', { class: 'scan-log__no', text: String(results.length) }),
      el('span', { class: 'scan-log__text', text: String(line || 'よみとりました') }),
    ]));
    logList.scrollTop = logList.scrollHeight;
    hint.textContent = `いま ${results.length} まい目。つぎのQRへ カメラを むけてね。`;
  }

  /**
   * 読み取り成功 → **すぐシートを閉じる** → 閉じたあとに演出（onClosed）へ渡す。
   * 重い処理（演出・再描画）を閉じる前に待たないので、カメラのモーダルが残らない。
   * continuous のときは閉じずにログへ積む（エラーでもカメラは止めない）。
   */
  /** 連続モードは読み取りを直列に処理する（読んでいる最中の次のQRを取りこぼさない） */
  let queue = Promise.resolve();
  function submit(text) {
    if (!text) return Promise.resolve();
    if (!continuous) return handleText(text);
    queue = queue.then(() => handleText(text)).catch(() => {});
    return queue;
  }

  async function handleText(text) {
    if (busy || !text) return;
    busy = true;
    try {
      const outcome = await onText(text);
      if (continuous) {
        appendLog(outcome);
        return;
      }
      sheet.close();
      stopCameraScan();
      onClosed?.(outcome);
    } catch (error) {
      toast(error?.message ?? '読み取れませんでした', { tone: 'error', duration: 3600 });
      if (continuous) hint.textContent = 'うまく よみとれませんでした。もういちど カメラを むけてね。';
    } finally {
      busy = false;
    }
  }

  startButton.addEventListener('click', async () => {
    try {
      await startCameraScan(video, submit, { continuous });
      cameraBox.classList.add('scanner__camera--live');
      startButton.hidden = true;
      stopButton.hidden = false;
      hint.textContent = 'QRコードを枠の中に合わせてください。';
    } catch (error) {
      toast(error?.message ?? 'カメラを起動できませんでした', { tone: 'error', duration: 3600 });
      hint.textContent = 'カメラが使えないため、写真またはコード貼り付けで読み取ってください。';
    }
  });

  stopButton.addEventListener('click', () => {
    stopCameraScan();
    cameraBox.classList.remove('scanner__camera--live');
    startButton.hidden = false;
    stopButton.hidden = true;
    hint.textContent = 'カメラを停止しました。';
  });

  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await decodeImageFile(file);
      if (!text) {
        toast('写真からQRコードを読み取れませんでした', { tone: 'error' });
        return;
      }
      await submit(text);
    } catch (error) {
      toast(error?.message ?? '読み取れませんでした', { tone: 'error' });
    } finally {
      fileInput.value = '';
    }
  });

  pasteButton.addEventListener('click', async () => {
    const text = pasteField.value.trim();
    if (!text) {
      pasteField.focus();
      return;
    }
    await submit(text);
    if (continuous) pasteField.value = '';
  });

  doneButton?.addEventListener('click', finish);

  return sheet;
}

/** テスト・デバッグ用: canvas から直接読む */
export { decodeCanvas };
