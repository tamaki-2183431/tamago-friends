/**
 * ペットルーム（Phase 3-1 / 3-2）。
 * - 横12×8マスのグリッド。ペットが3匹を超えるごとに横1画面ぶん広がる
 * - ペットは自律で歩く・寝る・遊ぶ・家具を使う（性格の tempo で速さと頻度が変わる）
 * - 家具は**もようがえモードのときだけ**ドラッグで移動（マス単位スナップ）。
 *   レイヤーは じゅうたん < 床置き < 壁掛け。モードは保存しない（リロードで通常に戻る）
 * - モード中は 8px 以上動いたらドラッグ、動かずに離したらタップ（「かたづける」シート）。
 *   通常のモードでは家具はドラッグもタップも効かない（ペットのタップは従来どおり）
 * - rAF は1本だけ。DOM は作り直さず transform だけ更新する
 */

import { PERIODS, ROOM_ROWS, SCREEN_COLS, TILE, TUTORIAL } from '../../data/room.js';
import { LAYERS, findShopItem, isPlaceable } from '../../data/shop.js';
import { SPECIES } from '../../data/pets.js';
import { GLASS } from '../../data/room-set.js';
import {
  DOUBLE_TAP_MS,
  FLOOR_MIN_Y,
  advanceActor,
  clampToRoom,
  closestActor,
  createActor,
  gatherPlan,
  insideFurniture,
  isFreeCell,
  isNear,
  pairEvent,
  periodFor,
  roomColsFor,
  snapToDevicePixel,
  spotNextTo,
} from '../game/room.js';
import { canPlace, resolveFurniture } from '../game/furniture.js';
import {
  NIGHT_OPACITY,
  lampIsLit,
  lightLayers,
  lightMaskImage,
  lightSourcesOf,
  nightWindowKey,
  toggleLamp,
  warmMaskImage,
} from '../game/lighting.js';
import { hitOf } from '../game/ink.js';
import { stageFor } from '../game/pet.js';
import { NIGHT_CARE_TEXT, NIGHT_GAME_TEXT, isNightRest } from '../game/night.js';
import { setNightLocked } from './night.js';
import { paintFurniture } from './furniture-art.js';
import { drawPet } from './pet-sprite.js';
import {
  ART_HEIGHT,
  ART_WIDTH,
  WEATHER_PART,
  clockSpecOf,
  paintClockHands,
  paintItemArt,
  paintRoomBackground,
  msToNextMinute,
} from './room-art.js';
import { weatherNoteText as weatherNoteFor, weatherView } from '../game/weather.js';
import { accessoryOf, drawHat, drawHatThumb } from './pet-accessory.js';
import { clear, el, formatNumber, guarded, mount, openSheet, toast } from './dom.js';

const PET_SIZE = 42;
/**
 * ペットの描画位置。端末ピクセルに丸めて、合成時の補間（ドット絵の色が濁る）を防ぐ。
 * 位置の計算（actor.x/y）は float のまま持つ。
 */
function petTransform(actor, dpr = globalThis.devicePixelRatio || 1) {
  return `translate3d(${snapToDevicePixel(actor.x * TILE, dpr)}px, ${snapToDevicePixel(actor.y * TILE, dpr)}px, 0)`;
}
const MAX_DT = 60;
/** これ以上動いたらドラッグ（タップの誤爆防止） */
const DRAG_THRESHOLD = 8;

/** 家具のレイヤー → z-index（じゅうたんは床下・壁掛けはペットより手前には出さない） */
const LAYER_Z = Object.freeze({ [LAYERS.RUG]: 0, [LAYERS.FLOOR]: 1, [LAYERS.WALL]: 2 });

function speciesOf(id) {
  return SPECIES.find((item) => item.id === id) ?? SPECIES[0];
}

/** 部屋の名前チップに出す文字列。**名前だけ**（種の略号・種名は混ぜない） */
export function roomPetLabel(pet) {
  return String(pet?.name ?? '').trim();
}

function periodLabel(id) {
  return PERIODS.find((item) => item.id === id)?.label ?? 'ひる';
}

/** アクターの状態 → ふきだしの1文字（ねている子は 💤） */
function stateGlyph(state) {
  return state === 'sleep' ? '💤' : state === 'use' ? '♪' : state === 'chat' ? '💛' : '';
}

/**
 * 保存形式の1件 → 描画用。照明（v21）の手動点灯状態は**光源を持つ家具だけ**持ち回る。
 * @param {{itemId?:string,id?:string,col:number,row:number,layer?:string,lit?:boolean,lightWindow?:string}} entry
 */
function placementOf(entry) {
  const itemId = entry?.itemId ?? entry?.id;
  const item = findShopItem(itemId);
  const placement = {
    itemId,
    col: entry?.col,
    row: entry?.row,
    layer: entry?.layer ?? item?.layer ?? LAYERS.FLOOR,
  };
  if (typeof entry?.lit === 'boolean') placement.lit = entry.lit;
  if (typeof entry?.lightWindow === 'string' && entry.lightWindow) placement.lightWindow = entry.lightWindow;
  return placement;
}

/** 家具のノード（位置は CSS の left/top、絵は canvas） */
function furnitureNode(entry) {
  const w = entry.w * TILE;
  const h = entry.h * TILE;
  const art = el('canvas', { class: 'room-furniture__art' });
  // 絵は仕様のドットのみ（部屋セットの部品 or ショップの点）。無い商品は置けないので来ない
  paintItemArt(art, entry, { cellWidth: w, cellHeight: h });
  const children = [art];
  let hands = null;
  if (entry.clock) {
    // 針は毎分描き直す別レイヤー（1ドット・アンチエイリアスなし）。セル全体に敷いて
    // 幾何（中心・針の長さ）は CLOCK_SPECS から引く（かけどけい と とけい で同じ描き方）
    hands = el('canvas', { class: 'room-furniture__hands', 'aria-hidden': 'true' });
    hands.style.left = '0';
    hands.style.top = '0';
    hands.dataset.clockItem = entry.itemId;
    paintClockHands(hands, Date.now(), clockSpecOf(entry), { width: w, height: h });
    children.push(hands);
  }
  const node = el('div', {
    class: `room-furniture room-furniture--${entry.kind} room-furniture--layer-${entry.layer}`,
    style: { left: `${entry.col * TILE}px`, top: `${entry.row * TILE}px`, width: `${w}px`, height: `${h}px` },
    dataset: { kind: entry.kind, id: entry.itemId, itemId: entry.itemId, layer: entry.layer, light: entry.light ? 'true' : 'false' },
    title: entry.name ?? '',
  }, children);
  node.style.zIndex = String(LAYER_Z[entry.layer] ?? 1);
  return node;
}

/**
 * 部屋を作る。
 * @returns {{element:HTMLElement, destroy:()=>void, actors:Array, metrics:()=>object, refresh:(room:object)=>void}}
 */
