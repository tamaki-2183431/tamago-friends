/**
 * ミニゲーム（Phase 3-3）。
 *
 * - 部屋の下の帯「あそぶ」から開く一覧シート（5枚のカード）
 * - **パスA**: ペット神経衰弱。**パスB（v34）**: ごはんキャッチ・ジャンプチャレンジ
 * - 遊び終わると 成績 → コイン（1日30枚まで・5ゲーム共通）→ 抽選 → 結果画面
 * - 夜間（22:00〜06:59）は入口が無効。**プレイ中に22時を跨いだら結果画面まで遊ばせ**、
 *   次のプレイ（もういちど）から不可にする（判定は既存の isNightRest）
 *
 * 数値（枚数・秒数・戻す時間・報酬表・難易度の段）は data/games.js の GAME_CONFIG だけを見る。
 * 報酬・上限・抽選の計算は js/game/games.js、アーケードの判定は js/game/arcade.js の純関数。
 * 結果画面は js/ui/game-result.js（3ゲーム共通）。ここは画面と入力だけ。
 *
 * v28: 30秒・8枚（4ペア・4×2）／SE（めくる・一致・不一致・残り5秒・終了）／
 * めくる弾み・一致の光と💛・不一致の揺れ・連続一致の文字・残り5秒の赤字／
 * 結果画面は「＋Nまい」を主役にカウントアップ＋コインの舞、抽選当選は結果の上に別格で出す。
 *
 * v32: 30秒・**12枚（6ペア・4×3）**に戻す（報酬 1/3/5/7）。加えて
 * **パーフェクト（ミス0で6ペア）**の特別演出＝金/虹の帯・紙吹雪・カードが一斉に光る・専用SE `perfect`。
 *
 * v34: **ごはんキャッチ（30秒）**と**ジャンプチャレンジ（40秒）**を追加。
 * - キャッチ: 上から食べものが落ちる。タップで取る。時間経過で落下速度と出現量が上がる（3段）
 * - ジャンプ: 自動で横に進み、タップでジャンプ。ぶつかっても **終了せず -1**（0.8秒の無敵）で続行
 * - どちらも 1プレイ=1 playId で `finishGame` を通す（二重付与なし・30上限は5ゲーム共通）
 *
 * v36:
 * - **3ゲーム共通の「よーい…スタート！」**（`js/ui/countdown.js` の `runCountdown()`）。
 *   1.5秒の演出中は操作を受け付けず、残り時間も減らさない（タイマーは演出後に開始）
 * - ごはんキャッチ: 石ころを取ったら **buzzer＋横揺れ＋赤フラッシュ＋「−1」＋破片**
 * - ジャンプ: 空中時間が速さに連動（横クリア約110px・高さ66px）／カラスは52〜62pxの帯
 *
 * v37:
 * - **結果画面・プレイ中の✕は「ゲームだけ」閉じる**（一覧シートは開いたまま・スクロール位置もそのまま）。
 *   戻ったときに一覧の**コイン残高と「きょう あと Nまい」**を今の台帳で描き直す（`listSummaryText()`）。
 *   プレイ中の✕は時間切れと同じ扱い＝`finishGame` を呼ばない（付与も抽選もなし）。
 * - **「おわる」だけがゲームと一覧の両方を閉じて部屋へ戻る**（`onQuitAll`）。
 */

import * as childStore from '../store/child.js';
import { GAME_CONFIG, GAMES } from '../../data/games.js';
import { SPECIES } from '../../data/pets.js';
import { findShopItem } from '../../data/shop.js';
import { buildMemoryDeck, isPerfectClear, memoryCardsMatch, ownedSpeciesOf } from '../game/games.js';
import {
  catchScore,
  createCatchRun,
  createJumpRun,
  jumpRunScore,
  stepCatch,
  stepJump,
  tapCatch,
  triggerJump,
} from '../game/arcade.js';
import {
  buildSearchPets,
  createSearchRun,
  currentSearchTarget,
  searchLocked,
  searchPetCount,
  searchScore,
  stepSearch,
  tapSearch,
} from '../game/search.js';
import {
  createRhythmRun,
  rhythmScore,
  stepRhythm,
  tapRhythm,
} from '../game/rhythm.js';
import { NIGHT_GAME_TEXT, isNightRest } from '../game/night.js';
import { CROW_ART_GAP_ROWS, FOOD_LABELS, drawCrow, drawFood, drawObstacle } from './food-art.js';
import { paintFurniture } from './furniture-art.js';
import { drawPet } from './pet-sprite.js';
import { arcadeFinale, renderGameResult } from './game-result.js';
import { runCountdown } from './countdown.js';
import { clear, el, formatNumber, guarded, mount, openSheet, toast } from './dom.js';
import { lockGameZoom } from './game-zoom.js';
import { playSe } from './sound.js';

/** プレイIDの連番（同じミリ秒に始めても衝突させない） */
let playSerial = 0;

