/**
 * ずかん（ペット図鑑）の純関数（v42・Phase 3-3）。
 *
 * DOM / IndexedDB / Date.now() に依存しない（時刻・乱数はすべて引数で受け取る）ので、
 * 単体テストと E2E の時計送りで同じ関数を通せる。
 *
 * 仕様の要点（plan.md v1.5）
 * - **個体データは持たない**: 一覧は既存のペット配列を唯一の正として petId で結合する。
 *   ずかん側が保存するのは「種の発見・お気に入り・成長の記録」だけ（Z2-6・Z6-5）。
 * - 記録は**昇順**（古い記録が上・新しい記録が下に追加）。同じ日は createdAt で安定ソート（Z6-8）。
 * - 自動記録は 孵化（🥚）・段階アップ（⭐）・ペット日記（📖）の3種（Z6-7・Z6-9）。
 * - ペット日記は**1個体1日1件まで**・確率発火・テンプレート方式（AI・新規通信なし）。
 * - 鳴き声は合成音のパラメータだけを持つ（音は js/ui/sound.js の tone() が鳴らす）。
 */

import { MOTIFS } from '../../data/pet-designs.js';
import { PERSONALITIES, SPECIES, STAGES } from '../../data/pets.js';

/** 記録の種類（auto:true のものは自動記録） */
export const DEX_RECORD_KINDS = Object.freeze({ HATCH: 'hatch', GROW: 'grow', DIARY: 'diary' });

/** 夜ロック中の案内（Z9） */
export const DEX_NIGHT_TEXT = 'いまは ねる じかん。ずかんは みるだけ できるよ';
export const DEX_NIGHT_ACTION_TEXT = 'あさ 7じ から できるよ';

/** 未発見の種の表示名（Z1-5: 名前・ひとこと・鳴き声は一切出さない） */
export const DEX_UNKNOWN_NAME = '？？？';
export const DEX_UNKNOWN_NOTE = 'まだ であった ことが ないよ。たまごから うまれるのを たのしみに しててね。';

/** なるびかえ（個体一覧）の種類 */
export const DEX_SORTS = Object.freeze([
  { id: 'fav', label: '★ おきにいり さき' },
  { id: 'met', label: 'あたらしい じゅん' },
]);

/** 記録の本文の上限（画面の入力欄と保存の両方で使う） */
export const DEX_RECORD_MAX_LENGTH = 40;
export const DEX_RECORD_PLACEHOLDER = 'できごとを かこう';

/** 自動記録の文言（デモと同一） */
export const HATCH_RECORD_TEXT = '🥚 たまごから うまれたよ';

/** 途中段階 → 上がった先の文言 */
export function growRecordText(stage) {
  return stage === 'adult' ? '⭐ おとなに そだったよ' : '⭐ こどもに そだったよ';
}

/** ペット日記の発火確率（毎回ではない・目安） */
export const DIARY_CHANCE = 0.35;

/**
 * おせわ → 日記の話題。デモ（final/dex-ui.js）の DIARY_TEMPLATES を移植し、
 * 種・性格で言い換えるための「性格のひとこと」を足した。
 */
export const DIARY_TEMPLATES = Object.freeze({
  pet: Object.freeze({
    label: 'なでる',
    lines: Object.freeze(['いっぱい なでてもらって うれしいよ', 'なでてもらうの だいすき', 'あったかくて ねむくなっちゃう']),
  }),
  play: Object.freeze({
    label: 'あそぶ',
    lines: Object.freeze(['いっぱい あそんで たのしかった！', 'きょうの あそび たのしかったよ', 'もっと あそびたかったな']),
  }),
  food: Object.freeze({
    label: 'ごはん',
    lines: Object.freeze(['エサが おいしかったよ', 'おなか いっぱいで げんき！', 'ごはんの じかんが だいすき']),
  }),
  bath: Object.freeze({
    label: 'おふろ',
    lines: Object.freeze(['おふろで ぴかぴかに なったよ', 'おふろ きもち よかったよ', 'あわあわ たのしかった']),
  }),
  sleep: Object.freeze({
    label: 'ねかせる',
    lines: Object.freeze(['ゆっくり ねて すっきり したよ', 'いい ゆめを みたよ', 'ふかふかで よく ねむれた']),
  }),
});

/** 性格ごとのひとこと（文面を種・性格で変える） */
export const DIARY_FLAVOR = Object.freeze({
  laidback: Object.freeze(['ゆっくり すごしたよ', 'のんびり してるよ']),
  bright: Object.freeze(['きょうも げんき いっぱい！', 'はやく あそびたいな']),
  cool: Object.freeze(['…ちょっと うれしかった', 'おちついて すごしたよ']),
  clingy: Object.freeze(['もっと かまって ほしいな', 'そばに いてね']),
});

/** おせわの actionId → 日記の話題（対象外は null） */
export function diaryCareType(actionId) {
  return Object.prototype.hasOwnProperty.call(DIARY_TEMPLATES, actionId) ? actionId : null;
}

function speciesIndex(speciesId) {
  return SPECIES.findIndex((species) => species.id === speciesId);
}

