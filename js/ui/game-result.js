/**
 * ミニゲームの**結果画面**（v34 で共通化）。神経衰弱・ごはんキャッチ・ジャンプチャレンジが
 * まったく同じ見た目・同じ挙動（＋Nまいのカウントアップ・上限の文言・抽選当選・もういちど）になる。
 *
 * 見た目: 「けっか」→ スコア → ＋Nまい（主役）→ のこり／上限の文言 → ボタン2つ。
 * 抽選の当選は結果より上に別格で出し、パーフェクト（神経衰弱だけ）は抽選の下に別枠で置く。
 *
 * 付与・上限・抽選・二重付与は `childStore.finishGame`（js/game/games.js）が済ませている。
 * ここは **result を描くだけ**（コインは増やさない）。
 */

import { findShopItem } from '../../data/shop.js';
import { paintFurniture, paintSurfaceSwatch } from './furniture-art.js';
import { drawHatThumb } from './pet-accessory.js';
import { el, clear, formatNumber, mount } from './dom.js';
import { playSe } from './sound.js';

/** パーフェクトの紙吹雪の枚数（装飾・操作は邪魔しない） */
const PERFECT_CONFETTI = 18;
/** 当たった商品のサムネ（ショップと同じ描き分け） */
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

function prizeThumb(item, size = 44) {
  const canvas = el('canvas', { class: 'game-prize__art' });
  if (item.surface) paintSurfaceSwatch(canvas, item, { size });
  else if (item.category === 'hat') drawHatThumb(canvas, item, { size });
  else paintFurniture(canvas, item, { maxWidth: size, maxHeight: size });
  return canvas;
}

/**
 * 結果画面を描く。
 * @param {HTMLElement} view 結果を入れる箱（中身は消して描き直す）
 * @param {object} options
 *   prefix: id の接頭辞（memory/catch/jump）。`#<prefix>Coins` などを出す
 *   scoreText: スコアの表示（例 '5ペア' '15こ' '20'）
 *   result: childStore.finishGame の戻り値（省略時は付与なしの表示）
 *   finale: カウントアップ後に鳴らす音を決める関数（score, granted, extra）=> void
 *   onAgain / onQuit: ボタンの動作
 */
