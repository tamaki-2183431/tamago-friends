/**
 * QR コードの描画（vendor/qrcode.js を同梱・外部CDNなし）。
 */

const DEFAULT_QUIET = 4;

function ensureLib() {
  if (typeof globalThis.qrcode !== 'function') {
    throw new Error('QRコード生成ライブラリが読み込まれていません');
  }
  return globalThis.qrcode;
}

/**
 * canvas に QR を描く。
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{targetSize?:number, color?:string, background?:string, quiet?:number}} options
 */
export function drawQr(canvas, text, options = {}) {
  const qrcode = ensureLib();
  const { targetSize = 260, color = '#221733', background = '#ffffff', quiet = DEFAULT_QUIET } = options;

  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const cells = count + quiet * 2;
  const pixelRatio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  const cssSize = Math.max(160, Math.min(targetSize, 360));
  const scale = Math.max(2, Math.floor((cssSize * pixelRatio) / cells));
  const dimension = cells * scale;

  canvas.width = dimension;
  canvas.height = dimension;
  canvas.style.width = `${Math.round(dimension / pixelRatio)}px`;
  canvas.style.height = `${Math.round(dimension / pixelRatio)}px`;

  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.fillRect(0, 0, dimension, dimension);
  context.fillStyle = color;
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!qr.isDark(row, column)) continue;
      context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }

  canvas.dataset.modules = String(count);
  return { modules: count, dimension };
}

/** 画面外の canvas で作って data URL にする（テスト・画像保存用） */
export function toDataUrl(text, options = {}) {
  const canvas = document.createElement('canvas');
  drawQr(canvas, text, options);
  return canvas.toDataURL('image/png');
}

/** QR 1枚分のブロック（見出し・canvas・コードコピー）を作る */
export function createQrBlock(text, { label = '', index = 1, total = 1 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'qr-block';

  if (total > 1) {
    const badge = document.createElement('p');
    badge.className = 'qr-block__badge';
    badge.textContent = `${index} / ${total}`;
    wrap.append(badge);
  }
  if (label) {
    const title = document.createElement('p');
    title.className = 'qr-block__label';
    title.textContent = label;
    wrap.append(title);
  }

  const frame = document.createElement('div');
  frame.className = 'qr-block__frame';
  const canvas = document.createElement('canvas');
  canvas.className = 'qr-block__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label || 'QRコード');
  frame.append(canvas);
  wrap.append(frame);
  drawQr(canvas, text);

  // カメラが使えない環境（PC等）でも受け渡せるように、コード文字列も保持する
  const details = document.createElement('details');
  details.className = 'qr-block__code';
  const summary = document.createElement('summary');
  summary.textContent = 'コードをコピー／貼り付け';
  const field = document.createElement('textarea');
  field.readOnly = true;
  field.value = text;
  field.rows = 3;
  field.className = 'qr-block__codetext';
  field.dataset.qrPayload = 'true';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn--ghost btn--small';
  copy.textContent = 'コピー';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'コピーしました';
      setTimeout(() => {
        copy.textContent = 'コピー';
      }, 1500);
    } catch {
      field.select();
    }
  });
  details.append(summary, field, copy);
  wrap.append(details);

  return wrap;
}
