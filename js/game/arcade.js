/**
 * アーケード系ミニゲーム（Phase 3-3 パスB・v34 / 手触り調整 v35）の**純関数エンジン**。
 * DOM / IndexedDB / Date.now() に依存しない（乱数と時刻は引数で受け取る）。
 *
 * ここに載っているもの:
 * - **ごはんキャッチ**: 落ちてくる食べもの・石ころの生成、落下、タップでの取得（石ころは減点）、逃した数
 * - **ジャンプチャレンジ**: 自動で進む地面・ジャンプ・岩/カラスの障害物・通過/被弾・無敵・連続上昇する速度
 * - 難易度（キャッチは3段・ジャンプは連続）とスコアの式
 *
 * 報酬・日次上限・抽選・二重付与は既存の `js/game/games.js`（applyGameResult）と
 * `childStore.finishGame` をそのまま通す。このファイルは「成績を数値にする」まで。
 *
 * 座標はフィールドの px（左上が 0,0）。画面は返ってきた状態をそのまま描くだけで、
 * 判定・難易度・スコアの計算はすべてここ（テストで同じ関数を通せる）。
 */

/** 経過秒に合う難易度の段を返す（最後の段で頭打ち・不正値は最初の段） */
export function phaseAt(phases, elapsedSec) {
  const list = Array.isArray(phases) ? phases : [];
  if (!list.length) return null;
  const seconds = Number(elapsedSec);
  if (!Number.isFinite(seconds) || seconds < 0) return list[0];
  for (const phase of list) {
    if (seconds < Number(phase.until)) return phase;
  }
  return list[list.length - 1];
}

/** キャッチの、その時点の難易度（落下速度・出現間隔） */
export function catchPhaseAt(config, elapsedMs) {
  return phaseAt(config?.phases, (Number(elapsedMs) || 0) / 1000);
}

/**
 * ジャンプのスクロール速度（px/秒）。**3段ではなく連続**で上がる（v35）。
 * `start + (end - start) * (t / seconds)^curve`（t は経過秒・seconds で頭打ち）
 */
export function jumpSpeedAt(config, elapsedMs) {
  const seconds = Math.max(1, Number(config?.seconds) || 40);
  const start = Number(config?.speedStartPxPerSec) || 0;
  const end = Number(config?.speedEndPxPerSec) || start;
  const curve = Number(config?.speedCurve) || 1;
  const elapsed = Math.max(0, (Number(elapsedMs) || 0) / 1000);
  const ratio = Math.min(1, elapsed / seconds);
  return start + (end - start) * ratio ** curve;
}

/** ジャンプのスコア＝避けた数 − ぶつかった数（0未満は0） */
export function jumpScore(dodged, hits) {
  const good = Math.max(0, Math.round(Number(dodged) || 0));
  const bad = Math.max(0, Math.round(Number(hits) || 0));
  return Math.max(0, good - bad);
}

/**
 * ジャンプの**空中時間**（秒）。速さに合わせて、横に進む距離がほぼ一定になるようにする（v36）。
 * `clamp(jumpClearPx / 速さ, jumpAirMinSec, jumpAirMaxSec)`。
 * 例: 100px/s → 1.05秒（1.1が上限超え）／300px/s → 0.42秒（0.367が下限下回り）。
 */
export function jumpAirTime(config, speedPxPerSec) {
  const clearPx = Number(config?.jumpClearPx) || 110;
  const min = Number(config?.jumpAirMinSec) || 0.42;
  const max = Number(config?.jumpAirMaxSec) || 1.05;
  const speed = Math.max(1, Number(speedPxPerSec) || Number(config?.speedStartPxPerSec) || 100);
  const air = clearPx / speed;
  return Math.min(max, Math.max(min, air));
}

/**
 * ジャンプの山なり（初速・重力・高さ）を空中時間から逆算する（v36）。
 * 高さ H と空中時間 T から `v = 4H/T`・`g = 8H/T²`（放物線がちょうど H で頂点・T で着地）。
 * @returns {{airSec:number, heightPx:number, vy:number, gravity:number, clearPx:number}}
 */
