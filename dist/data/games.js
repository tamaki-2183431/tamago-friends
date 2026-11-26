/**
 * ミニゲーム（Phase 3-3 パスA）の**データだけ**。
 * 遊びのロジック・抽選・台帳への反映は js/game/games.js、画面は js/ui/games.js。
 *
 * 正 = オーナー要望書（Phase 3-3）＋ PM 判断（2026-10-29 / 2026-10-30）。
 * - パスA は ペット神経衰弱、**パスB（v34）で ごはんキャッチ と ジャンプチャレンジ**、
 *   **v38 で ペットをさがせ！ と リズムあそび**が遊べる（5ゲームすべて）。
 * - 報酬額・枚数・時間・戻す時間・難易度の段は、ここ（GAME_CONFIG）だけで調整できるようにする
 * - 抽選は既存の商品から。**新しい家具・アイテムは追加しない**
 */

/** 5ゲーム合計の1日のコイン上限（コイン台帳の daily.game で数える） */
export const GAME_DAILY_CAP = 30;

/** 1プレイあたりのアイテム当選確率（本番 2%。テストは `lotteryChance` の入口で固定する） */
export const LOTTERY_CHANCE = 0.02;

/**
 * レア区分は**価格**で決める（PM 判断 2026-10-29）。
 * 60 / 100 = レア、20 / 40 = 通常。初期家具（price 0）は抽選の対象外。
 */
export const RARE_PRICE_MIN = 60;

/** 所持済み（重複）をコインに変えたときの額。日次上限の**外**（別枠・上限なし） */
export const DUPLICATE_COINS = Object.freeze({ rare: 30, normal: 10 });

/** 二重付与の防止に残すプレイIDの数（台帳 games.playIds） */
export const PLAY_ID_KEEP = 20;

/**
 * 全ゲーム共通の「よーい…、スタート！」（v36）。3ゲームとも `js/ui/countdown.js` の
 * `runCountdown()` がこの値を使う。**演出中は操作もタイマーも止める**。
 */
export const COUNTDOWN = Object.freeze({ readyMs: 800, startMs: 700 });

/**
 * ゲームごとの調整値。
 * rewards は「スコアが max 以下なら coins」の表（上から順に見る）。
 */
