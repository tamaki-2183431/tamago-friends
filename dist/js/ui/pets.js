/**
 * 子ども画面のペットパネル（Phase 2）。
 * 一覧（孵化順）＋選択中ペットの詳細＋お世話＋孵化＋コイン＋設定。
 * Phase 3-1 の部屋・Phase 3-3 のミニゲームは実装済み（v39: 実態と合わなくなった「Phase 3」の注記は削除）。
 */
import * as childStore from '../store/child.js';
import {
  CARE_ACTIONS,
  CARE_ORDER,
  EXPRESSION_LABELS,
  GAUGES,
  GAUGE_LABELS,
  canCare,
  cooldownRemainingMs,
  expression,
  formatRemaining,
  nextStageRequirement,
  stageLabel,
  tick as tickLogic,
} from '../game/pet.js';
import { NIGHT_CARE_TEXT, isNightRest } from '../game/night.js';
import { setNightLocked } from './night.js';
import { BASIC_FOOD, SPECIAL_FOODS, SPECIAL_FOODS as _specialFoods, findFood, findSpecies } from '../../data/pets.js';
import { buildGrid, drawPet, speciesIntro } from './pet-sprite.js';
import { accessoryOf, drawHat, drawHatThumb } from './pet-accessory.js';
import { historyWithBalances } from '../game/coins.js';
import { HAT_ITEMS } from '../../data/shop.js';
import { PREFECTURES } from '../../data/prefectures.js';
import { CHILD_VERSION_LABEL } from '../version.js';
import { clear, downloadFile, el, formatDateTimeJP, formatNumber, guarded, mount, openSheet, readFileAsText, toast } from './dom.js';
import { playSe, setBgm, setSe, unlockAudio } from './sound.js';
import { openScanSheet } from './scan-sheet.js';

const rng = () => Math.random();

let dashboard = null;
let liveTimer = null;
let blinkTimer = null;
let currentView = null;
const blinkState = new WeakMap();

/* ------------------------------------------------------------ 補助 */

function speciesOf(pet) {
  return findSpecies(pet?.speciesId) ?? findSpecies('mochi');
}

function ageLabel(pet, now) {
  const hours = Math.floor((now - pet.hatchedAt) / 3600000);
  if (hours < 1) return 'うまれて まだ すぐ';
  if (hours < 24) return `うまれて ${hours}じかん`;
  return `うまれて ${Math.floor(hours / 24)}にち`;
}

function coinLabel(coins) {
  return `🪙 ${formatNumber(coins?.balance ?? 0)}`;
}

/* ------------------------------------------------------------ 本体 */

/** いま表示中のペット欄を作り直す（受け取り後に孵化ボタンや成長表示を最新化する） */
export async function refreshPetSection() {
  const section = document.getElementById('petSection');
  if (!section) return false;
  await refresh(section);
  return true;
}

export async function createPetSection() {
  const section = el('section', { class: 'pets', id: 'petSection' });
  await refresh(section);
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => guarded(() => liveUpdate(section))(), 1000);
  return section;
}

async function refresh(section) {
  dashboard = await childStore.getPetDashboard(Date.now());
  render(section);
}

async function refreshAndRender(section) {
  await refresh(section);
}

/**
 * ペットの保存状態（ねる・おきる・孵化・名前）が変わったことを部屋へ知らせる（v33）。
 * 部屋へ反映する経路はこのイベント1本だけ（`js/ui/child.js` が受けて `syncSleep`）。
 * detail には保存済みの最新配列を載せる（部屋側でDBを読み直さない）。
 */
async function notifyPetsChanged() {
  const pets = await childStore.listPets();
  document.dispatchEvent(new CustomEvent('tamago:pets-changed', { detail: { pets } }));
  return pets;
}

function render(section) {
  const { pets, selected, coins, tokens } = dashboard;
  clear(section);

  mount(section, ...[
    el('div', { class: 'pets__head' }, [
      el('h2', { class: 'pets__title', text: 'ペット' }),
      el('div', { class: 'pets__tools' }, [
        el('button', {
          class: 'coin-chip',
          type: 'button',
          id: 'coinChip',
          text: coinLabel(coins),
          onclick: guarded(() => openCoinSheet()),
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          id: 'petSettingsButton',
          'aria-label': 'せってい',
          text: '⚙',
          onclick: guarded(() => openSettingsSheet(section)),
        }),
      ]),
    ]),
  ]);

  // ペット一覧（孵化順）
  if (pets.length) {
    const list = el('div', { class: 'pet-cards', id: 'petCards', role: 'tablist' });
    for (const pet of pets) {
      const species = speciesOf(pet);
      const canvas = el('canvas', { class: 'pet-card__canvas' });
      drawPet(canvas, species, { expression: expression(pet), size: 44, stage: pet.stage });
      list.append(
        el('button', {
          class: `pet-card ${selected?.id === pet.id ? 'pet-card--on' : ''}`,
          type: 'button',
          dataset: { petId: pet.id },
          'aria-label': `${pet.name}（${stageLabel(pet.stage)}）`,
          onclick: guarded(async () => {
            playSe('tap');
            await childStore.setSelectedPet(pet.id);
            await refreshAndRender(section);
          }),
        }, [
          canvas,
          el('span', { class: 'pet-card__name', text: pet.name }),
          el('span', { class: 'pet-card__stage', text: stageLabel(pet.stage) }),
        ])
      );
    }
    section.append(list);
  }

  // 選択中ペットの詳細
  if (selected) {
    section.append(renderDetail(section, selected));
  } else {
    section.append(renderEmptyEgg());
  }

  // 孵化
  section.append(renderHatchArea(section, tokens, pets.length));
}

function renderEmptyEgg() {
  const canvas = el('canvas', { class: 'pet-egg-canvas' });
  drawEgg(canvas, 120);
  return el('div', { class: 'pet-empty' }, [
    canvas,
    el('p', { class: 'pet-empty__title', text: 'まだ ペットが いないよ' }),
    el('p', { class: 'muted small', text: '「ふかの けんり」が 1こ あると、たまごを かえせるよ。' }),
  ]);
}

