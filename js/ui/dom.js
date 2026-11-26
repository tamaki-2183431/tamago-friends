/** 画面共通の小道具（DOM生成・トースト・シート・確認ダイアログ）。 */

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'value' && 'value' in node) node.value = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * parent.append の安全版。null / undefined / false を無視する
 * （append は null を "null" という文字列にして表示してしまうため）。
 */
export function mount(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function formatNumber(value) {
  const number = Number(value) || 0;
  return number.toLocaleString('ja-JP');
}

export function todayISO() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateJP(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTimeJP(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ------------------------------------------------------------ トースト */

let toastHost = null;

export function toast(message, { tone = 'info', duration = 2600 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast toast--${tone}`, text: message });
  toastHost.append(node);
  // 連続操作で画面が埋まらないように、表示は最大3件まで
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 300);
  }, duration);
  return node;
}

/* ------------------------------------------------------------ シート（モーダル） */

let sheetStack = [];

/**
 * 画面下から出るシート。content は Node。
 * 戻り値: { root, close }
 */
export function openSheet({ title, description = '', content, actions = [], size = 'normal', onClose = null }) {
  const previousFocus = document.activeElement;
  const overlay = el('div', { class: 'sheet-overlay' });
  const panel = el('div', { class: `sheet sheet--${size}`, role: 'dialog', 'aria-modal': 'true' });

  const header = el('div', { class: 'sheet__head' }, [
    el('h2', { class: 'sheet__title', text: title }),
    el('button', {
      class: 'sheet__close',
      type: 'button',
      'aria-label': '閉じる',
      text: '✕',
      onclick: () => close(),
    }),
  ]);
  panel.append(header);
  if (description) panel.append(el('p', { class: 'sheet__desc', text: description }));
  const body = el('div', { class: 'sheet__body' });
  body.append(content);
  panel.append(body);

  if (actions.length) {
    const footer = el('div', { class: 'sheet__foot' });
    for (const action of actions) {
      footer.append(
        el('button', {
          class: `btn ${action.variant === 'primary' ? 'btn--primary' : action.variant === 'danger' ? 'btn--danger' : 'btn--ghost'}`,
          type: 'button',
          text: action.label,
          onclick: () => action.onClick?.(close),
        })
      );
    }
    panel.append(footer);
  }

  overlay.append(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    // いちばん上のシートだけを閉じる（下に重なっている一覧まで消さない／v37）
    if (sheetStack[sheetStack.length - 1] !== close) return;
    close();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  document.body.classList.add('has-sheet');

  function close() {
    try {
      onClose?.();
    } catch (error) {
      console.error(error);
    }
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    sheetStack = sheetStack.filter((entry) => entry !== close);
    if (!sheetStack.length) document.body.classList.remove('has-sheet');
    previousFocus?.focus?.();
  }

  sheetStack.push(close);
  requestAnimationFrame(() => overlay.classList.add('sheet-overlay--in'));
  panel.querySelector('button, input, textarea, select')?.focus?.();
  return { root: panel, body, close };
}

export function closeAllSheets() {
  [...sheetStack].forEach((close) => close());
}

/**
 * 確認ダイアログ。ok で true。
 * requireText を渡すと、その文字列を入力しないと実行できない（破壊的操作向け）。
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
  danger = false,
  requireText = null,
  inputLabel = null,
}) {
  return new Promise((resolve) => {
    let input = null;
    const content = el('div', { class: 'confirm' }, [el('p', { class: 'confirm__message', text: message })]);
    if (requireText) {
      input = el('input', { class: 'input', type: 'text', placeholder: `「${requireText}」と入力`, 'aria-label': inputLabel ?? '確認の入力' });
      content.append(el('label', { class: 'field' }, [el('span', { class: 'field__label', text: inputLabel ?? `確認のため「${requireText}」と入力してください` }), input]));
    }
    let settled = false;
    const sheet = openSheet({
      title,
      content,
      actions: [
        {
          label: cancelLabel,
          onClick: (close) => {
            settled = true;
            resolve(false);
            close();
          },
        },
        {
          label: confirmLabel,
          variant: danger ? 'danger' : 'primary',
          onClick: (close) => {
            if (requireText && input?.value.trim() !== requireText) {
              input?.classList.add('input--error');
              input?.focus();
              return;
            }
            settled = true;
            resolve(true);
            close();
          },
        },
      ],
    });
    sheet.root.addEventListener('sheet:closed', () => {
      if (!settled) resolve(false);
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(sheet.root) && !settled) {
        settled = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/* ------------------------------------------------------------ ファイル */

export function downloadFile(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------ 例外処理 */

export function guarded(handler, { onError } = {}) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      console.error(error);
      if (onError) onError(error);
      else toast(error?.message ?? '処理に失敗しました', { tone: 'error', duration: 3600 });
    }
  };
}
