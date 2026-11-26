/**
 * ペットの育成ロジック（純関数・時刻はすべて引数で受け取る）。
 * DOM / IndexedDB / Date.now() に依存しないので、単体テストと E2E の時計送りで同じ関数を通せる。
 *
 * 仕様の要点
 * - 状態4つ（おなか・きげん・せいけつ・たいりょく）は 0〜100、高いほど良い。
 * - 減衰は「起動中だけ」。満タンから 50 になるまでの時間で速度を決める。
 * - 閉じている間は悪化しない（前回時刻との差が大きい＝アプリが止まっていた、とみなす）。
 *   ただし寝かせたまま閉じていた場合は、閉じていた時間ぶん たいりょく だけ回復する（他3ゲージは変化なし）。
 * - 成長は実時間（孵化からの経過）と「有効なお世話回数」の両方が必要。
 * - お世話は対応するゲージが 80 未満のときだけ成長カウントに数える。
 */
import { PERSONALITIES, SPECIES, STAGES, findFood, findSpecies } from '../../data/pets.js';

export const GAUGES = Object.freeze(['hunger', 'mood', 'clean', 'stamina']);

export const GAUGE_LABELS = Object.freeze({
  hunger: 'おなか',
  mood: 'きげん',
  clean: 'せいけつ',
  stamina: 'たいりょく',
});

/** 満タン(100) → 50 になるまでの時間（時） */
export const DECAY_HOURS_TO_50 = Object.freeze({ hunger: 8, mood: 10, clean: 12, stamina: 9 });

/**
 * 1回の tick で反映する最大時間。
 * 起動時（resume）は「閉じていた」ので減らさないが、起動したままタブが裏に回って
 * タイマーが間引かれた場合は、あとからまとめて反映する（上限は減衰がいちばん遅いゲージ相当）。
 */
export const MAX_TICK_STEP_MS = 12 * 60 * 60 * 1000;

/** 睡眠中の たいりょく 回復（1時間あたり） */
export const SLEEP_RECOVERY_PER_HOUR = 20;

/** お世話の定義（効果量・クールダウン） */
export const CARE_ACTIONS = Object.freeze({
  food: { id: 'food', label: 'ごはん', gauge: 'hunger', cooldownMs: 10 * 60 * 1000, effects: { hunger: 30, mood: 5 } },
  play: { id: 'play', label: 'あそぶ', gauge: 'mood', cooldownMs: 5 * 60 * 1000, effects: { mood: 25, hunger: -5, stamina: -10 } },
  pet: { id: 'pet', label: 'なでる', gauge: 'mood', cooldownMs: 60 * 1000, effects: { mood: 10 } },
  bath: { id: 'bath', label: 'おふろ', gauge: 'clean', cooldownMs: 30 * 60 * 1000, effects: { clean: 40, mood: 5 } },
  sleep: { id: 'sleep', label: 'ねかせる', gauge: null, cooldownMs: 0, effects: {} },
});

export const CARE_ORDER = Object.freeze(['food', 'play', 'pet', 'bath', 'sleep']);

/** 成長カウントに入るゲージのしきい値 */
export const GROWTH_GAUGE_THRESHOLD = 80;

/**
 * ゲージは内部では小数で持つ（1分ごとの減衰が丸めで消えないように）。
 * 画面表示のときだけ丸める。
 */
function clampGauge(value) {
  const number = Number(value) || 0;
  return Math.max(0, Math.min(100, number));
}

/** 表示用（整数に丸めたゲージ） */
export function displayGauges(pet) {
  const gauges = normalizeGauges(pet.gauges);
  return {
    hunger: Math.round(gauges.hunger),
    mood: Math.round(gauges.mood),
    clean: Math.round(gauges.clean),
    stamina: Math.round(gauges.stamina),
  };
}

function emptyGauges() {
  return { hunger: 100, mood: 100, clean: 100, stamina: 100 };
}

function normalizeGauges(gauges = {}) {
  return {
    hunger: clampGauge(gauges.hunger ?? 100),
    mood: clampGauge(gauges.mood ?? 100),
    clean: clampGauge(gauges.clean ?? 100),
    stamina: clampGauge(gauges.stamina ?? 100),
  };
}

/* ------------------------------------------------------------ 生成 */

/**
 * 孵化したペットを作る。
 * @param {{speciesId:string, name:string, now:number, rng?:()=>number}} input
 */
export function createPet({ speciesId, name, now, rng = Math.random }) {
  const species = findSpecies(speciesId) ?? SPECIES[0];
  const personality = PERSONALITIES[species.personality] ?? PERSONALITIES.laidback;
  const specials = ['cookie', 'pudding', 'cake'];
  const pet = {
    id: `pet_${Math.floor(rng() * 1e9).toString(36)}`,
    speciesId: species.id,
    name: String(name).slice(0, 10),
    hatchedAt: now,
    stage: 'baby',
    stageChangedAt: now,
    careCount: 0,
    gauges: emptyGauges(),
    sleeping: false,
    lastTickAt: now,
    cooldowns: { food: 0, play: 0, pet: 0, bath: 0 },
    traits: {
      personality: personality.id,
      favoriteFood: specials[Math.floor(rng() * specials.length)],
      reaction: Math.round((personality.reaction * (0.9 + rng() * 0.2)) * 100) / 100,
      tempo: Math.round((personality.tempo * (0.9 + rng() * 0.2)) * 100) / 100,
    },
  };
  return pet;
}