let detailRefresh = null;

function renderDetail(section, pet) {
  const species = speciesOf(pet);
  const now = dashboard.now;
  const expressionId = expression(pet);
  const next = nextStageRequirement(pet, now);

  const canvas = el('canvas', { class: 'pet-canvas', id: 'petCanvas' });
  drawPet(canvas, species, { expression: expressionId, size: 132, stage: pet.stage });
  startBlink(canvas, species, pet, expressionId);
  // 帽子は別レイヤー（ペットのグリッドには触らない）
  const hatCanvas = el('canvas', { class: 'pet-hat-canvas', id: 'petHatCanvas', 'aria-hidden': 'true' });
  const wornHat = accessoryOf(dashboard?.room, pet.id);
  if (wornHat) drawHat(hatCanvas, wornHat, { size: 132, stage: pet.stage });
  currentView = { canvas, species, pet, expressionId };

  const gauges = el('ul', { class: 'gauges', id: 'petGauges' });
  for (const gauge of GAUGES) {
    const value = pet.gaugesShown[gauge];
    gauges.append(
      el('li', { class: `gauge-row gauge-row--${gauge}`, dataset: { gauge } }, [
        el('span', { class: 'gauge-row__label', text: GAUGE_LABELS[gauge] }),
        el('div', {
          class: 'gauge',
          role: 'progressbar',
          'aria-label': GAUGE_LABELS[gauge],
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(value),
        }, [el('i', { class: 'gauge__fill', style: { width: `${value}%` } })]),
        el('b', { class: 'gauge-row__value', text: String(value) }),
      ])
    );
  }

  const actions = el('div', { class: 'care-actions', id: 'careActions' });
  // 夜間ロック（v25）: 22:00〜06:59 は おせわを押せない（薄い見た目＋押すと文言）。
  // ネイティブの disabled はクリックを捨てるので使わず、aria-disabled で表す。
  const nightLocked = isNightRest(Date.now());
  for (const actionId of CARE_ORDER) {
    const action = CARE_ACTIONS[actionId];
    const remaining = actionId === 'sleep' ? 0 : cooldownRemainingMs(pet, actionId, now);
    const blocked = actionId !== 'sleep' && pet.sleeping;
    const label = actionId === 'sleep' ? (pet.sleeping ? 'おこす' : 'ねかせる') : action.label;
    actions.append(
      el('button', {
        class: `care-btn care-btn--${actionId}${nightLocked ? ' is-night-locked' : ''}`,
        type: 'button',
        dataset: { care: actionId, nightLocked: nightLocked ? 'true' : 'false' },
        disabled: !nightLocked && (remaining > 0 || blocked),
        'aria-disabled': nightLocked || (remaining > 0 || blocked) ? 'true' : 'false',
        onclick: guarded(async () => {
          unlockAudio();
          if (isNightRest(Date.now())) {
            toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
            return;
          }
          if (actionId === 'food') return openFoodSheet(section, pet);
          const result = await childStore.carePet(pet.id, actionId, { now: Date.now() });
          if (!result.ok) {
            playSe('error');
            playReaction('fail', currentView ?? {});
            toast(result.message, { tone: 'error' });
            return;
          }
          playSe(actionId === 'sleep' ? 'tap' : 'care');
          if (result.growth) playSe('coin');
          // ねかせる／おこす（v33）: カードの操作をその場で部屋へ伝える
          if (actionId === 'sleep') await notifyPetsChanged();
          const kind = reactionFor(actionId, { sleeping: result.pet?.sleeping !== true && actionId === 'sleep' });
          await afterCare(section, result, { reaction: kind });
        }),
      }, [
        el('span', { class: 'care-btn__label', text: label }),
        remaining > 0 ? el('span', { class: 'care-btn__cd', text: `あと ${formatRemaining(remaining)}` }) : null,
      ])
    );
  }

  const card = el('div', { class: 'pet-detail', id: 'petDetail', dataset: { petId: pet.id } }, [
    el('div', { class: 'pet-stage' }, [
      el('div', { class: 'pet-sprite-wrap' }, [canvas, hatCanvas]),
      el('span', { class: `pet-mood-bubble pet-mood-bubble--${expressionId}`, text: EXPRESSION_LABELS[expressionId] }),
    ]),
    el('div', { class: 'pet-meta' }, [
      el('p', { class: 'pet-name-row' }, [
        // 名前は名前だけ（種の略号・種IDを混ぜない）
        el('span', { class: 'pet-name', id: 'petName', text: pet.name }),
        // 種は名前の横に**正式な表示名**で置く（ローマ字の略号は使わない）
        el('span', { class: 'pet-species-chip', id: 'petSpecies', text: species.name }),
        el('span', { class: 'pet-stage-chip', id: 'petStage', text: stageLabel(pet.stage) }),
      ]),
      el('p', { class: 'pet-sub' }, [
        el('span', { text: personalityLabel(pet) }),
        el('span', { class: 'pet-sub__dot', text: '・' }),
        el('span', { text: ageLabel(pet, now) }),
      ]),
      el('p', { class: 'pet-sub muted small', id: 'petCareCount', text: `そだち ${pet.careCount}かい ・ すきな たべもの: ${foodName(pet.traits?.favoriteFood)}` }),
      el('p', { class: 'pet-intro', id: 'petIntro', text: speciesIntro(species) }),
    ]),
    gauges,
    actions,
    renderHatRow(section, pet),
    el('div', { class: 'pet-links' }, [
      el('p', { class: 'pet-next', id: 'petNext', text: next ? `つぎの そだち（${next.label}）まで あと ${Math.ceil(next.needHours)}じかん・${next.needCare}かい` : 'いちばん おおきく なったよ！' }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        id: 'renamePetButton',
        text: 'なまえを かえる',
        onclick: guarded(() => openRenameSheet(section, pet)),
      }),
    ]),
  ]);

  return card;
}

