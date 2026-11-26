/**
 * ペットのマスターデータ（Phase 2）。
 * 絵文字は使わず、24×24 のドット絵をこのデータから組み立てる（js/ui/pet-sprite.js）。
 */

export const STAGES = Object.freeze([
  { id: 'baby', label: 'ベビー', minHours: 0, minCare: 0 },
  { id: 'child', label: 'こども', minHours: 24, minCare: 15 },
  { id: 'adult', label: 'おとな', minHours: 72, minCare: 50 },
]);

export const PERSONALITIES = Object.freeze({
  laidback: { id: 'laidback', label: 'のんびり', tempo: 1.35, reaction: 0.9, note: 'ゆったり うごくよ' },
  bright: { id: 'bright', label: 'げんき', tempo: 0.72, reaction: 1.15, note: 'ぴょこぴょこ よく うごくよ' },
  cool: { id: 'cool', label: 'クール', tempo: 1.1, reaction: 0.8, note: 'おちついて いるよ' },
  clingy: { id: 'clingy', label: 'あまえんぼ', tempo: 0.9, reaction: 1.2, note: 'かまって ほしがるよ' },
});

/** 20種。palette は 3〜4 色、shape はドット絵の型。 */
export const SPECIES = Object.freeze([
  { id: 'mochi', name: 'モチモチ', personality: 'laidback', palette: { body: '#ffe0e9', accent: '#ffb0c6', dark: '#c97f96' }, shape: { body: 'round', ears: 'round', tail: 'puff', pattern: 'belly' } },
  { id: 'poko', name: 'ポコ', personality: 'bright', palette: { body: '#fff0c4', accent: '#ffcf5c', dark: '#c99a2e' }, shape: { body: 'egg', ears: 'pointy', tail: 'puff', pattern: 'spots' } },
  { id: 'muni', name: 'ムニ', personality: 'cool', palette: { body: '#d9ecff', accent: '#8ec4f2', dark: '#5b8fbf' }, shape: { body: 'blob', ears: 'none', tail: 'curl', pattern: 'none' } },
  { id: 'shiro', name: 'シロ', personality: 'clingy', palette: { body: '#f6f4ff', accent: '#cfc6f0', dark: '#9c92c4' }, shape: { body: 'round', ears: 'long', tail: 'puff', pattern: 'belly' } },
  { id: 'kuri', name: 'クリ', personality: 'bright', palette: { body: '#ffd9b8', accent: '#e8a468', dark: '#ab6c34' }, shape: { body: 'round', ears: 'pointy', tail: 'spike', pattern: 'stripe' } },
  { id: 'mizu', name: 'ミズ', personality: 'laidback', palette: { body: '#c8f2ef', accent: '#7fd6d2', dark: '#479f9c' }, shape: { body: 'blob', ears: 'none', tail: 'none', pattern: 'spots' } },
  { id: 'hane', name: 'ハネ', personality: 'bright', palette: { body: '#e5d9ff', accent: '#b79bff', dark: '#7a5fd0' }, shape: { body: 'egg', ears: 'pointy', tail: 'none', pattern: 'belly' } },
  { id: 'mame', name: 'マメ', personality: 'clingy', palette: { body: '#ffe9d6', accent: '#ffc193', dark: '#c9834f' }, shape: { body: 'round', ears: 'round', tail: 'puff', pattern: 'spots' } },
  { id: 'tono', name: 'トノ', personality: 'cool', palette: { body: '#dfe6ee', accent: '#9aa9bb', dark: '#5f6c7c' }, shape: { body: 'wide', ears: 'round', tail: 'none', pattern: 'stripe' } },
  { id: 'suna', name: 'スナ', personality: 'laidback', palette: { body: '#fff3d1', accent: '#f0cf7a', dark: '#b8933c' }, shape: { body: 'tall', ears: 'long', tail: 'puff', pattern: 'belly' } },
  { id: 'hoshi', name: 'ホシ', personality: 'bright', palette: { body: '#e8e3ff', accent: '#ffd76e', dark: '#8d7fd0' }, shape: { body: 'blob', ears: 'pointy', tail: 'none', pattern: 'spots' } },
  { id: 'kumo', name: 'クモ', personality: 'cool', palette: { body: '#f0f4f8', accent: '#c3d3e0', dark: '#8698a8' }, shape: { body: 'blob', ears: 'round', tail: 'curl', pattern: 'none' } },
  { id: 'momiji', name: 'モミジ', personality: 'clingy', palette: { body: '#ffd5cf', accent: '#f08573', dark: '#b04a3c' }, shape: { body: 'egg', ears: 'pointy', tail: 'spike', pattern: 'stripe' } },
  { id: 'yuki', name: 'ユキ', personality: 'laidback', palette: { body: '#eef8ff', accent: '#a9d8f0', dark: '#6aa2bf' }, shape: { body: 'tall', ears: 'round', tail: 'none', pattern: 'spots' } },
  { id: 'kaze', name: 'カゼ', personality: 'bright', palette: { body: '#d8f5dd', accent: '#7fd39a', dark: '#479c62' }, shape: { body: 'tall', ears: 'pointy', tail: 'curl', pattern: 'belly' } },
  { id: 'tori', name: 'トリ', personality: 'bright', palette: { body: '#fff4e0', accent: '#ffb347', dark: '#b87714' }, shape: { body: 'egg', ears: 'none', tail: 'spike', pattern: 'belly' } },
  { id: 'neko', name: 'ネコ', personality: 'cool', palette: { body: '#f3ece2', accent: '#c9a984', dark: '#8a6a48' }, shape: { body: 'round', ears: 'pointy', tail: 'curl', pattern: 'stripe' } },
  { id: 'inu', name: 'イヌ', personality: 'clingy', palette: { body: '#f7e2c8', accent: '#d8a877', dark: '#94693c' }, shape: { body: 'wide', ears: 'long', tail: 'puff', pattern: 'belly' } },
  { id: 'usagi', name: 'ウサギ', personality: 'clingy', palette: { body: '#ffeef5', accent: '#ffc2da', dark: '#c98aa4' }, shape: { body: 'tall', ears: 'long', tail: 'puff', pattern: 'belly' } },
  { id: 'ryu', name: 'リュウ', personality: 'cool', palette: { body: '#d9f2e4', accent: '#6fc59a', dark: '#3d8a63' }, shape: { body: 'wide', ears: 'pointy', tail: 'spike', pattern: 'stripe' } },
]);