function personalityOf(speciesId, personalityId = null) {
  const fromSpecies = SPECIES.find((species) => species.id === speciesId)?.personality;
  const id = personalityId || fromSpecies || 'laidback';
  return PERSONALITIES[id] ? id : 'laidback';
}

/**
 * ペット日記の一文（種・性格・話題・日付で決まる）。
 * 名前は**入れない**（表示時に「◯◯の にっき」として参照する＝改名に追随する）。
 * @param {{speciesId:string, personality?:string, careType:string, seed?:number}} input
 */
export function diaryText({ speciesId, personality = null, careType, seed = 0 } = {}) {
  const type = diaryCareType(careType) ?? 'pet';
  const lines = DIARY_TEMPLATES[type].lines;
  const trait = personalityOf(speciesId, personality);
  const flavor = DIARY_FLAVOR[trait] ?? DIARY_FLAVOR.laidback;
  const index = speciesIndex(speciesId);
  const base = Math.abs(Math.trunc(Number(seed) || 0)) + Math.max(0, index);
  const line = lines[base % lines.length];
  const tail = flavor[(base + Math.max(0, index) * 2) % flavor.length];
  return `${line}。${tail}`;
}

/** ローカル日付の 'YYYY-MM-DD'（記録の date はこの形で保存する） */
export function recordDate(now = Date.now()) {
  const date = new Date(Number(now));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 表示用 'YYYY/MM/DD'（保存は変えない） */
export function formatRecordDate(value) {
  return String(value ?? '').replace(/-/g, '/');
}

/** 段階の日本語ラベル（data/pets.js の STAGES が正） */
export function stageLabelOf(stageId) {
  return STAGES.find((stage) => stage.id === stageId)?.label ?? stageId;
}

/** 段階の順番（baby=0 / child=1 / adult=2）。未知は 1 */
export function stageRank(stageId) {
  const index = STAGES.findIndex((stage) => stage.id === stageId);
  return index < 0 ? 1 : index;
}

/* ------------------------------------------------------------ 記録の組み立て */

/**
 * 記録の並び（昇順＝古い記録が上・新しい記録が下）。Z6-8
 * 同じ日は createdAt → recordId の順で安定させる。
 */
export function compareRecords(a, b) {
  const dateCompare = String(a?.date ?? '').localeCompare(String(b?.date ?? ''));
  if (dateCompare !== 0) return dateCompare;
  const createdCompare = (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0);
  if (createdCompare !== 0) return createdCompare;
  return String(a?.recordId ?? '').localeCompare(String(b?.recordId ?? ''));
}

export function sortRecords(records = []) {
  return [...records].sort(compareRecords);
}

/** 1個体ぶんの記録（昇順） */
export function recordsForPet(records = [], petId) {
  return sortRecords(records.filter((record) => record?.petId === petId));
}

/**
 * 記録ID。自動記録は「1個体1日1件」「段階ごとに1件」をIDで構造的に守る
 * （同じ出来事を二重に書かない・書き直しは上書き）。
 */
export function hatchRecordId(petId) {
  return `${petId}:hatch`;
}

export function growRecordId(petId, stage) {
  return `${petId}:grow:${stage}`;
}

export function diaryRecordId(petId, date) {
  return `${petId}:diary:${date}`;
}

export function hatchRecord({ petId, stage = 'baby', now, createdAt = now } = {}) {
  return {
    recordId: hatchRecordId(petId),
    petId,
    date: recordDate(now),
    stageAt: stage,
    text: HATCH_RECORD_TEXT,
    auto: true,
    kind: DEX_RECORD_KINDS.HATCH,
    createdAt: Number(createdAt) || Number(now) || 0,
  };
}

export function growRecord({ petId, stage, now, createdAt = now } = {}) {
  return {
    recordId: growRecordId(petId, stage),
    petId,
    date: recordDate(now),
    stageAt: stage,
    text: growRecordText(stage),
    auto: true,
    kind: DEX_RECORD_KINDS.GROW,
    createdAt: Number(createdAt) || Number(now) || 0,
  };
}

export function diaryRecord({ petId, stage, text, now, createdAt = now } = {}) {
  const date = recordDate(now);
  return {
    recordId: diaryRecordId(petId, date),
    petId,
    date,
    stageAt: stage,
    text: String(text ?? ''),
    auto: true,
    kind: DEX_RECORD_KINDS.DIARY,
    createdAt: Number(createdAt) || Number(now) || 0,
  };
}

/** 本人が書いた記録（auto は付けない・recordId は store が作る） */
export function userRecord({ recordId, petId, stage, text, now, createdAt = now } = {}) {
  return {
    recordId: String(recordId ?? ''),
    petId,
    date: recordDate(now),
    stageAt: stage,
    text: String(text ?? ''),
    createdAt: Number(createdAt) || Number(now) || 0,
  };
}

/**
 * ペット日記を書くか（Z6-9）。
 * - 同じ個体・同じ日にすでに日記があれば書かない（1個体1日1件）
 * - 確率発火（`DIARY_CHANCE`）。乱数は引数で受け取る（テストで固定する）
 */
export function shouldWriteDiary({ records = [], petId, date, rng = Math.random, chance = DIARY_CHANCE } = {}) {
  if (!petId || !date) return false;
  const already = records.some((record) => record?.petId === petId && record?.kind === DEX_RECORD_KINDS.DIARY && record?.date === date);
  if (already) return false;
  const roll = Number(rng());
  if (!Number.isFinite(roll)) return false;
  return roll < chance;
}

/** 記録の本文を整える（前後の空白を除く・長さ上限） */
export function normalizeRecordText(value) {
  return String(value ?? '').trim().slice(0, DEX_RECORD_MAX_LENGTH);
}

/* ------------------------------------------------------------ 種・個体の一覧 */

/** 種の1行ぶんの表示データ（発見済み・未発見を問わず全20種） */
export function buildSpeciesRows(dexSpecies = {}, pets = []) {
  const registered = dexSpecies && typeof dexSpecies === 'object' ? dexSpecies : {};
  const rows = [];
  for (const species of SPECIES) {
    const mine = pets.filter((pet) => pet?.speciesId === species.id);
    const entry = registered[species.id] ?? null;
    rows.push({
      id: species.id,
      name: species.name,
      discovered: Boolean(entry) || mine.length > 0,
      discoveredAt: entry?.discoveredAt ?? null,
      firstPetId: entry?.firstPetId ?? mine[0]?.id ?? null,
      petCount: mine.length,
      motif: MOTIFS[species.id]?.motif ?? '',
      kind: MOTIFS[species.id]?.kind ?? '',
      personality: species.personality ?? 'laidback',
    });
  }
  return rows;
}

/** 個体一覧の行（★・きろく件数つき）。並びは おきにいり先 / あたらしい順 */
export function buildIndividualRows({ pets = [], records = [], favorites = {}, sort = 'fav' } = {}) {
  const rows = pets.map((pet) => ({
    pet,
    favorite: Boolean(favorites?.[pet.id]),
    recordCount: records.filter((record) => record?.petId === pet.id).length,
    metAt: Number(pet.firstMetAt) || Number(pet.hatchedAt) || 0,
  }));
  const newestFirst = (a, b) => b.metAt - a.metAt;
  rows.sort((a, b) => {
    if (sort === 'met') return newestFirst(a, b);
    return Number(b.favorite) - Number(a.favorite) || newestFirst(a, b);
  });
  return rows;
}

/* ------------------------------------------------------------ 移行（v41 → v42） */

/**
 * 既存個体の「であった日」。
 * 既存の `hatchedAt`（孵化した時刻）があればそれを使い、無ければ移行日で代用する
 * （あとから変更しない・自動）。plan.md §2 ②。
 */
export function firstMetAtFor(pet, now) {
  const saved = Number(pet?.firstMetAt);
  if (Number.isFinite(saved) && saved > 0) return saved;
  const hatched = Number(pet?.hatchedAt);
  if (Number.isFinite(hatched) && hatched > 0) return hatched;
  return Number(now) || 0;
}

/**
 * 既存ペットから種の発見を再構築する（旧バックアップ復元・v41 からの移行）。
 * すでに発見済みの種は触らない（discoveredAt は最初の発見を保持）。
 * @returns {{species:object, changed:boolean}}
 */
export function migrateSpeciesMap(dexSpecies = {}, pets = [], now = Date.now()) {
  const species = { ...(dexSpecies && typeof dexSpecies === 'object' ? dexSpecies : {}) };
  let changed = false;
  for (const pet of pets) {
    if (!pet?.speciesId || !pet?.id) continue;
    if (species[pet.speciesId]) continue;
    species[pet.speciesId] = {
      discoveredAt: recordDate(firstMetAtFor(pet, now)),
      firstPetId: pet.id,
    };
    changed = true;
  }
  return { species, changed };
}

/* ------------------------------------------------------------ 鳴き声（合成・素材0） */

const CRY_WAVES = Object.freeze(['square', 'triangle', 'sawtooth', 'sine']);

/**
 * 種ごとの鳴き声パラメータ。20種で音色・高さ・長さが変わる。
 * 未準備（未知の種ID）は `null` ＝ 画面はボタンを無効にする（Z4-5: 停止しない）。
 */
export function cryParams(speciesId) {
  const index = speciesIndex(speciesId);
  if (index < 0) return null;
  return {
    speciesId,
    wave: CRY_WAVES[index % CRY_WAVES.length],
    /** 基音（280〜757Hz） */
    base: 280 + ((index * 47) % 480),
    /** 2〜4音 */
    notes: 2 + (index % 3),
    /** 音の間隔（95〜207ms） */
    gap: 95 + (index % 5) * 28,
    /** 最後の音の上げ下げ（Hz） */
    slide: (index % 2 === 0 ? 1 : -1) * (60 + (index % 7) * 40),
  };
}

/** 発見数（種） */
export function discoveredCount(rows = []) {
  return rows.filter((row) => row.discovered).length;
}