function personalityLabel(pet) {
  const species = speciesOf(pet);
  const labels = { laidback: 'のんびり', bright: 'げんき', cool: 'クール', clingy: 'あまえんぼ' };
  return labels[pet.traits?.personality ?? species.personality] ?? 'ふつう';
}

function foodName(foodId) {
  return findFood(foodId)?.name ?? 'ふつうのエサ';
}

/** ペットIDの名前（装着中の子を「◯◯が つけているよ」と出すため） */
function petNameOf(petId) {
  const row = dashboard?.pets?.find((entry) => entry.id === petId);
  return row?.name ?? 'ほかの こ';
}

/**
 * 帽子を着ける・外す（**1アイテムは1匹だけ**）。
 * 付け替えたら、詳細カードのペットが既存のリアクション演出一回だけ行う
 * （reduced-motion のときは動かない＝CSS とデータ属性で静止）。
 */
async function applyHatChange(section, pet, itemId) {
  // 夜間ロック（v25）: ぼうしの着脱は 22:00〜06:59 不可（store 側でも弾く）
  if (isNightRest(Date.now())) {
    toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
    return;
  }
  const result = await childStore.setPetAccessory(pet.id, itemId, { now: Date.now() });
  if (result && result.ok === false && result.reason === 'night') {
    toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
    return;
  }
  playSe('tap');
  document.dispatchEvent(new CustomEvent('tamago:room-changed'));
  if (detailRefresh) await detailRefresh();
  else await refreshAndRender(section);
  // 描き直したあとの canvas でリアクションを1回（連打しても上書きされる）
  if (currentView) playReaction('pet', currentView);
}

/**
 * ぼうし・アクセサリーの行（ペット1匹につき1点だけ装着）。
 * 買った中から選ぶ／「つけない」で外す。装着は即保存する。
 * 他のペットが着けている帽子を選んだときは「◯◯が つけているよ。つけかえる？」で確認する。
 */
function renderHatRow(section, pet) {
  const room = dashboard?.room;
  const worn = accessoryOf(room, pet.id);
  const owned = HAT_ITEMS.filter((item) => room?.inventory?.includes(item.id));
  // 夜間ロック（v25）: ぼうしの着脱は部屋の変更＝22:00〜06:59 は不可（見た目は おせわ・もようがえ と同じ）
  const nightLocked = isNightRest(Date.now());
  const chipClass = (on) => `pet-hat__chip${on ? ' pet-hat__chip--on' : ''}${nightLocked ? ' is-night-locked' : ''}`;
  const chipLock = { 'aria-disabled': nightLocked ? 'true' : 'false', dataset: { nightLocked: nightLocked ? 'true' : 'false' } };
  const whenNight = () => {
    if (!isNightRest(Date.now())) return false;
    toast(NIGHT_CARE_TEXT, { tone: 'info', duration: 2600 });
    return true;
  };

  const chips = el('div', { class: 'pet-hat__chips' });
  chips.append(el('button', {
    class: chipClass(!worn),
    type: 'button',
    id: 'hatNone',
    dataset: { hat: '', nightLocked: nightLocked ? 'true' : 'false' },
    'aria-pressed': String(!worn),
    'aria-disabled': nightLocked ? 'true' : 'false',
    text: 'つけない',
    onclick: guarded(async () => {
      if (whenNight()) return;
      if (!worn) return;
      await applyHatChange(section, pet, null);
    }),
  }));

  for (const item of owned) {
    const active = worn?.id === item.id;
    const art = el('canvas', { class: 'pet-hat__art', 'aria-hidden': 'true' });
    drawHatThumb(art, item, { size: 26 });
    chips.append(el('button', {
      class: chipClass(active),
      type: 'button',
      dataset: { hat: item.id, nightLocked: nightLocked ? 'true' : 'false' },
      'aria-pressed': String(active),
      'aria-disabled': nightLocked ? 'true' : 'false',
      onclick: guarded(async () => {
        if (whenNight()) return;
        if (active) {
          await applyHatChange(section, pet, null);
          return;
        }
        // 1アイテムは1匹だけ: 他の子が着けていたら確認してから付け替える
        const otherId = Object.keys(room?.accessories ?? {}).find(
          (petId) => room.accessories[petId] === item.id && petId !== pet.id
        );
        if (otherId) {
          openHatSwapSheet(section, pet, item, petNameOf(otherId));
          return;
        }
        await applyHatChange(section, pet, item.id);
      }),
    }, [art, el('span', { text: item.name })]));
  }

  return el('div', { class: 'pet-hat', id: 'petHat' }, [
    el('div', { class: 'pet-hat__head' }, [
      el('span', { class: 'field__label', text: 'ぼうし・アクセサリー' }),
      el('span', { class: 'pet-hat__now', text: worn ? `${worn.name}を つけているよ` : 'つけていないよ' }),
    ]),
    chips,
    owned.length ? null : el('p', { class: 'muted small', text: 'ショップで かった ぼうしを つけられるよ。' }),
  ]);
}

/** 「◯◯が つけているよ。つけかえる？」（はい＝前の子から外して付け替え／いいえ＝何もしない） */
function openHatSwapSheet(section, pet, item, wearerName) {
  return openSheet({
    title: 'ぼうしの つけかえ',
    description: `${wearerName}が つけているよ。つけかえる？`,
    content: el('p', { class: 'muted small', id: 'hatSwapNote', text: `${item.name}は 1ぴきだけ つけられるよ。` }),
    actions: [
      { label: 'いいえ', onClick: (close) => close() },
      {
        label: 'はい',
        variant: 'primary',
        onClick: guarded(async (close) => {
          close();
          await applyHatChange(section, pet, item.id);
        }),
      },
    ],
  });
}

