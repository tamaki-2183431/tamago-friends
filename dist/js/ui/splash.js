/**
 * 起動スプラッシュ（v46）— B案「ポンポン」
 *
 * デザインハンドオフ（splash_handoff/README.md）の数値どおり vanilla JS + SVG で再実装。
 * - 1080×1920 基準のステージを画面幅基準で等倍スケール（高さが足りない画面では縮小して中央寄せ）
 * - 約1.5秒で「3匹が順に落下→着地→全員ジャンプ→ロゴが1文字ずつポップイン」で完成し、以降は静止
 *   （背景の光だまりだけはデザインどおり漂い続ける）
 * - 「アニメ完了」と「appReady（js/app.js が tamago:app-ready を発火）」の両方がそろったら
 *   0.2秒フェードで本体へ。本体初期化が極端に遅い/失敗した場合も4秒で抜ける
 * - prefers-reduced-motion は最終フレームを即表示（0.2秒フェードで遷移）
 * - ロゴの Zen Maru Gothic 900 は assets/fonts/ のサブセット woff2 を同梱（オフラインでも出る）
 */

const STAGE_W = 1080;
const STAGE_H = 1920;
const FLOOR = 1120;
const HOLD_T = 1.5; // ロゴ完成（静止）時刻
const HOLD_EXTRA = 1.0; // ロゴ完成後の余韻（v47: 実機フィードバック「文字が出たらすぐ本体へ切り替わる」への対応）
const FALL = 0.24; // 落下時間
const SPARK_T0 = 0.82;
const LOGO_T0 = 0.86;

const EGG_PATH = 'M100 10 C148 10 188 92 188 152 C188 206 150 232 100 232 C50 232 12 206 12 152 C12 92 52 10 100 10 Z';
const TINTS = {
  cream: ['#FFFBF6', '#FBE2CF'],
  pink: ['#FFF3F3', '#FBCFCF'],
  mint: ['#F4FFF8', '#C9EED8'],
};
const EGGS = [
  { id: 'main', tint: 'cream', x: 540, w: 400, t0: 0.0, hop: 0.72, sproutAtHop: true, z: 2 },
  { id: 'pink', tint: 'pink', x: 232, w: 250, t0: 0.2, hop: 0.76, sproutAtHop: false, z: 1 },
  { id: 'mint', tint: 'mint', x: 848, w: 250, t0: 0.3, hop: 0.8, sproutAtHop: false, z: 1 },
];
const LOGO_TEXT = 'たまごフレンズ';
const SPARK_COLORS = ['#FFFFFF', '#FFF2B0', '#FFD0B0'];
const SPARK_PATH = 'M0 -10 Q1.5 -1.5 10 0 Q1.5 1.5 0 10 Q-1.5 1.5 -10 0 Q-1.5 -1.5 0 -10 Z';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInQuad = (t) => t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** 着地インパクトのつぶれ。k>0 でつぶれる（README: scaleX=1+0.8k / scaleY=1-k） */
function squash(t, t0, dur = 0.22, amt = 0.2) {
  const p = (t - t0) / dur;
  if (p <= 0 || p >= 1) return [1, 1];
  const k = Math.sin(p * Math.PI * 2) * (1 - p) * amt;
  return [1 + k * 0.8, 1 - k];
}