export function jumpArcFor(config, speedPxPerSec) {
  const heightPx = Number(config?.jumpHeightPx) || 66;
  const airSec = jumpAirTime(config, speedPxPerSec);
  const speed = Math.max(1, Number(speedPxPerSec) || Number(config?.speedStartPxPerSec) || 100);
  return {
    airSec,
    heightPx,
    vy: (4 * heightPx) / airSec,
    gravity: (8 * heightPx) / (airSec * airSec),
    clearPx: speed * airSec,
  };
}

/** キャッチのスコア＝食べものを取った数 − 石ころをタップした数（0未満は0） */
export function catchScore(run) {
  const caught = Math.max(0, Math.round(Number(run?.caught) || 0));
  const rocks = Math.max(0, Math.round(Number(run?.rockHits) || 0));
  return Math.max(0, caught - rocks);
}

/* ------------------------------------------------------------ ごはんキャッチ */

let catchSerial = 0;
let jumpSerial = 0;

/**
 * 1プレイぶんのキャッチを始める。
 * @param {{config:object, width:number, height:number, rng?:()=>number, now?:number}} input
 *   width / height はフィールドの実寸（px）。rng は種類と x に使う。
 */
export function createCatchRun({ config, width, height, rng = Math.random, now = 0 } = {}) {
  const startedAt = Number(now) || 0;
  return {
    config,
    width: Math.max(1, Number(width) || 1),
    height: Math.max(1, Number(height) || 1),
    rng,
    startedAt,
    endsAt: startedAt + config.seconds * 1000,
    lastAt: startedAt,
    /** 次の生成時刻（最初の1個は 300ms 後） */
    nextSpawnAt: startedAt + 300,
    /** 画面にあるもの（x,y は左上・px） */
    items: [],
    caught: 0,
    rockHits: 0,
    missed: 0,
    ended: false,
  };
}

function spawnCatchItem(run, at) {
  const { config } = run;
  const size = config.itemPx;
  const span = Math.max(0, run.width - size);
  const roll = Number(run.rng());
  const ratio = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  let x = Math.round(ratio * span);
  // 直前の1個と真横に重ならないよう、離れていなければ反対側へずらす
  const last = run.items[run.items.length - 1];
  if (last && Math.abs(last.x - x) < size * 0.8 && span > 0) {
    x = Math.round((x + span / 2) % (span + 1));
  }
  // 石ころは4個に1個（rockChance）。食べものは foods から等確率
  const kindRoll = Number(run.rng());
  const isRock = Number.isFinite(kindRoll) && kindRoll < (Number(config.rockChance) || 0);
  const foodRoll = Number(run.rng());
  const foodRatio = Number.isFinite(foodRoll) ? Math.min(0.999999, Math.max(0, foodRoll)) : 0;
  const foodId = isRock
    ? config.rockId
    : (config.foods[Math.floor(foodRatio * config.foods.length)] ?? config.foods[0]);
  catchSerial += 1;
  const item = {
    id: `food-${catchSerial}`,
    foodId,
    rock: isRock,
    x,
    y: 0,
    w: size,
    h: size,
    bornAt: at,
  };
  run.items.push(item);
  return item;
}

/**
 * キャッチを dt ぶん進める。鳴らす音のためのイベントを返す（DOM は触らない）。
 * イベント: {type:'spawned'|'missed', foodId, rock} / {type:'end'}
 */