function renderHatchArea(section, tokens, petCount) {
  const count = tokens?.tokens ?? 0;
  const canHatch = count > 0;
  return el('div', { class: 'hatch-area', id: 'hatchArea' }, [
    el('div', { class: 'hatch-area__count' }, [
      el('span', { class: 'hatch-area__label', text: 'ふかの けんり' }),
      el('span', { class: 'hatch-area__value', id: 'hatchTokens', text: `× ${count}` }),
    ]),
    // 孵化は「うえの たまごを タップ」に一本化（ボタンは置かない）
    canHatch
      ? el('p', { class: 'muted small', text: 'うえの たまごを タップすると かえせます（' + (petCount ? 'もう いっぴき ' : '') + 'あと ' + count + 'こ）。' })
      : el('p', { class: 'muted small', text: 'ふかの けんりは、てんすうが 1,000てん たまるごとに 1こ もらえるよ。' }),
  ]);
}

/** 部屋からペットをタップしたときに、育成（おせわ）をシートで開く */
export async function openPetSheet(petId) {
  const data = await childStore.getPetDashboard(Date.now());
  const pet = data.pets.find((row) => row.id === petId) ?? data.pets[0];
  if (!pet) return null;
  dashboard = data;
  await childStore.setSelectedPet(pet.id);

  const wrapper = el('div', { class: 'sheet-pet' });
  const section = el('section', { class: 'pets pets--sheet', id: 'petSheet' });
  wrapper.append(section);

  const draw = (target) => {
    const found = dashboard.pets.find((row) => row.id === pet.id) ?? dashboard.pets[0];
    if (!found) return;
    clear(section);
    // シート内は id を外す（親画面の #petCanvas などと衝突させない）
    section.append(renderDetail(section, found));
    section.querySelectorAll('[id]').forEach((el2) => el2.removeAttribute('id'));
  };

  detailRefresh = async () => {
    dashboard = await childStore.getPetDashboard(Date.now());
    draw();
  };

  const sheet = openSheet({ title: `${pet.name}`, content: wrapper, size: 'normal' });
  draw();
  const originalClose = sheet.close;
  sheet.close = () => {
    detailRefresh = null;
    originalClose();
    const main = document.getElementById('petSection');
    if (main) refreshAndRender(main);
  };
  return sheet;
}

/* ------------------------------------------------------------ 孵化 */

function drawEgg(canvas, size) {
  const grid = Array.from({ length: 24 }, () => Array(24).fill('.'));
  for (let y = 5; y <= 21; y += 1) {
    const t = (y - 5) / 16;
    const half = 3 + 7.5 * Math.sin(Math.PI * (0.12 + 0.86 * t));
    for (let x = Math.round(11.5 - half); x <= Math.round(11.5 + half); x += 1) grid[y][x] = 'b';
  }
  for (let y = 5; y <= 21; y += 1) {
    for (let x = 0; x < 24; x += 1) if (grid[y][x] === 'b' && (x > 16 || y > 19)) grid[y][x] = 'd';
  }
  for (const [x, y] of [[9, 8], [15, 11], [11, 15], [8, 17]]) grid[y][x] = 'a';
  const species = { id: 'egg', palette: { body: '#fff4e6', accent: '#ffd7a8', dark: '#e0b982' } };
  drawPet(canvas, species, { expression: 'normal', size, grid: grid.map((row) => row.join('')) });
  canvas.dataset.egg = 'true';
}

export async function openHatchFlow({ onHatched = null } = {}) {
  unlockAudio();
  playSe('tap');
  const tokens = await childStore.getHatchTokens();
  if (tokens.tokens <= 0) {
    toast('ふかの けんりが ないよ', { tone: 'error' });
    return false;
  }

  const species = (await import('../../data/pets.js')).SPECIES[Math.floor(rng() * 20)];
  const content = el('div', { class: 'hatch-flow' }, [
    el('div', { class: 'hatch-egg-wrap' }, [el('canvas', { class: 'hatch-egg', id: 'hatchEgg' })]),
    el('p', { class: 'hatch-flow__text', id: 'hatchText', text: 'たまごが ゆれている…' }),
  ]);
  const sheet = openSheet({ title: 'たまごを ふかす', content, size: 'normal' });
  drawEgg(content.querySelector('#hatchEgg'), 150);
  playSe('hatch');

  await new Promise((resolve) => setTimeout(resolve, 1200));

  // 抽選結果を表示してから命名
  const canvas = el('canvas', { class: 'hatch-pet', id: 'hatchPet' });
  drawPet(canvas, species, { expression: 'happy', size: 150, stage: 'baby' });
  const nameInput = el('input', { class: 'input', type: 'text', maxlength: '10', id: 'hatchName', placeholder: '10もじまで', 'aria-label': 'ペットのなまえ' });
  const decided = el('button', { class: 'btn btn--primary btn--large', type: 'button', id: 'hatchDecide', text: 'この こに きめる' });

  clear(content);
  content.append(
    el('div', { class: 'hatch-reveal' }, [canvas]),
    el('p', { class: 'hatch-flow__text', id: 'hatchSpecies', text: `${species.name}が うまれたよ！` }),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'なまえ' }), nameInput]),
    decided
  );
  nameInput.focus();
  playSe('stage');

  const decide = guarded(async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('なまえを いれてね', { tone: 'error' });
      nameInput.focus();
      return;
    }
    const result = await childStore.hatchPet({ name, now: Date.now(), speciesId: species.id });
    if (!result.ok) {
      toast(result.reason === 'no-tokens' ? 'ふかの けんりが ないよ' : 'ふか できませんでした', { tone: 'error' });
      return;
    }
    sheet.close();
    playSe('coin');
    toast(`${name}が なかまに なったよ！（コイン +30）`, { tone: 'success', duration: 3200 });
    // 孵化（v33）: 匹数が増えたことを部屋へ知らせる（部屋の作り直しは onHatched が行う）
    await notifyPetsChanged();
    const section = document.getElementById('petSection');
    if (section) await refreshAndRender(section);
    if (onHatched) await onHatched();
  });

  decided.addEventListener('click', decide);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') decide();
  });
  return true;
}

/* ------------------------------------------------------------ お世話 */