export function createRoomSection({
  pets,
  room,
  onPetTap = null,
  onTutorialDone = null,
  onFurnitureMove = null,
  onStoreItem = null,
  onPlaceItem = null,
  onOpenShop = null,
  onOpenGames = null,
  onOpenDex = null,
  onLampToggle = null,
}) {
  const cols = roomColsFor(pets.length);
  const screens = Math.max(1, Math.round(cols / SCREEN_COLS));
  const screenCells = Math.max(4, Math.min(SCREEN_COLS, Math.round((globalThis.innerWidth || 375) / TILE)));
  const now = Date.now();
  const actors = pets.map((pet, index) => createActor({ ...pet, stage: stageFor(pet, now) }, index, cols, Math.random, screenCells));

  /** 保存形式（itemId / col / row / layer ＋ 光源の手動点灯状態 lit / lightWindow） */
  let placements = (room.furniture ?? []).map((entry) => placementOf(entry));
  let accessories = { ...(room.accessories ?? {}) };
  /** 所持品（配置モードの一覧に出す）。置いてあるものは除く */
  let inventory = [...(room.inventory ?? [])];
  /**
   * もようがえモード。**保存しない**（リロードで通常に戻る）。
   * 通常は家具のドラッグもタップも効かない（子どもが誤って動かさないように）。
   */
  let arrangeMode = false;
  /**
   * 照明（v21）。`renderFurniture()` は照明の枠より先に走るので、状態はここで先に宣言する。
   * - `lightsWrap` は時間帯の3枚をまとめる枠。**光のマスクはこの1枚に掛ける**（世界で1組）
   * - `warmNode` は光の中の薄い暖色（夜オーバーレイのマスクの逆）
   * - `lightReady` は「枠を作ったか」（家具の初回描画では何もしない）
   * - `dragCells` はドラッグ中の光源の位置（マスクを絵に追従させる・保存は離したとき）
   */
  let lightsWrap = null;
  let warmNode = null;
  let lightReady = false;
  let dragCells = null;

  const elements = new Map();
  const world = el('div', {
    class: 'room__world',
    style: { width: `${cols * TILE}px`, height: `${ROOM_ROWS * TILE}px` },
    dataset: { cols: String(cols), rows: String(ROOM_ROWS) },
  });

  const furnitureLayer = el('div', { class: 'room__furniture' });
  world.append(furnitureLayer);

  /** 歩くときに避ける家具（じゅうたんと壁掛けは床をふさがない） */
  function walkFurniture() {
    return resolveFurniture(placements).filter((entry) => entry.layer === LAYERS.FLOOR);
  }
  let blockers = walkFurniture();

  function renderFurniture() {
    clear(furnitureLayer);
    const entries = resolveFurniture(placements);
    for (const entry of entries) {
      const node = furnitureNode(entry);
      attachDrag(node, entry);
      furnitureLayer.append(node);
    }
    blockers = entries.filter((entry) => entry.layer === LAYERS.FLOOR);
    // 家具が増減・移動したら光も作り直す（点いている光源の位置が変わる）
    applyLighting();
  }

  /** 家具をタップしたとき（ドラッグにならなかったとき） */
  function openFurnitureSheet(entry) {
    return openSheet({
      title: entry.name ?? 'かぐ',
      description: 'かたづけると もちものに もどるよ。',
      content: el('p', {
        class: 'muted small',
        id: 'furnitureNote',
        text: `いまの ばしょ: ${entry.col + 1}れつ・${entry.row + 1}ぎょう`,
      }),
      actions: [
        { label: 'とじる', onClick: (close) => close() },
        {
          label: 'かたづける',
          variant: 'primary',
          onClick: guarded(async (close) => {
            close();
            const result = await onStoreItem?.(entry.itemId);
            if (result?.ok === false) {
              toast('かたづけられませんでした', { tone: 'error' });
              return;
            }
            const index = placements.findIndex((row) => row.itemId === entry.itemId);
            if (index >= 0) placements.splice(index, 1);
            renderFurniture();
            toast(`${entry.name}を しまったよ（もちものに もどしたよ）`, { tone: 'success', duration: 2400 });
          }),
        },
      ],
    });
  }

  /* ---------------------------------------------------------- ドラッグ */

  function attachDrag(node, entry) {
    let drag = null;

    node.addEventListener('pointerdown', (event) => {
      if (!arrangeMode) return; // 通常は家具をつかめない（ドラッグもタップも）
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const rect = node.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        grabX: event.clientX - rect.left,
        grabY: event.clientY - rect.top,
        originCol: entry.col,
        originRow: entry.row,
        moved: false,
        target: { col: entry.col, row: entry.row },
        ghost: null,
      };
      node.setPointerCapture?.(event.pointerId);
      node.classList.add('room-furniture--held');
      node.addEventListener('pointermove', onPointerMove);
      node.addEventListener('pointerup', onPointerUp);
      node.addEventListener('pointercancel', onPointerCancel);
    });

    function checkAt(col, row) {
      return canPlace(
        placements.filter((row_) => row_.itemId !== entry.itemId),
        { itemId: entry.itemId, col, row, layer: entry.layer },
        { cols, rows: ROOM_ROWS }
      );
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        node.classList.add('room-furniture--dragging');
        drag.ghost = el('div', { class: 'room-drop', 'aria-hidden': 'true' });
        drag.ghost.style.width = `${entry.w * TILE}px`;
        drag.ghost.style.height = `${entry.h * TILE}px`;
        world.append(drag.ghost);
      }
      const worldRect = world.getBoundingClientRect();
      const col = Math.round((event.clientX - worldRect.left - drag.grabX) / TILE);
      const row = Math.round((event.clientY - worldRect.top - drag.grabY) / TILE);
      drag.target = { col, row };
      const ok = checkAt(col, row).ok;
      node.style.left = `${col * TILE}px`;
      node.style.top = `${row * TILE}px`;
      // ランプはドラッグ中も光が付いてくる（保存は離したとき）
      if (entry.light) {
        dragCells = { itemId: entry.itemId, col, row };
        applyLighting();
      }
      node.classList.toggle('room-furniture--ng', !ok);
      drag.ghost.style.left = `${col * TILE}px`;
      drag.ghost.style.top = `${row * TILE}px`;
      drag.ghost.dataset.ok = ok ? 'true' : 'false';
      drag.ghost.classList.toggle('room-drop--ng', !ok);
      event.preventDefault();
    }

    function restore() {
      node.style.left = `${drag.originCol * TILE}px`;
      node.style.top = `${drag.originRow * TILE}px`;
      node.classList.remove('room-furniture--ng');
    }

    function finishCleanup(event) {
      node.classList.remove('room-furniture--held', 'room-furniture--dragging', 'room-furniture--ng');
      drag?.ghost?.remove();
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
      try {
        node.releasePointerCapture?.(event?.pointerId ?? drag?.pointerId);
      } catch {
        /* すでに外れている */
      }
    }

    async function onPointerUp(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const current = drag;
      const moved = current.moved;
      const target = current.target;
      finishCleanup(event);
      drag = null;
      if (entry.light) dragCells = null;

      // 動かさずに離した＝タップ
      if (!moved) {
        openFurnitureSheet(entry);
        return;
      }
      if (target.col === current.originCol && target.row === current.originRow) {
        node.style.left = `${current.originCol * TILE}px`;
        node.style.top = `${current.originRow * TILE}px`;
        applyLighting();
        return;
      }
      const check = checkAt(target.col, target.row);
      if (!check.ok) {
        node.style.left = `${current.originCol * TILE}px`;
        node.style.top = `${current.originRow * TILE}px`;
        node.classList.remove('room-furniture--ng');
        applyLighting();
        toast(check.reason === 'overlap' ? 'そこには おけないよ（おなじ ばしょに かさなるよ）' : 'そこには おけないよ', { tone: 'error', duration: 2200 });
        return;
      }
      const from = { col: entry.col, row: entry.row };
      entry.col = target.col;
      entry.row = target.row;
      const placement = placements.find((row_) => row_.itemId === entry.itemId);
      if (placement) {
        placement.col = target.col;
        placement.row = target.row;
      }
      node.style.left = `${target.col * TILE}px`;
      node.style.top = `${target.row * TILE}px`;
      blockers = walkFurniture();
      const result = await onFurnitureMove?.(entry.itemId, target.col, target.row);
      if (result && result.ok === false) {
        entry.col = from.col;
        entry.row = from.row;
        if (placement) {
          placement.col = from.col;
          placement.row = from.row;
        }
        node.style.left = `${from.col * TILE}px`;
        node.style.top = `${from.row * TILE}px`;
        blockers = walkFurniture();
        toast('おけなかったので もとの ばしょに もどしたよ', { tone: 'error', duration: 2400 });
      }
    }

    function onPointerCancel(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const current = drag;
      finishCleanup(event);
      drag = null;
      node.style.left = `${current.originCol * TILE}px`;
      node.style.top = `${current.originRow * TILE}px`;
      if (entry.light) {
        dragCells = null;
        applyLighting();
      }
    }
  }

  renderFurniture();

  // ペット
  const petLayer = el('div', { class: 'room__pets' });
  for (const actor of actors) {
    const species = speciesOf(actor.speciesId);
    const canvas = el('canvas', { class: 'room-pet__canvas' });
    drawPet(canvas, species, { expression: actor.expression, size: PET_SIZE, stage: actor.stage });
    const hatCanvas = el('canvas', { class: 'room-pet__hat', 'aria-hidden': 'true' });
    let tapStart = null;
    const node = el('div', {
      class: 'room-pet',
      id: `roomPet-${actor.id}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${actor.name}と あそぶ`,
      dataset: {
        petId: actor.id,
        stage: actor.stage,
        state: actor.state,
        species: actor.speciesId,
        personality: actor.personality,
        sleeping: actor.sleeping ? 'true' : 'false',
      },
      style: { transform: petTransform(actor) },
      // 8px 以上動いたらタップ扱いにしない（ドラッグの誤爆防止）
      onclick: guarded((event) => {
        if (tapStart && typeof event?.clientX === 'number') {
          const moved = Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y);
          tapStart = null;
          if (moved > DRAG_THRESHOLD) return;
        }
        tapStart = null;
        handlePetTap(actor);
      }),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handlePetTap(actor);
        }
      },
    }, [
      el('div', { class: 'room-pet__body' }, [
        el('div', { class: 'room-pet__sprite' }, [canvas, hatCanvas]),
        el('span', { class: 'room-pet__state', 'aria-hidden': 'true', text: stateGlyph(actor.state) }),
      ]),
      el('span', { class: 'room-pet__name', text: roomPetLabel(actor) }),
    ]);
    node.addEventListener('pointerdown', (event) => {
      tapStart = { x: event.clientX, y: event.clientY };
    });
    elements.set(actor.id, { node, canvas, hatCanvas, expression: actor.expression, state: actor.state, crowded: false, hatId: undefined });
    petLayer.append(node);
  }
  world.append(petLayer);

  function renderHats() {
    for (const actor of actors) {
      const view = elements.get(actor.id);
      if (!view) continue;
      const item = accessoryOf({ accessories }, actor.id);
      const id = item?.id ?? '';
      if (view.hatId === id) continue;
      view.hatId = id;
      if (item) drawHat(view.hatCanvas, item, { size: PET_SIZE, stage: actor.stage });
      else view.hatCanvas.getContext('2d')?.clearRect(0, 0, view.hatCanvas.width, view.hatCanvas.height);
      view.node.dataset.hat = id;
    }
  }
  renderHats();

  const effects = el('div', { class: 'room__effects', 'aria-hidden': 'true' });
  world.append(effects);

  const viewport = el('div', { class: 'room__viewport' }, [world]);
  const period = periodFor(Date.now());
  let weather = weatherView(room.weather);
  // 天気の地域（未設定なら取得しない）。注記の文言はこの値で決まる
  let prefecture = room.prefecture ?? '';

  // 部屋の絵（壁紙・幅木・床・ラグ・小物・窓・空・天気・サッシ・カーテン・ドア・マット）
  const art = el('canvas', { class: 'room__art', 'aria-hidden': 'true' });
  world.prepend(art);
  let screensCount = screens;

  /** 部屋の幅（画面数×528px）に合わせて canvas を用意する */
  function canvasSize() {
    art.width = ART_WIDTH * screensCount;
    art.height = ART_HEIGHT;
    art.style.width = `${ART_WIDTH * screensCount}px`;
    art.style.height = `${ART_HEIGHT}px`;
  }
  canvasSize();
  paintArt();

  /** 背景を描き直す（時間帯・天気・もようがえが変わったときだけ） */
  function paintArt() {
    paintRoomBackground(art, {
      period: periodFor(Date.now()),
      weather: weather.kind,
      screens: screensCount,
      wallpaper: findShopItem(room.wallpaper),
      floor: findShopItem(room.floor),
    });
  }

  /* ---- 照明（時間帯 → 天気 → ランプ） ---- */
  /**
   * 時間帯の色。夜は **`NIGHT_OPACITY`（0.45）のまま**。ランプはこのオーバーレイの
   * 不透明度を**下げる**（暗さを薄くする）だけで、光を足さない（v21・仕様§1）。
   */
  const LIGHT = {
    morning: { color: '#FFCBB0', opacity: 0.1 },
    day: { color: null, opacity: 0 },
    evening: { color: '#FF9152', opacity: 0.16 },
    night: { color: '#1F2A57', opacity: NIGHT_OPACITY },
  };
  const WEATHER_TINT = {
    sunny: null,
    cloudy: { color: '#94A5BC', opacity: 0.1 },
    rain: { color: '#5F7189', opacity: 0.18 },
    snow: { color: '#E9F3FF', opacity: 0.14 },
  };

  // ガラス面（オーバーレイを掛けない）を避けた矩形。**部屋全体（world幅）に対して1組だけ**
  // 作る（js/game/lighting.js）。画面数ぶん複製すると全幅の矩形が同じ位置に重なり、
  // opacity が合成されて部屋が潰れる（19匹=7画面で 42枚 → 6枚）。
  const overlayNodes = { time: [], weather: [] };

  /** 窓ガラスの列（px）。穴あきの帯の repeating-linear-gradient に使う */
  function glassSpans() {
    return {
      left: GLASS.x * 2,
      right: (GLASS.x + GLASS.w) * 2,
      screen: ART_WIDTH,
    };
  }

  function buildLightMasks() {
    for (const list of Object.values(overlayNodes)) for (const node of list) node.remove();
    overlayNodes.time = [];
    overlayNodes.weather = [];
    lightsWrap?.remove();
    warmNode?.remove();
    lightsWrap = el('div', { class: 'room__lights', 'aria-hidden': 'true' });
    warmNode = el('div', { class: 'room__warm', 'aria-hidden': 'true' });
    const layers = lightLayers({ screens: screensCount });
    for (const kind of ['time', 'weather']) {
      for (const layer of layers) {
        overlayNodes[kind].push(
          el('div', {
            class: `room__lite room__lite--${kind}`,
            dataset: { layer: layer.id, holes: String(layer.holes) },
            style: {
              left: '0',
              width: '100%',
              top: `${layer.top * 2}px`,
              height: `${layer.height * 2}px`,
            },
          })
        );
      }
    }
    // 時間帯の3枚だけを枠に入れる（枠に1枚のマスクを掛ける＝世界で1組）
    for (const node of overlayNodes.time) lightsWrap.append(node);
    world.append(lightsWrap);
    for (const node of overlayNodes.weather) world.append(node);
    world.append(warmNode);
    lightReady = true;
    applyLighting();
  }

  /** 1種類ぶん（時間帯 or 天気）の色を流し込む。穴あきの帯は窓の列だけ透明にする */
  function paintLightKind(nodes, color, opacity) {
    const span = glassSpans();
    for (const node of nodes) {
      const holes = node.dataset.holes === 'true';
      node.style.opacity = String(color ? opacity : 0);
      if (!color) {
        node.style.background = 'transparent';
        node.style.backgroundImage = '';
      } else if (holes) {
        node.style.background = 'transparent';
        node.style.backgroundImage = `repeating-linear-gradient(to right, ${color} 0 ${span.left}px, transparent ${span.left}px ${span.right}px, ${color} ${span.right}px ${span.screen}px)`;
      } else {
        node.style.background = color;
        node.style.backgroundImage = '';
      }
    }
  }

  /** マスクを掛ける（空文字なら外す＝光源0件は現行と同じ見た目） */
  function applyMask(node, image) {
    if (!node) return;
    const value = image || 'none';
    node.style.setProperty('mask-image', value);
    node.style.setProperty('-webkit-mask-image', value);
    node.dataset.masked = image ? 'true' : 'false';
  }

  /** 光源を持つ家具（カタログの `light`）の配置。ドラッグ中は絵の位置を優先する */
  function lampEntries() {
    const out = [];
    for (const entry of placements) {
      const item = findShopItem(entry.itemId);
      if (!item?.light) continue;
      const cell = dragCells && dragCells.itemId === entry.itemId ? dragCells : entry;
      out.push({
        itemId: entry.itemId,
        item,
        light: item.light,
        col: cell.col,
        row: cell.row,
        lit: entry.lit,
        lightWindow: entry.lightWindow,
      });
    }
    return out;
  }

  /** 家具のノード（光源・点灯状態の目印を付ける） */
  function lampNodeOf(itemId) {
    for (const node of furnitureLayer.children) {
      if (node.dataset.itemId === itemId) return node;
    }
    return null;
  }

  /**
   * 時間帯 → 天気 → ランプの順に重ねる。
   * ランプは「点いている光源」の周りで夜オーバーレイの不透明度を下げる（マスク1枚）。
   */
  function applyLighting() {
    // まだ枠を作っていない（家具の初回描画）ときは何もしない
    if (!lightReady) return;
    const nowMs = Date.now();
    const periodNow = periodFor(nowMs);
    const windowKey = nightWindowKey(nowMs);
    const light = LIGHT[periodNow] ?? LIGHT.day;
    const tint = WEATHER_TINT[weather.kind] ?? null;
    paintLightKind(overlayNodes.time, light.color, light.opacity);
    paintLightKind(overlayNodes.weather, tint?.color ?? null, tint ? tint.opacity : 0);
    element.dataset.period = periodNow;
    element.dataset.weather = weather.kind;
    element.dataset.nightWindow = windowKey;

    // 点灯している光源（夜だけ・手動の記録があればそれに従う）
    const lamps = lampEntries().map((lamp) => ({
      ...lamp,
      lit: lampIsLit(lamp, { period: periodNow, windowKey }),
    }));
    for (const lamp of lamps) {
      const node = lampNodeOf(lamp.itemId);
      if (!node) continue;
      node.dataset.lit = lamp.lit ? 'true' : 'false';
      node.dataset.light = 'true';
      node.classList.toggle('room-furniture--lit', lamp.lit);
      // 電球の位置（セル左上からの px）。CSS の発光（::after）が使う
      node.style.setProperty('--light-x', `${(lamp.light.cx * 2).toFixed(1)}px`);
      node.style.setProperty('--light-y', `${(lamp.light.cy * 2).toFixed(1)}px`);
    }
    const sources = lightSourcesOf(lamps, { tile: TILE });
    applyMask(lightsWrap, lightMaskImage(sources));
    applyMask(warmNode, warmMaskImage(sources));
    if (warmNode) warmNode.style.opacity = sources.length ? '1' : '0';
    element.dataset.lamp = String(sources.length);
    element.dataset.lightSources = String(sources.length);
  }

  /** その座標にあるランプ（光源を持つ家具）。**絵の範囲**だけで当たりを取る */
  function lampAtPoint(clientX, clientY) {
    const rect = world.getBoundingClientRect();
    const cell = { x: (clientX - rect.left) / TILE, y: (clientY - rect.top) / TILE };
    return hitOf(lampEntries(), cell, TILE);
  }

  /**
   * ランプをタップで点灯/消灯する（通常モードのみ・呼び出し側でペット優先）。
   * 当たったら true（床のタップとしては扱わない）。
   */
  function toggleLampAt(event) {
    const hit = lampAtPoint(event.clientX, event.clientY);
    if (!hit) return false;
    lastTap = null;
    const nowMs = Date.now();
    const periodNow = periodFor(nowMs);
    const windowKey = nightWindowKey(nowMs);
    const entry = placements.find((row) => row.itemId === hit.itemId);
    if (!entry) return false;
    const result = toggleLamp(
      { light: hit.light, lit: entry.lit, lightWindow: entry.lightWindow },
      { period: periodNow, windowKey }
    );
    if (!result.changed) {
      if (result.reason === 'daytime') toast('よるに なると つくよ', { tone: 'info', duration: 1600 });
      return true;
    }
    entry.lit = result.lit;
    entry.lightWindow = result.lightWindow;
    applyLighting();
    toast(
      result.lit ? `${hit.item.name}を つけたよ` : `${hit.item.name}を けしたよ`,
      { tone: 'info', duration: 1400 }
    );
    void onLampToggle?.(hit.itemId, result.lit, result.lightWindow);
    return true;
  }

  /**
   * 下の帯のボタン（もちもの・ショップ・もようがえ・あそぶ・ずかん）。
   * v27: 5つを**横スクロール**に並べる（1画面に3つ＋4つ目が少し見える・44px以上）。
   */
  function toolButton({ id, icon, label, ariaLabel, onclick, extraClass = '' }) {
    return el('button', {
      class: `room__tool${extraClass}`,
      type: 'button',
      id,
      'aria-label': ariaLabel,
      onclick,
    }, [
      el('span', { class: 'room__tool__icon', 'aria-hidden': 'true', text: icon }),
      el('span', { class: 'room__tool__label', text: label }),
    ]);
  }

  const shopButton = toolButton({
    id: 'roomShopButton',
    icon: '🛍',
    label: 'ショップ',
    ariaLabel: 'ショップを ひらく',
    onclick: guarded(() => {
      // 夜間ロック（v25）: 22:00〜06:59 は開かない（薄い見た目＋文言）
      if (isNightRest(Date.now())) {
        toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
        return;
      }
      onOpenShop?.();
    }),
  });

  /* ---- もちもの（配置モード）: 所持しているのに まだ 置いていない かぐ ---- */

  /** 所持品のうち、置いていない「置ける」もの（商品かどうかは問わない） */
  function unplacedOwned() {
    const placedIds = new Set(placements.map((entry) => entry.itemId));
    return inventory
      .map((id) => findShopItem(id))
      .filter((item) => item && isPlaceable(item) && !placedIds.has(item.id));
  }

  /** 保存された家具の配列を、描画用の状態へ反映する */
  function applyPlacements(nextFurniture, nextInventory) {
    if (Array.isArray(nextFurniture)) placements = nextFurniture.map((entry) => placementOf(entry));
    if (Array.isArray(nextInventory)) inventory = [...nextInventory];
    renderFurniture();
  }

  /** 所持している帽子（1アイテム＝1匹だけ。装着中のペット名を出す） */
  function ownedHats() {
    return inventory
      .map((id) => findShopItem(id))
      .filter((item) => item && item.category === 'hat');
  }

  /** 帽子を装着しているペットの名前（誰も付けていなければ null） */
  function wearerNameOf(itemId) {
    for (const [petId, wornId] of Object.entries(accessories)) {
      if (wornId !== itemId) continue;
      const pet = pets.find((row) => row.id === petId);
      return pet ? roomPetLabel(pet) || 'なまえの ない こ' : 'ペット';
    }
    return null;
  }

  /** もちもののシート。「かぐ」「ぼうし」の2タブ（ショップのカテゴリ名と揃える） */
  function openItemsSheet() {
    const paneFurniture = el('div', { class: 'room-items__pane', id: 'roomItemsFurniture', role: 'tabpanel' });
    const paneHat = el('div', { class: 'room-items__pane', id: 'roomItemsHat', role: 'tabpanel', hidden: true });
    // 夜間ロック（v25）: もちものは「開いて見る」だけ可。**おく**だけ不可にする
    // （家具を置くのは部屋の変更＝もようがえと同じ扱い）。見た目は もようがえ と同じ薄さ＋押下で文言。
    let nightLocked = isNightRest(Date.now());

    const renderFurniturePane = () => {
      clear(paneFurniture);
      nightLocked = isNightRest(Date.now());
      const grid = el('div', { class: 'room-items__grid', id: 'roomItemsGrid' });
      const rows = unplacedOwned();
      if (!rows.length) {
        grid.append(el('p', { class: 'room-items__empty', id: 'roomItemsEmpty', text: 'ぜんぶ へやに おいてあるよ。' }));
      }
      for (const item of rows) {
        const thumb = el('canvas', { class: 'room-items__art', 'aria-hidden': 'true' });
        paintFurniture(thumb, item, { maxWidth: 40, maxHeight: 40 });
        grid.append(el('article', { class: 'room-items__item', dataset: { itemId: item.id } }, [
          el('div', { class: 'room-items__thumb' }, [thumb]),
          el('div', { class: 'room-items__body' }, [
            el('p', { class: 'room-items__name', text: item.name }),
            el('p', { class: 'room-items__note', text: 'もようがえ中に ドラッグで うごかせるよ' }),
          ]),
          el('button', {
            class: `btn btn--primary btn--small room-items__place${nightLocked ? ' is-night-locked' : ''}`,
            type: 'button',
            dataset: { action: 'place', nightLocked: nightLocked ? 'true' : 'false' },
            'aria-disabled': nightLocked ? 'true' : 'false',
            text: 'おく',
            onclick: guarded(async () => {
              // 夜間ロック（v25）: おく は不可（文言は もようがえ・おせわ と同じ）
              if (isNightRest(Date.now())) {
                toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
                return;
              }
              const result = await onPlaceItem?.(item.id);
              if (!result || result.ok === false) {
                if (result?.reason === 'night') {
                  toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
                  return;
                }
                toast(
                  result?.reason === 'no-space' ? 'おく ところが ないよ。なにか かたづけてね' : 'おけなかったよ',
                  { tone: 'error', duration: 2600 }
                );
                return;
              }
              applyPlacements(result.room?.furniture, result.room?.inventory);
              renderFurniturePane();
              toast(`${item.name}を おいたよ`, { tone: 'success', duration: 2000 });
            }),
          }),
        ]));
      }
      paneFurniture.append(grid);
    };

    const renderHatPane = () => {
      clear(paneHat);
      const grid = el('div', { class: 'room-items__grid', id: 'roomItemsHatGrid' });
      const rows = ownedHats();
      if (!rows.length) {
        grid.append(el('p', { class: 'room-items__empty', id: 'roomItemsHatEmpty', text: 'まだ ぼうしを もっていないよ。ショップで かってね。' }));
      }
      for (const item of rows) {
        const wearer = wearerNameOf(item.id);
        const thumb = el('canvas', { class: 'room-items__art', 'aria-hidden': 'true' });
        drawHatThumb(thumb, item, { size: 34 });
        grid.append(el('article', {
          class: 'room-items__item room-items__item--hat',
          dataset: { itemId: item.id, worn: wearer ? 'true' : 'false' },
        }, [
          el('div', { class: 'room-items__thumb' }, [thumb]),
          el('div', { class: 'room-items__body' }, [
            el('p', { class: 'room-items__name', text: item.name }),
            el('p', {
              class: `room-items__note${wearer ? ' room-items__note--worn' : ''}`,
              dataset: { worn: wearer ? 'true' : 'false' },
              text: wearer ? `${wearer}が つけているよ` : 'つけていないよ',
            }),
          ]),
        ]));
      }
      paneHat.append(grid);
    };

    const tabFurniture = el('button', {
      class: 'room-items__tab room-items__tab--on',
      type: 'button',
      id: 'roomItemsTabFurniture',
      role: 'tab',
      dataset: { tab: 'furniture' },
      'aria-selected': 'true',
      text: 'かぐ',
    });
    const tabHat = el('button', {
      class: 'room-items__tab',
      type: 'button',
      id: 'roomItemsTabHat',
      role: 'tab',
      dataset: { tab: 'hat' },
      'aria-selected': 'false',
      text: 'ぼうし',
    });
    const select = (tab) => {
      const isHat = tab === 'hat';
      tabFurniture.classList.toggle('room-items__tab--on', !isHat);
      tabHat.classList.toggle('room-items__tab--on', isHat);
      tabFurniture.setAttribute('aria-selected', String(!isHat));
      tabHat.setAttribute('aria-selected', String(isHat));
      paneFurniture.hidden = isHat;
      paneHat.hidden = !isHat;
      if (isHat) renderHatPane();
    };
    tabFurniture.addEventListener('click', () => select('furniture'));
    tabHat.addEventListener('click', () => select('hat'));

    renderFurniturePane();
    return openSheet({
      title: 'もちもの',
      description: 'もっている かぐと ぼうしを 見られるよ。',
      content: el('div', { class: 'room-items' }, [
        el('div', { class: 'room-items__tabs', role: 'tablist', 'aria-label': 'もちものの しゅるい' }, [tabFurniture, tabHat]),
        paneFurniture,
        paneHat,
      ]),
      actions: [{ label: 'とじる', onClick: (close) => close() }],
    });
  }

  const itemsButton = toolButton({
    id: 'roomItemsButton',
    icon: '🧺',
    label: 'もちもの',
    ariaLabel: 'もちものを ひらく',
    onclick: guarded(() => openItemsSheet()),
  });

  /* ---- あそぶ（ミニゲーム）・ずかん（Phase 3-3 パスA / パスC） ---- */

  /**
   * あそぶ。夜間（22:00〜06:59）は入口を無効にする（既存の data-night-locked と同じ扱い）。
   * プレイ中に22時を跨いだ場合は、結果画面まで遊ばせてから次を止める（js/ui/games.js）。
   */
  const gamesButton = toolButton({
    id: 'roomGamesButton',
    icon: '🎮',
    label: 'あそぶ',
    ariaLabel: 'ミニゲームで あそぶ',
    extraClass: ' room__tool--games',
    onclick: guarded(() => {
      if (isNightRest(Date.now())) {
        toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2600 });
        return;
      }
      onOpenGames?.();
    }),
  });

  // ずかん（v42）。夜も「みるだけ」で開ける（Z9）＝入口は止めない。
  // もようがえ中は押せない（未保存の配置を触らせない・既存のかんりょうフローを保つ）
  const zukanButton = toolButton({
    id: 'roomZukanButton',
    icon: '📖',
    label: 'ずかん',
    ariaLabel: 'ずかんを ひらく',
    extraClass: ' room__tool--dex',
    onclick: guarded(() => {
      if (arrangeMode) return;
      onOpenDex?.();
    }),
  });

  /* ---- もようがえモード ---- */

  const arrangeHint = el('p', {
    class: 'room__note room__note--arrange',
    id: 'roomArrangeHint',
    hidden: true,
    text: 'かぐを ドラッグして うごかせるよ。おわったら「かんりょう」を おしてね。',
  });

  const arrangeButton = toolButton({
    id: 'roomArrangeButton',
    icon: '✏️',
    label: 'もようがえ',
    ariaLabel: 'もようがえを はじめる',
    extraClass: ' room__tool--arrange',
    onclick: guarded(() => {
      // 夜間ロック（v25）: 22:00〜06:59 は もようがえに入らない
      if (isNightRest(Date.now())) {
        toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
        return;
      }
      setArrangeMode(!arrangeMode);
    }),
  });
  arrangeButton.setAttribute('aria-pressed', 'false');

  /** もようがえモードの切り替え（保存しない・リロードで通常に戻る） */
  function setArrangeMode(next) {
    const value = Boolean(next);
    if (value === arrangeMode) return;
    arrangeMode = value;
    element.classList.toggle('room--arrange', value);
    element.dataset.arrange = value ? 'true' : 'false';
    arrangeButton.setAttribute('aria-pressed', String(value));
    arrangeButton.setAttribute('aria-label', value ? 'もようがえを おわる' : 'もようがえを はじめる');
    arrangeButton.querySelector('.room__tool__icon').textContent = value ? '✔' : '✏️';
    arrangeButton.querySelector('.room__tool__label').textContent = value ? 'かんりょう' : 'もようがえ';
    arrangeHint.hidden = !value;
    // ずかん（v42）は もようがえ中は押せない（押しても何も起きない）
    zukanButton.disabled = value;
    // モードを抜けたら、ドラッグ中の見た目（ゴースト・赤枠）を残さない
    if (!value) {
      furnitureLayer.querySelectorAll('.room-drop').forEach((node) => node.remove());
      furnitureLayer.querySelectorAll('.room-furniture--ng').forEach((node) => node.classList.remove('room-furniture--ng'));
      furnitureLayer.querySelectorAll('.room-furniture--held, .room-furniture--dragging').forEach((node) => {
        node.classList.remove('room-furniture--held', 'room-furniture--dragging');
      });
      renderFurniture();
    }
    // ヘッダーの「さいよみこみ」は、未保存の配置が消えるので もようがえ中は押せない（v23）
    document.dispatchEvent(new CustomEvent('tamago:arrange-changed', { detail: { value } }));
    toast(value ? 'かぐを うごかせるよ' : 'もようがえを おわったよ', { tone: 'info', duration: 1600 });
  }

  /* ---- 就寝・起床の自動化＋夜間ロック（v25） ---- */

  /**
   * 保存されている `sleeping` を部屋のアクターへ反映する（22:00／7:00 の一斉切替）。
   * - 就寝: 状態を 'sleep' に固定し、歩行・家具・交流の予定を捨てる（位置は動かさない）
   * - 起床: 'idle' に戻す（次のフレームから歩き出す）
   * - v33: カードの ねかせる/おこす・孵化・名前変更・夜間の自動切替が
   *   `tamago:pets-changed` 経由でここに来る（部屋への保存状態の反映はこの1か所）。
   *   名前も変わっていれば一緒に差し替える。
   * @param {Array<object>} pets 保存されているペット（`id` / `sleeping` / `name` を見る）
   */
  function syncSleep(pets = []) {
    let sleeping = 0;
    for (const pet of pets) {
      const actor = actors.find((row) => row.id === pet?.id);
      if (!actor) continue;
      applySleep(actor, pet.sleeping === true);
      if (actor.sleeping) sleeping += 1;
      // 名前変更（v33）も同じ経路で反映する（部屋の名前チップ）
      if (typeof pet.name === 'string' && pet.name !== actor.name) {
        actor.name = pet.name;
        const node = elements.get(actor.id)?.node;
        if (node) {
          node.querySelector('.room-pet__name')?.replaceChildren(roomPetLabel(actor));
          node.setAttribute('aria-label', `${actor.name}と あそぶ`);
        }
      }
    }
    element.dataset.sleeping = String(sleeping);
    element.dataset.nightRest = isNightRest(Date.now()) ? 'true' : 'false';
    paintNightTools();
    return sleeping;
  }

  /** 1匹の就寝・起床（位置と、寝姿／ふつうの絵を切り替える） */
  function applySleep(actor, sleeping) {
    const next = Boolean(sleeping);
    if (actor.sleeping !== next) {
      actor.sleeping = next;
      if (next) {
        actor.state = 'sleep';
        actor.expression = 'sleep';
        actor.target = null;
        actor.pendingGreet = null;
        actor.chattingWith = null;
        actor.furnitureId = null;
        actor.walkStartedAt = 0;
        actor.until = 0;
      } else {
        actor.state = 'idle';
        actor.expression = 'normal';
        actor.target = null;
        actor.until = 0;
      }
      const view = elements.get(actor.id);
      if (view) {
        view.node.dataset.sleeping = next ? 'true' : 'false';
        view.node.dataset.state = actor.state;
        const glyph = view.node.querySelector('.room-pet__state');
        if (glyph) glyph.textContent = stateGlyph(actor.state);
      }
    } else if (next) {
      // 念のため（外から state を触られても寝姿に戻す）
      actor.state = 'sleep';
      actor.expression = 'sleep';
      actor.target = null;
    }
    return actor;
  }

  /**
   * 夜間ロックの見た目（ショップ・もようがえ）。22:00〜06:59 は薄く・押すと文言。
   * 入口を増やすときは、ここに `setNightLocked(ボタン, night)` を足して
   * onclick の先頭で `isNightRest(Date.now())` を見る（ゲームは Phase 3-3 で同じ形にする）。
   */
  function paintNightTools() {
    const night = isNightRest(Date.now());
    element.dataset.nightRest = night ? 'true' : 'false';
    setNightLocked(shopButton, night);
    setNightLocked(arrangeButton, night);
    // ゲームの入口も同じ扱い（薄く・押すと「あさ 7じから あそべるよ」）
    setNightLocked(gamesButton, night);
    // 22:00 を もようがえ中に跨いだら、未保存のドラッグを残さず通常モードへ戻す
    if (night && arrangeMode) setArrangeMode(false);
    return night;
  }

  /** 天気のチップは短く（アイコン＋分類だけ）。未取得・古いときは下の1行で正直に補う */
  function weatherChipText() {
    return `${weather.icon} ${weather.label}`;
  }

  /** 実天気と偽らないための1行（未設定／未取得／前回の値のまま）。空文字なら出さない */
  function weatherNoteText() {
    return weatherNoteFor(prefecture, weather);
  }

  const statusText = el('div', { class: 'room__status', id: 'roomStatus' }, [
    el('span', { class: 'room__chip', id: 'roomPeriod', text: periodLabel(period) }),
    el('span', { class: 'room__chip', id: 'roomWeather', text: weatherChipText() }),
    el('span', { class: 'room__chip room__chip--count', id: 'roomCount', text: `${pets.length}ひき` }),
  ]);
  // 地域が未設定のときだけ押せる（タップで「せってい」を開く）。見た目は小さな注記のまま
  const weatherNote = el('button', {
    class: 'room__note',
    id: 'roomWeatherNote',
    type: 'button',
    text: weatherNoteText(),
  });
  weatherNote.addEventListener('click', () => {
    if (prefecture) return; // 未設定のときだけ設定への導線
    document.dispatchEvent(new CustomEvent('tamago:open-settings'));
  });

  /** チップと同じタイミングで注記の文言・表示・押せる状態を合わせる（リロード不要） */
  function paintWeatherNote() {
    const actionable = !prefecture;
    const text = weatherNoteText();
    if (weatherNote.textContent !== text) weatherNote.textContent = text;
    weatherNote.hidden = !text;
    weatherNote.disabled = !actionable;
    weatherNote.tabIndex = actionable ? 0 : -1;
    weatherNote.classList.toggle('room__note--action', actionable);
    if (actionable) weatherNote.setAttribute('aria-label', 'せっていを ひらく');
    else weatherNote.removeAttribute('aria-label');
  }
  paintWeatherNote();

  // 状態チップは部屋の絵の外（下の帯）に置く（窓・絵画・時計に重ねない）。
  // そのすぐ下に もちもの・ショップ・もようがえ・あそぶ・ずかん の5ボタンを**横スクロール**で並べる。
  // 「もっと見る」は置かない（右端の見切れ＋フェードで「横に続く」と分かるようにする）。
  const tools = el('div', { class: 'room__tools', id: 'roomTools' }, [
    itemsButton,
    shopButton,
    arrangeButton,
    gamesButton,
    zukanButton,
  ]);
  const toolsWrap = el('div', { class: 'room__tools-wrap', id: 'roomToolsWrap' }, [tools]);
  const statusBar = el('div', { class: 'room__bar' }, [statusText, weatherNote, toolsWrap, arrangeHint]);

  const element = el('section', { class: 'room', id: 'roomSection', 'aria-label': 'ペットの へや' }, [
    viewport,
    statusBar,
  ]);
  buildLightMasks();
  // 夜間ロックの初期表示（22:00〜06:59 に開いたとき）＋寝ている匹数（テスト・デバッグ用）
  element.dataset.arrange = 'false';
  element.dataset.sleeping = String(actors.filter((actor) => actor.sleeping).length);
  element.dataset.petCount = String(actors.length);
  paintNightTools();
  // v33: 部屋の生成時に保存状態を1回通す（寝ている子は最初から寝姿・💤・動かない・位置そのまま）。
  // ここが無いと、カードで寝かせてリロードした子が起きて歩き出すことがある。
  syncSleep(pets);

  /* ---- 横スクロールの「まだ右に続くよ」のフェード（v27） ---- */

  /**
   * 右端のフェードの出し分け。
   * 横に続きがある（scrollWidth > clientWidth）ときだけ出し、右端まで送ったら消す。
   * 「もっと見る」ボタンは置かない代わりの合図（4つ目が見切れている＋このフェード）。
   */
  function paintToolsFade() {
    const max = tools.scrollWidth - tools.clientWidth;
    const scrollable = max > 1;
    toolsWrap.classList.toggle('is-scrollable', scrollable);
    toolsWrap.classList.toggle('is-at-end', !scrollable || tools.scrollLeft >= max - 1);
  }
  tools.addEventListener('scroll', paintToolsFade, { passive: true });
  let toolsObserver = null;
  let toolsRaf = 0;
  // 部屋がDOMに載ってから幅が決まるので、次のフレームとリサイズで測り直す
  toolsRaf = requestAnimationFrame(paintToolsFade);
  if (typeof ResizeObserver === 'function') {
    toolsObserver = new ResizeObserver(() => paintToolsFade());
    toolsObserver.observe(tools);
  } else {
    window.addEventListener('resize', paintToolsFade);
  }

  /* ------------------------------------------------------------ 演出 */

  function spawnEffect(actor, kind) {
    // 絵柄は中の .room-fx__glyph（大きさのアニメ用）。外側の .room-fx は位置だけを持つ
    const node = el('span', { class: `room-fx room-fx--${kind}` }, [
      el('span', { class: 'room-fx__glyph', text: kind === 'special' ? '✨' : '💛' }),
    ]);
    node.style.transform = `translate3d(${actor.x * TILE + TILE / 2}px, ${actor.y * TILE}px, 0)`;
    effects.append(node);
    setTimeout(() => node.remove(), kind === 'special' ? 1600 : 1200);
  }

  function startChat(a, b) {
    const now = performance.now();
    const event = pairEvent(a, b);
    for (const actor of [a, b]) {
      actor.state = 'chat';
      actor.until = now + 1800;
      actor.expression = 'happy';
      actor.chattingWith = actor === a ? b.id : a.id;
      actor.lastChatAt = now;
    }
    spawnEffect(a, event.type);
    spawnEffect(b, event.type);
    if (event.type === 'special') {
      const note = el('span', { class: 'room-fx room-fx--note' }, [
        el('span', { class: 'room-fx__glyph', text: '🎵' }),
      ]);
      note.style.transform = `translate3d(${((a.x + b.x) / 2) * TILE}px, ${((a.y + b.y) / 2) * TILE - 18}px, 0)`;
      effects.append(note);
      setTimeout(() => note.remove(), 1600);
    }
    return event;
  }

  function handlePetTap(actor) {
    if (arrangeMode) return; // もようがえ中はペットを触らない（かぐだけ動かす）
    // 就寝中は ふれあわない（歩かない・演出もしない）。タップは おせわシートを開くだけ
    if (actor.sleeping) {
      if (onPetTap) onPetTap(actor.id);
      return;
    }
    const partner = closestActor(actor, actors);
    if (partner) {
      // 近ければ その場で、遠ければ相手のそばまで歩いてから ふれあう
      if (isNear(actor, partner, 1.3)) startChat(actor, partner);
      else {
        const spot = spotNextTo(actor, partner, cols);
        if (spot) {
          actor.state = 'walk';
          actor.target = { ...spot, kind: 'greet', partnerId: partner.id };
          actor.pendingGreet = partner.id;
          actor.expression = 'happy';
          actor.until = 0;
        } else {
          startChat(actor, partner);
        }
      }
    } else {
      actor.state = 'play';
      actor.until = performance.now() + 1200;
      actor.expression = 'happy';
      spawnEffect(actor, 'friend');
    }
    if (onPetTap) onPetTap(actor.id);
  }

  /* ---- 床のダブルタップで近くの子が集まる（v19） ---- */

  let lastTap = null;
  /** 直前の pointerdown（スクロールのドラッグをタップと誤認しないため） */
  let tapStart = null;

  /** 画面座標 → 部屋のセル座標 */
  function cellAtPoint(clientX, clientY) {
    const rect = world.getBoundingClientRect();
    return { x: (clientX - rect.left) / TILE, y: (clientY - rect.top) / TILE };
  }

  /** 集まった人数（テスト・デバッグ用） */
  function gatherAt(cell) {
    const plan = gatherPlan({ actors, cell, cols, furniture: blockers });
    if (!plan.movers.length) return 0;
    for (const mover of plan.movers) {
      const actor = actors.find((row) => row.id === mover.id);
      if (!actor) continue;
      actor.state = 'walk';
      actor.target = { ...mover.target };
      actor.until = 0;
      actor.walkStartedAt = 0;
      actor.pendingGreet = null;
      actor.expression = 'normal';
    }
    element.dataset.gathered = String(plan.movers.length);
    // 誰を呼んだか（テスト・デバッグ用）
    element.dataset.gatherIds = plan.movers.map((mover) => mover.id).join(',');
    return plan.movers.length;
  }

  /**
   * 床をタップしたとき（通常モードのみ）。400ms 以内に2回で「集まる」。
   * ペットの上・家具の上・壁・シート表示中・もようがえ中は何もしない。
   */
  function onRoomTap(event) {
    if (event?.pointerType === 'mouse' && typeof event.button === 'number' && event.button > 0) return;
    if (arrangeMode) return;
    if (document.querySelector('.sheet-overlay')) return;
    if (document.querySelector('#roomTutorial')) return;
    if (event?.target?.closest?.('.room-pet')) return;
    // 指を滑らせた（横スクロール）ときはタップではない
    if (tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 10) {
      tapStart = null;
      return;
    }
    tapStart = null;

    // ランプの点灯/消灯（通常モードのみ・ペット優先は上の `.room-pet` 判定）
    if (toggleLampAt(event)) return;

    const cell = cellAtPoint(event.clientX, event.clientY);
    // 床（3行目以降）だけ。家具の上は「床」ではない
    if (cell.y < FLOOR_MIN_Y || cell.y > ROOM_ROWS - 0.5) return;
    if (insideFurniture(cell.x, cell.y, blockers)) return;

    // ここまで来た＝「床のタップ」として受け付けた（テスト・デバッグ用のカウンタ）
    const accepted = Number(element.dataset.taps ?? 0) + 1;
    element.dataset.taps = String(accepted);

    const now = performance.now();
    const isDouble =
      lastTap &&
      now - lastTap.t <= DOUBLE_TAP_MS &&
      Math.hypot(cell.x - lastTap.x, cell.y - lastTap.y) <= 0.75;
    if (!isDouble) {
      lastTap = { t: now, x: cell.x, y: cell.y };
      return;
    }
    lastTap = null;
    // ダブルタップでのズーム・スクロールを止める
    event.preventDefault?.();
    gatherAt(cell);
  }

  viewport.addEventListener('pointerdown', (event) => {
    tapStart = { x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener('pointerup', guarded(onRoomTap));

  /** 相手のそばに着いたら ふれあう */
  function resolveGreet(actor) {
    if (!actor.pendingGreet) return;
    const partner = actors.find((row) => row.id === actor.pendingGreet);
    actor.pendingGreet = null;
    if (partner) startChat(actor, partner);
  }

  /* ------------------------------------------------------------ ループ */

  let frame = 0;
  let last = 0;
  let disposed = false;
  let fpsSamples = [];
  let fps = 0;

  function paint(now) {
    const dt = Math.min(MAX_DT, Math.max(0, now - last));
    last = now;
    if (dt > 0) {
      fpsSamples.push(dt);
      if (fpsSamples.length > 60) fpsSamples.shift();
      const average = fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length;
      fps = average > 0 ? Math.round(1000 / average) : 0;
    }

    const scrollLeft = viewport.scrollLeft || 0;
    const visibleWidth = viewport.clientWidth || cols * TILE;
    const view = {
      minX: scrollLeft / TILE + 0.8,
      maxX: (scrollLeft + visibleWidth) / TILE - 0.8,
    };
    const ctx = { cols, now, rng: Math.random, furniture: blockers, view };
    // 就寝中（v25）の子は完全に止める: 状態も位置も変えない
    for (const actor of actors) {
      if (actor.sleeping) continue;
      advanceActor(actor, dt, ctx);
    }

    // 重なりすぎないように、少しだけ離す（家具の中には押し込まない）
    for (let i = 0; i < actors.length; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const a = actors[i];
        const b = actors[j];
        if (a.sleeping || b.sleeping) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const gap = Math.hypot(dx, dy);
        if (gap <= 0.001 || gap >= 0.72) continue;
        const push = (0.72 - gap) / 2;
        const nx = dx / gap;
        const ny = dy / gap;
        const ax = a.x - nx * push;
        const ay = a.y - ny * push;
        const bx = b.x + nx * push;
        const by = b.y + ny * push;
        if (isFreeCell(ax, ay, cols, blockers)) {
          a.x = ax;
          a.y = ay;
        }
        if (isFreeCell(bx, by, cols, blockers)) {
          b.x = bx;
          b.y = by;
        }
      }
    }

    // 画面のふちで見切れないように位置を丸め直す（右端・左端）
    for (const actor of actors) {
      if (actor.sleeping) continue;
      const clamped = clampToRoom(actor.x, actor.y, cols);
      if (clamped.x !== actor.x || clamped.y !== actor.y) {
        if (isFreeCell(clamped.x, clamped.y, cols, blockers)) {
          actor.x = clamped.x;
          actor.y = clamped.y;
        }
      }
    }

    // 近づいたらふれあう（クールダウンつき）
    for (let i = 0; i < actors.length; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const a = actors[i];
        const b = actors[j];
        if (a.sleeping || b.sleeping) continue;
        if (a.state === 'sleep' || b.state === 'sleep') continue;
        if (a.state === 'chat' || b.state === 'chat') continue;
        if (a.chattingWith || b.chattingWith) continue;
        const cooldown = 6000;
        if (a.lastChatAt && now - a.lastChatAt < cooldown) continue;
        if (b.lastChatAt && now - b.lastChatAt < cooldown) continue;
        if (isNear(a, b, 1.2)) startChat(a, b);
      }
    }

    for (const actor of actors) {
      if (actor.pendingGreet && actor.state !== 'walk') resolveGreet(actor);
      const view_ = elements.get(actor.id);
      if (!view_) continue;
      view_.node.style.transform = petTransform(actor);
      view_.node.dataset.state = actor.state;
      view_.node.dataset.facing = actor.facing > 0 ? 'right' : 'left';
      if (view_.expression !== actor.expression) {
        view_.expression = actor.expression;
        drawPet(view_.canvas, speciesOf(actor.speciesId), { expression: actor.expression, size: PET_SIZE, stage: actor.stage });
      }
      // 近くに仲間がいるときは名前を隠す（2.5マス以内・チップが重ならない）
      const crowded = actors.some(
        (other) =>
          other.id !== actor.id && Math.hypot(other.x - actor.x, other.y - actor.y) <= 2.5
      );
      if (view_.crowded !== crowded) {
        view_.crowded = crowded;
        view_.node.dataset.crowded = crowded ? 'true' : 'false';
      }

      if (view_.state !== actor.state) {
        view_.state = actor.state;
        const glyph = view_.node.querySelector('.room-pet__state');
        if (glyph) glyph.textContent = stateGlyph(actor.state);
      }
    }

    if (!disposed) frame = requestAnimationFrame(paint);
  }

  // 時間帯は30秒ごとに見直す（背景の絵と照明を作り直す）
  let periodTimer = 0;
  let currentPeriod = period;
  function refreshPeriod() {
    // 夜間ロックはここでも見直す（境界を跨いだまま再描画が来なくても薄くなる）
    paintNightTools();
    const next = periodFor(Date.now());
    if (next === currentPeriod) return;
    currentPeriod = next;
    paintArt();
    applyLighting();
    const label = document.getElementById('roomPeriod');
    if (label) label.textContent = periodLabel(next);
  }

  frame = requestAnimationFrame((now) => {
    last = now;
    paint(now);
  });
  periodTimer = setInterval(refreshPeriod, 30000);

  // 掛け時計の針は「次の分境界」でだけ描き直す（毎秒の interval にはしない）
  let clockTimer = 0;
  function refreshClock() {
    // 掛け時計（かけどけい・とけい）はすべて同じ規則で毎分描き直す
    for (const node of world.querySelectorAll('.room-furniture__hands')) {
      const item = findShopItem(node.dataset.clockItem);
      const parent = node.parentElement;
      paintClockHands(node, Date.now(), clockSpecOf(item), {
        width: parent?.offsetWidth || 44,
        height: parent?.offsetHeight || 44,
      });
    }
    clockTimer = setTimeout(refreshClock, msToNextMinute());
  }
  clockTimer = setTimeout(refreshClock, msToNextMinute());

  // 初回だけチュートリアル
  let tutorialNode = null;
  if (!room.tutorialDone) tutorialNode = buildTutorial(async () => {
    // 保存が終わってから閉じる（すぐ再読込しても出直さないように）
    if (onTutorialDone) await onTutorialDone();
    tutorialNode?.remove();
    tutorialNode = null;
  });
  if (tutorialNode) element.append(tutorialNode);

  function destroy() {
    disposed = true;
    cancelAnimationFrame(frame);
    clearInterval(periodTimer);
    clearTimeout(clockTimer);
    cancelAnimationFrame(toolsRaf);
    toolsObserver?.disconnect();
    window.removeEventListener('resize', paintToolsFade);
    tools.removeEventListener('scroll', paintToolsFade);
  }

  /** ショップや帽子のあとに、部屋の見た目だけを差し替える（ペットは歩き続ける） */
  function refresh(nextRoom) {
    if (!nextRoom) return;
    if (nextRoom.wallpaper) room.wallpaper = nextRoom.wallpaper;
    if (nextRoom.floor) room.floor = nextRoom.floor;
    const previousKind = weather.kind;
    // 地域の変更（未設定→設定・解除）も注記に効くので、天気が来ていなくても反映する
    if (typeof nextRoom.prefecture === 'string') {
      room.prefecture = nextRoom.prefecture;
      prefecture = nextRoom.prefecture;
    }
    if (nextRoom.weather) {
      room.weather = nextRoom.weather;
      weather = weatherView(nextRoom.weather);
    }
    if (typeof nextRoom.prefecture === 'string' || nextRoom.weather) {
      const chip = document.getElementById('roomWeather');
      if (chip) chip.textContent = weatherChipText();
      paintWeatherNote();
    }
    // 絵に効くのは壁紙・床・天気の種類だけ。取得に失敗しただけの再描画（起動直後など）で
    // キャンバスを描き直さない（毎回の再取得で無駄な描画を走らせない）
    const artChanged = Boolean(nextRoom.wallpaper || nextRoom.floor)
      || (Boolean(nextRoom.weather) && weather.kind !== previousKind);
    if (artChanged) {
      paintArt();
      applyLighting();
    }
    if (Array.isArray(nextRoom.inventory)) inventory = [...nextRoom.inventory];
    if (Array.isArray(nextRoom.furniture)) {
      const before = JSON.stringify(placements);
      placements = nextRoom.furniture.map((entry) => placementOf(entry));
      if (JSON.stringify(placements) !== before) renderFurniture();
    }
    if (nextRoom.accessories) {
      accessories = { ...nextRoom.accessories };
      renderHats();
    }
  }

  return {
    element,
    actors,
    destroy,
    refresh,
    syncSleep,
    metrics: () => ({ fps, cols, actors: actors.length, tiles: cols * ROOM_ROWS }),
  };
}

