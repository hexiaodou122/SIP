// 右上角的玻璃杯：鼠标一到就降下 / 按下就倒水、按多久倒多久 / 收回

(() => {
  'use strict';

  const HIDDEN_Y = -96;
  const WATER_FULL = 15;      // 杯中水面 y（SVG 坐标）
  const WATER_POURING = 30;   // 倒水时杯里剩的水（神奇的杯子，永远倒不完）
  const MAX_POUR_MS = 30000;

  const api = window.sip || createPreviewApi();

  const hanger = document.getElementById('hanger');
  const glass = document.getElementById('glass');
  const water = document.getElementById('water');
  const spout = document.getElementById('spout');
  const hit = document.getElementById('hit');

  // 弹簧：k 越大越快，c 越小越弹
  function spring(x, k, c) {
    return { x, v: 0, t: x, k, c };
  }
  function stepSpring(s, dt) {
    const sub = 3;
    for (let i = 0; i < sub; i++) {
      const h = dt / sub;
      const a = s.k * (s.t - s.x) - s.c * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
    return Math.abs(s.t - s.x) > 0.01 || Math.abs(s.v) > 0.01;
  }

  const drop = spring(HIDDEN_Y, 280, 24);
  const tilt = spring(0, 190, 17);
  const level = spring(WATER_FULL, 60, 13);
  const pop = spring(1, 320, 22);   // 点出来的杯子：从小到大"冒"出来
  let mode = 'corner';

  let shown = false;
  let pressAt = null;
  let pourSent = false;
  let busyTimer = null;
  let running = false;
  let last = 0;

  function render() {
    const sc = 0.55 + 0.45 * Math.max(0, pop.x);
    hanger.style.transform = `translateY(${drop.x.toFixed(2)}px) scale(${sc.toFixed(3)})`;
    hanger.style.opacity = Math.max(0, Math.min(1, pop.x)).toFixed(3);
    glass.style.transform = `rotate(${tilt.x.toFixed(2)}deg)`;
    // 杯子歪了，杯里的水面依然是平的
    water.setAttribute('transform',
      `translate(0 ${level.x.toFixed(2)}) rotate(${(-tilt.x).toFixed(2)} 20 0)`);
  }

  function tick(ms) {
    const t = ms / 1000;
    const dt = Math.min(0.033, t - (last || t));
    last = t;

    if (pressAt != null) {
      // 按得越久，杯子歪得越多，像在慢慢加大倾倒
      const held = (performance.now() - pressAt) / 1000;
      tilt.t = -52 - Math.min(1, held / 1.2) * 26;
      if (held * 1000 > MAX_POUR_MS) release();
    }

    const moving = [stepSpring(drop, dt), stepSpring(tilt, dt), stepSpring(level, dt), stepSpring(pop, dt)].some(Boolean);
    render();
    if (moving || pressAt != null) {
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

  function spoutPoint() {
    const r = spout.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function setBusy(busy, delay = 0) {
    clearTimeout(busyTimer);
    if (busy) api.send('cup-busy', true);
    else busyTimer = setTimeout(() => api.send('cup-busy', false), delay);
  }

  // ---------- 按下就倒，松手就停 ----------

  hit.addEventListener('pointerdown', (e) => {
    if (!shown || e.button !== 0 || pressAt != null) return;
    hit.setPointerCapture(e.pointerId);
    startPour();
  });

  function startPour() {
    pressAt = performance.now();
    pourSent = false;
    setBusy(true);
    tilt.t = -52;
    level.t = WATER_POURING;
    kick();
    // 杯口转到朝下的位置再出水，水柱才是从杯沿流出来的
    setTimeout(() => {
      if (pressAt == null) return;
      pourSent = true;
      api.send('pour-start', { spout: spoutPoint() });
    }, 70);
  }

  function release() {
    if (pressAt == null) return;
    const seconds = (performance.now() - pressAt) / 1000;
    pressAt = null;
    if (!pourSent) api.send('pour-start', { spout: spoutPoint() });
    api.send('pour-end', { seconds });
    tilt.t = 0;
    kick();
    setTimeout(() => { level.t = WATER_FULL; kick(); }, 500);
    setBusy(false, 400);
  }
  hit.addEventListener('pointerup', release);
  hit.addEventListener('pointercancel', release);
  hit.addEventListener('lostpointercapture', release);

  // ---------- 降下 / 收回 ----------
  api.on('cup-show', (o) => {
    const opts = o || {};
    mode = opts.mode || 'corner';
    shown = true;
    if (mode === 'here') {
      // 在点的地方冒出来，轻轻落一下
      drop.x = -12; drop.v = 0; drop.t = 0;
      pop.x = 0; pop.v = 0; pop.t = 1;
    } else {
      if (pop.x < 0.05) { drop.x = HIDDEN_Y; drop.v = 0; } // 刚才是点出来的杯子，已经消失
      pop.x = 1; pop.v = 0; pop.t = 1;
      drop.t = 0;
    }
    if (opts.pour && pressAt == null) startPour();
    kick();
  });

  // 在桌面上按住倒水时，松手由主进程告诉杯子
  api.on('cup-release', () => release());

  api.on('cup-hide', () => {
    shown = false;
    release();
    if (mode === 'here') { pop.t = 0; drop.t = -16; } // 淡出时轻轻往上收
    else drop.t = HIDDEN_Y;
    level.t = WATER_FULL;
    kick();
  });

  render();
  if (!window.sip) window.__cup = { drop, tilt, level, state: () => ({ pressAt, running, shown }) };

  // ---------- 预览模式 ----------
  function createPreviewApi() {
    const handlers = {};
    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('beforeend',
      '<div class="help">空格：降下/收回 · 按住杯子倒水，松手停</div>');
    let on = false;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      on = !on;
      (handlers[on ? 'cup-show' : 'cup-hide'] || []).forEach((f) => f({ mode: 'corner' }));
    });
    return {
      on(ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); },
      send(ch, d) { console.log('[cup]', ch, d); },
      invoke() { return Promise.resolve(null); },
    };
  }
})();