async function afterCare(section, result, { reaction: kind = null } = {}) {
  if (detailRefresh) await detailRefresh();
  else await refreshAndRender(section);
  if (kind && currentView) playReaction(kind, currentView);
  if (result.growth) toast(`そだち +1（コイン +1）`, { tone: 'success', duration: 2000 });
  if (result.stageUp) {
    playSe('stage');
    showStageFx(stageLabel(result.stageUp));
  }
}

export function showStageFx(label) {
  const layer = document.querySelector('.fx-layer') ?? (() => {
    const node = el('div', { class: 'fx-layer' });
    document.body.append(node);
    return node;
  })();
  const card = el('div', { class: 'fx-stage', id: 'stageFx' }, [
    el('span', { class: 'fx-stage__label', text: 'そだった！' }),
    el('span', { class: 'fx-stage__value', text: label }),
    el('span', { class: 'fx-stage__note', text: 'コイン +50' }),
  ]);
  layer.append(card);
  setTimeout(() => {
    card.classList.add('fx-stage--out');
    setTimeout(() => card.remove(), 400);
  }, 2000);
}

function openFoodSheet(section, pet) {
  const { coins } = dashboard;
  const content = el('div', { class: 'food-list' });

  const offer = (food) => {
    const affordable = food.price <= (coins?.balance ?? 0);
    return el('button', {
      class: `food-item ${affordable ? '' : 'food-item--locked'}`,
      type: 'button',
      dataset: { food: food.id },
      onclick: guarded(async () => {
        if (!affordable) {
          playSe('error');
          playReaction('fail', currentView ?? {});
          toast(`コインが たりないよ（あと ${food.price - coins.balance}まい）`, { tone: 'error' });
          return;
        }
        const result = await childStore.carePet(pet.id, 'food', { now: Date.now(), foodId: food.id });
        if (!result.ok) {
          playSe('error');
          playReaction('fail', currentView ?? {});
          toast(result.message, { tone: 'error' });
          return;
        }
        sheet.close();
        playSe('coin');
        await afterCare(section, result, { reaction: reactionFor('food', { foodId: food.id }) });
      }),
    }, [
      el('span', { class: 'food-item__name', text: food.name }),
      el('span', { class: 'food-item__note', text: food.note }),
      el('span', { class: 'food-item__price', text: food.price === 0 ? 'むりょう' : `🪙 ${food.price}` }),
    ]);
  };

  content.append(offer(BASIC_FOOD));
  for (const food of SPECIAL_FOODS) content.append(offer(food));

  const sheet = openSheet({
    title: 'ごはん',
    description: `コイン ${formatNumber(coins?.balance ?? 0)}まい（おせわの コインは 1にち ${coins?.careRemaining ?? 0}かい のこり）`,
    content,
  });
  return sheet;
}

function openRenameSheet(section, pet) {
  const input = el('input', { class: 'input', type: 'text', maxlength: '10', value: pet.name, id: 'renameInput', 'aria-label': 'あたらしいなまえ' });
  const sheet = openSheet({
    title: 'なまえを かえる',
    content: el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'なまえ（10もじまで）' }), input]),
    actions: [
      { label: 'やめる', onClick: (close) => close() },
      {
        label: 'かえる',
        variant: 'primary',
        onClick: guarded(async (close) => {
          await childStore.renamePet(pet.id, input.value);
          // 名前変更（v33）: 部屋の名前チップも同じ経路で直す
          await notifyPetsChanged();
          close();
          playSe('tap');
          await refreshAndRender(section);
        }),
      },
    ],
  });
  setTimeout(() => input.focus(), 80);
  return sheet;
}

function openCoinSheet() {
  const { coins } = dashboard;
  const history = historyWithBalances(coins, 20);
  const list = el('ul', { class: 'coin-history' },
    history.length
      ? history.map((entry) => el('li', { class: 'coin-history__item' }, [
          el('span', { class: `coin-history__delta ${entry.delta > 0 ? 'is-plus' : 'is-minus'}`, text: `${entry.delta > 0 ? '+' : ''}${entry.delta}` }),
          el('span', { class: 'coin-history__label', text: entry.label || entry.reason }),
          el('span', { class: 'coin-history__at', text: new Date(entry.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) }),
        ]))
      : [el('li', { class: 'muted small', text: 'まだ ないよ' })]
  );
  openSheet({
    title: 'コイン',
    description: `いま ${formatNumber(coins?.balance ?? 0)}まい。ふか +30 / そだち +50 / おせわ +1（1にち ${coins?.careRemaining ?? 0}かい のこり）`,
    content: list,
  });
}

/* ------------------------------------------------------------ 設定・バックアップ */

/**
 * 天気の地域（都道府県）を1回だけ選ぶ。選ぶとその場で取りに行く。
 * 位置情報（Geolocation）は使わない＝許可ダイアログを出さない。
 */
function buildPrefectureRow() {
  const select = el('select', { class: 'input', id: 'prefectureSelect', 'aria-label': 'おてんきの ばしょ' }, [
    el('option', { value: '', text: 'まだ えらんでいない（くもり として あつかう）' }),
    ...PREFECTURES.map((prefecture) => el('option', { value: prefecture.id, text: prefecture.name })),
  ]);
  select.addEventListener('change', guarded(async () => {
    await childStore.setPrefecture(select.value);
    const result = await childStore.refreshWeather({ now: Date.now() });
    document.dispatchEvent(new CustomEvent('tamago:room-changed'));
    if (!select.value) {
      toast('おてんきの ばしょを えらぶと そとの てんきに なるよ', { tone: 'info', duration: 2600 });
      return;
    }
    toast(result.ok ? 'おてんきを とりました' : 'いまは とれなかったよ（さいごの てんきを つかうよ）', {
      tone: result.ok ? 'success' : 'info',
      duration: 2600,
    });
  }));
  // いまの設定を反映（開いたとき）
  void childStore.getRoom().then((room) => {
    select.value = room.prefecture ?? '';
  });
  return el('div', { class: 'stack' }, [
    select,
    el('p', { class: 'muted small', text: 'えらんだ ばしょの てんきを 30ぷんごとに とりにいくよ（Open-Meteo）。とれない ときは さいごの てんきを つかうよ。' }),
  ]);
}