export function renderGameResult(view, {
  prefix,
  score = 0,
  scoreText,
  result = null,
  onAgain = null,
  onQuit = null,
  finale = null,
} = {}) {
  clear(view);
  view.classList.add('game-result');
  const coins = result?.coins ?? {};
  const record = result?.result ?? {};
  const granted = Math.max(0, Number(record.coins) || 0);
  const capped = record.capped === true;
  const lottery = record.lottery ?? null;
  const perfect = record.perfect === true;
  const perfectCount = Math.max(0, Number(record.perfectCount) || 0);

  // 舞うコインは結果の後ろ（装飾）。上限のときは控えめに6枚
  const fxCount = capped ? 6 : 14;
  const fx = el('div', { class: 'game-result__fx', 'aria-hidden': 'true' },
    Array.from({ length: fxCount }, (_, index) => el('span', {
      class: 'game-result__fx-coin',
      text: '🪙',
      style: { left: `${(index * 13 + 6) % 96}%`, animationDelay: `${index * 70}ms` },
    }))
  );

  let prizeNode = null;
  if (lottery) {
    const item = findShopItem(lottery.itemId);
    const sparkle = (className) => el('span', {
      class: `game-prize__spark ${className}`, 'aria-hidden': 'true', text: '✨',
    });
    // 抽選は「別格」＝結果より上に出す（未所持は見出し＋絵＋キラキラ、所持済みは +10/+30）
    prizeNode = el('div', {
      class: `game-prize game-prize--top${lottery.owned ? ' game-prize--dupe' : ' game-prize--new'}`,
      id: `${prefix}Prize`,
      dataset: { item: lottery.itemId, owned: lottery.owned ? 'true' : 'false' },
    }, [
      el('p', { class: 'game-prize__lead', text: lottery.owned ? 'もっていたので' : 'あたらしい かぐ！' }),
      lottery.owned || !item ? null : prizeThumb(item, 46),
      el('p', { class: 'game-prize__name', text: lottery.name }),
      el('p', {
        class: 'game-prize__note',
        text: lottery.owned
          ? `＋${formatNumber(lottery.coins ?? 0)}まい に かえたよ（上限の そと）`
          : 'もちものに はいったよ',
      }),
      sparkle('game-prize__spark--a'),
      sparkle('game-prize__spark--b'),
      lottery.owned ? null : sparkle('game-prize__spark--c'),
    ]);
  }

  // パーフェクト（ミス0で全ペア＝神経衰弱だけ）の特別演出。**抽選当選の下**に別枠で置き、重ねない
  const perfectNode = perfect
    ? el('div', {
      class: 'game-result__perfect',
      id: `${prefix}Perfect`,
      role: 'status',
      'aria-label': 'パーフェクト！ ミス ゼロ',
      dataset: { count: String(perfectCount) },
    }, [
      el('div', { class: 'game-result__perfect-band' }, [
        el('p', { class: 'game-result__perfect-title', text: 'パーフェクト！' }),
        el('p', { class: 'game-result__perfect-sub', text: 'ミス ゼロ' }),
      ]),
      el('p', {
        class: 'game-result__perfect-count',
        id: `${prefix}PerfectCount`,
        text: `パーフェクト ${formatNumber(perfectCount)}かい目`,
      }),
    ])
    : null;

  // 紙吹雪は結果画面ぜんたいに降らせる（装飾・操作を邪魔しない）
  const confettiNode = perfect
    ? el('div', { class: 'game-result__confetti', 'aria-hidden': 'true' },
      Array.from({ length: PERFECT_CONFETTI }, (_, index) => el('span', {
        class: 'game-result__confetti-bit',
        style: {
          left: `${(index * 37 + 9) % 94}%`,
          animationDelay: `${(index % 6) * 90}ms`,
          animationDuration: `${1200 + (index % 4) * 160}ms`,
        },
      }))
    )
    : null;

  const coinNumber = el('span', { class: 'game-result__coin-number', text: '＋0' });
  const coinNode = el('p', {
    class: 'game-result__result-coins',
    id: `${prefix}Coins`,
    dataset: { capped: capped ? 'true' : 'false', granted: String(granted), counting: 'false' },
  }, [
    coinNumber,
    el('span', { class: 'game-result__coin-unit', text: 'まい' }),
  ]);
  // 読み上げは最終値で1回（カウントアップの途中を読ませない）
  coinNode.setAttribute('aria-label', `コイン ${formatNumber(granted)}まい`);

  mount(
    view,
    fx,
    confettiNode,
    prizeNode,
    perfectNode,
    el('p', { class: 'game-result__label', text: 'けっか' }),
    el('p', { class: 'game-result__score', id: `${prefix}Score`, text: scoreText ?? String(score) }),
    coinNode,
    el('p', {
      class: 'game-result__note',
      id: `${prefix}Note`,
      dataset: { capped: capped ? 'true' : 'false' },
      text: capped
        ? 'きょうは ここまで（ゲームは まだ あそべるよ／あした また コインが もらえるよ）'
        : `のこり 🪙 ${formatNumber(coins.balance ?? 0)}まい`,
    }),
    el('div', { class: 'game-result__actions' }, [
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        id: `${prefix}Again`,
        text: 'もういちど',
        onclick: onAgain ? onAgain : null,
      }),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        id: `${prefix}Quit`,
        text: 'おわる',
        onclick: onQuit ? onQuit : null,
      }),
    ])
  );

  // 抽選は別格（未所持＝fanfare）。所持済みはコインの音（下の playSe('coin')）で足りる
  const prizeFanfare = Boolean(lottery && !lottery.owned);
  if (prizeFanfare) playSe('fanfare');

  // カウントアップの始まりに coin（獲得0のときは鳴らさない）
  if (granted > 0) playSe('coin');

  /** カウントアップの完了（終了の音はここで1回） */
  const settle = () => {
    coinNumber.textContent = `＋${formatNumber(granted)}`;
    coinNode.dataset.counting = 'false';
    if (finale) {
      finale({ score, granted, capped, lottery, perfect, prizeFanfare });
      return;
    }
    if (prizeFanfare) return; // 当選（未所持）の fanfare を先に鳴らしている
    if (granted > 0) playSe('stage');
  };

  const duration = 650;
  if (granted <= 0 || reducedMotion()) {
    settle();
    return { settle };
  }
  // setInterval で数える（テストの時計送りでも必ず最後まで進む）
  coinNode.dataset.counting = 'true';
  const started = Date.now();
  const countTimer = window.setInterval(() => {
    if (!coinNode.isConnected) {
      window.clearInterval(countTimer);
      return;
    }
    const ratio = Math.min(1, (Date.now() - started) / duration);
    const eased = 1 - (1 - ratio) ** 3;
    coinNumber.textContent = `＋${Math.round(granted * eased)}`;
    if (ratio >= 1) {
      window.clearInterval(countTimer);
      settle();
    }
  }, 45);
  return { settle };
}

/**
 * アーケード（キャッチ／ジャンプ）の終了音。取れた数・よけた数に応じて変える。
 * - 高得点（報酬5以上）＝fanfare、そこそこ（3以上）＝stage、それ以外＝coin
 * （神経衰弱はパーフェクトの専用SEがあるので、games.js 側で自前の finale を渡す）
 */
export function arcadeFinale({ score, granted, prizeFanfare }) {
  if (prizeFanfare) return;
  if (score >= 10) playSe('fanfare');
  else if (score >= 5) playSe('stage');
  else if (granted === 0) playSe('coin');
}
