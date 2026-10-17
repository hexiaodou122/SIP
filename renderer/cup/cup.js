// 右上角的玻璃杯：降下 / 单击一口 / 按住一杯 / 收回

(() => {
  'use strict';

  const HOLD_MS = 220;        // 按住超过这么久算"倒一杯"
  const FULL_POUR_MS = 1500;  // 按满 1.5 秒倒完一杯
  const HIDDEN_Y = -96;
  const WATER_FULL = 15;      // 杯中水面 y（SVG 坐标）
  const WATER_EMPTY = 53;

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

  const drop = spring(HIDDEN_Y, 150, 15);
  const tilt = spring(0, 190, 17);
  const level = spring(WATER_FULL, 60, 13);

  let shown = false;
  let pressAt = null;
  let holdTimer = null;
  let streaming = false;
  let busyTimer = null;
  let running = false;
  let last = 0;

  function render() {
    hanger.style.transform = `translateY(${drop.x.toFixed(2)}px)`;
    glass.style.transform = `rotate(${tilt.x.toFixed(2)}deg)`;
    // 杯子歪了，杯里的水面依然是平的
    water.setAttribute('transform',
      `translate(0 ${level.x.toFixed(2)}) rotate(${(-tilt.x).toFixed(2)} 20 0)`);
  }

  function tick(ms) {
    const t = ms / 1000;
    const dt = Math.min(0.033, t - (last || t));
    last = t;

    if (streaming && pressAt != null) {
      const frac = Math.min(1, (performance.now() - pressAt) / FULL_POUR_MS);
      level.t = WATER_FULL + (WATER_EMPTY - WATER_FULL) * frac;
      if (frac >= 1) finishStream();
    }

    const moving = [stepSpring(drop, dt), stepSpring(tilt, dt), stepSpring(level, dt)].some(Boolean);
    render();
    if (moving || streaming || pressAt != null) {
      requestAnimationFrame(tick);
    } else {
      running = false;
      if (!shown && drop.t === HIDDEN_Y) api.send('cup-retracted');
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

  // ---------- 一口 ----------
  function sip() {
    tilt.t = -34;
    level.t = WATER_FULL + 4;
    kick();
    setTimeout(() => api.send('cup-sip', { spout: spoutPoint() }), 140);
    setTimeout(() => { tilt.t = 0; kick(); }, 330);
    setTimeout(() => { level.t = WATER_FULL; kick(); }, 700);
    setBusy(false, 600);
  }

  // ---------- 按住：一杯 ----------
  function startStream() {
    holdTimer = null;
    streaming = true;
    tilt.t = -64;
    kick();
    setTimeout(() => {
      if (streaming) api.send('stream-start', { spout: spoutPoint() });
    }, 110);
  }

  function finishStream() {
    if (!streaming) return;
    const frac = Math.min(1, (performance.now() - pressAt) / FULL_POUR_MS);
    streaming = false;
    pressAt = null;
    api.send('stream-end', { fraction: frac });
    tilt.t = 0;
    kick();
    // 倒空的杯子过一会儿再慢慢满上
    setTimeout(() => { level.t = WATER_FULL; kick(); }, 900);
    setBusy(false, 500);
  }

  hit.addEventListener('pointerdown', (e) => {
    if (!shown || e.button !== 0 || pressAt != null) return;
    hit.setPointerCapture(e.pointerId);
    pressAt = performance.now();
    setBusy(true);
    holdTimer = setTimeout(startStream, HOLD_MS);
    kick();
  });

  function release() {
    if (pressAt == null) return;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      pressAt = null;
      sip();
    } else if (streaming) {
      finishStream();
    } else {
      pressAt = null;
    }
  }
  hit.addEventListener('pointerup', release);
  hit.addEventListener('pointercancel', release);
  hit.addEventListener('lostpointercapture', release);

  // ---------- 降下 / 收回 ----------
  api.on('cup-show', () => {
    shown = true;
    drop.t = 0;
    kick();
  });

  api.on('cup-hide', () => {
    shown = false;
    if (streaming) finishStream();
    drop.t = HIDDEN_Y;
    level.t = WATER_FULL;
    kick();
  });

  render();
  if (!window.sip) window.__cup = { drop, tilt, level, state: () => ({ pressAt, streaming, running, shown }) };

  // ---------- 预览模式 ----------
  function createPreviewApi() {
    const handlers = {};
    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('beforeend',
      '<div class="help">空格：降下/收回 · 点杯子一口 · 按住倒一杯</div>');
    let on = false;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      on = !on;
      (handlers[on ? 'cup-show' : 'cup-hide'] || []).forEach((f) => f());
    });
    return {
      on(ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); },
      send(ch, d) { console.log('[cup]', ch, d); },
      invoke() { return Promise.resolve(null); },
    };
  }
})();