/**
 * コインの履歴（直近20件）。日時・内容・増減・残高を出す。
 * 購入は「こうにゅう: アイテム名」で残る（増減の両方を残す）。
 */
function coinLogNode(coins) {
  const rows = historyWithBalances(coins, 20);
  if (!rows.length) return el('p', { class: 'muted small', text: 'まだ コインの きろくが ないよ' });
  const list = el('ul', { class: 'coin-log', id: 'coinLog' });
  for (const row of rows) {
    list.append(el('li', { class: 'coin-log__item' }, [
      el('span', { class: 'coin-log__at', text: formatDateTimeJP(row.at) }),
      el('span', { class: 'coin-log__label', text: row.label || row.reason || '' }),
      el('span', { class: `coin-log__delta ${row.delta > 0 ? 'is-plus' : 'is-minus'}`, text: `${row.delta > 0 ? '+' : ''}${formatNumber(row.delta)}` }),
      el('span', { class: 'coin-log__balance', text: `のこり ${formatNumber(row.balance)}` }),
    ]));
  }
  return list;
}

/**
 * 部屋の天気の注記（地域が未設定のとき）から「せってい」を開く。
 * 部屋側は `tamago:open-settings` を出すだけで、開くのはこの画面の担当。
 * すでに何かのシートが開いているときは重ねない。
 */
document.addEventListener('tamago:open-settings', guarded(() => {
  if (document.body.classList.contains('has-sheet')) return;
  const section = document.getElementById('petSection');
  if (!section) return;
  void openSettingsSheet(section);
}));

async function openSettingsSheet(section) {
  const settings = await childStore.getSettings();
  const bgmButton = el('button', { class: 'btn btn--ghost', type: 'button', id: 'bgmToggle', 'aria-pressed': String(settings.bgm), text: '' });
  const seButton = el('button', { class: 'btn btn--ghost', type: 'button', id: 'seToggle', 'aria-pressed': String(settings.se), text: '' });
  const paintToggles = () => {
    bgmButton.textContent = `BGM: ${settings.bgm ? 'オン' : 'オフ'}`;
    seButton.textContent = `こうかおん: ${settings.se ? 'オン' : 'オフ'}`;
    bgmButton.dataset.on = String(settings.bgm);
    seButton.dataset.on = String(settings.se);
    bgmButton.setAttribute('aria-pressed', String(settings.bgm));
    seButton.setAttribute('aria-pressed', String(settings.se));
  };
  paintToggles();

  bgmButton.addEventListener('click', guarded(async () => {
    settings.bgm = !settings.bgm;
    await childStore.setSettings({ bgm: settings.bgm });
    setBgm(settings.bgm);
    if (settings.bgm) unlockAudio();
    paintToggles();
  }));
  seButton.addEventListener('click', guarded(async () => {
    settings.se = !settings.se;
    await childStore.setSettings({ se: settings.se });
    setSe(settings.se);
    if (settings.se) playSe('tap');
    paintToggles();
  }));

  const fileInput = el('input', { class: 'visually-hidden', type: 'file', accept: 'application/json,.json', id: 'childRestoreFile' });
  const paste = el('textarea', { class: 'input input--area', rows: 3, id: 'childRestoreText', placeholder: 'バックアップJSONを貼り付け' });

  const settingsSheet = openSheet({
    title: 'せってい',
    content: el('div', { class: 'stack' }, [
      el('p', { class: 'field__label', text: 'おと' }),
      el('div', { class: 'button-row' }, [bgmButton, seButton]),
      el('p', { class: 'muted small', text: 'おとは 端末のなかで つくっています（インターネットは つかいません）。' }),
      el('hr', { class: 'divider' }),
      el('p', { class: 'field__label', text: 'データ' }),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          id: 'childBackupButton',
          text: '⬇ バックアップを保存',
          onclick: guarded(async () => {
            const backup = await childStore.exportChildBackup(Date.now());
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            downloadFile(`tamago-friends-child-${stamp}.json`, JSON.stringify(backup, null, 2));
            toast('バックアップを保存しました', { tone: 'success' });
          }),
        }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          id: 'childRestorePick',
          text: '📂 復元する',
          onclick: () => fileInput.click(),
        }),
      ]),
      fileInput,
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'または JSON を貼り付け' }), paste]),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        id: 'childRestoreButton',
        text: '貼り付けた内容で復元',
        onclick: guarded(async () => {
          if (!paste.value.trim()) {
            toast('JSONを はりつけてね', { tone: 'info' });
            return;
          }
          await runChildRestore(section, paste.value, settingsSheet);
        }),
      }),
      el('p', { class: 'muted small', id: 'childRestoreNote', text: '復元には おうちのひと（親）の かぞくQRが ひつようです。ペット・コイン・設定・ゲージが もどり、復元のまえの データは じどうで たいひ されます。' }),
      el('hr', { class: 'divider' }),
      el('p', { class: 'field__label', text: 'おてんきの ばしょ' }),
      buildPrefectureRow(),
      el('hr', { class: 'divider' }),
      el('p', { class: 'field__label', text: 'コインの きろく' }),
      coinLogNode(await childStore.getCoins()),
      el('hr', { class: 'divider' }),
      el('p', { class: 'field__label', text: '端末の初期化' }),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        id: 'resetScanButton',
        text: '📷 初期化QRを読み取る',
        onclick: guarded(() => {
          settingsSheet.close();
          startResetFlow();
        }),
      }),
      el('p', { class: 'muted small', text: 'おうちのひとが PIN を かいじょして 発行した 初期化QRが ひつようです。' }),
      el('hr', { class: 'divider' }),
      // v41: あそびかたガイド（別タブ）。版表示の上・シート最下部
      el('a', {
        class: 'guide-link',
        id: 'childGuideLink',
        href: './guide.html',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'あそびかたガイド',
      }),
      // 版（v24）。押せない補助テキスト。シートのスクロール内の最下部に置く
      el('p', { class: 'muted small app-version', id: 'childVersionNote', text: CHILD_VERSION_LABEL }),
    ]),
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      paste.value = text;
      await runChildRestore(section, text, settingsSheet);
    } catch (error) {
      toast(error?.message ?? 'よみこめませんでした', { tone: 'error' });
    } finally {
      fileInput.value = '';
    }
  });
}