function newPlayId(gameId) {
  playSerial += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${gameId}-${Date.now().toString(36)}-${playSerial.toString(36)}-${random}`;
}

function speciesOf(speciesId) {
  return SPECIES.find((species) => species.id === speciesId) ?? SPECIES[0];
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

/**
 * v40: ゲームのシートを開く（全ゲーム共通）。開いている間だけ画面の拡大を止め、
 * 閉じたら必ず解除する（`js/ui/game-zoom.js`）。今後のゲームもこの関数を使う。
 */
function openGameSheet(options) {
  let releaseZoom = null;
  const sheet = openSheet({
    ...options,
    onClose: () => {
      try {
        options.onClose?.();
      } finally {
        releaseZoom?.();
      }
    },
  });
  releaseZoom = lockGameZoom(sheet.root);
  return sheet;
}

/** パーフェクトでカードが一斉に光る時間（結果画面を出す前にひと呼吸おく） */
const PERFECT_GLOW_MS = 560;

/**
 * 一覧シートの見出し（コイン残高・「きょう あと Nまい」）の文言。
 * **初回の描画も、結果画面から戻ったときの描き直しも同じ1か所**（v37）。
 * 上限（きょう 30まい）に届いたら既存の文言「きょうは ここまで（ゲームは あそべるよ）」。
 */
function listSummaryText(coins) {
  const remaining = Math.max(0, Number(coins?.gameRemaining) || 0);
  return {
    balance: `🪙 ${formatNumber(coins?.balance ?? 0)}まい`,
    rest: remaining > 0
      ? `きょう あと ${formatNumber(remaining)}まい もらえるよ`
      : 'きょうは ここまで（ゲームは あそべるよ）',
  };
}

/* ------------------------------------------------------------ 一覧シート */

/**
 * ゲーム一覧を開く。
 * @param {{onChanged?: (room:object)=>void, rng?: () => number, lotteryChance?: number}} options
 *   rng は抽選・山札・アーケードの乱数（省略時は Math.random）。テストで固定するための入口。
 *   lotteryChance も**テスト用の入口**（省略時は data/games.js の LOTTERY_CHANCE）。
 */
export async function openGamesSheet({ onChanged = null, rng = Math.random, lotteryChance } = {}) {
  const coins = await childStore.getCoins();
  let listSheet = null;
  const initial = listSummaryText(coins);
  const balanceNode = el('p', { class: 'game-list__balance', id: 'gameBalance', text: initial.balance });
  const restNode = el('p', { class: 'game-list__rest', id: 'gameRest', text: initial.rest });

  /**
   * 一覧の見出しを**いまの台帳**で描き直す（v37: 結果画面の✕で一覧に戻ったとき）。
   * 残高と「きょう あと Nまい」を再計算し、上限なら既存の文言へ切り替える。
   * 一覧そのもの（カード・スクロール位置）は作り直さない＝同じノードの文字だけ差し替える。
   */
  async function refreshListSummary() {
    if (!balanceNode.isConnected) return;
    let latest = null;
    try {
      latest = await childStore.getCoins();
    } catch (error) {
      console.error(error);
      return;
    }
    // 待っている間に一覧が閉じられていたら何もしない
    if (!balanceNode.isConnected || !restNode.isConnected) return;
    const text = listSummaryText(latest);
    balanceNode.textContent = text.balance;
    restNode.textContent = text.rest;
  }

  const start = (gameId) => {
    // 入口と同じ判定（夜は始めない）。プレイ中に22時を跨いだ場合は結果まで遊べる
    if (isNightRest(Date.now())) {
      toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2600 });
      return;
    }
    const shared = {
      rng,
      lotteryChance,
      onChanged: (room) => {
        if (room) onChanged?.(room);
      },
      // ✕（結果画面・プレイ中とも）: **ゲームだけ**閉じて一覧に戻る（v37）。
      // 一覧は開いたまま・スクロール位置もそのまま・見出しだけ今の台帳で描き直す
      onClose: () => {
        void refreshListSummary();
      },
      // 「おわる」: 従来どおりゲームと一覧の両方を閉じて部屋へ戻る（v37）
      onQuitAll: () => {
        listSheet?.close();
      },
    };
    if (gameId === 'memory') void openMemoryGame(shared);
    else if (gameId === 'catch') void openCatchGame(shared);
    else if (gameId === 'jump') void openJumpGame(shared);
    else if (gameId === 'search') void openSearchGame(shared);
    else if (gameId === 'rhythm') void openRhythmGame(shared);
  };

  const readyCount = GAMES.filter((game) => game.ready === true).length;
  const cards = GAMES.map((game) => {
    const ready = game.ready === true;
    return el('article', { class: `game-card${ready ? '' : ' game-card--soon'}`, dataset: { game: game.id } }, [
      el('div', { class: 'game-card__head' }, [
        el('p', { class: 'game-card__name', text: game.name }),
        el('span', { class: 'game-card__time', text: `⏱ ${game.duration}` }),
      ]),
      el('p', { class: 'game-card__blurb', text: game.blurb }),
      el('div', { class: 'game-card__foot' }, [
        el('span', {
          class: `game-card__state${ready ? ' game-card__state--ready' : ''}`,
          dataset: { state: ready ? 'ready' : 'soon' },
          text: ready ? 'あそべる' : 'これから',
        }),
        ready
          ? el('button', {
            class: 'btn btn--primary btn--small game-card__action',
            type: 'button',
            id: `gameStart-${game.id}`,
            text: 'あそぶ',
            'aria-label': `${game.name}を あそぶ`,
            onclick: guarded(() => start(game.id)),
          })
          : el('button', {
            class: 'btn btn--ghost btn--small game-card__action',
            type: 'button',
            id: `gameStart-${game.id}`,
            text: 'これから',
            disabled: true,
          }),
      ]),
    ]);
  });

  listSheet = openSheet({
    title: 'あそぶ',
    description: 'ミニゲームで あそぶと コインが もらえるよ（1日 30まいまで）。',
    content: el('div', { class: 'game-list' }, [
      el('div', { class: 'game-list__head' }, [balanceNode, restNode]),
      ...cards,
      el('p', {
        class: 'game-list__note muted small',
        text: readyCount === GAMES.length
          ? `${readyCount}つの ゲームで あそべるよ。`
          : `${readyCount}つの ゲームで あそべるよ。ほかは これから ふえるよ。`,
      }),
    ]),
  });
  return listSheet;
}

/* ------------------------------------------------------------ ペット神経衰弱 */

/**
 * 神経衰弱を開く（1プレイ・もういちど で同じシート内をやり直す）。
 * @param {{onChanged?: (room:object|null)=>void, onClose?: () => void, onQuitAll?: () => void, rng?: () => number, lotteryChance?: number}} options
 *   onClose は ✕（ゲームだけ閉じる）・onQuitAll は「おわる」（一覧も閉じる）。v37
 */
export async function openMemoryGame({ onChanged = null, onClose = null, onQuitAll = null, rng = Math.random, lotteryChance } = {}) {
  const config = GAME_CONFIG.memory;
  const pairs = config.pairs;
  const pets = await childStore.listPets();
  const ownedSpecies = ownedSpeciesOf(pets);

  const view = el('div', { class: 'memory' });
  let timer = null;
  /** いま出ている「よーい…スタート！」（やり直し・閉じるで片付ける） */
  let countdown = null;
  const sheet = openGameSheet({
    title: 'ペット しんけいすいじゃく',
    description: `おなじ ペットの カードを 2まい めくって そろえよう（${config.seconds}びょう）。`,
    content: view,
    onClose: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      countdown?.cancel();
      countdown = null;
      onClose?.();
    },
  });

  /** 1プレイぶんの状態（もういちど で作り直す） */
  function play() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    countdown?.cancel();
    countdown = null;
    clear(view);
    view.classList.remove('game-result');

    const deck = buildMemoryDeck({ ownedSpecies, rng, pairs });
    const playId = newPlayId('memory');
    /** 終了時刻（カウントダウンが終わってから決める＝演出中に残り時間を減らさない・v36） */
    let endsAt = null;
    /** カウントダウン中はカードをめくれない（v36） */
    let started = false;
    const matched = new Set();
    /** 後片付けするタイマー（終了・やり直しで止める） */
    const timeouts = new Set();
    let open = [];
    let lock = false;
    let ended = false;
    let found = 0;
    /** 連続一致の数（不一致で0に戻る。スコアはペア数のまま） */
    let combo = 0;
    /** このプレイの不一致（ミス）回数。0のまま全ペアなら パーフェクト（v32） */
    let misses = 0;
    /** 最後に tick を鳴らした残り秒（毎秒1回にする） */
    let lastTickSecond = null;

    const later = (fn, ms) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        if (!ended) fn();
      }, ms);
      timeouts.add(id);
      return id;
    };

    const timeLabel = el('p', { class: 'memory__stat', id: 'memoryTime', text: `のこり ${config.seconds}びょう` });
    const foundLabel = el('p', { class: 'memory__stat memory__stat--score', id: 'memoryFound', text: `0 / ${pairs}ペア` });
    const help = el('p', { class: 'memory__help muted small', id: 'memoryHelp', text: 'おなじ ペットの カードを 2まい えらんでね' });
    const board = el('div', {
      class: 'memory__board',
      id: 'memoryBoard',
      role: 'group',
      'aria-label': 'カード',
      style: { gridTemplateColumns: `repeat(${config.cols}, minmax(0, 1fr))` },
    });
    const comboLabel = el('p', { class: 'memory__combo', id: 'memoryCombo', 'aria-live': 'polite' });
    const stage = el('div', { class: 'memory__stage' }, [board, comboLabel]);

    /** カード1枚（おもて＝既存の24×24 のペット絵。新規アートは作らない） */
    function cardNode(card, index) {
      const canvas = el('canvas', { class: 'memory-card__face' });
      drawPet(canvas, speciesOf(card.speciesId), { size: 60, stage: 'child', expression: 'normal' });
      return el('button', {
        class: 'memory-card',
        type: 'button',
        dataset: { key: card.key, species: card.speciesId, index: String(index), label: `カード ${index + 1}` },
        'aria-label': `カード ${index + 1}`,
        'aria-pressed': 'false',
        onclick: guarded(() => flip(card)),
      }, [
        el('span', { class: 'memory-card__back', 'aria-hidden': 'true' }, [
          el('span', { class: 'memory-card__mark', text: '🥚' }),
        ]),
        el('span', { class: 'memory-card__front' }, [canvas]),
      ]);
    }

    const nodes = deck.map((card, index) => cardNode(card, index));
    for (const node of nodes) board.append(node);
    mount(view, el('div', { class: 'memory__bar' }, [timeLabel, foundLabel]), stage, help);

    const nodeOf = (key) => nodes.find((node) => node.dataset.key === key) ?? null;

    function showOpen() {
      for (const node of nodes) {
        const key = node.dataset.key;
        const faceUp = open.includes(key) || matched.has(key);
        node.classList.toggle('memory-card--open', faceUp);
        node.classList.toggle('memory-card--matched', matched.has(key));
        node.setAttribute('aria-pressed', faceUp ? 'true' : 'false');
        const suffix = matched.has(key) ? '（そろった）' : faceUp ? '（おもて）' : '';
        node.setAttribute('aria-label', `${node.dataset.label}${suffix}`);
      }
    }

    /**
     * 22:00（ねる じかん）になったら **その場で打ち切って結果画面**にする（PM 判断 2026-10-29）。
     * - 残り時間は待たない（22:00 の時点で終了）。獲得済みのペアの報酬はそのまま付与する
     * - 判定は既存の `isNightRest` だけを使う（新しい時刻判定は作らない）
     */
    function nightReached() {
      return !ended && isNightRest(Date.now());
    }

    function tick() {
      if (ended || !started || endsAt === null) return;
      if (nightReached()) {
        void finish();
        return;
      }
      const left = Math.max(0, endsAt - Date.now());
      const secondsLeft = Math.ceil(left / 1000);
      timeLabel.textContent = `のこり ${secondsLeft}びょう`;
      // 残り5秒は赤字＋毎秒1回のクリック音（4,3,2,1 と1回ずつ）
      const urgent = left > 0 && secondsLeft <= 5;
      timeLabel.classList.toggle('memory__stat--urgent', urgent);
      if (urgent && secondsLeft !== lastTickSecond) {
        lastTickSecond = secondsLeft;
        playSe('tick');
      }
      if (left <= 0) void finish();
    }

    /** 一致したカードに💛を2〜3個ふわっと出す */
    function showHearts(keys) {
      const count = found % 2 === 0 ? 2 : 3;
      for (const key of keys) {
        const node = nodeOf(key);
        if (!node) continue;
        for (let index = 0; index < count; index += 1) {
          const heart = el('span', {
            class: 'memory-card__heart',
            'aria-hidden': 'true',
            text: '💛',
            style: { left: `${28 + index * 20}%`, animationDelay: `${index * 90}ms` },
          });
          node.append(heart);
          later(() => heart.remove(), 1000);
        }
      }
    }

    /** 連続一致（2連続以上）の小さな文字 */
    function showCombo(value) {
      comboLabel.textContent = `${value}れんぞく！`;
      comboLabel.classList.remove('memory__combo--in');
      // クラスを付け直してアニメを最初から再生する
      void comboLabel.offsetWidth;
      comboLabel.classList.add('memory__combo--in');
      later(() => {
        comboLabel.classList.remove('memory__combo--in');
        comboLabel.textContent = '';
      }, 1200);
    }

    function bump(node) {
      if (!node) return;
      node.classList.add('memory-card--bump');
      later(() => node.classList.remove('memory-card--bump'), 300);
    }

    function shake(keys) {
      for (const key of keys) {
        const node = nodeOf(key);
        if (!node) continue;
        node.classList.add('memory-card--miss');
        later(() => node.classList.remove('memory-card--miss'), 420);
      }
    }

    function flip(card) {
      if (ended || lock || !started) return;
      // 22:00 を跨いだ直後（次の tick まで）のタップも、その場で結果へ
      if (nightReached()) {
        void finish();
        return;
      }
      const key = card.key;
      if (matched.has(key) || open.includes(key)) return;
      open.push(key);
      showOpen();
      playSe('tap');
      bump(nodeOf(key));
      if (Date.now() >= endsAt) {
        void finish();
        return;
      }
      if (open.length < 2) return;

      const [first, second] = open.map((row) => deck.find((entry) => entry.key === row));
      if (memoryCardsMatch(first, second)) {
        matched.add(first.key);
        matched.add(second.key);
        found += 1;
        combo += 1;
        open = [];
        foundLabel.textContent = `${found} / ${pairs}ペア`;
        showOpen();
        // ペア数に応じて音程が上がる（1→4ペアで 523→1047Hz）
        playSe('match', found - 1);
        showHearts([first.key, second.key]);
        if (combo >= 2) showCombo(combo);
        if (found >= pairs) void finish();
        return;
      }
      // 不一致は config.flipBackMs（1.2秒）だけ見せてから戻す
      lock = true;
      combo = 0;
      misses += 1;
      help.textContent = 'ちがう ペットだったね';
      playSe('miss');
      shake(open);
      window.setTimeout(() => {
        if (ended) return;
        open = [];
        lock = false;
        help.textContent = 'おなじ ペットの カードを 2まい えらんでね';
        showOpen();
      }, config.flipBackMs);
    }

    /** 終了 → 付与（1プレイ1回）→ 抽選の結果を表示 */
    async function finish() {
      if (ended) return;
      ended = true;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      lock = true;
      for (const id of timeouts) window.clearTimeout(id);
      timeouts.clear();
      const score = found;
      // パーフェクト＝ミス0で全ペア（時間切れ・未コンプリートは対象外）。判定は純関数1か所
      const perfect = isPerfectClear('memory', { score, misses });
      // カードが一斉に光る（結果を出す前にひと呼吸。reduced-motion では動かさない）
      if (perfect) {
        view.classList.add('memory--perfect');
        for (const node of nodes) node.classList.add('memory-card--perfect');
      }
      const result = await childStore.finishGame({ gameId: 'memory', score, playId, rng, lotteryChance, perfect });
      onChanged?.(result?.room ?? null);
      if (perfect && !reducedMotion()) {
        await new Promise((resolve) => { window.setTimeout(resolve, PERFECT_GLOW_MS); });
        // 光っている間にシートを閉じられたら、結果は出さない
        if (!view.isConnected) return;
      }
      renderResult(result, score);
    }

    /** 結果画面（＋Nまいが主役・抽選は上に別格・もういちど／おわる） */
    function renderResult(result, score) {
      renderGameResult(view, {
        prefix: 'memory',
        score,
        scoreText: `${score}ペア`,
        result,
        onAgain: guarded(() => {
          // 22時を跨いでいても結果画面までは遊べる。**次のプレイから**不可
          if (isNightRest(Date.now())) {
            toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2800 });
            return;
          }
          play();
        }),
        // おわる: ゲームと一覧の 両方 を閉じて部屋へ（✕ は一覧を残す・v37）
        onQuit: () => {
          sheet.close();
          onQuitAll?.();
        },
        // パーフェクトは専用SE。当選の fanfare と重ならないよう、当選があるときだけ遅らせる
        finale: ({ score: value, granted, perfect, prizeFanfare }) => {
          if (perfect) {
            if (!prizeFanfare) {
              playSe('perfect');
              return;
            }
            window.setTimeout(() => {
              if (view.isConnected) playSe('perfect');
            }, 900);
            return;
          }
          if (prizeFanfare) return;
          if (value >= 4) playSe('fanfare');
          else if (value >= 2) playSe('stage');
          else if (granted === 0) playSe('coin');
        },
      });
    }

    showOpen();
    // 0.8秒「よーい…」→ 0.7秒「スタート！」。この間はカードをめくれず、残り時間も減らない（v36）
    countdown = runCountdown(view, {
      onStart: () => {
        if (ended) return;
        started = true;
        endsAt = Date.now() + config.seconds * 1000;
        tick();
        timer = window.setInterval(tick, 200);
      },
    });
  }

  play();
  return sheet;
}

/* ------------------------------------------------------------ アーケード共通 */

/** 残り時間の表示（毎フレーム同じ文字なら書き換えない） */
function setTimeLabel(node, run, now) {
  const left = Math.max(0, Math.ceil((run.endsAt - now) / 1000));
  const text = `のこり ${left}びょう`;
  if (node.textContent !== text) node.textContent = text;
}

/** 秒数→「のこり Nびょう」の初期表示 */
const timeText = (seconds) => `のこり ${seconds}びょう`;

/* ------------------------------------------------------------ ごはんキャッチ */

/**
 * ごはんキャッチを開く（1プレイ・もういちど で同じシート内をやり直す）。
 * 上から落ちてくる食べものをタップで取る。取れなければ床に落ちて消える。
 * スコア＝取った数。時間経過で落下速度と出現量が上がる（GAME_CONFIG.catch）。
 */
export async function openCatchGame({ onChanged = null, onClose = null, onQuitAll = null, rng = Math.random, lotteryChance } = {}) {
  const config = GAME_CONFIG.catch;
  const view = el('div', { class: 'arcade arcade--catch' });
  let timer = null;
  /** いま出ている「よーい…スタート！」（やり直し・閉じるで片付ける） */
  let countdown = null;

  const sheet = openGameSheet({
    title: 'ごはん キャッチ',
    description: `おちてくる たべものを タップして あつめよう（${config.seconds}びょう）。`,
    content: view,
    onClose: () => {
      stop();
      countdown?.cancel();
      countdown = null;
      onClose?.();
    },
  });

  function stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  function play() {
    stop();
    countdown?.cancel();
    countdown = null;
    clear(view);
    view.classList.remove('game-result');

    const playId = newPlayId('catch');
    let ended = false;
    /** カウントダウン中は操作を受け付けない（タイマーもまだ動かない） */
    let locked = true;
    /** 1プレイぶんの状態（カウントダウンが終わってから作る＝残り時間を減らさない） */
    let run = null;
    const timeLabel = el('p', { class: 'arcade__stat', id: 'catchTime', text: timeText(config.seconds) });
    const scoreLabel = el('p', { class: 'arcade__stat arcade__stat--score', id: 'catchNow', text: '0こ' });
    const help = el('p', { class: 'arcade__help muted small', id: 'catchHelp', text: 'おちてくる たべものを タップしてね（いしころは さわらないでね）' });
    const field = el('div', {
      class: 'arcade__field arcade__field--catch',
      id: 'catchField',
      role: 'group',
      'aria-label': 'おちてくる たべもの',
    });
    mount(view, el('div', { class: 'arcade__bar' }, [timeLabel, scoreLabel]), field, help);

    const rect = field.getBoundingClientRect();

    /** 画面の食べもの（id → button） */
    const nodes = new Map();
    /** 逃した音は控えめに（連続で鳴らしすぎない） */
    let lastMissSe = 0;

    function addItem(item) {
      if (!item) return;
      const canvas = el('canvas', { class: 'catch-item__art' });
      drawFood(canvas, item.foodId, { size: config.itemPx - 6 });
      const node = el('button', {
        class: `catch-item${item.rock ? ' catch-item--rock' : ''}`,
        type: 'button',
        dataset: { id: item.id, food: item.foodId, rock: item.rock ? 'true' : 'false' },
        'aria-label': FOOD_LABELS[item.foodId] ?? 'たべもの',
        style: {
          width: `${config.itemPx}px`,
          height: `${config.itemPx}px`,
          transform: `translate3d(${item.x}px, ${item.y}px, 0)`,
        },
        // ボタン自体を押しても、フィールドのタップでも同じ結果にする（v35）
        onclick: guarded(() => take(item.id)),
      }, [canvas]);
      field.append(node);
      nodes.set(item.id, node);
    }

    /**
     * **石ころを取ったときの演出（v36）**。取った瞬間に
     * 赤いフラッシュ（0.25秒・不透明度0.18）＋「−1」（石の位置・0.7秒）＋
     * フィールド全体の横揺れ（振幅6px・0.3秒）＋石が砕けて小片が飛ぶ（0.3秒）。
     * reduced-motion では **揺れと小片を出さず**、フラッシュと「−1」だけ残す。
     * 数値は data/games.js の GAME_CONFIG.catch.penalty の1か所。
     */
    function showRockPenalty(item) {
      const penalty = config.penalty ?? {};
      const cx = item.x + item.w / 2;
      const cy = item.y + item.h / 2;

      // 赤いフラッシュ（reduced-motion でも出す）
      const flash = el('span', { class: 'arcade__flash', 'aria-hidden': 'true' });
      flash.style.setProperty('--flash-ms', `${penalty.flashMs}ms`);
      flash.style.setProperty('--flash-opacity', String(penalty.flashOpacity));
      field.append(flash);
      window.setTimeout(() => flash.remove(), penalty.flashMs);

      // 石の位置に「−1」（0.7秒で消える）
      const minus = el('span', { class: 'catch-minus', 'aria-hidden': 'true', text: '−1' });
      minus.style.left = `${cx}px`;
      minus.style.top = `${cy}px`;
      minus.style.setProperty('--minus-ms', `${penalty.minusMs}ms`);
      field.append(minus);
      window.setTimeout(() => minus.remove(), penalty.minusMs);

      if (reducedMotion()) return; // 揺れ・小片は動かさない（フラッシュと −1 だけ）

      // フィールド全体を横に揺らす（振幅6px・0.3秒）
      field.classList.remove('arcade--shake');
      void field.offsetWidth; // 連続で石を取ってもアニメを最初から再生する
      field.style.setProperty('--shake-px', `${penalty.shakePx}px`);
      field.style.setProperty('--shake-ms', `${penalty.shakeMs}ms`);
      field.classList.add('arcade--shake');
      window.setTimeout(() => field.classList.remove('arcade--shake'), penalty.shakeMs);

      // 石が砕けて小片が飛ぶ（0.3秒）
      const count = Math.max(1, Math.round(Number(penalty.shards) || 6));
      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count + 0.4;
        const shard = el('span', { class: 'catch-shard', 'aria-hidden': 'true' });
        shard.style.left = `${cx}px`;
        shard.style.top = `${cy}px`;
        shard.style.setProperty('--dx', `${Math.round(Math.cos(angle) * 26)}px`);
        shard.style.setProperty('--dy', `${Math.round(Math.sin(angle) * 26)}px`);
        shard.style.setProperty('--shard-ms', `${penalty.shardMs}ms`);
        field.append(shard);
        window.setTimeout(() => shard.remove(), penalty.shardMs);
      }
    }

    /**
     * 取る（食べもの=+1・石ころ=−1）。
     * 石ころは **buzzer の低い2音＋画面の横揺れ＋赤フラッシュ＋「−1」＋破片**（v36）。
     * 石ころはコインの対象外（スコアだけ減る）。
     */
    function take(itemId) {
      if (ended || locked || !run) return;
      // 位置は消える前に控える（「−1」と破片を石の位置に出すため）
      const item = run.items.find((entry) => entry.id === itemId) ?? null;
      const result = tapCatch(run, itemId, Date.now());
      if (!result.ok) return;
      const node = nodes.get(itemId);
      nodes.delete(itemId);
      if (node) {
        // 位置は transform のまま・scale/rotate だけで弾む／揺れる
        node.classList.add(result.kind === 'rock' ? 'catch-item--bonk' : 'catch-item--caught');
        window.setTimeout(() => node.remove(), 320);
      }
      scoreLabel.textContent = `${catchScore(run)}こ`;
      if (result.kind === 'rock') {
        playSe('buzzer');
        if (item) showRockPenalty(item);
      } else {
        playSe('coin');
      }
      if (isNightRest(Date.now())) void finish();
    }

    /**
     * フィールドのタップ位置から **一番近いもの** を取る（v35）。
     * 判定は見た目から上下左右 `tapPaddingPx`（14px）広く、56px なら実効84px。
     * 近くに何も無ければ何もしない（空振りの音も出さない）。カウントダウン中は無反応。
     */
    field.addEventListener('click', (event) => {
      if (ended || locked || !run) return;
      // ボタンの onclick で処理済み（同じものを二重に取らない）
      if (event.target instanceof Element && event.target.closest('.catch-item')) return;
      const box = field.getBoundingClientRect();
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      if (px < 0 || py < 0 || px > box.width || py > box.height) return;
      const pad = Number(config.tapPaddingPx) || 0;
      let best = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of run.items) {
        if (px < item.x - pad || px > item.x + item.w + pad) continue;
        if (py < item.y - pad || py > item.y + item.h + pad) continue;
        const dx = px - (item.x + item.w / 2);
        const dy = py - (item.y + item.h / 2);
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = item;
        }
      }
      if (best) take(best.id);
    });

    function tick() {
      if (ended) return;
      const now = Date.now();
      const events = stepCatch(run, now);
      for (const event of events) {
        if (event.type === 'spawned') addItem(run.items.find((item) => item.id === event.id));
        else if (event.type === 'missed') {
          const node = nodes.get(event.id);
          if (node) {
            node.remove();
            nodes.delete(event.id);
          }
          if (now - lastMissSe > 260) {
            playSe('miss');
            lastMissSe = now;
          }
        } else if (event.type === 'end') {
          void finish();
          return;
        }
      }
      // 位置は状態をそのまま写す（落下・横位置）
      for (const item of run.items) {
        const node = nodes.get(item.id);
        if (node) node.style.transform = `translate3d(${item.x}px, ${item.y}px, 0)`;
      }
      setTimeLabel(timeLabel, run, now);
      if (isNightRest(now)) void finish();
    }

    async function finish() {
      if (ended) return;
      ended = true;
      stop();
      countdown?.cancel();
      countdown = null;
      const score = catchScore(run);
      const result = await childStore.finishGame({ gameId: 'catch', score, playId, rng, lotteryChance });
      onChanged?.(result?.room ?? null);
      if (!view.isConnected) return;
      renderGameResult(view, {
        prefix: 'catch',
        score,
        scoreText: `${score}こ`,
        result,
        finale: arcadeFinale,
        onAgain: guarded(() => {
          if (isNightRest(Date.now())) {
            toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2800 });
            return;
          }
          play();
        }),
        // おわる: ゲームと一覧の 両方 を閉じて部屋へ（✕ は一覧を残す・v37）
        onQuit: () => {
          sheet.close();
          onQuitAll?.();
        },
      });
    }

    // 0.8秒「よーい…」→ 0.7秒「スタート！」。この間は操作も残り時間も動かさない（v36）
    countdown = runCountdown(view, {
      onStart: () => {
        locked = false;
        if (ended) return;
        run = createCatchRun({
          config,
          width: Math.round(rect.width) || 300,
          height: Math.round(rect.height) || 300,
          rng,
          now: Date.now(),
        });
        tick();
        timer = window.setInterval(tick, 33);
      },
    });
  }

  play();
  return sheet;
}

/* ------------------------------------------------------------ ジャンプチャレンジ */

/**
 * ジャンプチャレンジを開く（1プレイ・もういちど で同じシート内をやり直す）。
 * 自動で横に進み、タップでジャンプして障害物を避ける。ぶつかっても **終了せず -1**
 * （0.8秒の無敵）で続行し、残り時間は減り続ける。
 * スコア＝避けた数 − ぶつかった数（0未満は0）。走るのは選択中のペット（いなければ先頭）。
 */
export async function openJumpGame({ onChanged = null, onClose = null, onQuitAll = null, rng = Math.random, lotteryChance } = {}) {
  const config = GAME_CONFIG.jump;
  // 走るペット＝いま選んでいる子（いなければ先頭の子）。既存のドット絵をそのまま使う
  const dashboard = await childStore.getPetDashboard().catch(() => null);
  const pet = dashboard?.selected ?? dashboard?.pets?.[0] ?? null;
  const species = speciesOf(pet?.speciesId);
  const petStage = pet?.stage ?? 'child';

  const view = el('div', { class: 'arcade arcade--jump' });
  let timer = null;
  /** いま出ている「よーい…スタート！」（やり直し・閉じるで片付ける） */
  let countdown = null;

  const sheet = openGameSheet({
    title: 'ジャンプ チャレンジ',
    description: `タップで ジャンプして じゃまなものを よけよう（${config.seconds}びょう）。`,
    content: view,
    onClose: () => {
      stop();
      countdown?.cancel();
      countdown = null;
      onClose?.();
    },
  });

  function stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  function play() {
    stop();
    countdown?.cancel();
    countdown = null;
    clear(view);
    view.classList.remove('game-result');

    const playId = newPlayId('jump');
    let ended = false;
    /** カウントダウン中はジャンプを受け付けない（タイマーもまだ動かない） */
    let locked = true;
    /** 1プレイぶんの状態（カウントダウンが終わってから作る＝残り時間を減らさない） */
    let run = null;
    let lastPassSe = 0;
    const timeLabel = el('p', { class: 'arcade__stat', id: 'jumpTime', text: timeText(config.seconds) });
    const scoreLabel = el('p', { class: 'arcade__stat arcade__stat--score', id: 'jumpNow', text: '0' });
    const help = el('p', { class: 'arcade__help muted small', id: 'jumpHelp', text: 'いわは ジャンプで とぼう／とりは はしって やりすごそう' });
    const playerCanvas = el('canvas', { class: 'jump-player__art' });
    drawPet(playerCanvas, species, { size: config.playerPx - 6, stage: petStage, expression: 'normal' });
    const player = el('div', { class: 'jump-player', id: 'jumpPlayer', dataset: { species: species.id } }, [playerCanvas]);
    const ground = el('div', { class: 'jump-ground', 'aria-hidden': 'true' });
    const field = el('div', {
      class: 'arcade__field arcade__field--jump',
      id: 'jumpField',
      role: 'button',
      tabindex: '0',
      'aria-label': 'ジャンプ（タップで ジャンプ）',
    }, [ground, player]);
    mount(view, el('div', { class: 'arcade__bar' }, [timeLabel, scoreLabel]), field, help);

    // 地面の高さ・ペット/障害物の大きさはデータ（GAME_CONFIG.jump）から CSS へ渡す
    field.style.setProperty('--ground', `${config.groundPx}px`);
    player.style.width = `${config.playerPx}px`;
    player.style.height = `${config.playerPx}px`;
    const rect = field.getBoundingClientRect();

    /** 画面の障害物（id → div） */
    const nodes = new Map();
    /** 画面のカラス（id → div） */
    const crowNodes = new Map();

    function addObstacle(obstacle) {
      if (!obstacle || nodes.has(obstacle.id)) return null;
      const canvas = el('canvas', { class: 'jump-obstacle__art' });
      drawObstacle(canvas, obstacle.kind, { size: config.obstaclePx - 4 });
      const node = el('div', {
        class: 'jump-obstacle',
        dataset: { id: obstacle.id, kind: obstacle.kind },
        style: {
          width: `${config.obstaclePx}px`,
          height: `${config.obstaclePx}px`,
          transform: `translate3d(${obstacle.x}px, 0, 0)`,
        },
      }, [canvas]);
      field.insertBefore(node, player);
      nodes.set(obstacle.id, node);
      return node;
    }

    function addCrow(crow) {
      if (!crow || crowNodes.has(crow.id)) return null;
      const crowPx = Number(config.crowPx) || 30;
      const canvas = el('canvas', { class: 'jump-crow__art' });
      drawCrow(canvas, { size: crowPx });
      const node = el('div', {
        class: 'jump-crow',
        dataset: { id: crow.id },
        'aria-hidden': 'true',
        style: {
          width: `${crowPx}px`,
          height: `${crowPx}px`,
          // 地面（groundPx）から数えた帯の下端に**絵の胴体の下端**を合わせる（v36）。
          // 絵は下に CROW_ART_GAP_ROWS ドット空くので、その分だけ下げる
          bottom: `${Number(((Number(config.groundPx) || 38)
            + (Number(config.crowMinPx) || 52)
            - (CROW_ART_GAP_ROWS / 24) * crowPx).toFixed(2))}px`,
          transform: `translate3d(${crow.x}px, 0, 0)`,
        },
      }, [canvas]);
      field.insertBefore(node, player);
      crowNodes.set(crow.id, node);
      return node;
    }

    function doJump() {
      if (ended || locked || !run) return;
      if (isNightRest(Date.now())) {
        void finish();
        return;
      }
      if (triggerJump(run, Date.now())) playSe('jump');
    }

    field.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      doJump();
    });
    field.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      doJump();
    });

    function tick() {
      if (ended) return;
      const now = Date.now();
      const events = stepJump(run, now);
      for (const event of events) {
        if (event.type === 'hit') {
          // ぶつかった直後は 0.8秒の無敵（画面は赤くならず、ペットが点滅する）
          field.classList.add('arcade--hit');
          field.dataset.invincible = 'true';
          window.setTimeout(() => field.classList.remove('arcade--hit'), 260);
          playSe('miss');
          scoreLabel.textContent = String(jumpRunScore(run));
        } else if (event.type === 'pass') {
          // 通過ごとの小気味よい音。10個ごとは stage に替える
          if (event.count % 10 === 0) playSe('stage');
          else if (now - lastPassSe > 60) playSe('pass');
          lastPassSe = now;
          scoreLabel.textContent = String(jumpRunScore(run));
        } else if (event.type === 'end') {
          void finish();
          return;
        }
      }
      // 無敵の表示（点滅）は時間で消す
      const invincible = now < run.invincibleUntil;
      if (field.dataset.invincible === 'true' && !invincible) delete field.dataset.invincible;
      field.classList.toggle('arcade--invincible', invincible);
      // 状態の目印（スコアの内訳が見えるように。読み上げには使わない）
      field.dataset.hits = String(run.hits);
      field.dataset.crowHits = String(run.crowHits);
      field.dataset.dodged = String(run.dodged);
      field.dataset.speed = String(Math.round(run.scroll));
      // 経過ms（デバッグとテストの手がかり。読み上げには使わない）
      field.dataset.elapsed = String(Math.round(now - run.startedAt));
      player.style.transform = `translate3d(0, ${-run.player.y}px, 0)`;
      for (const obstacle of run.obstacles) {
        const node = nodes.get(obstacle.id) ?? addObstacle(obstacle);
        if (node) node.style.transform = `translate3d(${obstacle.x}px, 0, 0)`;
      }
      // カラス（空）
      for (const crow of run.crows) {
        const node = crowNodes.get(crow.id) ?? addCrow(crow);
        if (node) node.style.transform = `translate3d(${crow.x}px, 0, 0)`;
      }
      // 消えた障害物・カラスの片付け
      for (const [id, node] of [...nodes]) {
        if (run.obstacles.some((obstacle) => obstacle.id === id)) continue;
        node.remove();
        nodes.delete(id);
      }
      for (const [id, node] of [...crowNodes]) {
        if (run.crows.some((crow) => crow.id === id)) continue;
        node.remove();
        crowNodes.delete(id);
      }
      // 地面はスクロールし続ける（reduced-motion では止める＝ゲームは進む）
      if (!reducedMotion()) ground.style.backgroundPositionX = `${-Math.round(run.scroll)}px`;
      setTimeLabel(timeLabel, run, now);
      if (isNightRest(now)) void finish();
    }

    async function finish() {
      if (ended) return;
      ended = true;
      stop();
      countdown?.cancel();
      countdown = null;
      const score = jumpRunScore(run);
      const result = await childStore.finishGame({ gameId: 'jump', score, playId, rng, lotteryChance });
      onChanged?.(result?.room ?? null);
      if (!view.isConnected) return;
      renderGameResult(view, {
        prefix: 'jump',
        score,
        scoreText: `${score}`,
        result,
        finale: arcadeFinale,
        onAgain: guarded(() => {
          if (isNightRest(Date.now())) {
            toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2800 });
            return;
          }
          play();
        }),
        // おわる: ゲームと一覧の 両方 を閉じて部屋へ（✕ は一覧を残す・v37）
        onQuit: () => {
          sheet.close();
          onQuitAll?.();
        },
      });
    }

    // 0.8秒「よーい…」→ 0.7秒「スタート！」。この間は操作も残り時間も動かさない（v36）
    countdown = runCountdown(view, {
      onStart: () => {
        locked = false;
        if (ended) return;
        run = createJumpRun({
          config,
          width: Math.round(rect.width) || 300,
          height: Math.round(rect.height) || 300,
          rng,
          now: Date.now(),
        });
        player.style.left = `${run.player.x}px`;
        tick();
        timer = window.setInterval(tick, 33);
      },
    });
  }

  play();
  return sheet;
}

/* ------------------------------------------------------------ ペットをさがせ！（v38） */

/**
 * 小さめのゲーム（さがせ＝最大3／リズム＝段階）の終了音。
 * しきい値はゲームごとに渡す（`arcadeFinale` は10・5が基準で、この2つには合わない）。
 */
function finaleFor({ fanfareAt, stageAt }) {
  return ({ score, granted, prizeFanfare }) => {
    if (prizeFanfare) return;
    if (score >= fanfareAt) playSe('fanfare');
    else if (score >= stageAt) playSe('stage');
    else if (granted === 0) playSe('coin');
  };
}

/**
 * 部屋風のフィールドに 5〜8匹 が歩く。家具の後ろを通ると半透明になり、
 * 上に出す「さがしている こ」をタップで見つける（3匹で達成）。
 * ちがう子をタップすると 0.8秒 操作できない（GAME_CONFIG.search.penaltyMs）。
 *
 * 絵は既存の 24×24 のペットと家具（`drawPet` / `paintFurniture`）。新規アートは無い。
 */
export async function openSearchGame({ onChanged = null, onClose = null, onQuitAll = null, rng = Math.random, lotteryChance } = {}) {
  const config = GAME_CONFIG.search;
  // 所持している子を優先して出す（足りない分は未出演の種から）
  const owned = await childStore.listPets();
  const view = el('div', { class: 'search' });
  let timer = null;
  let countdown = null;
  /** play ごとの後片付け（ちがうよ・みつけた の表示タイマー） */
  let playTimers = new Set();

  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    for (const id of playTimers) window.clearTimeout(id);
    playTimers.clear();
  };

  const later = (fn, ms) => {
    const id = window.setTimeout(() => {
      playTimers.delete(id);
      fn();
    }, ms);
    playTimers.add(id);
    return id;
  };

  const sheet = openGameSheet({
    title: 'ペットを さがせ！',
    description: `さがしている こを ${config.targetCount}びき みつけよう。`,
    content: view,
    onClose: () => {
      stop();
      countdown?.cancel();
      countdown = null;
      onClose?.();
    },
  });

  function play() {
    stop();
    countdown?.cancel();
    countdown = null;
    clear(view);
    view.classList.remove('game-result');

    const playId = newPlayId('search');
    let ended = false;
    /** カウントダウン中は操作を受け付けない（タイマーもまだ動かない） */
    let locked = true;
    /** 1プレイぶんの状態（カウントダウンが終わってから作る＝残り時間を減らさない） */
    let run = null;
    const timeLabel = el('p', { class: 'arcade__stat', id: 'searchTime', text: timeText(config.seconds) });
    const foundLabel = el('p', { class: 'arcade__stat arcade__stat--score', id: 'searchFound', text: `0 / ${config.targetCount}ひき` });
    const message = el('p', {
      class: 'search__message',
      id: 'searchMessage',
      role: 'status',
      'aria-live': 'polite',
    });
    const targetFace = el('canvas', { class: 'search__target-art' });
    const targetName = el('p', { class: 'search__target-name', id: 'searchTargetName' });
    const targetNode = el('div', { class: 'search__target', id: 'searchTarget' }, [
      el('p', { class: 'search__target-lead', text: 'さがしている こ' }),
      targetFace,
      targetName,
    ]);
    const help = el('p', {
      class: 'arcade__help muted small',
      id: 'searchHelp',
      text: 'さがしている この かおと なまえを おぼえて、タップしてね',
    });
    const field = el('div', {
      class: 'search__field',
      id: 'searchField',
      role: 'group',
      'aria-label': 'ペットを さがす ばしょ',
    }, [
      el('div', { class: 'search__wall', 'aria-hidden': 'true' }),
      el('div', { class: 'search__floor', 'aria-hidden': 'true' }),
      el('div', { class: 'search__rugs', 'aria-hidden': 'true' }),
      el('div', { class: 'search__furniture', 'aria-hidden': 'true' }),
    ]);
    mount(view, el('div', { class: 'arcade__bar' }, [timeLabel, foundLabel]), targetNode, message, field, help);

    const furnitureLayer = field.querySelector('.search__furniture');
    const rugLayer = field.querySelector('.search__rugs');
    const width = Math.round(field.clientWidth) || 300;
    const height = Math.round(field.clientHeight) || 300;

    // じゅうたん（飾り・隠さない・ペットの下）
    const rugItem = findShopItem('hajimari-rug');
    if (rugItem) {
      const rugCanvas = el('canvas', { class: 'search-furniture__art' });
      paintFurniture(rugCanvas, rugItem, { maxWidth: 88, maxHeight: 44 });
      rugLayer.append(el('div', {
        class: 'search-furniture',
        style: {
          left: `${Math.round(width / 2 - 44)}px`,
          bottom: '16px',
          width: '88px',
          height: '44px',
        },
      }, [rugCanvas]));
    }

    /**
     * 家具の配置（既存の絵・px の矩形）。家具はタップを透かす（後ろの子を押せる）。
     * 隠れる家具は左右に2つだけにして、フィールドの半分は「見えている」状態を残す。
     */
    const furniture = [];
    const specs = [
      { item: findShopItem('bed-1'), w: 99, h: 66, left: -6 },
      { item: findShopItem('tansu'), w: 66, h: 66, left: Math.max(0, width - 72) },
      { item: findShopItem('oekaki'), w: 44, h: 44, left: Math.max(0, width - 58), top: 12, hide: false },
    ];
    for (const spec of specs) {
      if (!spec.item) continue;
      const canvas = el('canvas', { class: 'search-furniture__art' });
      paintFurniture(canvas, spec.item, { maxWidth: spec.w, maxHeight: spec.h });
      const node = el('div', {
        class: 'search-furniture',
        style: {
          left: `${spec.left}px`,
          top: spec.top === undefined ? 'auto' : `${spec.top}px`,
          bottom: spec.top === undefined ? '14px' : 'auto',
          width: `${spec.w}px`,
          height: `${spec.h}px`,
        },
      }, [canvas]);
      furnitureLayer.append(node);
      furniture.push({
        left: spec.left,
        right: spec.left + spec.w,
        top: spec.top === undefined ? height - 14 - spec.h : spec.top,
        bottom: spec.top === undefined ? height - 14 : spec.top + spec.h,
        hide: spec.hide !== false,
      });
    }

    const petNodes = new Map();

    /** さがしている子の顔と名前を出す（見つけたら次の子へ） */
    function renderTarget() {
      const target = currentSearchTarget(run);
      if (!target) return;
      targetNode.dataset.id = target.id;
      targetNode.dataset.species = target.speciesId;
      targetName.textContent = target.name;
      drawPet(targetFace, speciesOf(target.speciesId), { size: 48, stage: target.stage, expression: 'normal' });
      // ドット絵は48pxで描いて、枠（44px）に収める
      targetFace.style.width = '44px';
      targetFace.style.height = '44px';
    }

    /** 一時的な文字（ちがうよ・みつけた！）。tone で色を変える */
    function showMessage(text, tone, ms) {
      message.textContent = text;
      message.dataset.tone = tone;
      message.classList.remove('search__message--in');
      void message.offsetWidth;
      message.classList.add('search__message--in');
      later(() => {
        message.textContent = '';
        message.classList.remove('search__message--in');
      }, ms);
    }

    /** ペットのタップ（指定の子＝発見／ちがう子＝0.8秒ロック） */
    function tap(petId) {
      if (ended || locked || !run) return;
      const now = Date.now();
      if (searchLocked(run, now)) return;
      const result = tapSearch(run, petId, now);
      if (!result.ok) return;

      if (!result.hit) {
        playSe('miss');
        field.classList.add('search--penalty');
        showMessage('ちがうよ', 'wrong', config.penaltyMs);
        later(() => field.classList.remove('search--penalty'), config.penaltyMs);
        return;
      }

      playSe('match', Math.min(5, result.found - 1));
      const node = petNodes.get(petId);
      if (node) {
        node.classList.add('search-pet--found');
        later(() => node.classList.remove('search-pet--found'), 520);
      }
      foundLabel.textContent = `${result.found} / ${config.targetCount}ひき`;
      if (result.ended) {
        void finish();
        return;
      }
      showMessage('みつけた！', 'ok', 700);
      renderTarget();
    }

    function tick() {
      if (ended || !run) return;
      const now = Date.now();
      const events = stepSearch(run, now);
      for (const pet of run.pets) {
        const node = petNodes.get(pet.id);
        if (!node) continue;
        node.style.transform = `translate3d(${pet.x}px, ${pet.y}px, 0)`;
        node.dataset.hidden = pet.hidden ? 'true' : 'false';
        node.dataset.facing = pet.dir < 0 ? 'left' : 'right';
        node.style.opacity = pet.hidden ? String(config.hiddenOpacity) : '1';
      }
      setTimeLabel(timeLabel, run, now);
      for (const event of events) {
        if (event.type === 'end') {
          void finish();
          return;
        }
      }
      // 22:00 を跨いだら、その時点までの発見数で結果にする（既存ゲームと同じ）
      if (isNightRest(now)) void finish();
    }

    async function finish() {
      if (ended) return;
      ended = true;
      stop();
      countdown?.cancel();
      countdown = null;
      const score = searchScore(run);
      const result = await childStore.finishGame({ gameId: 'search', score, playId, rng, lotteryChance });
      onChanged?.(result?.room ?? null);
      if (!view.isConnected) return;
      renderGameResult(view, {
        prefix: 'search',
        score,
        scoreText: `${score}ひき`,
        result,
        finale: finaleFor({ fanfareAt: config.targetCount, stageAt: 2 }),
        onAgain: guarded(() => {
          if (isNightRest(Date.now())) {
            toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2800 });
            return;
          }
          play();
        }),
        // おわる: ゲームと一覧の 両方 を閉じて部屋へ（✕ は一覧を残す・v37）
        onQuit: () => {
          sheet.close();
          onQuitAll?.();
        },
      });
    }

    // 0.8秒「よーい…」→ 0.7秒「スタート！」。この間は操作も残り時間も動かさない（v36）
    countdown = runCountdown(view, {
      onStart: () => {
        locked = false;
        if (ended) return;
        const count = searchPetCount(config, rng);
        const pets = buildSearchPets({ owned, count, rng });
        run = createSearchRun({ config, width, height, pets, furniture, rng, now: Date.now() });
        for (const pet of run.pets) {
          const canvas = el('canvas', { class: 'search-pet__art' });
          drawPet(canvas, speciesOf(pet.speciesId), {
            size: config.petPx,
            stage: pet.stage,
            expression: 'normal',
          });
          const node = el('button', {
            class: 'search-pet',
            type: 'button',
            dataset: { id: pet.id, species: pet.speciesId },
            'aria-label': 'ペット',
            style: {
              width: `${config.petPx}px`,
              height: `${config.petPx}px`,
              transform: `translate3d(${pet.x}px, ${pet.y}px, 0)`,
            },
            onclick: guarded(() => tap(pet.id)),
          }, [canvas]);
          field.append(node);
          petNodes.set(pet.id, node);
        }
        renderTarget();
        tick();
        timer = window.setInterval(tick, 33);
      },
    });
  }

  play();
  return sheet;
}

/* ------------------------------------------------------------ リズムあそび（v38） */

/**
 * 4つのランプ（ド・ミ・ソ・ド）が光る順番を再生し、同じ順でタップする。
 * 1段目は2音・成功のたびに1音ずつ長くなる（最大10音）。1音でも間違えたら終了。
 * スコア＝クリアした段階数。音は `tone()` の音階（SEオフならランプの点滅で追える）。
 */
export async function openRhythmGame({ onChanged = null, onClose = null, onQuitAll = null, rng = Math.random, lotteryChance } = {}) {
  const config = GAME_CONFIG.rhythm;
  const view = el('div', { class: 'rhythm' });
  let timer = null;
  let countdown = null;
  let playTimers = new Set();

  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    for (const id of playTimers) window.clearTimeout(id);
    playTimers.clear();
  };

  const later = (fn, ms) => {
    const id = window.setTimeout(() => {
      playTimers.delete(id);
      fn();
    }, ms);
    playTimers.add(id);
    return id;
  };

  const sheet = openGameSheet({
    title: 'リズム あそび',
    description: 'ひかる じゅんばんを おぼえて、おなじように おそう。',
    content: view,
    onClose: () => {
      stop();
      countdown?.cancel();
      countdown = null;
      onClose?.();
    },
  });

  function play() {
    stop();
    countdown?.cancel();
    countdown = null;
    clear(view);
    view.classList.remove('game-result');

    const playId = newPlayId('rhythm');
    let ended = false;
    /** カウントダウン中はタップを受け付けない（タイマーもまだ動かない） */
    let locked = true;
    let run = null;
    const timeLabel = el('p', { class: 'arcade__stat', id: 'rhythmTime', text: timeText(config.seconds) });
    const stageLabel = el('p', { class: 'arcade__stat arcade__stat--score', id: 'rhythmStage', text: '0だん' });
    const progressLabel = el('p', { class: 'rhythm__progress', id: 'rhythmProgress', text: `${config.startLength}おん` });
    const help = el('p', {
      class: 'arcade__help muted small',
      id: 'rhythmHelp',
      text: 'ひかる じゅんばんを おぼえてね',
    });
    const padNodes = config.padLabels.map((label, index) => el('button', {
      class: `rhythm-pad rhythm-pad--${index}`,
      type: 'button',
      dataset: { pad: String(index), label },
      'aria-label': `${label} の ランプ`,
      onclick: guarded(() => tapPad(index)),
    }, [el('span', { class: 'rhythm-pad__label', text: label })]));
    const field = el('div', {
      class: 'rhythm__field',
      id: 'rhythmField',
      role: 'group',
      'aria-label': 'リズムの ランプ',
    }, padNodes);
    mount(view, el('div', { class: 'arcade__bar' }, [timeLabel, stageLabel]), field, el('div', { class: 'rhythm__foot' }, [progressLabel, help]));

    /** ランプごとの「消す」タイマー（同じランプが続けて光っても取り違えない） */
    const litTimers = new Map();

    /** 光らせる（点滅は CSS。reduced-motion では動かさず長めに残す） */
    function light(pad) {
      const node = padNodes[pad];
      if (!node) return;
      const pending = litTimers.get(pad);
      if (pending) {
        window.clearTimeout(pending);
        litTimers.delete(pad);
      }
      node.classList.add('rhythm-pad--lit');
    }

    /** 消す。reduced-motion では「間」のぶんだけ長く残す（点滅を長めに） */
    function unlight(pad) {
      const node = padNodes[pad];
      if (!node) return;
      if (!reducedMotion()) {
        node.classList.remove('rhythm-pad--lit');
        return;
      }
      const pending = litTimers.get(pad);
      if (pending) window.clearTimeout(pending);
      litTimers.set(pad, later(() => {
        litTimers.delete(pad);
        node.classList.remove('rhythm-pad--lit');
      }, config.gapMs));
    }

    function showMessage(text, tone, ms) {
      help.textContent = text;
      help.dataset.tone = tone;
      help.classList.remove('rhythm__help--in');
      void help.offsetWidth;
      help.classList.add('rhythm__help--in');
      later(() => {
        help.dataset.tone = '';
        help.classList.remove('rhythm__help--in');
      }, ms);
    }

    /** ランプのタップ（正解なら次の音へ・まちがえたら終了） */
    function tapPad(pad) {
      if (ended || locked || !run) return;
      const now = Date.now();
      if (isNightRest(now)) {
        void finish();
        return;
      }
      // 押した音はすぐ鳴らす（SEオフなら無音）
      playSe('note', config.notes[pad]);
      const result = tapRhythm(run, pad, now);
      if (!result.ok) return;
      field.dataset.stage = String(run.stage);
      field.dataset.input = String(run.inputIndex);
      if (!result.correct) {
        playSe('miss');
        showMessage('ちがうよ…', 'wrong', 1200);
        void finish();
        return;
      }
      const node = padNodes[pad];
      if (node) {
        node.classList.add('rhythm-pad--hit');
        setTimeout(() => node.classList.remove('rhythm-pad--hit'), 220);
      }
      if (!result.cleared) return;
      stageLabel.textContent = `${run.stage}だん`;
      // 次の段階の再生がすぐ始まる（目印も戻す）
      field.dataset.phase = 'play';
      field.dataset.stage = String(run.stage);
      field.dataset.length = String(run.sequence.length);
      playSe('stage');
      if (result.ended) {
        void finish();
        return;
      }
      showMessage('できた！', 'ok', 800);
    }

    function tick() {
      if (ended || !run) return;
      const now = Date.now();
      const events = stepRhythm(run, now);
      for (const event of events) {
        if (event.type === 'lit') {
          light(event.pad);
          playSe('note', config.notes[event.pad]);
          field.dataset.phase = 'play';
          help.textContent = 'きいてね…';
          help.dataset.tone = '';
        } else if (event.type === 'off') {
          unlight(event.pad);
        } else if (event.type === 'input') {
          field.dataset.phase = 'input';
          help.textContent = 'おなじ じゅんばんで おしてね';
          progressLabel.textContent = `${run.length}おん`;
          field.dataset.length = String(run.length);
        } else if (event.type === 'end') {
          void finish();
          return;
        }
      }
      field.dataset.stage = String(run.stage);
      field.dataset.length = String(run.sequence.length);
      field.dataset.input = String(run.inputIndex);
      setTimeLabel(timeLabel, run, now);
      // 22:00 を跨いだら、その時点の段階で結果にする（既存ゲームと同じ）
      if (isNightRest(now)) void finish();
    }

    async function finish() {
      if (ended) return;
      ended = true;
      stop();
      countdown?.cancel();
      countdown = null;
      const score = rhythmScore(run);
      const result = await childStore.finishGame({ gameId: 'rhythm', score, playId, rng, lotteryChance });
      onChanged?.(result?.room ?? null);
      if (!view.isConnected) return;
      renderGameResult(view, {
        prefix: 'rhythm',
        score,
        scoreText: `${score}だん`,
        result,
        finale: finaleFor({ fanfareAt: 6, stageAt: 2 }),
        onAgain: guarded(() => {
          if (isNightRest(Date.now())) {
            toast(NIGHT_GAME_TEXT, { tone: 'info', duration: 2800 });
            return;
          }
          play();
        }),
        // おわる: ゲームと一覧の 両方 を閉じて部屋へ（✕ は一覧を残す・v37）
        onQuit: () => {
          sheet.close();
          onQuitAll?.();
        },
      });
    }

    // 0.8秒「よーい…」→ 0.7秒「スタート！」。この間は操作も残り時間も動かさない（v36）
    countdown = runCountdown(view, {
      onStart: () => {
        locked = false;
        if (ended) return;
        run = createRhythmRun({ config, rng, now: Date.now() });
        stageLabel.textContent = '0だん';
        tick();
        timer = window.setInterval(tick, 33);
      },
    });
  }

  play();
  return sheet;
}