/** 等確率で20種から選ぶ */
export function pickSpecies(rng = Math.random) {
  const index = Math.min(SPECIES.length - 1, Math.floor(rng() * SPECIES.length));
  return SPECIES[index].id;
}

/* ------------------------------------------------------------ 減衰・時間 */

/**
 * 閉じていた時間ぶんの たいりょく 回復量（内部小数のまま）。
 * 閉じている長さに上限は置かない（たいりょくは 100 で頭打ちになるため）。
 * 端末時計の巻き戻し（負の経過）・NaN / Infinity は回復 0（不正値をゲージに入れない）。
 */
function sleepRecoveryFor(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return (SLEEP_RECOVERY_PER_HOUR * elapsedMs) / 3600000;
}

/**
 * 起動中の時間経過を反映する（閉じていた間は減らさない）。
 * 起動直後（resume）は、寝かせたまま閉じていたときだけ たいりょく を回復する。
 * @returns {{pet:object, changed:boolean, suspended:boolean, elapsedMs:number}}
 */
export function tick(pet, now, { resume = false } = {}) {
  const last = Number(pet.lastTickAt) || now;

  // 起動直後（resume）: 閉じていた間は減らさない。
  // 寝かせたまま閉じていた場合だけ、閉じていた時間ぶん たいりょく を回復する
  // （睡眠中は他3ゲージが止まる仕様なので、それ以外は変化させない）。
  if (resume) {
    const elapsed = Number(now) - last;
    const gauges = normalizeGauges(pet.gauges);
    const recovery = pet.sleeping ? sleepRecoveryFor(elapsed) : 0;
    if (!(recovery > 0)) {
      return { pet: { ...pet, lastTickAt: now }, changed: false, suspended: true, elapsedMs: 0 };
    }
    const stamina = clampGauge(gauges.stamina + recovery);
    const changed = stamina !== gauges.stamina;
    return {
      pet: { ...pet, gauges: { ...gauges, stamina }, lastTickAt: now },
      changed,
      suspended: true,
      elapsedMs: elapsed,
    };
  }

  const raw = Number(now) - last;
  if (!Number.isFinite(raw) || raw <= 0) {
    return { pet: { ...pet, lastTickAt: now }, changed: false, suspended: false, elapsedMs: 0 };
  }

  const elapsed = Math.min(raw, MAX_TICK_STEP_MS);
  const suspended = raw > MAX_TICK_STEP_MS;

  const gauges = normalizeGauges(pet.gauges);
  const next = { ...gauges };

  if (pet.sleeping) {
    next.stamina = clampGauge(next.stamina + sleepRecoveryFor(elapsed));
  } else {
    for (const gauge of GAUGES) {
      const hoursTo50 = DECAY_HOURS_TO_50[gauge];
      const ratePerMs = 50 / (hoursTo50 * 3600000);
      next[gauge] = clampGauge(next[gauge] - ratePerMs * elapsed);
    }
  }

  const changed = GAUGES.some((gauge) => next[gauge] !== gauges[gauge]);
  return { pet: { ...pet, gauges: next, lastTickAt: now }, changed, suspended, elapsedMs: elapsed };
}

/** 睡眠の切り替え（タップで寝かせる／起こす） */
export function toggleSleep(pet, now) {
  const sleeping = !pet.sleeping;
  return {
    ...pet,
    sleeping,
    lastTickAt: now,
    sleepingSince: sleeping ? now : null,
  };
}

/** 孵化からの経過時間（時間単位・小数） */
export function ageHours(pet, now) {
  return Math.max(0, (now - pet.hatchedAt) / 3600000);
}

/* ------------------------------------------------------------ お世話 */

export function cooldownRemainingMs(pet, actionId, now) {
  const action = CARE_ACTIONS[actionId];
  if (!action || !action.cooldownMs) return 0;
  const until = Number(pet.cooldowns?.[actionId]) || 0;
  return Math.max(0, until - now);
}

/** 実行できるか（できない理由も返す） */
export function canCare(pet, actionId, now) {
  const action = CARE_ACTIONS[actionId];
  if (!action) return { ok: false, reason: 'unknown', message: 'その おせわは ありません' };
  if (actionId !== 'sleep' && pet.sleeping) {
    return { ok: false, reason: 'sleeping', message: 'いま ねています。おこしてから おせわしてね' };
  }
  const remainingMs = cooldownRemainingMs(pet, actionId, now);
  if (remainingMs > 0) {
    return { ok: false, reason: 'cooldown', remainingMs, message: `あと ${formatRemaining(remainingMs)} まってね` };
  }
  return { ok: true, remainingMs: 0 };
}