/**
 * 子端末の復元。**親の承認（かぞくQRの再読み取り）が必須**。
 * 1) バックアップの形式を確認 → 2) かぞくQRを読む → 3) 家族・子どもが一致したら復元
 */
async function runChildRestore(section, text, settingsSheet = null) {
  // 先に形式だけ確認（読み取りの手間を省く）
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('JSONとして よみとれませんでした', { tone: 'error' });
    return;
  }
  if (parsed?.app !== 'tamago-friends' || (parsed.role && parsed.role !== 'child')) {
    toast('子端末の バックアップではありません', { tone: 'error' });
    return;
  }

  settingsSheet?.close?.();
  openScanSheet({
    title: '親の しょうにん（かぞくQR）',
    description: 'おうちのひとに PIN を かいじょして かぞくQRを 出してもらってください。',
    onText: async (qrText) => {
      const approval = await childStore.approveRestoreWithFamilyQr(qrText);
      const result = await childStore.restoreChildBackup(text, Date.now(), approval);
      toast(`もどしました（${result.restored}件）`, { tone: 'success' });
      await refreshAndRender(section);
    },
  });
}

/* ------------------------------------------------------------ お世話のリアクション */

/** お世話ごとの反応（表情・動き・粒）。外部アセットなし */
const REACTIONS = {
  food: { expression: 'happy', className: 'pet-react--food', particles: ['crumb', 'crumb', 'crumb', 'sparkle', 'sparkle'], label: 'ぱくぱく' },
  foodDeluxe: { expression: 'happy', className: 'pet-react--food', particles: ['crumb', 'crumb', 'sparkle', 'sparkle', 'sparkle', 'sparkle'], label: 'ごちそう' },
  play: { expression: 'happy', className: 'pet-react--play', particles: ['sparkle', 'heart', 'heart', 'sparkle'], label: 'ぴょんぴょん' },
  pet: { expression: 'happy', className: 'pet-react--pet', particles: ['heart'], label: 'にっこり' },
  bath: { expression: 'happy', className: 'pet-react--bath', particles: ['bubble', 'bubble', 'bubble', 'bubble', 'bubble'], label: 'ぶるぶる' },
  sleep: { expression: 'sleep', className: 'pet-react--sleep', particles: ['zzz'], label: 'すやすや' },
  wake: { expression: 'good', className: 'pet-react--wake', particles: [], label: 'ぱっちり' },
  fail: { expression: 'tired', className: 'pet-react--fail', particles: [], label: 'いやいや' },
};

const BASE_REACTION_MS = 1000;
let reaction = { timer: null, wrap: null, canvas: null, species: null, pet: null, baseExpression: null };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

function clearReaction() {
  if (reaction.timer) clearTimeout(reaction.timer);
  reaction.timer = null;
  const { wrap, canvas, species, pet, baseExpression } = reaction;
  if (wrap) {
    wrap.classList.remove(...Object.values(REACTIONS).map((entry) => entry.className));
    wrap.dataset.reaction = '';
    wrap.querySelectorAll('.pet-particle').forEach((node) => node.remove());
  }
  if (canvas && species && pet) drawPet(canvas, species, { expression: baseExpression ?? expression(pet), size: 132, stage: pet.stage });
  reaction = { timer: null, wrap: null, canvas: null, species: null, pet: null, baseExpression: null };
}

/**
 * 反応を1つだけ再生する（連打しても上書きされ、多重再生しない）。
 * @param {string} kind REACTIONS のキー
 */
export function playReaction(kind, { wrap = null, canvas = null, species = null, pet = null } = {}) {
  const preset = REACTIONS[kind];
  if (!preset || !pet) return null;

  // canvas が分かっていれば、その親（シート内のカードなど）を優先する。
  // document.querySelector だと、シートの後ろにある本体側のカードを掴んでしまう。
  const wrapNode = wrap ?? canvas?.closest?.('.pet-sprite-wrap') ?? document.querySelector('.pet-sprite-wrap');
  const canvasNode = canvas ?? wrapNode?.querySelector('.pet-canvas');
  if (!wrapNode || !canvasNode) return null;

  const baseExpression = reaction.baseExpression ?? expression(pet);
  clearReaction();

  const tempo = Math.min(1.6, Math.max(0.6, Number(pet.traits?.tempo) || 1));
  const duration = Math.round(Math.min(1600, Math.max(700, BASE_REACTION_MS * tempo)));

  wrapNode.dataset.reaction = kind;
  wrapNode.dataset.reduced = String(reducedMotion());
  wrapNode.classList.add(preset.className);
  drawPet(canvasNode, species ?? speciesOf(pet), { expression: preset.expression, size: 132, stage: pet.stage });

  if (!reducedMotion()) {
    preset.particles.forEach((type, index) => {
      const node = el('span', { class: `pet-particle pet-particle--${type}` });
      const angle = (index / Math.max(1, preset.particles.length)) * Math.PI * 2;
      node.style.setProperty('--dx', `${Math.round(Math.cos(angle) * 26)}px`);
      node.style.setProperty('--dy', `${Math.round(-18 - Math.sin(angle) * 14)}px`);
      node.style.animationDelay = `${index * 60}ms`;
      wrapNode.append(node);
    });
    if (kind === 'bath') {
      const gauge = document.querySelector('.gauge-row--clean .gauge');
      if (gauge) {
        gauge.classList.add('gauge--flash');
        setTimeout(() => gauge.classList.remove('gauge--flash'), 700);
      }
    }
  }

  reaction = { timer: null, wrap: wrapNode, canvas: canvasNode, species: species ?? speciesOf(pet), pet, baseExpression };
  reaction.timer = setTimeout(() => clearReaction(), duration + 120);
  return { kind, duration, reduced: reducedMotion() };
}