export const GAME_CONFIG = Object.freeze({
  memory: Object.freeze({
    cards: 12,
    pairs: 6,
    cols: 4,
    rows: 3,
    seconds: 30,
    /** 不一致の2枚を裏返すまでの時間 */
    flipBackMs: 1200,
    rewards: Object.freeze([
      { max: 2, coins: 1 },
      { max: 4, coins: 3 },
      { max: 5, coins: 5 },
      { max: 6, coins: 7 },
    ]),
  }),
  /**
   * ごはんキャッチ（v34・v35で手触り調整）。**スコア＝食べものを取った数 − 石ころをタップした数**（0未満は0）。
   * 難易度は elapsed 秒の3段（0-10 / 10-20 / 20-30）で、落下速度と出現間隔を変える。
   *
   * v35: 食べもの 56px・**フィールドのタップ位置から一番近いもの**を取る（判定は上下左右 +14px）・
   * 石ころ（25%）を追加（タップすると −1・コイン対象外）。
   */
  catch: Object.freeze({
    seconds: 30,
    /** 食べもの／石ころの大きさ（見た目。44px 以上のタップ領域を保つ） */
    itemPx: 56,
    /** タップ判定を見た目から上下左右に広げる量（56 + 14*2 = 実効84px） */
    tapPaddingPx: 14,
    /** 落ちる食べもの（絵は js/ui/food-art.js のコード描画） */
    foods: Object.freeze(['apple', 'banana', 'cookie', 'pudding', 'cake']),
    /** 石ころ（食べものではない・タップすると減点） */
    rockId: 'rock',
    /** 石ころの出現割合（4個に1個） */
    rockChance: 0.25,
    /**
     * **石ころを取ったときの演出（v36）**。数値はここだけで持つ。
     * 揺れと破片は reduced-motion では出さない（フラッシュと「−1」だけ残す）。
     */
    penalty: Object.freeze({
      /** フィールド全体の横揺れ（振幅・長さ） */
      shakePx: 6,
      shakeMs: 300,
      /** 赤いフラッシュ（長さ・不透明度） */
      flashMs: 250,
      flashOpacity: 0.18,
      /** 石の位置に浮かべる「−1」が消えるまで */
      minusMs: 700,
      /** 砕けた小片（数・飛ぶ長さ） */
      shards: 6,
      shardMs: 300,
    }),
    phases: Object.freeze([
      { until: 10, fallPxPerSec: 140, spawnMs: 880 },
      { until: 20, fallPxPerSec: 215, spawnMs: 610 },
      { until: 30, fallPxPerSec: 300, spawnMs: 400 },
    ]),
    rewards: Object.freeze([
      { max: 4, coins: 1 },
      { max: 9, coins: 3 },
      { max: 14, coins: 5 },
      { max: Number.POSITIVE_INFINITY, coins: 6 },
    ]),
  }),
  /**
   * ペットをさがせ！（v38）。**スコア＝みつけた数**（0〜3）。
   * 部屋風のフィールドを 5〜8匹が歩き、家具の後ろを通ると半透明になって隠れる。
   * 上に「さがしている こ」を1匹ぶん出し、その子をタップで発見。3匹で達成終了。
   * ちがう子をタップすると `penaltyMs` のあいだ操作できない（時間のペナルティ）。
   *
   * 調整はこの1か所: 人数（min/max）・隠れ方（hiddenOpacity）・ペナルティ（ms）・
   * 歩く速さ・報酬。
   */
  search: Object.freeze({
    seconds: 40,
    /** 出てくるペットの数（この範囲で1プレイごとに決める） */
    petMin: 5,
    petMax: 8,
    /** 見つけたら達成になる数 */
    targetCount: 3,
    /** ペットの大きさ（タップ領域もこの大きさ＝44px以上・ドット絵は2倍でくっきり） */
    petPx: 48,
    /** 家具の後ろを通ったときの不透明度（半透明・タップはできる） */
    hiddenOpacity: 0.4,
    /** ちがう子をタップしたときの操作不可（ms）＝実質の時間ペナルティ */
    penaltyMs: 800,
    /** 歩く速さ（px/秒）と、立ち止まる時間（ms） */
    speedMinPxPerSec: 16,
    speedMaxPxPerSec: 30,
    pauseMsMin: 500,
    pauseMsMax: 1600,
    /** フィールドの左右の余白（px） */
    marginPx: 6,
    /** 足元をフィールドの下から何 px 上げるか（床の上に立たせる） */
    floorInsetPx: 14,
    rewards: Object.freeze([
      { max: 0, coins: 1 },
      { max: 1, coins: 2 },
      { max: 2, coins: 4 },
      { max: Number.POSITIVE_INFINITY, coins: 6 },
    ]),
  }),
  /**
   * リズムあそび（v38）。**スコア＝クリアした段階数**。
   * 4つのランプ（ド・ミ・ソ・ド）が光る順番を再生し、同じ順でタップする。
   * 1段目は2音・成功するたび1音ずつ長くなる（最大10音）。1音でも間違えたら終了。
   *
   * 調整はこの1か所: 音数（startLength/growth/maxLength）・再生速度（noteMs/gapMs）・報酬。
   */
  rhythm: Object.freeze({
    seconds: 40,
    /** ランプの数と音階（ド・ミ・ソ・ド）。音は sound.js の tone() で鳴らす */
    pads: 4,
    notes: Object.freeze([523.25, 659.25, 783.99, 1046.5]),
    padLabels: Object.freeze(['ド', 'ミ', 'ソ', 'ド']),
    /** 1段目の音数・成功ごとの伸び・上限 */
    startLength: 2,
    growth: 1,
    maxLength: 10,
    /** 再生: 1音が光っている時間と、音と音の間 */
    noteMs: 450,
    gapMs: 150,
    /** カウントダウン後・段階クリア後に、再生が始まるまでの間 */
    leadMs: 450,
    restartMs: 500,
    rewards: Object.freeze([
      { max: 1, coins: 1 },
      { max: 3, coins: 3 },
      { max: 5, coins: 5 },
      { max: Number.POSITIVE_INFINITY, coins: 7 },
    ]),
  }),
  /**
   * ペットのジャンプチャレンジ（v34・v35で手触り調整）。
   * スコア＝**避けた数 − ぶつかった数**（0未満は0）。ぶつかっても終了しない（-1・0.8秒の無敵で続行）。
   *
   * v35:
   * - スクロール速度は **100→300px/s の連続上昇**（`100 + 200 * (t/40)^1.6`）
   * - 地上の障害物は **岩**だけ・間隔は **260px 固定**（速くなるほど時間間隔が詰まる）
   * - ジャンプは **山なり70px・空中0.4秒**
   * - **カラス**が地面から40〜60pxを飛ぶ（地上なら当たらない／ジャンプ中に当たると −1）
   *
   * v36:
   * - 空中時間を速さに合わせる（**横クリア約110px一定**・山なりの高さは66px固定）。
   *   0.4秒固定のままだと開始直後（100px/s）は横に40pxしか進めず、岩（34px）＋体（44px）＝78px を越えられない。
   * - カラスを **52〜62px** の帯へ上げ、当たりは上下4px内側（地上では当たらない）。
   */
  jump: Object.freeze({
    seconds: 40,
    /** 地上の帯の高さ（障害物とペットの足元） */
    groundPx: 38,
    /** 走るペットの大きさ・岩の大きさ（タップ領域はフィールド全体） */
    playerPx: 44,
    obstaclePx: 34,
    /** 地上の障害物（岩）の種類 */
    obstacles: Object.freeze(['rock']),
    /** 岩と岩の間隔（px 固定。速くなるほど時間間隔が詰まる） */
    gapPx: 260,
    /** スクロール速度（px/秒）: start + (end-start) * (elapsed/seconds)^curve */
    speedStartPxPerSec: 100,
    speedEndPxPerSec: 300,
    speedCurve: 1.6,
    /**
     * **ジャンプの高さと空中時間（v36）**。
     * 空中時間は **速さに合わせて** `clamp(jumpClearPx / 速さ, jumpAirMinSec, jumpAirMaxSec)`。
     * 山なりの高さは `jumpHeightPx` に固定し、初速と重力を空中時間から逆算する（v = 4H/T・g = 8H/T²）。
     * 速いときは短く跳び、遅いときはふんわり長く跳ぶ（横に進む距離はほぼ一定）。
     */
    jumpClearPx: 110,
    jumpAirMinSec: 0.42,
    jumpAirMaxSec: 1.05,
    jumpHeightPx: 66,
    /** ぶつかった直後の無敵（この間は減点されない） */
    invincibleMs: 800,
    /**
     * 空の障害物カラス。岩を出すたびに crowChance で **岩と岩の合間** に出す。
     * 地面から crowMinPx〜crowMaxPx の帯を飛び、速度はスクロールの crowSpeedFactor 倍。
     * **当たり判定は帯の上下を crowInsetPx 内側に詰める**（v36）:
     * 立っている子（44px）には届かず、ジャンプ中（山なり66px）だけ当たる。
     */
    crowChance: 0.25,
    crowPx: 30,
    crowMinPx: 52,
    crowMaxPx: 62,
    crowInsetPx: 4,
    crowSpeedFactor: 1.25,
    rewards: Object.freeze([
      { max: 4, coins: 1 },
      { max: 9, coins: 3 },
      { max: 19, coins: 5 },
      { max: Number.POSITIVE_INFINITY, coins: 7 },
    ]),
  }),
});