/* ------------------------------------------------------------ チュートリアル */

/** チュートリアルの挿絵（既存のドット絵＋canvasで描く） */
function tutorialArt(kind) {
  const wrap = el('div', { class: `room-tutorial__art room-tutorial__art--${kind}`, 'aria-hidden': 'true' });

  const petCanvas = (speciesId, size, extraClass) => {
    const canvas = el('canvas', { class: `room-tutorial__pet ${extraClass ?? ''}` });
    drawPet(canvas, speciesOf(speciesId), { expression: 'happy', size });
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    return canvas;
  };

  if (kind === 'future') {
    const canvas = el('canvas', { class: 'room-tutorial__gamepad' });
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = 120 * ratio;
    canvas.height = 64 * ratio;
    canvas.style.width = '120px';
    canvas.style.height = '64px';
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#8b6ff0';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(8, 12, 104, 34, 16) : ctx.rect(8, 12, 104, 34);
    ctx.fill();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(30, 29, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff8fab';
    [[84, 23], [92, 35], [76, 35], [84, 29]].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    // 外部画像なし・日本語で「あそぶ」（COMING SOON は使わない）
    ctx.fillStyle = '#4b2f5e';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('あそぶ', 60, 56);
    wrap.append(canvas);
    return wrap;
  }

  wrap.append(
    el('div', { class: 'room-tutorial__floor' }),
    el('div', { class: 'room-tutorial__pets' }, [
      petCanvas('mochi', 52, 'room-tutorial__pet--a'),
      kind === 'care'
        ? el('span', { class: 'room-tutorial__heart', text: '💛' })
        : petCanvas('poko', 44, 'room-tutorial__pet--b'),
    ])
  );
  if (kind === 'care') {
    wrap.append(
      el('span', { class: 'room-tutorial__heart room-tutorial__heart--b', text: '💗' }),
      el('span', { class: 'room-tutorial__heart room-tutorial__heart--c', text: '✨' })
    );
  }
  return wrap;
}

function buildTutorial(onFinish) {
  let page = 0;
  const card = el('div', { class: 'room-tutorial__card', role: 'dialog', 'aria-label': 'あそびかた' });
  const overlay = el('div', { class: 'room-tutorial', id: 'roomTutorial' }, [card]);

  const renderPage = () => {
    const item = TUTORIAL[page];
    const last = page === TUTORIAL.length - 1;
    // ページを切り替えるときは必ず作り直す（前のページを残さない）
    clear(card);
    mount(card,
      tutorialArt(item.art),
      el('p', { class: 'room-tutorial__step', text: `${page + 1} / ${TUTORIAL.length}` }),
      el('h3', { class: 'room-tutorial__title', text: item.title }),
      el('p', { class: 'room-tutorial__body', text: item.body }),
      el('div', { class: 'room-tutorial__actions' }, [
        el('button', {
          class: `btn btn--ghost${page === 0 ? ' btn--ghost--placeholder' : ''}`,
          type: 'button',
          id: 'tutorialBack',
          text: 'もどる',
          tabindex: page === 0 ? '-1' : '0',
          'aria-hidden': page === 0 ? 'true' : 'false',
          onclick: () => {
            if (page === 0) return;
            page -= 1;
            renderPage();
          },
        }),
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          id: last ? 'tutorialDone' : 'tutorialNext',
          text: last ? 'はじめる' : 'つぎへ',
          onclick: async () => {
            if (last) {
              await onFinish();
              return;
            }
            page += 1;
            renderPage();
          },
        }),
      ]),
      // v41: 最後のページから あそびかたガイド（別タブ）へ。主操作「はじめる」は動かさない
      last
        ? el('a', {
            class: 'btn btn--ghost room-tutorial__guide',
            id: 'tutorialGuideLink',
            href: './guide.html',
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'あそびかたガイドを みる',
          })
        : null
    );
    card.querySelector('.btn--primary')?.focus();
  };
  renderPage();
  return overlay;
}

/** 部屋の見出し（外から使う小さなラベル） */
export function roomSummaryText(pets, room) {
  return `${formatNumber(pets.length)}ひき ・ ${periodLabel(periodFor(Date.now()))} ・ ${weatherView(room.weather).label}`;
}