/** お世話IDから反応の種類を決める */
export function reactionFor(actionId, { foodId = null, sleeping = false } = {}) {
  if (actionId === 'sleep') return sleeping ? 'wake' : 'sleep';
  if (actionId === 'food' && foodId && foodId !== 'basic') return 'foodDeluxe';
  return REACTIONS[actionId] ? actionId : 'pet';
}

/* ------------------------------------------------------------ 端末の初期化 */

const RESET_KEEP = [
  'ペット',
  'コイン',
  'おとの せってい',
];
const RESET_DELETE_KEEP = [
  'てんすうの きろく・ごうけい',
  'つぎの たまごまでの しんちょく',
  'ふかの けんり',
  'ごほうびの メモ',
  'かぞくとの ペアリング（もういちど かぞくQRが ひつよう）',
];
const RESET_DELETE_FACTORY = [...RESET_DELETE_KEEP, 'ペット', 'コイン', 'おとの せってい'];

async function startResetFlow() {
  openScanSheet({
    title: '初期化QRを よみとる',
    description: 'おうちのひとが 出している 初期化QRを よみとってください。',
    onText: async (qrText) => {
      const info = await childStore.verifyResetQr(qrText);
      await confirmReset(info);
    },
  });
}

async function confirmReset(info) {
  const factory = info.mode === 'factory';
  const removeList = factory ? RESET_DELETE_FACTORY : RESET_DELETE_KEEP;
  const keepList = factory ? [] : RESET_KEEP;

  const list = (items, className) =>
    el('ul', { class: `reset-list ${className}` }, items.map((text) => el('li', { text })));

  openSheet({
    title: 'ほんとうに 初期化しますか？',
    description: factory ? 'B: 完全初期化' : 'A: ペットを のこす',
    content: el('div', { class: 'stack' }, [
      el('p', { class: 'field__label', text: 'きえるもの' }),
      list(removeList, 'reset-list--delete'),
      keepList.length ? el('p', { class: 'field__label', text: 'のこるもの' }) : null,
      keepList.length ? list(keepList, 'reset-list--keep') : null,
      el('p', { class: 'muted small', text: '初期化のあとは「ようこそ」画面にもどります。つづけて つかうには かぞくQRを もういちど よみとってください。' }),
      el('button', {
        class: 'btn btn--danger btn--large',
        type: 'button',
        id: 'resetConfirmButton',
        text: '初期化する',
        onclick: guarded(async () => {
          await childStore.performChildReset(info.mode, {
            via: 'reset-qr',
            mode: info.mode,
            at: Date.now(),
          });
          document.querySelectorAll('.sheet__overlay').forEach((node) => node.remove());
          toast('初期化しました', { tone: 'success', duration: 2600 });
          // 未ペアリング状態に戻すため、読み込み直して「ようこそ」画面へ
          setTimeout(() => location.reload(), 600);
        }),
      }),
    ]),
  });
}

/* ------------------------------------------------------------ まばたき・ライブ更新 */

function startBlink(canvas, species, pet, expressionId) {
  if (blinkTimer) clearInterval(blinkTimer);
  const stage = pet.stage;
  blinkTimer = setInterval(() => {
    if (!document.body.contains(canvas)) {
      clearInterval(blinkTimer);
      blinkTimer = null;
      return;
    }
    if (canvas.closest?.('.pet-sprite-wrap')?.dataset.reaction) return;
    const blinking = Math.random() < 0.22;
    drawPet(canvas, species, { expression: expressionId, blink: blinking, size: 132, stage });
  }, 900);
}

/** 1秒ごとの軽い更新（クールダウン表示・ゲージ・表情） */
async function liveUpdate(section) {
  if (!dashboard?.selected) return;
  const now = Date.now();
  const stored = await childStore.getPet(dashboard.selected.id);
  if (!stored) return;
  // 表示は「いま」の値で（永続化は別のタイマーがまとめて行う）
  const pet = tickLogic(stored, now).pet;

  const gauges = document.querySelector('#petGauges');
  if (gauges) {
    for (const row of gauges.querySelectorAll('.gauge-row')) {
      const gauge = row.dataset.gauge;
      const value = Math.round(Math.max(0, Math.min(100, Number(pet.gauges?.[gauge] ?? 0))));
      row.querySelector('.gauge-row__value').textContent = String(value);
      row.querySelector('.gauge__fill').style.width = `${value}%`;
      row.querySelector('.gauge').setAttribute('aria-valuenow', String(value));
    }
  }

  const actions = document.querySelector('#careActions');
  if (actions) {
    const night = isNightRest(now);
    for (const button of actions.querySelectorAll('.care-btn')) {
      const actionId = button.dataset.care;
      const remaining = actionId === 'sleep' ? 0 : cooldownRemainingMs(pet, actionId, now);
      const blocked = actionId !== 'sleep' && pet.sleeping;
      button.disabled = !night && (remaining > 0 || blocked);
      setNightLocked(button, night);
      const cd = button.querySelector('.care-btn__cd');
      if (remaining > 0) {
        if (cd) cd.textContent = `あと ${formatRemaining(remaining)}`;
        else button.append(el('span', { class: 'care-btn__cd', text: `あと ${formatRemaining(remaining)}` }));
      } else if (cd) {
        cd.remove();
      }
    }
  }

  const next = nextStageRequirement(pet, now);
  const nextNode = document.querySelector('#petNext');
  if (nextNode && next) {
    nextNode.textContent = `つぎの そだち（${next.label}）まで あと ${Math.ceil(next.needHours)}じかん・${next.needCare}かい`;
  }
}
