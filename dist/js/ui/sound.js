/**
 * 音（BGM・効果音）を WebAudio で合成する。音源ファイルは使わない（外部通信なし）。
 * ブラウザの自動再生制限があるため、最初のタップで AudioContext を用意する。
 */

let context = null;
let masterGain = null;
let bgmTimer = null;
let bgmStep = 0;
const state = { bgm: true, se: true };

function ensureContext() {
  if (!context) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
    masterGain = context.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(context.destination);
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

/** 設定を反映する（読み込み直後にも呼ぶ） */
export function configure({ bgm, se }) {
  if (typeof bgm === 'boolean') state.bgm = bgm;
  if (typeof se === 'boolean') state.se = se;
  if (!state.bgm) stopBgm();
}

export function isBgmOn() {
  return state.bgm;
}

export function isSeOn() {
  return state.se;
}

function tone({ frequency, duration = 0.16, type = 'triangle', gain = 0.08, delay = 0, slideTo = null }) {
  const audio = ensureContext();
  if (!audio) return;
  const now = audio.currentTime + delay;
  const oscillator = audio.createOscillator();
  const envelope = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.02);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(envelope);
  envelope.connect(masterGain);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

/** 一致の音程（ペア数に応じて上げる。1→6ペアで 523→587→659→784→880→1047Hz） */
const MATCH_NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];

const SE = {
  tap: () => tone({ frequency: 660, duration: 0.08, type: 'square', gain: 0.05 }),
  /** そろった（2音の和音）。index は0始まり＝何ペア目か */
  match: (index = 0) => {
    const frequency = MATCH_NOTES[Math.min(MATCH_NOTES.length - 1, Math.max(0, Math.round(Number(index) || 0)))];
    // 基音＋完全5度で「そろった」感じを出す（6ペアまで上がる）
    tone({ frequency, duration: 0.16, type: 'triangle', gain: 0.075 });
    tone({ frequency: frequency * 1.5, duration: 0.18, type: 'triangle', gain: 0.05, delay: 0.015 });
  },
  /** ちがった（短い下降2音・error より控えめ） */
  miss: () => {
    tone({ frequency: 392, duration: 0.09, type: 'triangle', gain: 0.04 });
    tone({ frequency: 311, duration: 0.12, type: 'triangle', gain: 0.035, delay: 0.08 });
  },
  /**
   * パーフェクト（ミス0で全ペア・v32）。fanfare とは別の音にする:
   * キラキラ上がる5音 → 高い和音を伸ばす＋しずく2つ（2093 / 2637Hz）。
   */
  perfect: () => {
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((frequency, index) => {
      tone({ frequency, duration: 0.12, type: 'triangle', gain: 0.08, delay: index * 0.075 });
    });
    [1046.5, 1318.51, 1567.98].forEach((frequency, index) => {
      tone({ frequency, duration: 0.9, type: 'triangle', gain: 0.05, delay: 0.42 + index * 0.02 });
    });
    tone({ frequency: 2093, duration: 0.5, type: 'sine', gain: 0.045, delay: 0.46 });
    tone({ frequency: 2637, duration: 0.4, type: 'sine', gain: 0.03, delay: 0.6 });
  },
  /** のこり5秒のクリック（毎秒1回） */
  tick: () => tone({ frequency: 1245, duration: 0.045, type: 'square', gain: 0.032 }),
  /** ジャンプ（v34・上に跳ねる短い2音） */
  jump: () => {
    tone({ frequency: 523.25, duration: 0.07, type: 'square', gain: 0.04, slideTo: 784 });
    tone({ frequency: 1046.5, duration: 0.05, type: 'triangle', gain: 0.03, delay: 0.06 });
  },
  /** 障害物を1つよけた（v34・小気味よいポン） */
  pass: () => tone({ frequency: 987.77, duration: 0.045, type: 'triangle', gain: 0.03 }),
  /**
   * 石ころを取った（v36・低い2音の「ブブー」・約0.35秒）。
   * miss より低くて太い音にして「まちがえた」が伝わるようにする（SEオフなら鳴らない）。
   */
  buzzer: () => {
    tone({ frequency: 165, duration: 0.17, type: 'sawtooth', gain: 0.055 });
    tone({ frequency: 123.47, duration: 0.18, type: 'sawtooth', gain: 0.055, delay: 0.17 });
  },
  /** カウントダウンの合図（v36・「スタート！」の明るい2音） */
  start: () => {
    tone({ frequency: 783.99, duration: 0.09, type: 'square', gain: 0.05 });
    tone({ frequency: 1046.5, duration: 0.16, type: 'triangle', gain: 0.06, delay: 0.09 });
  },
  /**
   * リズムあそびの音階（v38・ドミソド）。周波数は `GAME_CONFIG.rhythm.notes` が持ち、
   * ここは鳴らすだけ（SEオフなら `playSe` が何もしない＝無音でもランプで追える）。
   */
  note: (frequency = 523.25) => {
    const value = Number(frequency);
    if (!Number.isFinite(value) || value <= 0) return;
    tone({ frequency: value, duration: 0.3, type: 'triangle', gain: 0.075 });
    tone({ frequency: value * 2, duration: 0.16, type: 'sine', gain: 0.03, delay: 0.01 });
  },
  care: () => {
    tone({ frequency: 523, duration: 0.1, gain: 0.07 });
    tone({ frequency: 784, duration: 0.12, gain: 0.06, delay: 0.07 });
  },
  coin: () => {
    tone({ frequency: 988, duration: 0.07, type: 'square', gain: 0.05 });
    tone({ frequency: 1319, duration: 0.09, type: 'square', gain: 0.045, delay: 0.06 });
  },
  hatch: () => {
    tone({ frequency: 392, duration: 0.12, gain: 0.07 });
    tone({ frequency: 523, duration: 0.12, gain: 0.07, delay: 0.1 });
    tone({ frequency: 784, duration: 0.2, gain: 0.07, delay: 0.2 });
  },
  fanfare: () => {
    // ファンファーレ風: 上昇アルペジオ → 明るい和音を伸ばす
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      tone({ frequency, duration: 0.18, type: 'triangle', gain: 0.085, delay: index * 0.11 });
    });
    [523.25, 659.25, 783.99].forEach((frequency) => {
      tone({ frequency, duration: 0.85, type: 'triangle', gain: 0.045, delay: 0.5 });
    });
    tone({ frequency: 1567.98, duration: 0.55, type: 'sine', gain: 0.05, delay: 0.52 });
    tone({ frequency: 1046.5, duration: 0.95, type: 'triangle', gain: 0.055, delay: 0.6 });
  },
  stage: () => {
    [523, 659, 784, 1047].forEach((frequency, index) => {
      tone({ frequency, duration: 0.16, gain: 0.07, delay: index * 0.09 });
    });
  },
  error: () => tone({ frequency: 220, duration: 0.18, type: 'sawtooth', gain: 0.05, slideTo: 160 }),
  /**
   * ずかんの なきごえ（v42）。種ごとのパラメータは `js/game/dex.js` の `cryParams()` が持ち、
   * ここは既存の `tone()` で鳴らすだけ（音源ファイル0・precache不要・新規通信なし）。
   * SEオフは `playSe` が早期 return するので無音。パラメータが壊れていても例外を投げない。
   */
  cry: (params = {}) => {
    const wave = ['square', 'triangle', 'sawtooth', 'sine'].includes(params.wave) ? params.wave : 'triangle';
    const base = Number(params.base);
    if (!Number.isFinite(base) || base <= 0) return;
    const count = Math.max(1, Math.min(6, Math.round(Number(params.notes)) || 1));
    const gap = Math.max(60, Math.min(300, Number(params.gap) || 120));
    const slide = Number(params.slide) || 0;
    for (let index = 0; index < count; index += 1) {
      const frequency = Math.max(120, base * (1 + (index % 2 === 1 ? 0.18 : 0)) + (index === count - 1 ? slide : 0));
      tone({
        frequency,
        duration: (gap / 1000) * 0.92,
        type: wave,
        gain: 0.07,
        delay: (index * gap) / 1000,
      });
    }
  },
};

