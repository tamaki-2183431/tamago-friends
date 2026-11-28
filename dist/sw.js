/**
 * Service Worker — オフラインでも起動できるようにする。
 *
 * 方針:
 * - 同一オリジンの GET はネットワーク優先（更新が反映されやすい）、失敗したらキャッシュ。
 * - **pages のクリーンURL問題**: Cloudflare Pages は `/parent.html` を `/parent` へ 308 する。
 *   リダイレクトを追った応答は `redirected: true` になり、ナビゲーションに返すとブラウザが
 *   net::ERR_FAILED にする。そのため precache は `./` と `./parent` だけにし、
 *   ナビゲーションのフォールバックでは 200 の Response として作り直して返す。
 * - **guide.html は precache しない**（約380KB の単体HTML。ゲームを起動するだけの端末に
 *   常時ぶら下げる価値がない）。オフラインでは SPA シェルの代わりに返さない＝素直に失敗させる。
 */
const VERSION = 'v49';
const CACHE = `tamago-friends-${VERSION}`;

/** あそびかたガイド（v41）。precache しないので、オフラインではシェルを返さず失敗させる対象 */
const GUIDE_PATHS = new Set(['/guide', '/guide.html', '/guide/']);

/** ナビゲーションのパス → キャッシュキー（クリーンURL） */
const PAGE_CACHE = new Map([
  ['/', './'],
  ['/index.html', './'],
  ['/index', './'],
  ['/parent', './parent'],
  ['/parent.html', './parent'],
]);

const ASSETS = [
  './',
  './parent',
  './manifest.webmanifest',
  './css/base.css',
  './css/child.css',
  './css/parent.css',
  './css/splash.css',
  './js/app.js',
  './js/db.js',
  './js/version.js',
  './js/store/parent.js',
  './js/store/child.js',
  './js/game/points.js',
  './js/game/backup-save.js',
  './js/game/factory-reset.js',
  './js/game/pet.js',
  './js/game/night.js',
  './js/game/coins.js',
  './js/game/dex.js',
  './js/game/games.js',
  './js/game/arcade.js',
  './js/game/search.js',
  './js/game/rhythm.js',
  './js/game/room.js',
  './js/game/furniture.js',
  './js/game/ink.js',
  './js/game/lighting.js',
  './js/game/weather.js',
  './js/qr/payload.js',
  './js/qr/gen.js',
  './js/qr/scan.js',
  './js/ui/dom.js',
  './js/ui/splash.js',
  './js/ui/child.js',
  './js/ui/parent.js',
  './js/ui/qr-sheet.js',
  './js/ui/save-backup.js',
  './js/ui/scan-sheet.js',
  './js/ui/pets.js',
  './js/ui/reload.js',
  './js/ui/room.js',
  './js/ui/night.js',
  './js/ui/shop.js',
  './js/ui/games.js',
  './js/ui/dex.js',
  './js/ui/game-zoom.js',
  './js/ui/game-result.js',
  './js/ui/countdown.js',
  './js/ui/food-art.js',
  './js/ui/furniture-art.js',
  './js/ui/room-art.js',
  './js/ui/pet-accessory.js',
  './js/ui/pet-sprite.js',
  './js/ui/sound.js',
  './data/pets.js',
  './data/games.js',
  './data/pet-designs.js',
  './data/room.js',
  './data/room-set.js',
  './data/shop-catalog.js',
  './data/shop-set.js',
  './data/owned-set.js',
  './data/prefectures.js',
  './data/shop.js',
  './data/rewards.js',
  './assets/fonts/zen-maru-gothic-900-splash.woff2',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/**
 * ページからの問い合わせ（v23 の「さいよみこみ」）。
 * - VERSION: いま動いている版を返す（ページ側がサーバーの sw.js と比べて更新の有無を決める）
 * - SKIP_WAITING: 待機中の新しい SW をすぐ有効化する
 */
self.addEventListener('message', (event) => {
  const data = event.data ?? {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'VERSION') {
    const port = event.ports?.[0];
    if (port) port.postMessage({ type: 'VERSION', version: VERSION });
  }
});

/**
 * ナビゲーションには「200 の通常応答」だけを返す。
 * キャッシュされた応答がリダイレクト由来（redirected: true）だとブラウザがエラーにするため、
 * 本文から Response を作り直して redirected を落とす。
 */
async function asNavigationResponse(response, request) {
  if (!response) return response;
  if (request.mode !== 'navigate') return response;
  if (response.status === 200 && !response.redirected) return response;
  const body = await response.text();
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8' },
  });
}

async function offlineFallback(request) {
  const url = new URL(request.url);

  if (request.mode === 'navigate' && GUIDE_PATHS.has(url.pathname)) {
    // ガイドは precache していない。ここで SPA シェル（index）を返すと、ガイドを開いた
    // つもりでゲームが起動してしまうので、素直に失敗させる。
    return new Response('オフラインでは ガイドを ひらけません', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (request.mode === 'navigate') {
    const key = PAGE_CACHE.get(url.pathname) ?? PAGE_CACHE.get(url.pathname.replace(/\/+$/, '')) ?? null;
    if (key) {
      const page = await caches.match(key);
      if (page) return asNavigationResponse(page, request);
    }
  }

  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return asNavigationResponse(cached, request);

  if (request.mode === 'navigate') {
    const home = await caches.match('./');
    if (home) return asNavigationResponse(home, request);
  }

  return new Response('オフラインのため読み込めませんでした', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // ナビゲーションは precache（クリーンURL）を使うので、リダイレクト応答は保存しない
        if (response && response.ok && !response.redirected && request.mode !== 'navigate') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => offlineFallback(request))
  );
});