function svg(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** たまご1匹の SVG（輪郭・塗り・ハイライト・顔・芽）。目は「閉じ/開き」の2グループを切替 */
function eggSvg(egg) {
  const [a, b] = TINTS[egg.tint];
  const s = svg('svg', { viewBox: '0 -24 200 264', overflow: 'visible' });
  const grad = svg('linearGradient', { id: `splash-g-${egg.id}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(svg('stop', { offset: 0, 'stop-color': a }));
  grad.appendChild(svg('stop', { offset: 1, 'stop-color': b }));
  const defs = svg('defs', {});
  defs.appendChild(grad);
  s.appendChild(defs);
  s.appendChild(svg('path', { d: EGG_PATH, fill: `url(#splash-g-${egg.id})`, stroke: '#B8692E', 'stroke-width': 7, 'stroke-linejoin': 'round' }));
  s.appendChild(svg('path', { d: 'M56 70 C48 88 44 108 44 124', stroke: '#fff', 'stroke-width': 11, 'stroke-linecap': 'round', fill: 'none', opacity: 0.9 }));
  for (const side of [-1, 1]) {
    s.appendChild(svg('ellipse', { cx: 100 + side * 38, cy: 158, rx: 11, ry: 6.5, fill: '#F6A99A', opacity: 0.55 }));
  }
  const eyesShut = svg('g', { opacity: 1 });
  for (const side of [-1, 1]) {
    eyesShut.appendChild(svg('path', {
      d: `M${100 + side * 26 - 8} 142 Q${100 + side * 26} 148 ${100 + side * 26 + 8} 142`,
      stroke: '#C0703A', 'stroke-width': 4.5, fill: 'none', 'stroke-linecap': 'round',
    }));
  }
  const eyesOpen = svg('g', { opacity: 0 });
  for (const side of [-1, 1]) {
    eyesOpen.appendChild(svg('ellipse', { cx: 100 + side * 26, cy: 142, rx: 7.5, ry: 7.5, fill: '#C0703A' }));
  }
  s.appendChild(eyesShut);
  s.appendChild(eyesOpen);
  s.appendChild(svg('path', { d: 'M86 160 Q100 172 114 160', stroke: '#C0703A', 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round' }));
  const sprout = svg('g', { transform: 'translate(100 14) scale(0)' });
  sprout.appendChild(svg('path', { d: 'M0 2 C-6 -14 -22 -18 -32 -12 C-26 -2 -12 4 0 2 Z', fill: '#6CC48E' }));
  sprout.appendChild(svg('path', { d: 'M0 2 C6 -14 22 -18 32 -12 C26 -2 12 4 0 2 Z', fill: '#9ADBAF' }));
  s.appendChild(sprout);
  return { node: s, eyesShut, eyesOpen, sprout };
}

(function initSplash() {
  const overlay = document.getElementById('splash');
  const stage = document.getElementById('splashStage');
  if (!overlay || !stage) return;

  try {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const parts = EGGS.map((egg) => {
      const wrap = document.createElement('div');
      wrap.className = 'splash-egg-wrap';
      wrap.style.zIndex = egg.z;
      wrap.style.visibility = 'hidden'; // 1フレーム目の render() まで隠す（v47: 初期フレームの静止画フラッシュ防止）
      const body = document.createElement('div');
      body.className = 'splash-egg';
      body.style.left = `${egg.x - egg.w / 2}px`;
      body.style.top = `${FLOOR - egg.w * 1.2}px`;
      body.style.width = `${egg.w}px`;
      body.style.height = `${egg.w * 1.2}px`;
      const piece = eggSvg(egg);
      piece.node.setAttribute('width', egg.w);
      piece.node.setAttribute('height', egg.w * 1.2 * 1.1);
      body.appendChild(piece.node);
      wrap.appendChild(body);
      stage.appendChild(wrap);
      const shadow = document.createElement('div');
      shadow.className = 'splash-shadow';
      shadow.style.top = `${FLOOR - 18}px`;
      shadow.style.opacity = '0';
      stage.appendChild(shadow);
      return { egg, wrap, body, shadow, ...piece };
    });

    const sparkles = Array.from({ length: 6 }, (_, i) => {
      const s = svg('svg', { viewBox: '-10 -10 20 20', class: 'splash-spark' });
      s.appendChild(svg('path', { d: SPARK_PATH, fill: SPARK_COLORS[i % SPARK_COLORS.length] }));
      s.style.display = 'none';
      stage.appendChild(s);
      return s;
    });

    const logo = document.createElement('div');
    logo.className = 'splash-logo';
    const chars = LOGO_TEXT.split('').map((ch) => {
      const span = document.createElement('span');
      span.className = 'splash-logo__ch';
      span.textContent = ch;
      logo.appendChild(span);
      return span;
    });
    stage.appendChild(logo);

    const glow1 = overlay.querySelector('.splash-glow--1');
    const glow2 = overlay.querySelector('.splash-glow--2');

    /** ステージを画面に収める（幅基準。高さが足りない画面は縮小して中央寄せ） */
    function fit() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const s = Math.min(vw / STAGE_W, vh / STAGE_H);
      const dx = (vw - STAGE_W * s) / 2;
      const dy = (vh - STAGE_H * s) / 2;
      stage.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    }
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);

    function render(t, driftT) {
      const drift = Math.sin(driftT * 1.4) * 20;
      if (glow1) glow1.style.transform = `translateX(${drift}px)`;
      if (glow2) glow2.style.transform = `translateY(${-drift}px)`;
      for (const part of parts) {
        const { egg } = part;
        if (t < egg.t0) {
          part.wrap.style.visibility = 'hidden';
          part.shadow.style.opacity = '0';
          continue;
        }
        part.wrap.style.visibility = 'visible';
        const p = clamp((t - egg.t0) / FALL, 0, 1);
        let y = -700 * (1 - easeInQuad(p));
        const rb = clamp((t - egg.t0 - FALL) / 0.22, 0, 1);
        if (rb > 0 && rb < 1) y -= Math.sin(rb * Math.PI) * egg.w * 0.14;
        const hp = clamp((t - egg.hop) / 0.24, 0, 1);
        if (hp > 0 && hp < 1) y -= Math.sin(hp * Math.PI) * 60;
        let [sx, sy] = squash(t, egg.t0 + FALL, 0.2, 0.22);
        const [hx, hy] = squash(t, egg.hop + 0.24, 0.18, 0.12);
        sx *= hx;
        sy *= hy;
        part.wrap.style.transform = `translateY(${y}px)`;
        part.body.style.transform = `scale(${sx}, ${sy})`;
        const open = t > egg.t0 + FALL + 0.05;
        part.eyesShut.setAttribute('opacity', open ? '0' : '1');
        part.eyesOpen.setAttribute('opacity', open ? '1' : '0');
        const sproutP = egg.sproutAtHop ? easeOutBack(clamp((t - egg.hop) / 0.2, 0, 1)) : 1;
        part.sprout.setAttribute('transform', `translate(100 14) scale(${Math.max(0.001, sproutP)})`);
        const k = 0.4 + 0.6 * p;
        part.shadow.style.left = `${egg.x - (egg.w * k) / 2}px`;
        part.shadow.style.width = `${egg.w * k}px`;
        part.shadow.style.opacity = String(p);
      }
      const sp = (t - SPARK_T0) / 0.45;
      if (sp <= 0 || sp >= 1) {
        for (const s of sparkles) s.style.display = 'none';
      } else {
        const e = easeOutCubic(sp);
        sparkles.forEach((s, i) => {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 2 + 0.3;
          const r = 150 + (300 - 150) * e;
          const size = (1 - sp) * (i % 2 ? 34 : 48);
          s.style.display = 'block';
          s.setAttribute('width', String(size));
          s.setAttribute('height', String(size));
          s.style.left = `${540 + Math.cos(a) * r - size / 2}px`;
          s.style.top = `${740 + Math.sin(a) * r - size / 2}px`;
        });
      }
      chars.forEach((span, i) => {
        const p = clamp((t - (LOGO_T0 + i * 0.05)) / 0.32, 0, 1);
        const e = easeOutBack(p);
        span.style.opacity = String(Math.min(1, p * 3));
        span.style.transform = `translateY(${(1 - e) * 70}px) scale(${0.4 + 0.6 * e})`;
      });
    }

    let animDone = false;
    let appReady = Boolean(window.__tamagoAppReady);
    let exited = false;

    function exit() {
      if (exited) return;
      exited = true;
      overlay.dataset.phase = 'out';
      setTimeout(() => overlay.remove(), 240);
    }
    /** アニメ完了とappReadyの両方がそろったら、余韻（HOLD_EXTRA）を見せてから抜ける */
    let exitTimer = null;
    function scheduleExit() {
      if (exited || exitTimer) return;
      exitTimer = setTimeout(exit, HOLD_EXTRA * 1000);
    }
    window.addEventListener('tamago:app-ready', () => {
      appReady = true;
      if (animDone) scheduleExit();
    });
    // 本体初期化が極端に遅い/失敗しても、アプリを閉ざさないための安全弁
    setTimeout(() => {
      appReady = true;
      if (animDone) scheduleExit();
    }, 4000);

    if (reduced) {
      render(HOLD_T + 0.1, HOLD_T + 0.1);
      animDone = true;
      if (appReady) exit();
      window.addEventListener('tamago:app-ready', () => exit());
      return;
    }

    let start = null;
    function frame(ts) {
      if (start === null) start = ts;
      const t = Math.min((ts - start) / 1000, HOLD_T);
      render(t, t);
      if (t >= HOLD_T) {
        animDone = true;
        holdLoop(); // 余韻の間も光だまりは漂わせ続ける
        if (appReady) scheduleExit();
        return;
      }
      requestAnimationFrame(frame);
    }
    // 静止後は光だまりの漂いだけを続ける（本体待ちの間も最終フレームを保つ）
    function holdLoop() {
      const held = performance.now();
      function drift(ts) {
        render(HOLD_T, HOLD_T + (ts - held) / 1000);
        if (!exited) requestAnimationFrame(drift);
      }
      requestAnimationFrame(drift);
    }

    // ロゴフォントを待ってから開始（同梱フォントなので基本は即時。遅くても800msで進める）
    const fontLoad = document.fonts
      ? document.fonts.load('900 64px "ZMG Splash"', LOGO_TEXT)
      : Promise.resolve();
    Promise.race([fontLoad, new Promise((r) => setTimeout(r, 300))]).then(
      () => requestAnimationFrame(frame),
      () => requestAnimationFrame(frame)
    );
  } catch (error) {
    console.error('splash init failed', error);
    overlay.remove();
  }
})();
