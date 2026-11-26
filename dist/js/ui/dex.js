/**
 * ずかん（ペット図鑑・v42・Phase 3-3）。
 *
 * - 3階層: ずかんトップ（しゅるい／こたい）→ 種詳細 → 個体詳細（であった日・★・成長の記録）
 * - 個体は既存のペット（`js/store/child.js` の listPets）を唯一の正として petId で結合する
 * - 未発見の種はシルエット＋「？」だけ（名前・ひとこと・鳴き声は出さない・Z1-5）
 * - 夜（22:00〜06:59）は「みるだけ」。鳴き声・★・記録の追加は押しても案内1行（Z9）
 * - 鳴き声は合成音（`js/ui/sound.js` の tone()）。素材0・precache不要・新規通信なし
 */
import * as childStore from '../store/child.js';
import { MOTIFS } from '../../data/pet-designs.js';
import { findSpecies } from '../../data/pets.js';
import { isNightRest } from '../game/night.js';
import {
  DEX_NIGHT_ACTION_TEXT,
  DEX_NIGHT_TEXT,
  DEX_RECORD_MAX_LENGTH,
  DEX_RECORD_PLACEHOLDER,
  DEX_SORTS,
  DEX_UNKNOWN_NAME,
  DEX_UNKNOWN_NOTE,
  buildIndividualRows,
  buildSpeciesRows,
  cryParams,
  discoveredCount,
  formatRecordDate,
  recordDate,
  recordsForPet,
  stageLabelOf,
} from '../game/dex.js';
import { clear, el, openSheet, toast } from './dom.js';
import { buildGrid, drawPet, speciesIntro } from './pet-sprite.js';
import { playSe, unlockAudio } from './sound.js';

/** スプライトの大きさ（24の整数倍で描く＝ドットが崩れない） */
const CARD_SPRITE_PX = 48;
const ROW_SPRITE_PX = 48;
const STAGE_SPRITE_PX = 48;
const BIG_SPRITE_PX = 144;

/** 未発見のシルエットの色（デモと同じ一色） */
const SILHOUETTE_COLOR = '#4a4458';

/** シルエット: グリッドの「.」以外を一色で塗る（新規素材0） */
function drawSilhouette(canvas, grid, px) {
  const scale = Math.max(1, Math.round(px / 24));
  const dimension = 24 * scale;
  canvas.width = dimension;
  canvas.height = dimension;
  canvas.style.width = `${dimension}px`;
  canvas.style.height = `${dimension}px`;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.fillStyle = SILHOUETTE_COLOR;
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const value = row[x];
      if (!value || value === '.') continue;
      context.fillRect(x * scale, y * scale, scale, scale);
    }
  });
}

/** ペットの絵（ドット絵）。見つかっていない種はシルエット */
function sprite(speciesId, { stage = 'child', px = CARD_SPRITE_PX, ink = false } = {}) {
  const canvas = el('canvas', { class: `dex-sprite${ink ? ' dex-sprite--ink' : ''}`, 'aria-hidden': 'true' });
  const species = findSpecies(speciesId);
  if (!species) return canvas;
  if (ink) {
    drawSilhouette(canvas, buildGrid(species, { stage: 'child', expression: 'normal', blink: false }), px);
  } else {
    // drawPet は 24 の整数倍で描く（px は24の倍数を渡す）
    drawPet(canvas, species, { size: px, stage, expression: 'normal', blink: false });
  }
  return canvas;
}

function stageText(stage) {
  return stageLabelOf(stage);
}

/** 夜いま？ 押した瞬間に判定する（画面を開いたまま22:00を跨いでも効く） */
function nightNow() {
  return isNightRest(Date.now());
}