export function playSe(name, ...args) {
  if (!state.se) return;
  const fn = SE[name];
  if (fn) fn(...args);
}

/** BGM: ゆるいペンタトニックのループ */
const BGM_NOTES = [523.25, 587.33, 659.25, 783.99, 880, 783.99, 659.25, 587.33];

export function startBgm() {
  if (bgmTimer || !state.bgm) return;
  const audio = ensureContext();
  if (!audio) return;
  bgmStep = 0;
  bgmTimer = setInterval(() => {
    if (!state.bgm) return;
    const note = BGM_NOTES[bgmStep % BGM_NOTES.length];
    tone({ frequency: note, duration: 0.5, type: 'sine', gain: 0.028 });
    if (bgmStep % 4 === 0) tone({ frequency: note / 2, duration: 0.7, type: 'sine', gain: 0.02 });
    bgmStep += 1;
  }, 620);
}

export function stopBgm() {
  if (bgmTimer) clearInterval(bgmTimer);
  bgmTimer = null;
}

export function setBgm(enabled) {
  state.bgm = Boolean(enabled);
  if (state.bgm) startBgm();
  else stopBgm();
}

export function setSe(enabled) {
  state.se = Boolean(enabled);
}

/** 最初のユーザー操作で呼ぶ（自動再生制限の解除とBGM開始） */
export function unlockAudio() {
  ensureContext();
  if (state.bgm) startBgm();
}
