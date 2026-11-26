/**
 * ヘッダーの「さいよみこみ」（v23）。
 *
 * ホーム画面から起動した PWA は再読み込みの手段が無いため、起動中に自分で新しい版を
 * 取り込めるようにする。約束ごと:
 * - 新しい版が無ければリロードしない（「いまが さいしん だよ」）。
 * - 判定は Service Worker の VERSION（いま動いている版 ⇔ サーバーの sw.js）で行う。
 * - 判定が 2.5秒で終わらなければ（圏外など）最新扱いにする＝勝手にリロードしない。
 * - 更新があると分かったら（または古い SW が版を答えないので分からないとき）、
 *   registration.update() を投げ、controllerchange を待ってからリロードする。
 *   sw.js の install は skipWaiting するので、通常は waiting に止まらず有効化される。
 * - SW が無い・未登録なら location.reload() にフォールバックする。
 * - キャッシュの全消去・確認ダイアログは行わない（仕様）。
 */

/** 画面に出す文言（仕様で確定した言い回し） */
export const RELOAD_LABEL = 'アプリを さいよみこみ';
export const RELOAD_BUSY_LABEL = 'よみこみ中';
export const RELOAD_BUSY_TEXT = 'よみこみ中…';
export const RELOAD_LATEST_TEXT = 'いまが さいしん だよ';
export const RELOAD_ERROR_TEXT = 'さいよみこみ できなかったよ';

/** 版の判定（サーバーの sw.js を読む）を待つ上限。仕様: 2.5秒 */
export const SW_WAIT_MS = 2500;
/** 新しい SW の有効化（controllerchange）を待つ上限。低速回線でも取りこぼさない */
export const ACTIVATE_WAIT_MS = 10000;
/** 動いている SW に VERSION を聞く上限 */
export const VERSION_WAIT_MS = 400;
/** 「よみこみ中…」を最低限見せる時間（速すぎると何が起きたか分からないため） */
export const MIN_BUSY_MS = 350;

/**
 * sw.js のソースから VERSION を取り出す。読めなければ null。
 * 例: `const VERSION = 'v23';` → 'v23'
 */
export function parseSwVersion(source) {
  const match = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(String(source ?? ''));
  return match ? match[1] : null;
}

/**
 * リロードしてよいかの判定（純関数）。
 * - latest: いまが最新 → リロードしない
 * - update: 新しい版がある → 更新してリロードする
 * - probe : 版が分からない（古い SW が答えない等）→ update() を投げて結果を待つ
 */
export function decideReload(current, latest) {
  if (!current || !latest) return 'probe';
  return current === latest ? 'latest' : 'update';
}

function reloadNow() {
  location.reload();
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

/** いま画面を動かしている SW に VERSION を聞く（答えなければ null） */
async function readCurrentVersion(registration) {
  const worker = registration?.active;
  if (!worker) return null;
  return withTimeout(new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const version = event?.data?.version;
      resolve(typeof version === 'string' && version ? version : null);
    };
    try {
      worker.postMessage({ type: 'VERSION' }, [channel.port2]);
    } catch {
      resolve(null);
    }
  }), VERSION_WAIT_MS, null);
}

/** サーバーに置いてある sw.js の VERSION を読む（読めなければ null） */
async function readServerVersion() {
  try {
    const response = await fetch('./sw.js', { cache: 'no-store' });
    if (!response.ok) return null;
    return parseSwVersion(await response.text());
  } catch {
    return null;
  }
}

function askSkipWaiting(worker) {
  try {
    worker?.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    /* すでに終了した worker */
  }
}

/**
 * 新しく入った SW が waiting で止まっている場合にだけ SKIP_WAITING を送る。
 * （sw.js の install が skipWaiting するので通常は waiting にならない）
 */
async function nudgeInstallingWorker(registration, waitMs) {
  const worker = registration.waiting ?? registration.installing;
  if (!worker) return;
  const waitingState = (state) => state === 'installed' || state === 'waiting';
  if (waitingState(worker.state)) {
    askSkipWaiting(worker);
    return;
  }
  if (worker.state === 'activated' || worker.state === 'redundant') return;
  await withTimeout(new Promise((resolve) => {
    const onChange = () => {
      if (waitingState(worker.state)) {
        askSkipWaiting(worker);
        worker.removeEventListener('statechange', onChange);
        resolve(true);
      } else if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', onChange);
        resolve(true);
      }
    };
    worker.addEventListener('statechange', onChange);
    onChange();
  }), waitMs, false);
}

/**
 * 更新を確認して、必要なら読み込み直す。
 * 戻り値: 'latest'（いまが最新だった） / 'reloaded'（リロードした） /
 *        'fallback'（SW が無いのでそのままリロードした）
 */
export async function runReload({ probeMs = SW_WAIT_MS, activateMs = ACTIVATE_WAIT_MS } = {}) {
  const container = navigator.serviceWorker;
  if (!container || typeof container.getRegistration !== 'function') {
    reloadNow();
    return 'fallback';
  }
  const registration = await container.getRegistration().catch(() => null);
  if (!registration) {
    reloadNow();
    return 'fallback';
  }

  const judged = await withTimeout(
    Promise.all([readCurrentVersion(registration), readServerVersion()])
      .then(([current, latest]) => decideReload(current, latest)),
    probeMs,
    'latest'
  );
  if (judged === 'latest') return 'latest';

  // controllerchange は update() より前に待ち始める（取りこぼさない）
  const controllerChanged = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), activateMs);
    container.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });

  await registration.update().catch(() => {});
  void nudgeInstallingWorker(registration, activateMs);

  const activated = await controllerChanged;
  // 更新があると分かっているのに有効化が来ないときも、ページだけは新しくする
  if (!activated && judged !== 'update') return 'latest';
  reloadNow();
  return 'reloaded';
}