export function stepCatch(run, now) {
  const events = [];
  if (run.ended) return events;
  const at = Number(now) || 0;
  if (at >= run.endsAt) {
    run.ended = true;
    events.push({ type: 'end' });
    return events;
  }
  // 長い停止（タブ復帰など）で食べものが瞬間移動しないよう dt を上限で切る
  const dt = Math.min(0.06, Math.max(0, (at - run.lastAt) / 1000));
  run.lastAt = at;

  const phase = catchPhaseAt(run.config, at - run.startedAt);
  const fall = (Number(phase?.fallPxPerSec) || 0) * dt;
  for (const item of [...run.items]) {
    item.y += fall;
    if (item.y + item.h * 0.6 >= run.height) {
      run.items = run.items.filter((entry) => entry !== item);
      run.missed += 1;
      events.push({ type: 'missed', foodId: item.foodId, rock: item.rock, id: item.id });
    }
  }

  // 出現量は段ごとの spawnMs（短いほど多い）。終了時刻を超える生成はしない
  let guard = 0;
  while (at >= run.nextSpawnAt && run.nextSpawnAt < run.endsAt && guard < 4) {
    const spawnPhase = catchPhaseAt(run.config, run.nextSpawnAt - run.startedAt);
    const item = spawnCatchItem(run, run.nextSpawnAt);
    events.push({ type: 'spawned', foodId: item.foodId, rock: item.rock, id: item.id });
    run.nextSpawnAt += Math.max(120, Number(spawnPhase?.spawnMs) || 600);
    guard += 1;
  }
  return events;
}

/**
 * タップで取る（取れたら `{ok:true, kind, foodId}`）。
 * 食べものは caught+1、石ころは rockHits+1（どちらも画面から消える）。
 * 取れない/終了後は `{ok:false}`。
 */
export function tapCatch(run, itemId, now = 0) {
  if (run.ended) return { ok: false, kind: null, foodId: null };
  if (Number(now) >= run.endsAt) return { ok: false, kind: null, foodId: null };
  const index = run.items.findIndex((item) => item.id === itemId);
  if (index < 0) return { ok: false, kind: null, foodId: null };
  const [item] = run.items.splice(index, 1);
  if (item.rock) run.rockHits += 1;
  else run.caught += 1;
  return { ok: true, kind: item.rock ? 'rock' : 'food', foodId: item.foodId, id: item.id };
}

/* ------------------------------------------------------------ ジャンプチャレンジ */

/**
 * 1プレイぶんのジャンプを始める。
 * @param {{config:object, width:number, height:number, rng?:()=>number, now?:number}} input
 */
export function createJumpRun({ config, width, height, rng = Math.random, now = 0 } = {}) {
  const startedAt = Number(now) || 0;
  const fieldWidth = Math.max(1, Number(width) || 1);
  const fieldHeight = Math.max(1, Number(height) || 1);
  const groundY = fieldHeight - config.groundPx;
  return {
    config,
    width: fieldWidth,
    height: fieldHeight,
    groundY,
    rng,
    startedAt,
    endsAt: startedAt + config.seconds * 1000,
    lastAt: startedAt,
    player: {
      x: Math.round(fieldWidth * 0.16),
      w: config.playerPx,
      h: config.playerPx,
      /** 地面からの高さ（px）。ジャンプ中だけ 0 より大きい */
      y: 0,
      /** 下向きが正（ジャンプで負になる） */
      vy: 0,
      /** いま飛んでいるジャンプの重力（px/秒²）。飛んだ瞬間の速さで決まる（v36） */
      gravity: jumpArcFor(config, Number(config.speedStartPxPerSec) || 100).gravity,
      /** いま飛んでいるジャンプの着地予定時刻（ms・v36。テストと内訳用） */
      landAt: 0,
      grounded: true,
    },
    /** 地上の障害物（岩） */
    obstacles: [],
    /** 空の障害物（カラス）。地面からの高さ crowMinPx〜crowMaxPx を飛ぶ */
    crows: [],
    dodged: 0,
    hits: 0,
    /** カラスで当たった数（岩と分けて数える・テストと内訳用） */
    crowHits: 0,
    /** この時刻まではぶつかっても減点しない（ms） */
    invincibleUntil: 0,
    /** 地面のスクロール量（px・装飾。reduced-motion では描かない） */
    scroll: 0,
    ended: false,
  };
}