/** 1日のお世話コイン上限 */
export const CARE_COIN_DAILY_CAP = 20;
/** 孵化・成長で得るコイン */
export const HATCH_COIN = 30;
export const STAGE_UP_COIN = 50;

/** 基本エサ（無料）と特別エサ（コイン購入） */
export const BASIC_FOOD = Object.freeze({
  id: 'basic',
  name: 'ふつうのエサ',
  price: 0,
  // お世話の「ごはん」と同じ効果（おなか +30 / きげん +5）
  effects: { hunger: 30, mood: 5 },
  note: 'いつでも 無料（おなか +30 / きげん +5）',
});

export const SPECIAL_FOODS = Object.freeze([
  { id: 'cookie', name: 'クッキー', price: 20, effects: { hunger: 50, mood: 20 }, note: 'おなか +50 / きげん +20' },
  { id: 'pudding', name: 'プリン', price: 50, effects: { hunger: 60, mood: 40, stamina: 10 }, note: 'おなか +60 / きげん +40 / たいりょく +10' },
  { id: 'cake', name: 'ケーキ', price: 120, effects: { hunger: 90, mood: 60, clean: -10 }, note: 'おなか +90 / きげん +60 / せいけつ -10' },
]);

export const FOODS = Object.freeze([BASIC_FOOD, ...SPECIAL_FOODS]);

export function findSpecies(speciesId) {
  return SPECIES.find((species) => species.id === speciesId) ?? null;
}

export function findFood(foodId) {
  return FOODS.find((food) => food.id === foodId) ?? null;
}
