/**
 * 子ども画面（index.html）。点数を受け取り、累計と次の孵化までの進捗を常時表示する。
 * Phase 3-1 で 部屋（ペットルーム）、Phase 3-3 パスA で ミニゲーム（神経衰弱）を実装。
 * 図鑑はパスC まで未実装（画面にも明示）。
 */
import * as childStore from '../store/child.js';
import { POINTS_PER_HATCH, summarize } from '../game/points.js';
import { stageLabel } from '../game/pet.js';
import { MORNING_TOAST, NIGHT_REST_TOAST, NIGHT_SYNC_INTERVAL_MS } from '../game/night.js';
import { el, formatNumber, formatDateJP, clear, mount, openSheet, toast, guarded } from './dom.js';
import { openScanSheet } from './scan-sheet.js';
import { createPetSection, openHatchFlow, openPetSheet, refreshPetSection, showStageFx } from './pets.js';
import {
  MIN_BUSY_MS,
  RELOAD_BUSY_LABEL,
  RELOAD_BUSY_TEXT,
  RELOAD_ERROR_TEXT,
  RELOAD_LABEL,
  RELOAD_LATEST_TEXT,
  runReload,
} from './reload.js';
import { createRoomSection } from './room.js';
import { openGamesSheet } from './games.js';
import { openDexSheet } from './dex.js';
import { openShopSheet } from './shop.js';
import { configure as configureSound, playSe } from './sound.js';

const root = () => document.getElementById('childApp');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EGG_PATH = 'M100 12c44 0 82 62 82 118 0 47-37 86-82 86s-82-39-82-86C18 74 56 12 100 12Z';

/**
 * QRコードの絵（自作のSVG・外部画像なし）。
 * 3つの位置検出パターン（角の四角）＋決まったデータ点で、QRらしく見える最小の絵にする。
 */