/** ずかんを開く（入口は部屋の「ずかん」ボタン） */
export async function openDexSheet() {
  const view = el('div', { class: 'dex', id: 'dexRoot' });
  const state = { tab: 'species', sort: 'fav', speciesId: null, petId: null, data: null, loading: true };

  async function load() {
    state.data = await childStore.getDexDashboard({ now: Date.now() });
    state.loading = false;
  }

  const sheet = openSheet({
    title: 'ずかん',
    description: 'であえた ペットの しゅるいと こたいを 見られるよ。',
    content: view,
    size: 'wide',
  });

  /* ---------------------------------------------------------- 共通パーツ */

  function nightBanner() {
    return nightNow() ? el('p', { class: 'dex-night', id: 'dexNight', text: `🌙 ${DEX_NIGHT_TEXT}` }) : null;
  }

  /** 夜に押したときの案内（1行）。何も変えない */
  function lockedByNight() {
    if (!nightNow()) return false;
    toast(DEX_NIGHT_ACTION_TEXT, { tone: 'info', duration: 2400 });
    return true;
  }

  function backButton(onClick) {
    return el('button', {
      class: 'dex-back',
      id: 'dexBack',
      type: 'button',
      text: '← もどる',
      onclick: () => {
        onClick();
        paint();
      },
    });
  }

  /* ---------------------------------------------------------- 画面: トップ */

  function renderTop() {
    const { dex, pets } = state.data;
    const speciesRows = buildSpeciesRows(dex.species, pets);
    const found = discoveredCount(speciesRows);
    const wrap = el('div', { class: 'dex-page', id: 'dexTop' });
    const banner = nightBanner();
    if (banner) wrap.append(banner);

    const tab = (label, id, value) => el('button', {
      class: `dex-tab${state.tab === value ? ' dex-tab--on' : ''}`,
      type: 'button',
      id,
      'aria-pressed': String(state.tab === value),
      text: label,
      onclick: () => {
        state.tab = value;
        paint();
      },
    });
    wrap.append(el('div', { class: 'dex-tabs', role: 'group', 'aria-label': 'ひょうじの きりかえ' }, [
      tab('しゅるい の 一覧', 'dexTabSpecies', 'species'),
      tab('こたい の 一覧', 'dexTabIndividual', 'individual'),
    ]));

    if (state.tab === 'species') {
      const grid = el('div', { class: 'dex-grid', id: 'dexGrid' });
      for (const row of speciesRows) {
        const foundIt = row.discovered;
        grid.append(el('button', {
          class: `dex-card${foundIt ? '' : ' dex-card--unknown'}`,
          type: 'button',
          dataset: { speciesId: row.id, unknown: foundIt ? 'false' : 'true' },
          // 未発見の種は名前を aria-label にも出さない（Z1-5）
          'aria-label': foundIt ? `${row.name}の ずかん` : 'まだ みつけていない ペット',
          onclick: () => {
            state.speciesId = row.id;
            state.petId = null;
            paint();
          },
        }, [
          sprite(row.id, { stage: 'child', px: CARD_SPRITE_PX, ink: !foundIt }),
          el('span', { class: 'dex-card__name', text: foundIt ? row.name : '？' }),
        ]));
      }
      wrap.append(grid);
      wrap.append(el('p', {
        class: 'dex-note',
        id: 'dexCount',
        text: `みつけた しゅるい ${found}／${speciesRows.length}・こたい ${pets.length}ひき`,
      }));
    } else {
      wrap.append(el('div', { class: 'dex-sortrow' }, [
        el('span', { class: 'dex-sortlabel', text: 'ならびかえ' }),
        // 44px のタップ領域を保ったまま1行に収める（ラベルは上の行に置く）
        el('div', { class: 'dex-sortopts' }, DEX_SORTS.map((sort) => el('button', {
          class: `dex-seg${state.sort === sort.id ? ' dex-seg--on' : ''}`,
          type: 'button',
          id: sort.id === 'fav' ? 'dexSortFav' : 'dexSortMet',
          'aria-pressed': String(state.sort === sort.id),
          text: sort.label,
          onclick: () => {
            state.sort = sort.id;
            paint();
          },
        }))),
      ]));
      const rows = buildIndividualRows({ pets, records: state.data.records, favorites: dex.favorites, sort: state.sort });
      const list = el('div', { class: 'dex-indiv', id: 'dexIndividualList' });
      if (!rows.length) list.append(el('p', { class: 'dex-intro', text: 'まだ ペットが いないよ' }));
      for (const row of rows) list.append(individualRow(row, { withSpecies: true }));
      wrap.append(list);
      wrap.append(el('p', { class: 'dex-note', text: '★は ここでも こたいの ページでも つけられるよ' }));
    }
    return wrap;
  }

  /* ---------------------------------------------------------- 個体の行 */

  /**
   * 個体1行: タップで個体ページ／★はその場でおきにいり（v1.1）／きろく件数を常時表示。
   * ★は再描画せず、その場で見た目と aria を変える（スクロール位置を動かさない）。
   */
  function individualRow(row, { withSpecies = false } = {}) {
    const { pet } = row;
    const species = findSpecies(pet.speciesId);
    const nameText = withSpecies && species ? `${pet.name}（${species.name}）` : pet.name;
    const metAt = Number(pet.firstMetAt) || Number(pet.hatchedAt) || 0;
    const metLabel = metAt ? formatRecordDate(recordDate(metAt)) : '—';

    const star = el('button', {
      class: `dex-star${row.favorite ? ' dex-star--on' : ''}`,
      type: 'button',
      dataset: { petId: pet.id },
      'aria-pressed': String(row.favorite),
      'aria-label': `${row.favorite ? 'おきにいりを はずす' : 'おきにいりに する'}: ${pet.name}`,
      text: row.favorite ? '★' : '☆',
      onclick: async () => {
        if (lockedByNight()) return;
        const next = !(state.data.dex.favorites?.[pet.id] === true);
        const result = await childStore.setDexFavorite(pet.id, next, { now: Date.now() });
        if (!result.ok) {
          toast(result.message ?? 'おきにいりを かえられませんでした', { tone: 'error' });
          return;
        }
        playSe('tap');
        state.data.dex.favorites = result.favorites;
        row.favorite = next;
        star.textContent = next ? '★' : '☆';
        star.classList.toggle('dex-star--on', next);
        star.setAttribute('aria-pressed', String(next));
        star.setAttribute('aria-label', `${next ? 'おきにいりを はずす' : 'おきにいりに する'}: ${pet.name}`);
      },
    });

    return el('div', { class: 'dex-indiv__row', dataset: { petId: pet.id } }, [
      el('button', {
        class: 'dex-indiv__main',
        type: 'button',
        'aria-label': `${pet.name}の ページを ひらく`,
        onclick: () => {
          state.speciesId = pet.speciesId;
          state.petId = pet.id;
          paint();
        },
      }, [
        sprite(pet.speciesId, { stage: pet.stage, px: ROW_SPRITE_PX }),
        el('span', { class: 'dex-indiv__col' }, [
          el('span', { class: 'dex-indiv__name', text: nameText }),
          el('span', { class: 'dex-indiv__meta', text: `${metLabel}・きろく ${row.recordCount}件` }),
        ]),
      ]),
      star,
    ]);
  }

  /* ---------------------------------------------------------- 画面: 種詳細 */

  function renderSpecies() {
    const species = findSpecies(state.speciesId);
    if (!species) return renderTop();
    const { dex, pets } = state.data;
    const row = buildSpeciesRows(dex.species, pets).find((entry) => entry.id === species.id);
    const foundIt = Boolean(row?.discovered);
    const wrap = el('div', { class: 'dex-sheet-page', id: 'dexSpecies', dataset: { speciesId: species.id } });
    const banner = nightBanner();
    if (banner) wrap.append(banner);
    wrap.append(backButton(() => {
      state.speciesId = null;
      state.petId = null;
    }));
    wrap.append(el('div', { class: 'dex-big' }, [sprite(species.id, { stage: 'child', px: BIG_SPRITE_PX, ink: !foundIt })]));
    wrap.append(el('h2', { class: 'dex-title', text: foundIt ? species.name : DEX_UNKNOWN_NAME }));

    if (!foundIt) {
      // Z1-5: 名前・ひとこと・鳴き声・成長段階を出さない
      wrap.append(el('p', { class: 'dex-intro', text: DEX_UNKNOWN_NOTE }));
      return wrap;
    }

    const motif = MOTIFS[species.id];
    if (motif) wrap.append(el('p', { class: 'dex-motif', text: `${motif.motif}・${motif.kind}ぞく` }));
    wrap.append(el('p', { class: 'dex-intro', text: speciesIntro(species) }));

    // 鳴き声（Z4）。未準備の種はボタンを無効にするだけで、アプリは止めない（Z4-5）
    const params = cryParams(species.id);
    wrap.append(el('button', {
      class: 'dex-cry',
      id: 'dexCry',
      type: 'button',
      disabled: !params,
      'aria-disabled': params ? 'false' : 'true',
      'aria-label': `なきごえを きく: ${species.name}`,
      onclick: () => {
        if (!params) return;
        if (lockedByNight()) return;
        unlockAudio();
        playSe('cry', params);
      },
    }, ['🔊 なきごえを きく']));

    // せいちょう（3段階の絵・Z: 元要件書 §4）
    wrap.append(el('h3', { class: 'dex-h3', text: 'せいちょう' }));
    const stages = el('div', { class: 'dex-stages' });
    for (const stage of ['baby', 'child', 'adult']) {
      stages.append(el('div', { class: 'dex-stages__item' }, [
        sprite(species.id, { stage, px: STAGE_SPRITE_PX }),
        el('span', { class: 'dex-stages__label', text: stageText(stage) }),
      ]));
    }
    wrap.append(stages);

    // この種の個体（同種をまとめて確認・Z2-4）
    const mine = pets
      .filter((pet) => pet.speciesId === species.id)
      .sort((a, b) => (Number(a.firstMetAt) || 0) - (Number(b.firstMetAt) || 0));
    wrap.append(el('h3', { class: 'dex-h3', text: `このしゅるいの こたい（${mine.length}ひき）` }));
    const list = el('div', { class: 'dex-indiv', id: 'dexSpeciesPets' });
    if (!mine.length) list.append(el('p', { class: 'dex-intro', text: 'まだ いないよ' }));
    const rows = buildIndividualRows({ pets: mine, records: state.data.records, favorites: dex.favorites, sort: 'met' });
    for (const entry of rows) list.append(individualRow(entry, { withSpecies: false }));
    wrap.append(list);
    return wrap;
  }

  /* ---------------------------------------------------------- 画面: 個体詳細 */

  function recordCard(record, pet) {
    const kind = record.kind ?? null;
    const tag = kind === 'diary'
      // 名前は記録に埋めず、表示のたびに参照する（改名に追随・v1.5）
      ? `・${pet.name}の にっき`
      : kind === 'grow' ? '・せいちょう' : kind === 'hatch' ? '・うまれた' : '';
    const className = kind === 'diary'
      ? 'dex-record dex-record--diary'
      : record.auto ? 'dex-record dex-record--auto' : 'dex-record';
    return el('div', { class: className, dataset: { kind: kind ?? 'user', recordId: record.recordId } }, [
      el('div', {
        class: 'dex-record__date',
        text: `${formatRecordDate(record.date)}・${stageText(record.stageAt)}${tag}`,
      }),
      el('div', { class: 'dex-record__text', text: record.text }),
    ]);
  }

  function renderPet() {
    const pet = state.data.pets.find((entry) => entry.id === state.petId);
    if (!pet) return renderTop();
    const species = findSpecies(pet.speciesId);
    const wrap = el('div', { class: 'dex-sheet-page', id: 'dexPet', dataset: { petId: pet.id } });
    const banner = nightBanner();
    if (banner) wrap.append(banner);
    wrap.append(backButton(() => {
      state.petId = null;
    }));
    wrap.append(el('div', { class: 'dex-big' }, [sprite(pet.speciesId, { stage: pet.stage, px: BIG_SPRITE_PX })]));
    wrap.append(el('h2', { class: 'dex-title', id: 'dexPetName', text: pet.name }));
    wrap.append(el('p', { class: 'dex-sub', text: `${species?.name ?? ''}・${stageText(pet.stage)}` }));

    // であった日（Z3: 自動・個体ごと・変更不可）
    const metAt = Number(pet.firstMetAt) || Number(pet.hatchedAt) || 0;
    const metLabel = metAt ? formatRecordDate(recordDate(metAt)) : '—';
    wrap.append(el('p', { class: 'dex-metday', id: 'dexMetDay', text: `🕊 であった日 ${metLabel}` }));

    // おきにいり（Z5: 個体ごとに独立）
    const favorite = state.data.dex.favorites?.[pet.id] === true;
    const favButton = el('button', {
      class: `dex-fav${favorite ? ' dex-fav--on' : ''}`,
      id: 'dexFav',
      type: 'button',
      dataset: { petId: pet.id },
      'aria-pressed': String(favorite),
      text: favorite ? '★ おきにいり に はいってる' : '☆ おきにいりに いれる',
      onclick: async () => {
        if (lockedByNight()) return;
        const next = !(state.data.dex.favorites?.[pet.id] === true);
        const result = await childStore.setDexFavorite(pet.id, next, { now: Date.now() });
        if (!result.ok) {
          toast(result.message ?? 'おきにいりを かえられませんでした', { tone: 'error' });
          return;
        }
        playSe('tap');
        state.data.dex.favorites = result.favorites;
        favButton.textContent = next ? '★ おきにいり に はいってる' : '☆ おきにいりに いれる';
        favButton.classList.toggle('dex-fav--on', next);
        favButton.setAttribute('aria-pressed', String(next));
      },
    });
    wrap.append(favButton);

    // せいちょうの きろく（昇順・Z6-8）
    wrap.append(el('h3', { class: 'dex-h3', text: 'せいちょうの きろく' }));
    const records = recordsForPet(state.data.records, pet.id);
    const list = el('div', { class: 'dex-records', id: 'dexRecords' });
    if (!records.length) list.append(el('p', { class: 'dex-intro', text: 'まだ きろくが ないよ' }));
    for (const record of records) list.append(recordCard(record, pet));
    wrap.append(list);

    // 追加フォーム（縦積み・折り返さない）
    if (nightNow()) {
      wrap.append(el('p', { class: 'dex-intro dex-intro--lock', id: 'dexRecordLock', text: `🌙 きろくを かくのは ${DEX_NIGHT_ACTION_TEXT}` }));
    }
    const input = el('input', {
      class: 'dex-record-input',
      id: 'dexRecordInput',
      type: 'text',
      maxlength: String(DEX_RECORD_MAX_LENGTH),
      placeholder: DEX_RECORD_PLACEHOLDER,
      'aria-label': 'できごと',
      enterkeyhint: 'done',
    });
    const add = el('button', {
      class: 'dex-record-add',
      id: 'dexRecordAdd',
      type: 'button',
      text: 'きろくを かく',
      onclick: async () => {
        if (lockedByNight()) return;
        const text = input.value.trim();
        if (!text) {
          toast('できごとを かいてね', { tone: 'info' });
          input.focus();
          return;
        }
        const result = await childStore.addDexRecord({ petId: pet.id, text, now: Date.now() });
        if (!result.ok) {
          toast(result.message ?? 'きろく できませんでした', { tone: 'error' });
          return;
        }
        playSe('care');
        input.value = '';
        await load();
        paint();
        // 新しい記録は下に足される（昇順）。足した記録が見えるところまで送る
        const last = view.querySelector('#dexRecords .dex-record:last-child');
        last?.scrollIntoView({ block: 'nearest' });
      },
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') add.click();
    });
    wrap.append(el('div', { class: 'dex-record-form' }, [input, add]));
    return wrap;
  }

  /* ---------------------------------------------------------- 描画 */

  function paint() {
    if (state.loading) return;
    clear(view);
    if (state.petId) view.append(renderPet());
    else if (state.speciesId) view.append(renderSpecies());
    else view.append(renderTop());
  }

  view.append(el('p', { class: 'dex-loading', text: 'よみこみ中…' }));
  try {
    await load();
  } catch (error) {
    console.error(error);
    clear(view);
    view.append(el('p', { class: 'dex-intro', text: 'ずかんを よみこめませんでした。とじてもういちど ためしてね。' }));
    return sheet;
  }
  paint();
  return sheet;
}