export function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}びょう`;
  return `${minutes}ふん${String(seconds).padStart(2, '0')}びょう`;
}

/**
 * お世話を実行する。
 * food のときは food（data/pets.js のエサ）を渡す。省略時は基本エサ。
 * @returns {{ok:boolean, pet:object, growth:boolean, effects:object, message:string, remainingMs:number}}
 */
export function applyCare(pet, actionId, { now, food = null } = {}) {
  const action = CARE_ACTIONS[actionId];
  const check = canCare(pet, actionId, now);
  if (!check.ok) return { ok: false, pet, growth: false, effects: {}, ...check };

  if (actionId === 'sleep') {
    return { ok: true, pet: toggleSleep(pet, now), growth: false, effects: {}, message: pet.sleeping ? 'おきたよ' : 'ねむったよ', remainingMs: 0 };
  }

  const before = normalizeGauges(pet.gauges);
  const effects = actionId === 'food' ? (food?.effects ?? CARE_ACTIONS.food.effects) : action.effects;
  const next = { ...before };
  for (const [gauge, amount] of Object.entries(effects)) {
    if (!GAUGES.includes(gauge)) continue;
    // 効果量は仕様どおり固定（個体差の reaction は表情・動きの表現に使う）
    next[gauge] = clampGauge(next[gauge] + amount);
  }

  // 対応するゲージが 80 未満のときだけ成長カウント
  const primary = action.gauge;
  const growth = Boolean(primary) && before[primary] < GROWTH_GAUGE_THRESHOLD;

  const updated = {
    ...pet,
    gauges: next,
    careCount: pet.careCount + (growth ? 1 : 0),
    lastTickAt: now,
    lastCareAt: now,
    lastCareAction: actionId,
    cooldowns: { ...pet.cooldowns, [actionId]: now + action.cooldownMs },
  };

  return {
    ok: true,
    pet: updated,
    growth,
    effects,
    message: growth ? `${action.label}したよ（そだち +1）` : `${action.label}したよ`,
    remainingMs: action.cooldownMs,
  };
}

/* ------------------------------------------------------------ 成長 */

/** 経過時間と有効なお世話回数から段階を求める（下がらない） */
export function stageFor(pet, now) {
  const hours = ageHours(pet, now);
  const care = Number(pet.careCount) || 0;
  let result = 'baby';
  for (const stage of STAGES) {
    if (hours >= stage.minHours && care >= stage.minCare) result = stage.id;
  }
  const currentIndex = STAGES.findIndex((stage) => stage.id === (pet.stage ?? 'baby'));
  const nextIndex = STAGES.findIndex((stage) => stage.id === result);
  return STAGES[Math.max(currentIndex, nextIndex, 0)].id;
}

/** 段階を更新する（上がったかを返す） */
export function updateStage(pet, now) {
  const nextStage = stageFor(pet, now);
  if (nextStage === pet.stage) return { pet, up: false, stage: pet.stage };
  return { pet: { ...pet, stage: nextStage, stageChangedAt: now }, up: true, stage: nextStage };
}

export function stageLabel(stageId) {
  return STAGES.find((stage) => stage.id === stageId)?.label ?? stageId;
}

export function stageIndex(stageId) {
  return Math.max(0, STAGES.findIndex((stage) => stage.id === stageId));
}

/** 次の段階までの目安（画面表示用） */
export function nextStageRequirement(pet, now) {
  const index = stageIndex(pet.stage);
  const next = STAGES[index + 1];
  if (!next) return null;
  const hours = ageHours(pet, now);
  return {
    stage: next.id,
    label: next.label,
    needHours: Math.max(0, next.minHours - hours),
    needCare: Math.max(0, next.minCare - (pet.careCount ?? 0)),
  };
}

/* ------------------------------------------------------------ 表情 */

/**
 * 表情は6段階。睡眠中は専用の表情。
 * happy / good / normal / tired / bad / sleep
 */
export function expression(pet) {
  if (pet.sleeping) return 'sleep';
  const gauges = normalizeGauges(pet.gauges);
  const average = GAUGES.reduce((sum, gauge) => sum + gauges[gauge], 0) / GAUGES.length;
  if (average >= 85) return 'happy';
  if (average >= 68) return 'good';
  if (average >= 52) return 'normal';
  if (average >= 36) return 'tired';
  return 'bad';
}

export const EXPRESSIONS = Object.freeze(['happy', 'good', 'normal', 'tired', 'bad', 'sleep']);

export const EXPRESSION_LABELS = Object.freeze({
  happy: 'ごきげん',
  good: 'いいかんじ',
  normal: 'ふつう',
  tired: 'おつかれ',
  bad: 'へとへと',
  sleep: 'すやぁ…',
});

export { findFood, findSpecies };