function qrGlyphSvg() {
  const cells = [
    // 位置検出パターン（左上・右上・左下）: 7×7 の枠 + 3×3 の中心
    ...[[0, 0], [14, 0], [0, 14]].flatMap(([ox, oy]) => {
      const out = [];
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const edge = x === 0 || x === 6 || y === 0 || y === 6;
          const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          if (edge || center) out.push([ox + x, oy + y]);
        }
      }
      return out;
    }),
    // データ点（固定の並び。見た目重視で非対称に置く）
    [8, 0], [10, 0], [12, 0], [8, 2], [11, 2], [9, 4], [12, 4], [8, 6], [10, 6],
    [0, 8], [2, 8], [4, 8], [6, 8], [9, 8], [11, 8], [13, 8], [16, 8], [18, 8], [20, 8],
    [1, 10], [3, 10], [5, 10], [8, 10], [12, 10], [15, 10], [17, 10], [19, 10],
    [8, 11], [10, 11], [13, 11], [16, 11], [18, 11], [20, 11],
    [0, 12], [4, 12], [6, 12], [9, 12], [11, 12], [14, 12], [17, 12], [19, 12],
    [2, 14], [5, 14], [7, 14], [10, 14], [12, 14], [14, 14], [16, 14], [19, 14],
    [8, 15], [11, 15], [13, 15], [15, 15], [18, 15], [20, 15],
    [9, 17], [12, 17], [14, 17], [17, 17], [19, 17],
    [8, 18], [10, 18], [13, 18], [16, 18], [18, 18], [20, 18],
    [9, 20], [11, 20], [14, 20], [16, 20], [19, 20],
  ];
  const rects = cells
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="currentColor" />`)
    .join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 21 21');
  svg.setAttribute('class', 'qr-glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.innerHTML = rects;
  return svg;
}

/* ------------------------------------------------------------ さいよみこみ（v23） */

/** もようがえ中は押させない（未保存の配置をリロードで消さないため） */
let arranging = false;
/** 実行中は二重押しさせない */
let reloading = false;

/**
 * 円弧の矢印（自作SVG）。QRボタンと同じく currentColor で描き、絵文字は使わない
 * （端末ごとに絵柄が変わらないようにするため）。
 */
function reloadGlyphSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'reload-glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = [
    '<path d="M19.5 12A7.5 7.5 0 1 1 12 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />',
    '<path d="M11.7 1.1 16 4.6 11.7 8.1Z" fill="currentColor" />',
  ].join('');
  return svg;
}

/** 状態（もようがえ中・実行中）をボタンへ反映する */
function syncReloadButton() {
  const button = document.getElementById('reloadButton');
  if (!button) return;
  const disabled = arranging || reloading;
  button.disabled = disabled;
  button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  button.setAttribute('aria-busy', reloading ? 'true' : 'false');
  button.dataset.busy = reloading ? 'true' : 'false';
  button.setAttribute('aria-label', reloading ? RELOAD_BUSY_LABEL : RELOAD_LABEL);
}

/** 押したとき: 新しい版があるかを確かめ、あれば読み込み直す */
async function onReloadTap() {
  if (reloading || arranging) return;
  reloading = true;
  syncReloadButton();
  const startedAt = Date.now();
  const busyToast = toast(RELOAD_BUSY_TEXT, { tone: 'info', duration: 12000 });
  let result = 'error';
  try {
    result = await runReload();
  } catch (error) {
    console.error(error);
  }
  // 速すぎると何が起きたか分からないので、最低限は「よみこみ中…」を見せる
  const remain = MIN_BUSY_MS - (Date.now() - startedAt);
  if (remain > 0) await sleep(remain);
  busyToast?.remove();
  reloading = false;
  syncReloadButton();
  if (result === 'latest') toast(RELOAD_LATEST_TEXT, { tone: 'success', duration: 2400 });
  else if (result === 'error') toast(RELOAD_ERROR_TEXT, { tone: 'error', duration: 3200 });
}

document.addEventListener('tamago:arrange-changed', (event) => {
  arranging = Boolean(event.detail?.value);
  syncReloadButton();
});

function eggSvg(progress) {
  const ratio = Math.max(0, Math.min(1, progress));
  const spots = [
    [70, 96, 13],
    [132, 120, 10],
    [92, 168, 15],
    [138, 178, 8],
    [58, 150, 9],
    [110, 76, 7],
  ]
    .map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" opacity="0.28" />`)
    .join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 200 240');
  svg.setAttribute('class', `egg${ratio >= 0.9 ? ' egg--ready' : ''}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `たまごの じゅんび ${Math.round(ratio * 100)}%`);
  svg.innerHTML = `
    <defs>
      <clipPath id="eggClip"><path d="${EGG_PATH}" /></clipPath>
      <linearGradient id="eggFillGrad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#ffb43c" />
        <stop offset="55%" stop-color="#ff9060" />
        <stop offset="88%" stop-color="#ff8fa4" />
        <stop offset="100%" stop-color="#ff7a9b" />
      </linearGradient>
    </defs>
    <g clip-path="url(#eggClip)">
      <rect x="0" y="0" width="200" height="240" fill="#fff6e8" />
      <rect class="egg__fill" x="0" y="${(240 * (1 - ratio)).toFixed(2)}" width="200" height="${(240 * ratio).toFixed(2)}" fill="url(#eggFillGrad)" />
      <rect class="egg__surface" x="0" y="${(240 * (1 - ratio) - 4).toFixed(2)}" width="200" height="4" rx="2" fill="#ffffff" opacity="${ratio > 0 ? 0.85 : 0}" />
      ${spots}
    </g>
    <path d="${EGG_PATH}" fill="none" stroke="#e8d3ba" stroke-width="5" />
    <path class="egg__shine" d="M64 62c-14 16-22 38-22 58" fill="none" stroke="#ffffff" stroke-opacity="0.75" stroke-width="9" stroke-linecap="round" />
  `;
  return svg;
}

/* ------------------------------------------------------------ 起動 */

export async function initChildScreen() {
  try {
    await configureSound(await childStore.getSettings());
    const pairing = await childStore.getPairing();
    if (!pairing) return renderOnboarding();
    const bootAt = Date.now();
    // 起動直後の順番（v25）:
    //   1) 閉じていた夜の たいりょく 回復（おきていた子にも夜のぶんを与える）
    //   2) 閉じていた間は状態を悪化させない（寝かせたまま閉じた子の回復はここ）
    //   3) 実時刻に就寝・起床をそろえる（22:30 に開く→寝ている／7:30 に開く→起きている）
    await childStore.recoverClosedNight(bootAt);
    await childStore.syncPets(Date.now(), { resume: true });
    await childStore.syncNightRest(bootAt, null);
    lastNightCheckAt = bootAt;
    await renderDashboard();
    // 天気は実APIから（起動時に1回＋30分ごと）。未設定・オフラインでも画面は止めない
    void refreshWeatherOnce();
  } catch (error) {
    console.error(error);
    clear(root());
    mount(root(), el('p', { class: 'fatal', text: `読み込みに失敗しました: ${error?.message ?? error}` }));
  }
}

let currentRoom = null;

/**
 * ペットの保存状態（ねる・おきる・孵化・名前）→ 部屋（v33）。
 * 発火元は `tamago:pets-changed` だけ（カードの ねかせる/おこす・ペット名の変更・
 * ふ化、および夜間の自動就寝/起床）。画面の作り直しで二重に購読しないよう、
 * モジュールで1回だけ登録する。
 */
function onPetsChanged(event) {
  const pets = event?.detail?.pets;
  if (!Array.isArray(pets)) return;
  currentRoom?.syncSleep(pets);
}
document.addEventListener('tamago:pets-changed', guarded(onPetsChanged));

async function renderDashboard() {
  // 画面を作り直すと部屋は通常モードに戻るので、もようがえのロックも解く
  arranging = false;
  const dash = await childStore.getDashboard();
  const { pairing, state, summary, events, eventCount } = dash;
  const petRows = await childStore.listPets();
  const room = await childStore.getRoom({ petCount: petRows.length });

  currentRoom?.destroy();
  currentRoom = createRoomSection({
    pets: petRows,
    room,
    onPetTap: (petId) => {
      openPetSheet(petId);
    },
    onTutorialDone: async () => {
      await childStore.completeTutorial();
    },
    // 家具のドラッグ移動・かたづけ（保存は store が行う）
    onFurnitureMove: (itemId, col, row) => childStore.moveItem(itemId, col, row),
    onStoreItem: (itemId) => childStore.storeItem(itemId),
    onPlaceItem: (itemId) => childStore.placeItem(itemId, { now: Date.now() }),
    // ランプの点灯/消灯（v21）。手動の状態はその夜のあいだだけ有効
    onLampToggle: (itemId, lit, lightWindow) => childStore.setLampState(itemId, { lit, lightWindow }),
    onOpenShop: () => openShopSheet({
      onChanged: (nextRoom) => currentRoom?.refresh(nextRoom),
    }),
    // ずかん（v42）。夜は「みるだけ」で開ける（入口では止めない）
    onOpenDex: () => {
      void openDexSheet();
    },
    // ミニゲーム（Phase 3-3 パスA）。当たった家具はその場で持ち物へ入る
    onOpenGames: () => openGamesSheet({
      onChanged: (nextRoom) => {
        currentRoom?.refresh(nextRoom);
        // 当選した家具は「もちもの」にも出るので、部屋の所持品だけ差し替える
        void childStore.getRoom({ petCount: petRows.length }).then((room) => currentRoom?.refresh(room));
      },
    }),
  });

  // ペットのシートで帽子を付け替えたら、部屋の見た目にも反映する
  const onRoomChanged = guarded(async () => {
    const [nextRoom, roomPets] = await Promise.all([
      childStore.getRoom({ petCount: petRows.length }),
      childStore.listPets(),
    ]);
    currentRoom?.refresh({ ...nextRoom });
    if (roomPets.length !== petRows.length) await renderDashboard();
  });
  document.removeEventListener('tamago:room-changed', onRoomChanged);
  document.addEventListener('tamago:room-changed', onRoomChanged);

  clear(root());
  mount(root(), 
    el('header', { class: 'child-head' }, [
      el('button', {
        class: 'child-head__who',
        type: 'button',
        'aria-label': 'ペアリング情報',
        onclick: () => showInfo(pairing),
      }, [
        el('span', { class: 'child-head__emoji', text: '🐣' }),
        el('span', { class: 'child-head__names' }, [
          el('span', { class: 'child-head__name', text: pairing.childName }),
          el('span', { class: 'child-head__family', text: pairing.familyName }),
        ]),
      ]),
      el('div', { class: 'child-head__tools' }, [
        // さいよみこみ（v23）: 名前チップとQRの間。文字なしの丸アイコン
        el('button', {
          type: 'button',
          id: 'reloadButton',
          class: 'icon-btn icon-btn--reload',
          disabled: arranging || reloading,
          'aria-disabled': arranging || reloading ? 'true' : 'false',
          'aria-label': RELOAD_LABEL,
          dataset: { busy: 'false' },
          onclick: guarded(onReloadTap),
        }, [reloadGlyphSvg()]),
        // おとの オン・オフは「せってい」に一本化した（ヘッダからは削除）
        el('button', {
          type: 'button',
          id: 'scanButton',
          disabled: receiptRunning,
          'aria-busy': receiptRunning ? 'true' : 'false',
          class: `icon-btn icon-btn--qr${receiptRunning ? ' btn--scan--busy' : ''}`,
          'aria-label': receiptRunning ? 'つぎのQRを よんでね' : 'QRコードを よみとる',
          onclick: () => openScanner(),
        }, [qrGlyphSvg(), el('span', { class: 'icon-btn__text', text: 'QRコード' })]),
      ]),
    ]),

    el('main', { class: 'child-main' }, [
      // v45: あそびかたへの導線を初期画面のいちばん上に出す（せっていの中だけだと届かない）
      el('a', {
        class: 'guide-pill',
        href: './guide',
        id: 'guideButton',
        'aria-label': 'あそびかたを ひらく',
      }, [
        el('span', { class: 'guide-pill__ico', text: '📖', 'aria-hidden': 'true' }),
        el('span', { class: 'guide-pill__text', text: 'あそびかた' }),
      ]),
      currentRoom.element,
      el('p', {
        class: 'scan-hint',
        id: 'scanHint',
        hidden: !receiptRunning,
        'aria-live': 'polite',
        text: 'つぎのQRを よんでね',
      }),
      el('section', { class: 'score-card', 'aria-live': 'polite' }, [
        el('p', { class: 'score-card__label', text: 'ごうけい てんすう' }),
        el('p', { class: 'score-card__value' }, [
          el('span', { id: 'totalValue', class: 'score-card__number', text: formatNumber(summary.total) }),
          el('span', { class: 'score-card__unit', text: 'てん' }),
        ]),
        el('button', {
          class: `egg-stage egg-stage--tap${summary.hatchTokens > 0 ? ' egg-stage--ready' : ''}`,
          type: 'button',
          id: 'eggButton',
          'aria-label': 'たまごを かえす',
          'aria-disabled': summary.hatchTokens > 0 ? 'false' : 'true',
          dataset: { tokens: String(summary.hatchTokens) },
          onclick: () => tapEgg(),
        }, [
          eggSvg(summary.progress),
          el('p', { class: 'egg-stage__caption', id: 'eggCaption' }, [
            'つぎの たまご まで あと ',
            el('strong', { id: 'needValue', text: formatNumber(summary.nextHatchNeed) }),
            ' てん',
          ]),
          el('p', {
            class: 'egg-hint',
            id: 'eggHint',
            hidden: summary.hatchTokens <= 0,
            text: summary.hatchTokens > 1
              ? `たまごを タップして かえす（あと ${summary.hatchTokens}こ）`
              : 'たまごを タップして かえす',
          }),
        ]),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '1000', 'aria-valuenow': String(summary.remainder) }, [
          el('div', { class: 'progress__bar', id: 'progressBar', style: { width: `${summary.progress * 100}%` } }),
        ]),
        el('div', { class: 'badges' }, [
          el('span', { class: 'badge badge--hatch', id: 'hatchBadge', text: `🥚 ふかの けんり × ${summary.hatchTokens}` }),
          el('span', { class: 'badge badge--count', text: `うけとった きろく ${eventCount}件` }),
        ]),
      ]),

      await createPetSection(),

      el('section', { class: 'card history-card' }, [
        el('div', { class: 'card__head' }, [
          el('h2', { class: 'card__title', text: 'これまでの きろく' }),
          el('span', { class: 'card__count', text: `${eventCount}件` }),
        ]),
        el('div', { id: 'historyArea' }),
      ]),
    ]),

    el('footer', { class: 'child-foot' }, [
      el('a', { class: 'child-foot__link', href: 'parent', text: 'おうちのひとへ（PIN）' }),
    ])
  );

  paintHistory(events);
  startPetSync();
  startWeatherSync();
  startNightSync();
}

/* ------------------------------------------------------------ 天気（実API） */

let weatherTimer = null;

/** 取りに行って、部屋のチップと注記を合わせる（失敗時も「古い」表示に切り替える） */
async function refreshWeatherOnce() {
  try {
    const result = await childStore.refreshWeather({ now: Date.now() });
    // 失敗しても room は返る（保存値のまま）。60分を超えた保存値は「古い」になる
    if (result?.room) currentRoom?.refresh(result.room);
  } catch (error) {
    console.warn('天気を取得できませんでした', error);
  }
}

/** 30分ごとに取り直す */
function startWeatherSync() {
  if (weatherTimer) clearInterval(weatherTimer);
  weatherTimer = setInterval(() => void refreshWeatherOnce(), 30 * 60 * 1000);
}

/* ------------------------------------------------------------ 就寝・起床（v25） */

/** 前回の判定時刻（境界の1回だけを見分ける。リロードで消える＝起動時はトースト無し） */
let lastNightCheckAt = null;
let nightTimer = null;

/**
 * 実時刻に合わせて全ペットを就寝・起床させる。
 * - 22:00 / 7:00 を跨いだ**その1回だけ**トーストを出す（22時台に何度も出さない）
 * - 部屋は一斉に切り替える（寝姿＋💤・歩かない）
 * - 開いたままでも 15秒ごとに呼ぶので、端末がスリープから戻っても実時刻に追いつく
 *   （v28: 60秒 → 15秒。起床の遅れは最大15秒。IDB読み1回＋比較だけ）
 */
async function checkNightRest() {
  const now = Date.now();
  const result = await childStore.syncNightRest(now, lastNightCheckAt);
  lastNightCheckAt = now;
  if (!result.count) return result;
  // 部屋への反映はカード操作と同じ1本の経路（v33）。トーストの1回判定はここで維持する
  document.dispatchEvent(new CustomEvent('tamago:pets-changed', { detail: { pets: result.pets } }));
  if (result.entered) toast(NIGHT_REST_TOAST, { tone: 'info', duration: 2600 });
  if (result.left) {
    playSe('tap');
    toast(MORNING_TOAST, { tone: 'info', duration: 2600 });
  }
  // おせわボタンの見た目（薄い・文言）を切り替える
  if (result.changed) await refreshPetSection().catch(() => {});
  return result;
}

/** 15秒ごとの判定（仕様: 起動時と15秒ごとに実時刻へ同期。就寝・起床の両方） */
function startNightSync() {
  if (nightTimer) return;
  nightTimer = setInterval(guarded(() => checkNightRest()), NIGHT_SYNC_INTERVAL_MS);
}

/** 20秒ごとに時間経過を保存し、時間由来の成長を反映する */
let petSyncTimer = null;
function startPetSync() {
  if (petSyncTimer) return;
  petSyncTimer = setInterval(guarded(async () => {
    const events = await childStore.syncPets(Date.now());
    const stageEvents = events.filter((event) => event.type === 'stage');
    if (stageEvents.length) {
      for (const event of stageEvents) showStageFx(stageLabel(event.stage));
      await renderDashboard();
    }
  }), 20000);
}

/* ------------------------------------------------------------ 数値の描画 */

/** 孵化権の表示（累計カード・ペット欄）を同じ値にする */
function paintHatchCounts(hatchTokens) {
  const card = document.getElementById('hatchBadge');
  if (card) card.textContent = `🥚 ふかの けんり × ${hatchTokens}`;
  const pet = document.getElementById('hatchTokens');
  if (pet) pet.textContent = `× ${hatchTokens}`;
}

function paintTotals({ total, hatchTokens }) {
  const remainder = total % POINTS_PER_HATCH;
  const totalNode = document.getElementById('totalValue');
  const needNode = document.getElementById('needValue');
  const barNode = document.getElementById('progressBar');
  const hatchNode = document.getElementById('hatchBadge');
  const stage = document.querySelector('.egg-stage');
  if (totalNode) totalNode.textContent = formatNumber(total);
  if (needNode) needNode.textContent = formatNumber(POINTS_PER_HATCH - remainder);
  if (barNode) barNode.style.width = `${(remainder / POINTS_PER_HATCH) * 100}%`;
  if (hatchNode) paintHatchCounts(hatchTokens);
  if (stage) {
    const old = stage.querySelector('svg.egg');
    if (old) {
      const fresh = eggSvg(remainder / POINTS_PER_HATCH);
      old.replaceWith(fresh);
    }
  }
}

function paintHistory(events) {
  const area = document.getElementById('historyArea');
  if (!area) return;
  clear(area);
  if (!events.length) {
    area.append(el('p', { class: 'muted', text: 'まだ きろくが ありません。おうちのひとに QR を つくってもらおう！' }));
    return;
  }
  const list = el('ul', { class: 'history-list' });
  for (const event of events) {
    const points = Number(event.points) || 0;
    list.append(
      el('li', { class: 'history-item' }, [
        el('span', { class: `history-item__points ${points > 0 ? 'is-plus' : ''}`, text: `${points > 0 ? '+' : ''}${formatNumber(points)}` }),
        el('span', { class: 'history-item__body' }, [
          el('span', { class: 'history-item__name', text: event.testName }),
          el('span', { class: 'history-item__date', text: event.date ? formatDateJP(event.date) : '—' }),
        ]),
      ])
    );
  }
  area.append(list);
}

/* ------------------------------------------------------------ 演出 */

function fxLayer() {
  let layer = document.querySelector('.fx-layer');
  if (!layer) {
    layer = el('div', { class: 'fx-layer', 'aria-live': 'polite' });
    document.body.append(layer);
  }
  return layer;
}

/**
 * 累計カードの中で数字をカウントアップする（全画面ポップアップは出さない）。
 * 0.6〜1.0秒かけて前の値から新しい値へ動かし、数字をぽんと弾ませる。
 */
async function countUpTo(target) {
  const node = document.getElementById('totalValue');
  if (!node) return;
  const from = Number(String(node.textContent).replace(/[^\d-]/g, '')) || 0;
  const to = Number(target) || 0;
  if (from === to) return;

  const duration = reducedMotion() ? 1 : 900;
  node.classList.remove('score-card__number--bump');
  void node.offsetWidth;
  node.classList.add('score-card__number--bump');
  spawnSparks();

  if (duration <= 1) {
    node.textContent = formatNumber(to);
    return;
  }

  const started = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      // 最後に少しだけ行き過ぎて戻る（ぽん）
      const eased = progress < 0.85 ? 1 - (1 - progress / 0.85) ** 2 : 1;
      const value = Math.round(from + (to - from) * eased);
      node.textContent = formatNumber(value);
      if (progress < 1) requestAnimationFrame(step);
      else {
        node.textContent = formatNumber(to);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
  node.classList.remove('score-card__number--bump');
}

/** たまごタップで孵化（孵化権がなければ案内だけ） */
async function tapEgg() {
  const egg = document.getElementById('eggButton');
  if (egg?.dataset.busy === 'true') return;
  const { tokens } = await childStore.getHatchTokens();
  if (tokens <= 0) {
    const state = await childStore.getState();
    const summary = summarize(state);
    playSe('error');
    toast(`まだ たまごは うごかないよ。あと ${formatNumber(summary.nextHatchNeed)}てんで うごくよ`, { tone: 'info', duration: 3000 });
    return;
  }
  if (egg) egg.dataset.busy = 'true';
  try {
    await openHatchFlow({
      onHatched: async () => {
        const next = await childStore.getHatchTokens();
        paintHatchCounts(next.tokens);
        await renderDashboard();
        await refreshPetSection();
        // 再描画でスクロールが戻るので、受け取りの結果（累計カード）を見える位置に戻す
        document.querySelector('.score-card')?.scrollIntoView({ block: 'center' });
        // 演出のあと、たまごが見える位置へ戻す
        document.getElementById('eggButton')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    });
  } finally {
    const current = document.getElementById('eggButton');
    if (current) delete current.dataset.busy;
  }
}

/** 数字のまわりに小さなキラキラを数個出す（カード内に収める） */
function spawnSparks() {
  if (reducedMotion()) return;
  const card = document.querySelector('.score-card');
  if (!card) return;
  card.querySelectorAll('.score-spark').forEach((node) => node.remove());
  const colors = ['#ffc93c', '#ff8fab', '#7c5cf0', '#35b9ac'];
  for (let index = 0; index < 5; index += 1) {
    const spark = el('span', { class: 'score-spark' });
    spark.style.background = colors[index % colors.length];
    spark.style.setProperty('--sx', `${-40 + index * 20}px`);
    spark.style.setProperty('--sy', `${-18 - (index % 3) * 10}px`);
    spark.style.animationDelay = `${index * 40}ms`;
    card.append(spark);
  }
  setTimeout(() => card.querySelectorAll('.score-spark').forEach((node) => node.remove()), 1100);
}

/**
 * 「たっせい おめでとう！」の全画面演出。
 * - 3.5秒以上表示（タップでスキップ可）
 * - 紙吹雪・光の輪・ファンファーレ・背景を暗く
 * - 複数回分は呼び出し側で合算して1回だけ出す
 */
const CELEBRATION_MS = 3600;

async function playCelebration(granted) {
  if (granted <= 0) return;
  const layer = fxLayer();
  const quiet = reducedMotion();
  playSe('fanfare');

  const confetti = el('div', { class: 'fx-celebrate__confetti' });
  if (!quiet) {
    for (let index = 0; index < 30; index += 1) {
      const bit = el('span', { class: 'fx-celebrate__bit' });
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.animationDelay = `${Math.random() * 0.9}s`;
      bit.style.animationDuration = `${1.8 + Math.random() * 1.2}s`;
      bit.style.background = ['#ffc93c', '#ff8fab', '#4ecdc4', '#8b6ff0', '#ff7a59', '#ffe08a'][index % 6];
      confetti.append(bit);
    }
  }

  let closeCelebration;
  const closed = new Promise((resolve) => {
    closeCelebration = resolve;
  });
  const overlay = el('div', {
    class: `fx-celebrate${quiet ? ' fx-celebrate--quiet' : ''}`,
    role: 'dialog',
    'aria-live': 'assertive',
    'aria-label': `たっせい おめでとう。ふかのけんり ${granted}こ`,
    onclick: () => closeCelebration(),
  }, [
    el('div', { class: 'fx-celebrate__backdrop' }),
    el('div', { class: 'fx-celebrate__ring' }),
    confetti,
    el('div', { class: 'fx-celebrate__card' }, [
      el('span', { class: 'fx-celebrate__egg', text: '🥚' }),
      el('p', { class: 'fx-celebrate__title', text: 'たっせい おめでとう！' }),
      el('p', { class: 'fx-celebrate__value' }, [
        el('span', { text: 'ふかの けんり ' }),
        el('strong', { text: `+${granted}` }),
      ]),
      el('p', { class: 'fx-celebrate__note', text: 'たまごが うごいた きがする…！' }),
    ]),
    el('p', { class: 'fx-celebrate__skip', text: 'タップで とじる' }),
  ]);

  layer.append(overlay);

  let closedByTap = false;
  const onTap = () => {
    closedByTap = true;
  };
  overlay.addEventListener('click', onTap);
  const timer = setTimeout(() => closeCelebration(), CELEBRATION_MS);
  await closed;
  closedByTap = false;
  clearTimeout(timer);
  overlay.removeEventListener('click', onTap);

  overlay.classList.add('fx-celebrate--out');
  await sleep(quiet ? 120 : 320);
  overlay.remove();
}

/* ------------------------------------------------------------ 受け取り */

let receiptQueue = Promise.resolve();
let receiptRunning = false;
let receiptPending = 0;

function setScanLocked(locked) {
  const button = document.getElementById('scanButton');
  if (button) {
    button.disabled = locked;
    button.classList.toggle('btn--scan--busy', locked);
    button.setAttribute('aria-busy', locked ? 'true' : 'false');
    button.setAttribute('aria-label', locked ? 'つぎのQRを よんでね' : 'QRコードを よみとる');
  }
  const hint = document.getElementById('scanHint');
  if (hint) hint.hidden = !locked;
}

/** 演出を直列に処理する（重複読み取りでも二重に走らない） */
function enqueueReceipt(result) {
  // 追加した時点でロックする（演出が始まる前の隙間で次を読めないように）
  receiptPending += 1;
  receiptRunning = true;
  setScanLocked(true);

  const release = () => {
    receiptPending = Math.max(0, receiptPending - 1);
    if (receiptPending === 0) {
      receiptRunning = false;
      setScanLocked(false);
    }
  };

  receiptQueue = receiptQueue
    .then(async () => {
      try {
        // 受け取りの演出は累計カードで見せる（部屋の上にいても伝わるように）
        document.querySelector('.score-card')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // アプリが裏に回っていたら演出は省いて即時反映
        if (document.hidden) {
          await renderDashboard();
          return;
        }
        await animateReceipt(result);
        // カードとペット欄（孵化ボタンの有効/無効・つぎの そだち）を最新化する
        await renderDashboard();
        await refreshPetSection();
        // 再描画でスクロールが戻るので、受け取りの結果（累計カード）を見える位置に戻す
        document.querySelector('.score-card')?.scrollIntoView({ block: 'center' });
      } finally {
        release();
      }
    })
    .catch((error) => {
      console.error(error);
      release();
    });
  return receiptQueue;
}

/** 連続読み取りの結果を1つにまとめる（演出と再描画は1回で済ませる） */
function combineScanResults(results) {
  const list = (results ?? []).filter((entry) => entry && !entry.pairing);
  const last = list[list.length - 1] ?? null;
  if (!last) return null;
  return {
    ...last,
    fresh: list.flatMap((entry) => entry.fresh ?? []),
    skipped: list.flatMap((entry) => entry.skipped ?? []),
    granted: list.reduce((sum, entry) => sum + (Number(entry.granted) || 0), 0),
    summary: last.summary,
    scanned: list.length,
  };
}

/** 連続読み取りのログ1行分（子ども向けの短い文） */
function formatScanLine(result) {
  if (!result) return 'よみとりました';
  if (result.pairing) return 'かぞくQRを よみとりました';
  const fresh = result.fresh ?? [];
  const last = fresh[fresh.length - 1] ?? null;
  if (!last) return result.message ?? 'よみとり済みです（二重には なりません）';
  return `${fresh.length}件 → ごうけい ${formatNumber(last.totalAfter)}てん`;
}

function openScanner() {
  if (receiptRunning) {
    toast('いま えんしゅつ中。おわったら つぎのQRを よんでね', { tone: 'info', duration: 1800 });
    return;
  }
  // v45: カメラを閉じずに つぎつぎ読み取る（リカバリーQRを上から順に流し読みできる）
  openScanSheet({
    title: 'QRコードを よみとる',
    description: 'おうちのひとが 見せている QR を、つぎつぎ よみとってね。',
    continuous: true,
    continuousHint: 'よみとれたら、つぎのQRへ そのまま カメラを むけてね。',
    formatResult: formatScanLine,
    onText: async (text) => {
      const result = await childStore.ingest(text);
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onClosed: (outcome) => {
      const result = outcome?.continuous ? combineScanResults(outcome.results) : outcome;
      if (!result) return;
      if (!result.fresh?.length) {
        toast(result.message ?? 'あたらしい QR は ありませんでした', { tone: result.skipped?.length ? 'error' : 'info', duration: 3800 });
        return;
      }
      enqueueReceipt(result);
    },
  });
}

async function animateReceipt(result) {
  const fresh = result.fresh.filter((entry) => !entry.duplicate);
  if (!fresh.length) {
    toast(result.message, { tone: result.skipped?.length ? 'error' : 'info', duration: 3800 });
    return;
  }

  let tokens = result.summary.hatchTokens - result.granted;
  let grantedTotal = 0;
  for (const entry of fresh) {
    tokens += entry.grantedNow ?? 0;
    grantedTotal += entry.grantedNow ?? 0;
    // カウントアップより先に、増えた孵化権を両方のバッジへ出す
    paintHatchCounts(tokens);
    // 1件ごとに、その件の分だけカウントアップ
    await countUpTo(entry.totalAfter);
    paintTotals({ total: entry.totalAfter, hatchTokens: tokens });
    await sleep(reducedMotion() ? 40 : 300);
  }

  paintTotals({ total: result.summary.total, hatchTokens: result.summary.hatchTokens });
  // 取りこぼしの同期などで最後に孵化権が増えた分も合算する
  grantedTotal += Math.max(0, result.summary.hatchTokens - tokens);

  // 何回跨いでも祝福は1回だけ（合算して表示）
  if (grantedTotal > 0) await playCelebration(grantedTotal);

  if (result.skipped?.length) {
    toast('さきに もとの てんすうQRを よみとってね（いまの訂正は つかわないよ）', { tone: 'error', duration: 4200 });
  }
  // 受け取り成功のトーストは出さない（エラーだけ知らせる）
}

function showInfo(pairing) {
  openSheet({
    title: 'この端末について',
    content: el('div', { class: 'info-list' }, [
      el('p', {}, [el('strong', { text: 'かぞく: ' }), pairing.familyName]),
      el('p', {}, [el('strong', { text: 'こども: ' }), pairing.childName]),
      el('p', { class: 'muted small', text: `ペアリング: ${new Date(pairing.pairedAt).toLocaleString('ja-JP')}` }),
      el('p', { class: 'muted small', text: '端末の引っ越しや データの削除は おうちのひと（PIN）が 行います。' }),
      el('p', { class: 'muted small', text: 'この端末の記録は この端末のブラウザにだけ 保存されます。' }),
    ]),
  });
}

/* ------------------------------------------------------------ 未ペアリング */

function renderOnboarding() {
  clear(root());
  mount(root(), 
    el('header', { class: 'child-head child-head--plain' }, [
      el('span', { class: 'child-head__name', text: 'たまごフレンズ' }),
    ]),
    el('main', { class: 'child-main' }, [
      el('section', { class: 'onboard' }, [
        el('div', { class: 'onboard__egg' }, [eggSvg(0)]),
        el('h1', { class: 'onboard__title', text: 'ようこそ！' }),
        el('p', { class: 'onboard__text', text: 'おうちのひとに「かぞくQR」を 出してもらって、この端末で よみとってね。' }),
        el('button', {
          class: 'btn btn--primary btn--large',
          type: 'button',
          text: '📷 かぞくQRを よみとる',
          onclick: guarded(async () => {
            openScanSheet({
              title: 'かぞくQRを よみとる',
              description: 'おうちのひとが 見せている QR を よみとってください。',
              // v45: かぞくQRのあと、そのまま てんすうQRを つづけて読み取れる
              continuous: true,
              continuousHint: 'まず かぞくQR。つづけて てんすうQRも よみとれます。',
              formatResult: formatScanLine,
              onText: async (text) => {
                if (!(await childStore.isPaired())) {
                  await childStore.pair(text);
                  await renderDashboard();
                  return { ok: true, pairing: true, fresh: [], message: 'ペアリングできました' };
                }
                const result = await childStore.ingest(text);
                if (!result.ok) throw new Error(result.message);
                return result;
              },
              onClosed: (outcome) => {
                const combined = combineScanResults(outcome?.continuous ? outcome.results : []);
                if (combined?.fresh?.length) enqueueReceipt(combined);
              },
            });
          }),
        }),
        el('p', { class: 'muted small onboard__note', text: 'カメラが使えないときは、QRの下の「コードをコピー／貼り付け」を 使ってください。' }),
        el('a', {
          class: 'guide-pill guide-pill--onboard',
          href: './guide',
          'aria-label': 'あそびかたを ひらく',
        }, [
          el('span', { class: 'guide-pill__ico', text: '📖', 'aria-hidden': 'true' }),
          el('span', { class: 'guide-pill__text', text: 'あそびかたを みる' }),
        ]),
      ]),
    ]),
    el('footer', { class: 'child-foot' }, [el('a', { class: 'child-foot__link', href: 'parent', text: 'おうちのひとへ（PIN）' })])
  );
}
