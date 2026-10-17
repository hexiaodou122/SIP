// 像素玻璃杯：鼠标一到右上角就降下 / 点桌面在原地冒出 / 按下就倒水、按多久倒多久
// 杯子画在 40×40 的像素画布上（1 像素 = 3 屏幕 px，和水窗口同一个网格）。
// 倒水时，杯口下面那一段水柱在这里画；落到杯子窗口外面的部分由桌面层的水窗口画，
// 两边用同样的起点、起始时间和重力，所以是同一条水柱。

(() => {
  'use strict';

  const PX = window.SipConstants.PX;               // 和 water.js / main.js 一样
  const GRAVITY = 2600;       // 和 water.js 一样
  const STREAM_V0 = 160;      // 和 water.js 一样
  const N = 40;               // 画布 40×40 像素
  document.documentElement.style.setProperty('--pixel', `${PX}px`);
  const HIDDEN_Y = -96;       // 收起时往上藏多少（屏幕 px）
  const POUR_ANGLE = -60;     // 倒水时杯子歪多少度
  const ANGLE_STEP = 10;      // 像素杯子按 10° 一档转，转起来是"一格一格"的
  const FILL_FULL = 0.78;
  const FILL_POURING = 0.42;
  const MAX_POUR_MS = 30000;

  // 杯子形状（杯子自己的坐标：宽 13、高 16，左下角是转轴）
  const CUP_W = 13, CUP_H = 16;
  const ORIGIN = { x: 16, y: 6 };                       // 直立时杯子左上角在画布里的位置
  const PIVOT = { x: ORIGIN.x, y: ORIGIN.y + CUP_H };   // 左下角

  const COL = {
    outline: [0x1e, 0x3a, 0x52],
    rim: [0xe9, 0xf8, 0xff],
    glass: [0xd6, 0xee, 0xf8],
    base: [0xa8, 0xd5, 0xea],
    shine: [0xff, 0xff, 0xff],
    water: [0x4f, 0xb4, 0xdf],
    waterTop: [0x9f, 0xe0, 0xf4],
  };
  const STREAM_A = '#e9fbff';
  const STREAM_B = '#8fd9f2';

  const api = window.sip || createPreviewApi();
  const canvas = document.getElementById('cup');
  const ctx = canvas.getContext('2d');
  const hit = document.getElementById('hit');

  // ---------- 生成某个角度、某个水量的杯子 ----------

  const cache = new Map();

  function cupFrame(angleDeg, fill) {
    const key = angleDeg + '|' + fill.toFixed(2);
    if (cache.has(key)) return cache.get(key);

    const th = angleDeg * Math.PI / 180;
    const cos = Math.cos(-th), sin = Math.sin(-th);
    const cells = new Array(N * N).fill(null);
    const interior = [];

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        // 反向旋转回杯子自己的坐标
        const dx = x + 0.5 - PIVOT.x, dy = y + 0.5 - PIVOT.y;
        const u = dx * cos - dy * sin;
        const v = dx * sin + dy * cos + CUP_H;
        if (v < 0 || v > CUP_H) continue;
        const left = (v / CUP_H) * 1.6;
        const right = CUP_W - (v / CUP_H) * 1.6;
        if (u < left || u > right) continue;

        let c;
        if (u - left < 1 || right - u < 1 || v > CUP_H - 1) c = 'outline';
        else if (v < 1) c = 'rim';
        else if (v > CUP_H - 2.6) c = 'base';
        else if (u - left > 1.6 && u - left < 2.6 && v > 2 && v < 11) c = 'shine';
        else { c = 'glass'; interior.push(y * N + x); }
        cells[y * N + x] = c;
      }
    }

    // 杯里的水：水面永远是水平的——从最低的格子开始往上填
    interior.sort((a, b) => Math.floor(b / N) - Math.floor(a / N) || (a % N) - (b % N));
    const n = Math.round(interior.length * fill);
    let topRow = Infinity;
    for (let i = 0; i < n; i++) {
      cells[interior[i]] = 'water';
      topRow = Math.min(topRow, Math.floor(interior[i] / N));
    }
    for (let i = 0; i < n; i++) {
      if (Math.floor(interior[i] / N) === topRow) cells[interior[i]] = 'waterTop';
    }

    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const g = cv.getContext('2d');
    const im = g.createImageData(N, N);
    cells.forEach((c, i) => {
      if (!c) return;
      const [r, gg, b] = COL[c];
      im.data[i * 4] = r; im.data[i * 4 + 1] = gg; im.data[i * 4 + 2] = b; im.data[i * 4 + 3] = 255;
    });
    g.putImageData(im, 0, 0);
    cache.set(key, cv);
    return cv;
  }

  // 倒水角度下的杯口（出水口），画布像素坐标
  function spoutCell() {
    const th = POUR_ANGLE * Math.PI / 180;
    const x = PIVOT.x - (-CUP_H) * Math.sin(th);
    const y = PIVOT.y + (-CUP_H) * Math.cos(th);
    return { x: Math.round(x - 0.5), y: Math.round(y) };
  }

  // ---------- 弹簧 ----------

  function spring(x, k, c) { return { x, v: 0, t: x, k, c }; }
  function stepSpring(s, dt) {
    for (let i = 0; i < 3; i++) {
      const h = dt / 3;
      const a = s.k * (s.t - s.x) - s.c * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
    return Math.abs(s.t - s.x) > 0.01 || Math.abs(s.v) > 0.01;
  }

  const drop = spring(HIDDEN_Y, 280, 24);
  const tilt = spring(0, 210, 19);
  const fill = spring(FILL_FULL, 40, 11);
  const pop = spring(1, 320, 22);

  let mode = 'corner';
  let shown = false;
  let pressAt = null;
  let pourSent = false;
  let busyTimer = null;
  let running = false;
  let last = 0;
  let stream = null;          // 杯口下这一段水柱 { x, y, t0, tEnd }

  function render(nowS) {
    ctx.clearRect(0, 0, N, N);
    canvas.style.opacity = Math.max(0, Math.min(1, pop.x)).toFixed(3);
    const off = Math.round(drop.x / PX);
    const a = Math.round(tilt.x / ANGLE_STEP) * ANGLE_STEP;
    const f = Math.round(Math.max(0, Math.min(1, fill.x)) * 20) / 20;
    ctx.drawImage(cupFrame(a, f), 0, off);

    if (stream) {
      const t1 = nowS - stream.t0;
      const head = stream.y + STREAM_V0 * t1 + 0.5 * GRAVITY * t1 * t1;
      const tau = stream.tEnd == null ? 0 : nowS - stream.tEnd;
      const tail = stream.y + STREAM_V0 * tau + 0.5 * GRAVITY * tau * tau;
      const top = Math.round(tail / PX), bot = Math.round(head / PX);
      for (let y = top; y <= bot && y < N; y++) {
        ctx.fillStyle = STREAM_A; ctx.fillRect(stream.x - 1, y, 1, 1);
        ctx.fillStyle = STREAM_B; ctx.fillRect(stream.x, y, 1, 1);
      }
      if (top >= N) stream = null;
    }
  }

  function tick(ms) {
    const t = ms / 1000;
    const dt = Math.min(0.033, t - (last || t));
    last = t;
    if (pressAt != null && performance.now() - pressAt > MAX_POUR_MS) release();
    const moving = [stepSpring(drop, dt), stepSpring(tilt, dt), stepSpring(fill, dt), stepSpring(pop, dt)].some(Boolean);
    render(performance.now() / 1000);
    if (moving || pressAt != null || stream) {
      requestAnimationFrame(tick);
    } else {
      running = false;
      if (!shown) api.send('cup-retracted');
    }
  }

  function kick() {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  function setBusy(busy, delay = 0) {
    clearTimeout(busyTimer);
    if (busy) api.send('cup-busy', true);
    else busyTimer = setTimeout(() => api.send('cup-busy', false), delay);
  }

  // ---------- 按下就倒，松手就停 ----------

  function startPour() {
    pressAt = performance.now();
    pourSent = false;
    setBusy(true);
    tilt.t = POUR_ANGLE;
    fill.t = FILL_POURING;
    kick();
    // 杯子转到位再出水，水柱从杯口正下方开始
    setTimeout(() => {
      if (pressAt == null) return;
      beginStream();
    }, 120);
  }

  function beginStream() {
    pourSent = true;
    const s = spoutCell();
    stream = { x: s.x, y: s.y * PX, t0: performance.now() / 1000, tEnd: null };
    api.send('pour-start', { spout: { x: s.x * PX, y: s.y * PX } });
    kick();
  }

  function release() {
    if (pressAt == null) return;
    api.send('cup-drag-end');
    const seconds = (performance.now() - pressAt) / 1000;
    pressAt = null;
    if (!pourSent) beginStream();
    if (stream) stream.tEnd = performance.now() / 1000;
    api.send('pour-end', { seconds });
    tilt.t = 0;
    kick();
    setTimeout(() => { fill.t = FILL_FULL; kick(); }, 500);
    setBusy(false, 400);
  }

  hit.addEventListener('pointerdown', (e) => {
    if (!shown || e.button !== 0 || pressAt != null) return;
    hit.setPointerCapture(e.pointerId);
    api.send('cup-drag-start');
    startPour();
  });
  hit.addEventListener('pointerup', e => { if (e.button === 0) release(); });
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!shown) return;
    release();
    api.send('open-collection');
  });
  hit.addEventListener('pointercancel', release);
  hit.addEventListener('lostpointercapture', release);

  // ---------- 出现 / 收起 ----------

  api.on('cup-show', (o) => {
    const opts = o || {};
    mode = opts.mode || 'corner';
    shown = true;
    if (mode === 'here') {
      drop.x = -12; drop.v = 0; drop.t = 0;          // 在点的地方冒出来，轻轻落一格
      pop.x = 0; pop.v = 0; pop.t = 1;
    } else {
      if (pop.x < 0.05) { drop.x = HIDDEN_Y; drop.v = 0; }
      pop.x = 1; pop.v = 0; pop.t = 1;
      drop.t = 0;
    }
    if (opts.pour && pressAt == null) startPour();
    kick();
  });

  api.on('cup-release', () => release());

  api.on('cup-hide', () => {
    shown = false;
    release();
    if (mode === 'here') { pop.t = 0; drop.t = -12; }
    else drop.t = HIDDEN_Y;
    fill.t = FILL_FULL;
    kick();
  });

  render(performance.now() / 1000);
  if (!window.sip) window.__cup = { cupFrame, spoutCell, drop, tilt, fill, pop };

  // ---------- 预览模式 ----------
  function createPreviewApi() {
    const handlers = {};
    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('beforeend', '<div class="help">空格：降下/收回 · 按住杯子倒水，松手停</div>');
    let on = false;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      on = !on;
      (handlers[on ? 'cup-show' : 'cup-hide'] || []).forEach((f) => f({ mode: 'corner' }));
    });
    return {
      on(ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); },
      send(ch, d) { console.log('[cup]', ch, JSON.stringify(d)); },
      invoke() { return Promise.resolve(null); },
    };
  }
})();
