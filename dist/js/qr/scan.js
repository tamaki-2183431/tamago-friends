/**
 * QR コードの読み取り（vendor/jsQR.js を同梱・外部CDNなし）。
 * カメラが使えない環境では、コード文字列の貼り付けでも同じ処理に流せる。
 */

let stream = null;
let frameHandle = null;

function decode(data, width, height) {
  if (typeof globalThis.jsQR !== 'function') return null;
  const result = globalThis.jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return result?.data ?? null;
}

/** ImageData / canvas / 画像要素から QR 文字列を取り出す */
export function decodeCanvas(source) {
  if (!source) return null;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  return decode(data, width, height);
}

export function decodeImageData(imageData) {
  return decode(imageData.data, imageData.width, imageData.height);
}

/** 画像ファイル（写真）から読む */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return decodeCanvas(bitmap);
  } finally {
    bitmap.close?.();
  }
}

/**
 * カメラを起動して連続スキャンする。
 *
 * `continuous: true`（v45・リカバリーQRの流し読み）では、1枚読んでも**カメラを止めずに**
 * 読み続ける。同じQRを写したまま何度も通知しないよう、画面から一度外れるまで
 * 同じ文字列は1回だけ onText に渡す（点数は子ストア側の rev 判定でも二重加算されない）。
 *
 * @param {HTMLVideoElement} video
 * @param {(text:string)=>void} onText
 * @param {{continuous?:boolean, blankFrames?:number}} [options]
 */
export async function startCameraScan(video, onText, { continuous = false, blankFrames = 8 } = {}) {
  stopCameraScan();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('この端末ではカメラを使えません。コードを貼り付けてください');
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  // 連続モード: 同じQRが写り続けているあいだは1回だけ通知する。
  // 画面からQRが外れて `blankFrames` フレーム続いたら、また同じQRを読めるように戻す。
  let lastText = '';
  let blank = 0;

  const tick = () => {
    if (!stream) return;
    let text = null;
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      text = decode(data, width, height);
    }
    if (text) {
      if (!continuous) {
        stopCameraScan();
        onText(text);
        return;
      }
      blank = 0;
      if (text !== lastText) {
        lastText = text;
        onText(text);
      }
    } else if (continuous) {
      blank += 1;
      if (blank > blankFrames) lastText = '';
    }
    frameHandle = requestAnimationFrame(tick);
  };
  frameHandle = requestAnimationFrame(tick);
}

export function stopCameraScan() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
}

export function isCameraActive() {
  return Boolean(stream);
}