function spawnJumpObstacle(run) {
  const { config } = run;
  jumpSerial += 1;
  const obstacle = {
    id: `jump-${jumpSerial}`,
    kind: (config.obstacles ?? ['rock'])[0],
    x: run.width,
    w: config.obstaclePx,
    h: config.obstaclePx,
    /** この岩の「合間」にカラスを出すか（1回だけ） */
    crowPending: Number(run.rng()) < (Number(config.crowChance) || 0),
    crowDone: false,
  };
  run.obstacles.push(obstacle);
  return obstacle;
}

function spawnCrow(run) {
  const { config } = run;
  jumpSerial += 1;
  const crow = {
    id: `crow-${jumpSerial}`,
    x: run.width,
    w: Number(config.crowPx) || 30,
  };
  run.crows.push(crow);
  return crow;
}

/**
 * ペットの当たり判定（**中央だけ**・足元の少し上）。
 * 見た目より小さくして「すれすれで よけた」が成立するようにする（子ども向けの甘さ）。
 * 縦は 0.85 倍: 地上にいるときの頭（37.4px）がカラスの当たり帯（52px〜）に入らない。
 */
export function jumpPlayerBox(run) {
  const { player, groundY } = run;
  const bottom = groundY - player.y;
  return {
    left: player.x + player.w * 0.3,
    right: player.x + player.w * 0.7,
    top: bottom - player.h * 0.85,
    bottom,
  };
}

export function jumpObstacleBox(obstacle, groundY) {
  return {
    left: obstacle.x + obstacle.w * 0.2,
    right: obstacle.x + obstacle.w * 0.8,
    top: groundY - obstacle.h,
    bottom: groundY,
  };
}

/**
 * カラスの当たり判定（帯 crowMinPx〜crowMaxPx の**上下を crowInsetPx 内側**へ・左右は中央60%）。
 * v36: 帯を 52〜62px に上げ、判定は 56〜58px に詰める（立ち姿の頭 37.4px には届かない）。
 */
export function jumpCrowBox(crow, groundY, config) {
  const min = Number(config?.crowMinPx) || 52;
  const max = Number(config?.crowMaxPx) || 62;
  const inset = Math.max(0, Number(config?.crowInsetPx) || 0);
  return {
    left: crow.x + crow.w * 0.2,
    right: crow.x + crow.w * 0.8,
    top: groundY - Math.max(min, max - inset),
    bottom: groundY - (min + inset),
  };
}

/**
 * カラスとペットの当たり（v35・帯の高さは v36）。
 * - **地上（y=0）なら当たらない**（カラスの当たり帯は立っている頭のすぐ上）
 * - **ジャンプ中は当たる**: 頭が帯の下端まで上がったら、その先の高さに関係なく当たり
 *   （＝「カラスはジャンプしないで やりすごす」）。左右は中央30-70%を流用する。
 */
export function crowHitsPlayer(run, crow, config) {
  if (!(run.player.y > 0)) return false;
  const box = jumpCrowBox(crow, run.groundY, config);
  const playerBox = jumpPlayerBox(run);
  const horizontal = playerBox.right > box.left && playerBox.left < box.right;
  return horizontal && playerBox.top <= box.bottom;
}