/**
 * ゲーム一覧（表示順）。所要時間は各ゲームの基本秒数。
 * `ready:false` は「これから」（押せない）。
 */
export const GAMES = Object.freeze([
  {
    id: 'memory',
    name: 'ペット しんけいすいじゃく',
    blurb: 'おなじ ペットの カードを 2まい そろえよう',
    duration: '30びょう',
    ready: true,
  },
  {
    id: 'catch',
    name: 'ごはん キャッチ',
    blurb: 'おちてくる たべものを タップして あつめよう',
    duration: '30びょう',
    ready: true,
  },
  {
    id: 'search',
    name: 'ペットを さがせ！',
    blurb: 'さがして ほしい ペットを 3びき みつけよう',
    duration: '40びょう',
    ready: true,
  },
  {
    id: 'rhythm',
    name: 'リズム あそび',
    blurb: 'ひかる じゅんばんを おぼえて おなじように おそう',
    duration: '40びょう',
    ready: true,
  },
  {
    id: 'jump',
    name: 'ジャンプ チャレンジ',
    blurb: 'ジャンプして じゃまなものを よけよう',
    duration: '40びょう',
    ready: true,
  },
]);

/** ゲームの表示名（履歴のラベルに使う） */
export function gameName(gameId) {
  return GAMES.find((game) => game.id === gameId)?.name ?? 'ゲーム';
}

export function gameConfig(gameId) {
  return GAME_CONFIG[gameId] ?? null;
}