function overlaps(a, b) {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

/**
 * ジャンプチャレンジを dt ぶん進める。
 * イベント: {type:'pass', count} / {type:'hit', hits, score, kind} / {type:'end'}
 * - 岩はジャンプで越える。カラスは地面を走れば当たらない（ジャンプ中に当たる）
 * - ぶつかっても **終了しない**。invincibleMs のあいだは当たらない（減点もされない）
 */
export function stepJump(run, now) {
  const events = [];
  if (run.ended) return events;
  const at = Number(now) || 0;
  if (at >= run.endsAt) {
    run.ended = true;
    events.push({ type: 'end' });
    return events;
  }
  const dt = Math.min(0.06, Math.max(0, (at - run.lastAt) / 1000));
  run.lastAt = at;

  const { config, player } = run;
  const speed = jumpSpeedAt(config, at - run.startedAt);
  run.scroll += speed * dt;

  // ジャンプの物理（等加速度の厳密解・地面に戻ったら y=0）
  // y は地面からの高さ、vy は下向き正。重力は**飛んだ瞬間の速さ**で決まる（v36・T は速さに連動）
  if (!player.grounded) {
    const gravity = Number(player.gravity) || jumpArcFor(config, speed).gravity;
    player.y += -player.vy * dt - 0.5 * gravity * dt * dt;
    player.vy += gravity * dt;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      player.grounded = true;
    }
  }

  const playerBox = jumpPlayerBox(run);

  // 岩（地上）
  for (const obstacle of [...run.obstacles]) {
    obstacle.x -= speed * dt;
    // 岩が gapPx の半分ちょっと進んだら、その「合間」にカラスを出す
    if (obstacle.crowPending && !obstacle.crowDone && run.width - obstacle.x >= (config.gapPx || 260) * 0.75) {
      obstacle.crowDone = true;
      const crow = spawnCrow(run);
      events.push({ type: 'crow', id: crow.id });
    }
    // 追い越した＝避けた
    if (obstacle.x + obstacle.w < player.x) {
      run.obstacles = run.obstacles.filter((entry) => entry !== obstacle);
      run.dodged += 1;
      events.push({ type: 'pass', count: run.dodged, kind: 'rock' });
      continue;
    }
    // 当たり（無敵中は判定しない）
    if (at >= run.invincibleUntil && overlaps(playerBox, jumpObstacleBox(obstacle, run.groundY))) {
      run.obstacles = run.obstacles.filter((entry) => entry !== obstacle);
      run.hits += 1;
      run.invincibleUntil = at + config.invincibleMs;
      events.push({ type: 'hit', hits: run.hits, score: jumpScore(run.dodged, run.hits), kind: 'rock' });
    }
  }

  // カラス（空・スクロールの crowSpeedFactor 倍で進む）
  const crowSpeed = speed * (Number(config.crowSpeedFactor) || 1);
  for (const crow of [...run.crows]) {
    crow.x -= crowSpeed * dt;
    if (crow.x + crow.w < player.x) {
      run.crows = run.crows.filter((entry) => entry !== crow);
      run.dodged += 1;
      events.push({ type: 'pass', count: run.dodged, kind: 'crow' });
      continue;
    }
    if (at >= run.invincibleUntil && crowHitsPlayer(run, crow, config)) {
      run.crows = run.crows.filter((entry) => entry !== crow);
      run.hits += 1;
      run.crowHits += 1;
      run.invincibleUntil = at + config.invincibleMs;
      events.push({ type: 'hit', hits: run.hits, score: jumpScore(run.dodged, run.hits), kind: 'crow' });
    }
  }

  // 最後に置いた岩が gapPx 進んだら次を出す（速度が上がるほど時間間隔が詰まる）
  const gap = Number(config.gapPx) || 260;
  const last = run.obstacles[run.obstacles.length - 1];
  if (!last || run.width - last.x >= gap) spawnJumpObstacle(run);

  return events;
}

/** タップでジャンプ（地面にいるときだけ）。飛んだら true */
export function triggerJump(run, now = 0) {
  if (run.ended) return false;
  if (!run.player.grounded) return false;
  if (Number(now) >= run.endsAt) return false;
  // 飛んだ瞬間の速さで空中時間を決める（横に進む距離がほぼ一定・高さは jumpHeightPx 固定）
  const at = Number(now) || 0;
  const speed = jumpSpeedAt(run.config, at - run.startedAt);
  const arc = jumpArcFor(run.config, speed);
  run.player.grounded = false;
  run.player.vy = -arc.vy;
  run.player.gravity = arc.gravity;
  run.player.landAt = at + arc.airSec * 1000;
  return true;
}

/** ジャンプの現在のスコア（避けた数 − ぶつかった数） */
export function jumpRunScore(run) {
  return jumpScore(run?.dodged, run?.hits);
}
