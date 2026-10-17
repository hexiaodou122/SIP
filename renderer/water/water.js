// 水窗口（铺在桌面层，所有窗口都在它上面）—— 像素风
// 整个画面画在一张低分辨率画布上（1 个像素 = 屏幕上 PX×PX），再用 pixelated 放大：
//   水：不透明平涂，5 层颜色台阶；水面一条浅色像素线 + 几颗白色高光
//   像素鱼、像素气泡、像素水柱 / 水花 / 蒸汽
// 在 Electron 里由主进程驱动；直接用浏览器打开时进入"预览模式"，用键盘调试。

(() => {
  'use strict';

  // ---- 可调常量 ----
  const PX = window.SipConstants.PX;                  // 像素格大小（屏幕 px）。杯子窗口和主进程用同一个值，才能对齐
  let FULL_RATIO = window.SipConstants.WATER_FULL_RATIO;
  let BASE_RATIO = window.SipConstants.WATER_BASE_RATIO;        // 满水位 = 屏幕高度的几分之几（主进程会传来，见 main.js WATER_FULL_RATIO）
  const GRAVITY = 2600;          // 水柱下落重力（px/s²），杯子窗口里用同一个值
  const STREAM_V0 = 160;         // 水柱出杯口的初速度（px/s），杯子窗口里用同一个值
  const STEP = 4;                // 水面计算采样（屏幕 px）
  const IDLE_FPS = 20;

  // 调色板（不透明）
  const C = {
    line: rgb(0xbf, 0xef, 0xfa),     // 水面浅色像素线
    hi: rgb(0xff, 0xff, 0xff),       // 白色高光
    bandA: rgb(0x4f, 0xb4, 0xdf),    // 第 1 层：水面下几行，跟着波浪走
    bandB: rgb(0x36, 0x8f, 0xc9),    // 第 2 层
    bandC: rgb(0x27, 0x6c, 0xab),    // 第 3 层：深处
    foam: '#e9fbff',
    streamA: '#e9fbff',
    streamB: '#8fd9f2',
    bubble: '#d4f4ff',
    steam: '#e8f6fb',
  };
  const BAND_A_ROWS = 2;             // 第 1 层厚度（像素行）
  const BAND_C_FROM = 0.42;          // 鱼的深水着色起点，与五层水体配色独立

  const TAU = Math.PI * 2;
  const canvas = document.getElementById('water');
  const ctx = canvas.getContext('2d');

  const api = window.sip || createPreviewApi();

  let W = 0, H = 0;          // 屏幕尺寸（px）
  let LW = 0, LH = 0;        // 像素画布尺寸
  let img = null, buf = null;
  let menuBar = 25;
  let settings = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
  let stateMl = 0;
  let paused = false;
  let ready = false;

  const level = { x: 0, v: 0 };
  let lastTarget = 0;

  const flights = [];
  const ripples = [];
  const drops = [];
  const bubbles = [];
  const steams = [];
  let fullFx = null;
  let evap = null;

  let ys = new Float32Array(0);
  let baseY = 0;
  let now = performance.now() / 1000;
  let lastFrame = 0;
  let lastDraw = 0;
  let nextAmbientBubble = 0;

  let cursor = null;
  let lastCursorFx = 0;
  let lastWake = 0;

  const highlights = Array.from({ length: 9 }, (_, i) => ({
    u: (i + Math.random() * 0.6) / 9,          // 在屏幕宽度上的位置（0..1）
    len: 1 + Math.floor(Math.random() * 3),
    speed: (Math.random() < 0.5 ? -1 : 1) * (0.004 + Math.random() * 0.006),
    ph: Math.random() * TAU,
  }));

  // ---------- 几何 ----------

  const levelToY = (lv) => H - H * (BASE_RATIO + lv * (FULL_RATIO - BASE_RATIO)); // 环境底水不计入喝水量

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    LW = Math.ceil(W / PX);
    LH = Math.ceil(H / PX);
    canvas.width = LW;
    canvas.height = LH;
    canvas.style.width = LW * PX + 'px';
    canvas.style.height = LH * PX + 'px';
    ctx.imageSmoothingEnabled = false;
    img = ctx.createImageData(LW, LH);
    buf = new Uint32Array(img.data.buffer);
    ys = new Float32Array(Math.ceil(W / STEP) + 2);
  }

  // ---------- 水面 ----------

  function wave(x, t) {
    return 2.8 * Math.sin(x * TAU / 1150 + t * TAU / 11.0)
      + 1.8 * Math.sin(x * TAU / 640 - t * TAU / 8.5 + 1.3)
      + 1.0 * Math.sin(x * TAU / 330 + t * TAU / 9.7 + 4.1);
  }

  function rippleAt(x, t) {
    let y = 0;
    for (const r of ripples) {
      const age = t - r.t0;
      if (age < 0) continue;
      const front = r.speed * age;
      const width = r.w + age * r.spread;
      const e = (Math.abs(x - r.x) - front) / width;
      if (e > 3 || e < -3) continue;
      y += r.amp * Math.exp(-age / r.tau) * Math.cos(e * width * r.k) * Math.exp(-e * e);
    }
    return y;
  }

  function addRipple(x, amp, o = {}) {
    ripples.push({
      x, amp, t0: now + (o.delay || 0),
      speed: o.speed || 110, k: TAU / (o.wl || 48), tau: o.tau || 1.1,
      w: o.w || 22, spread: o.spread || 18,
    });
    if (ripples.length > 50) ripples.shift();
  }

  function surfaceAt(x) {
    const f = x / STEP;
    const i = Math.max(0, Math.min(ys.length - 2, Math.floor(f)));
    return ys[i] + (ys[i + 1] - ys[i]) * clamp(f - i, 0, 1);
  }

  function splash(x, y, strength = 1) {
    const n = Math.round(3 + 5 * strength);
    for (let i = 0; i < n; i++) {
      drops.push({
        x: x + (Math.random() - 0.5) * 6, y: y - 2,
        vx: (Math.random() - 0.5) * 130 * strength,
        vy: -(90 + Math.random() * 170) * Math.sqrt(strength),
        age: 0,
      });
    }
    if (drops.length > 160) drops.splice(0, drops.length - 160);
  }

  function addBubble(x, y, r) {
    bubbles.push({ x, y, r: r || 1 + Math.random() * 2.5, vy: -10, wob: 0.5 + Math.random(), ph: Math.random() * TAU });
    if (bubbles.length > 120) bubbles.shift();
  }

  // ---------- 下落的水：竖直往下，和杯子窗口里那一段是同一条 ----------

  function headY(f, tau) {
    return f.y0 + f.v0 * tau + 0.5 * GRAVITY * tau * tau;
  }

  function landTau(f) {
    const surface = levelToY(Math.min(1, level.x)) - 1;
    const dy = surface - f.y0;
    if (dy <= 0) return 0;
    return (-f.v0 + Math.sqrt(f.v0 * f.v0 + 2 * GRAVITY * dy)) / GRAVITY;
  }

  function addSlug(from, ml, kind) {
    const drop = kind === 'drop';
    flights.push({
      kind, x0: from.x, y0: from.y, v0: drop ? 40 : STREAM_V0,
      tStart: now, tEnd: now + (drop ? 0.03 : 0.2),
      ml, rate: null, landT: null, landedMl: 0, lastFx: 0,
    });
  }

  function startStream(from, rate) {
    flights.push({
      kind: 'stream', x0: from.x, y0: from.y, v0: STREAM_V0,
      tStart: now, tEnd: null, ml: null, rate, landT: null, landedMl: 0, lastFx: 0,
    });
  }

  function endStream(ml) {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      if (f.kind === 'stream' && f.tEnd == null) { f.tEnd = now; f.ml = ml; return; }
    }
  }

  function updateFlights() {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      const tl = landTau(f);
      f.tl = tl;
      if (f.landT == null && now - f.tStart >= tl) {
        f.landT = now;
        const y = headY(f, tl);
        splash(f.x0, y, f.kind === 'stream' ? 1.2 : f.kind === 'drop' ? 0.5 : 0.85);
        addRipple(f.x0, f.kind === 'drop' ? 2.5 : 3.6, { tau: 1.2 });
        for (let b = 0; b < (f.kind === 'drop' ? 2 : 5); b++) {
          addBubble(f.x0 + (Math.random() - 0.5) * 12, y + 10 + Math.random() * 30);
        }
        if (f.kind !== 'stream') f.landedMl = f.ml;
        drip();
      }
      if (f.landT != null && f.kind === 'stream' && (f.tEnd == null || now - f.tEnd < tl)) {
        f.landedMl = f.rate * (now - f.landT);
        if (f.ml != null) f.landedMl = Math.min(f.landedMl, f.ml);
        if (now - f.lastFx > 0.08) {
          f.lastFx = now;
          const y = headY(f, tl);
          addRipple(f.x0 + (Math.random() - 0.5) * 8, 1.8, { tau: 0.9, speed: 95 });
          splash(f.x0, y, 0.4);
          addBubble(f.x0 + (Math.random() - 0.5) * 12, y + 15 + Math.random() * 60);
        }
      }
      if (f.tEnd != null && f.landT != null && now - f.tEnd >= tl) {
        f.landedMl = f.ml;
        flights.splice(i, 1);
      }
    }
  }

  function targetLevel() {
    let ml = stateMl;
    for (const f of flights) {
      if (f.ml != null) ml -= f.ml - f.landedMl;
      else ml += f.landedMl;
    }
    return Math.max(0, Math.min(1, ml / settings.goalMl));
  }

  // ---------- 鼠标划水 ----------

  function setCursor(c) {
    const t = performance.now() / 1000;
    if (!c) { cursor = null; return; }
    if (cursor && t - cursor.t < 0.25) {
      const dt = Math.max(0.008, t - cursor.t);
      cursor.vx = cursor.vx * 0.4 + ((c.x - cursor.x) / dt) * 0.6;
      cursor.vy = cursor.vy * 0.4 + ((c.y - cursor.y) / dt) * 0.6;
      cursor.x = c.x; cursor.y = c.y; cursor.t = t;
    } else {
      cursor = { x: c.x, y: c.y, vx: 0, vy: 0, t };
    }
  }

  const cursorLive = () => cursor && now - cursor.t < 0.3;

  function updateCursor() {
    if (!cursor) return;
    if (now - cursor.t > 0.12) { cursor.vx *= 0.5; cursor.vy *= 0.5; }
    const sp = Math.hypot(cursor.vx, cursor.vy);
    const sy = surfaceAt(cursor.x);
    const dy = cursor.y - sy;
    if (Math.abs(dy) < 18 && sp > 50 && now - lastCursorFx > 0.05) {
      lastCursorFx = now;
      addRipple(cursor.x, clamp(sp / 230, 0.6, 4), { tau: 1.0, speed: 100 + Math.min(200, sp * 0.1), wl: 40 });
      if (sp > 650) splash(cursor.x, sy, clamp(sp / 1600, 0.3, 1));
    }
    if (dy > 18 && sp > 130 && now - lastWake > 0.05) {
      lastWake = now;
      addBubble(cursor.x - cursor.vx * 0.03 + (Math.random() - 0.5) * 6, cursor.y + (Math.random() - 0.5) * 6);
    }
  }

  // ---------- 像素鱼 ----------
  // 只有收藏的鱼会按栖息门槛从屏幕边缘返回。

  const SP = window.SipSprites;
  const fishes = [];
  let catalog = [];
  let collection = { fish: {} };
  const arrivals = [];
  const particles = Array.from({length: 22}, (_, i) => ({u: (i * .6180339) % 1, phase: Math.random(), speed: 1 + Math.random() * 2}));

  function fishBand(f) {
    const species = catalog.find(g => g.id === f.name);
    const range = species?.habitat === '浅水' ? [.14, .25] : species?.habitat === '深海' ? [.79, .90] : [.44, .57];
    const depth = Math.max(0, H - baseY);
    const half = f.frames[0][0].height * PX / 2 + PX;
    const safeBottom = H - half;
    const safeTop = Math.min(safeBottom, baseY + half + PX);
    return {
      top: clamp(baseY + depth * range[0], safeTop, safeBottom),
      bottom: clamp(baseY + depth * range[1], safeTop, safeBottom),
    };
  }

  function spawnGroup(g, arrival) {
    const cm = arrival ? arrival.cm : (collection.fish[g.id].lastCm || collection.fish[g.id].maxCm);
    const f = makeFish(g.id, Math.random() < .5, baseY, null, 0);
    f.frames = SP.frames(g.id, cm);
    const band = fishBand(f);
    f.y = f.ty = band.top + Math.random() * (band.bottom - band.top);
    f.group = g.id;
    f.starUntil = arrival ? Infinity : 0;
    f.arriving = !!arrival;
    fishes.push(f);
    return f;
  }

  function makeFish(name, fromLeft, y, leader, idx) {
    const sp = SP.SPECIES[name];
    const off = leader ? { x: -14 - idx * 11 - Math.random() * 8, y: (idx % 2 ? -1 : 1) * (5 + idx * 3) } : null;
    return {
      name, sp, leader, off,
      frames: SP.frames(name),
      x: fromLeft ? -50 - (off ? -off.x : 0) : W + 50 + (off ? -off.x : 0),
      y: y + (off ? off.y : 0),
      dir: fromLeft ? 1 : -1,
      flip: fromLeft ? 1 : -1,
      speed: 0,
      tx: fromLeft ? 160 + Math.random() * W * 0.3 : W - 160 - Math.random() * W * 0.3,
      ty: y, wait: 0, phase: Math.random() * 4, bob: Math.random() * TAU,
      mode: 'swim', pecking: false, fast: false, seed: Math.random(),
    };
  }

  function groupActive(g) {
    return fishes.some((f) => f.group === g.id && f.mode !== 'leave');
  }

  function leaveGroup(g, fast) {
    for (const f of fishes) {
      if ((g && f.group !== g.id) || f.mode === 'leave') continue;
      f.mode = 'leave';
      f.fast = !!fast;
      f.pecking = false;
      f.wait = 0;
      f.dir = f.x < W / 2 ? -1 : 1;
      f.tx = f.dir > 0 ? W + 120 : -120;
      f.ty = f.y;
    }
  }

  function pickTarget(f) {
    const band = fishBand(f);
    f.pecking = false;
    const reach = 700;
    f.tx = clamp(f.x + (Math.random() - 0.5) * reach, 80, W - 80);
    f.ty = band.top + Math.random() * (band.bottom - band.top);
  }

  function updateFish(f, dt) {
    const leaving = f.mode === 'leave';
    const band = fishBand(f);

    if (!leaving && cursorLive() && cursor.y > baseY + 10 && Math.hypot(f.x - cursor.x, f.y - cursor.y) < 110) {
      const away = Math.sign(f.x - cursor.x) || 1;
      if (!f.leader) {
        f.tx = clamp(f.x + away * 280, 40, W - 40);
        f.ty = clamp(f.y + (f.y - cursor.y) * 0.8, band.top, band.bottom);
        f.pecking = false;
        f.wait = 0;
        f.scared = now + 1.2;
      }
      f.dir = away;
      f.speed = Math.max(f.speed, f.sp.cruise * 2.6);
    }

    if (f.leader && !leaving) {
      const L = f.leader;
      f.tx = L.x + f.off.x * L.dir;
      f.ty = L.y + f.off.y + Math.sin(now * 1.3 + f.seed * 9) * 3;
      f.wait = 0;
    } else if (!leaving && !f.pecking) {
      f.ty = clamp(f.ty, band.top, band.bottom);
    }
    if (f.pecking) f.ty = band.top;

    const dx = f.tx - f.x;
    const dy = f.ty - f.y;
    const dist = Math.hypot(dx, dy);
    const entering = f.arriving && f.starUntil === Infinity;
    const cruise = entering ? 65 : leaving ? (f.fast ? (W / 2 + 150) / 1.5 : Math.max(90, f.sp.cruise * 1.8)) : f.pecking ? f.sp.cruise * 1.2 : f.sp.cruise;

    if (f.wait > 0) {
      f.wait -= dt;
      f.speed += (5 - f.speed) * Math.min(1, dt * 1.5);
    } else {
      const scared = f.scared > now;
      const want = leaving ? cruise : f.leader ? Math.min(cruise * 1.6, dist * 2.2)
        : scared ? cruise * 2.2 : Math.min(cruise, 8 + dist * 0.5);
      f.speed += (want - f.speed) * Math.min(1, dt * 1.4);
      if (Math.abs(dx) > (f.leader ? 4 : 18)) f.dir = dx >= 0 ? 1 : -1;
    }

    f.flip += clamp(f.dir - f.flip, -dt * 6, dt * 6);
    f.x += f.flip * f.speed * dt;
    f.y += clamp(dy * 1.2, -f.speed * 0.5, f.speed * 0.5) * dt;
    const halfH = f.frames[0][0].height * PX / 2 + PX;
    f.y = leaving
      ? clamp(f.y, Math.min(H - halfH, baseY + halfH + PX), H - halfH)
      : clamp(f.y, band.top, band.bottom);
    if (f.arriving && f.x > f.frames[0][0].width * PX / 2 + 12 && f.x < W - f.frames[0][0].width * PX / 2 - 12 && f.starUntil === Infinity) f.starUntil = now + 5;
    f.phase += dt * (2.4 + f.speed * 0.12);

    if (leaving) {
      if (f.x < -100 || f.x > W + 100) f.dead = true;
      return;
    }
    if (!f.leader && dist < 14 && f.wait <= 0 && !(f.scared > now)) {
      if (f.pecking) {
        addRipple(f.x + f.dir * 16, 1.8, { tau: 1.0, speed: 70, wl: 30 });
        addBubble(f.x + f.dir * 14, f.y + 2, 1.4);
        f.pecking = false;
        f.tx = f.x + f.dir * 140;
        f.ty = band.top + Math.random() * (band.bottom - band.top);
        f.wait = 0.2;
      } else {
        f.wait = Math.random() * 2.4;
        pickTarget(f);
        if (Math.random() < 0.15) addBubble(f.x + f.dir * 14, f.y - 2, 1.1);
      }
    }
  }

  function updateFishes(dt) {
    if (!evap) {
      for (let i = arrivals.length - 1; i >= 0; i--) {
        const a = arrivals[i];
        if (level.x < .98 || now < a.at) continue;
        const g = catalog.find(g => g.id === a.id);
        if (g) {
          for (let j = fishes.length - 1; j >= 0; j--) if (fishes[j].name === a.id) fishes.splice(j, 1);
          spawnGroup(g, a);
        }
        arrivals.splice(i, 1);
      }
      for (const g of catalog) {
        const owned = collection.fish[g.id];
        const active = groupActive(g);
        const eligible = owned && targetLevel() >= g.threshold && level.x >= g.threshold - .001;
        if (!active && eligible && !arrivals.some(a => a.id === g.id)) spawnGroup(g);
        if (active && !eligible) leaveGroup(g, false);
      }
      for (const f of fishes) if (!collection.fish[f.name]) f.dead = true;
    }
    for (const f of fishes) updateFish(f, dt);
    for (let i = fishes.length - 1; i >= 0; i--) if (fishes[i].dead) fishes.splice(i, 1);
  }

  function drawFishes() {
    const deepRow = bandCRow();
    ctx.save();
    ctx.beginPath();
    for (let x = 0; x < LW; x++) ctx.rect(x, Math.ceil(surfaceAt(x * PX) / PX) + 1, 1, LH);
    ctx.clip();
    for (const f of fishes) {
      const bob = Math.sin(now * 1.6 + f.bob) * 1.2;
      const ly = Math.round((f.y + bob) / PX);
      const im = f.frames[ly >= deepRow ? 1 : 0][Math.floor(f.phase) % 4];
      const w = Math.max(1, Math.round(im.width * Math.abs(f.flip)));
      const lx = Math.round(f.x / PX);
      const top = ly - Math.floor(im.height / 2);
      if (f.name === 'angler') {
        const lure = im.lure || {x: im.width - 6, y: 2};
        const gx = lx + (lure.x - im.width / 2) * (f.flip >= 0 ? 1 : -1), gy = top + lure.y;
        for (let r = 5; r >= 1; r--) {
          ctx.fillStyle = `rgba(174,246,196,${(.018 + .007 * Math.sin(now * 1.6)) * (6-r)})`;
          px(gx-r,gy-r,r*2+1,r*2+1);
        }
      }
      if (f.starUntil > now && f.starUntil !== Infinity && Math.sin(now * 8) > -.55) {
        const sx = lx + Math.round(f.dir * im.width * .3), sy = top - 5;
        ctx.fillStyle = '#fff2ac'; px(sx,sy-2,1,5); px(sx-2,sy,5,1);
        ctx.fillStyle = '#ffffff'; px(sx,sy);
      }
      if (f.flip >= 0) {
        ctx.drawImage(im, lx - (w >> 1), top, w, im.height);
      } else {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(im, -lx - (w >> 1), top, w, im.height);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ---------- 满了 ----------

  function triggerFull() {
    fullFx = { t0: now + 0.45 };
    addRipple(W / 2, 6, { delay: 0.45, speed: 190, wl: 240, tau: 3.4, w: 110, spread: 40 });
  }

  // ---------- 蒸发：水退回屏幕底下，升起几缕像素水汽 ----------

  function startEvaporate(fromLevel) {
    evap = { t0: now, from: Math.max(level.x, fromLevel || 0) };
    level.x = evap.from;
    level.v = 0;
    fullFx = null;
    arrivals.length = 0;
    flights.length = 0;
    leaveGroup(null, true);
  }

  function updateEvap(dt) {
    if (!evap) return;
    const p = now - evap.t0;
    if (p > 2 && p < 5.4 && level.x > 0.002 && Math.random() < dt * 14) {
      steams.push({ x: Math.random() * W, y: baseY - 3, age: 0, life: 1.6 + Math.random() * 1.4, vy: -(18 + Math.random() * 16), sway: Math.random() * TAU });
    }
    if (evap.waterStart == null && !fishes.some(f => !f.dead)) evap.waterStart = now;
    const q = clamp((now - (evap.waterStart ?? now)) / 4, 0, 1);
    const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
    level.x = evap.from * (1 - e);
    level.v = 0;
    if (q >= 1 && steams.length === 0) {
      evap = null;
      level.x = 0;
      lastTarget = targetLevel();
    }
  }

  // ---------- 声音（默认关闭） ----------

  let audio = null;
  let lastDripAt = 0;
  function drip() {
    if (!settings.sound || now - lastDripAt < 0.12) return;
    lastDripAt = now;
    try {
      audio = audio || new AudioContext();
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';                       // 像素风：一点点 8-bit 的"嘀"
      osc.frequency.setValueAtTime(880 + Math.random() * 120, t);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.07);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.025, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.12);
    } catch (_) { /* 没有声音也没关系 */ }
  }

  // ---------- 每帧 ----------

  function isBusy() {
    return flights.length || drops.length || steams.length || evap || fullFx || cursorLive()
      || Math.abs(level.v) > 1e-4 || Math.abs(targetLevel() - level.x) > 1e-4
      || ripples.some((r) => now - r.t0 < r.tau * 2);
  }

  function update(dt) {
    updateFlights();

    const target = targetLevel();
    if (ready && !evap && lastTarget < 0.9999 && target >= 0.9999) triggerFull();
    lastTarget = target;

    if (evap) {
      updateEvap(dt);
    } else {
      const k = 30, c = 2 * Math.sqrt(k) * 0.66;
      for (let i = 0; i < 2; i++) {
        const h = dt / 2;
        const a = k * (target - level.x) - c * level.v;
        level.v += a * h;
        level.x += level.v * h;
      }
      if (Math.abs(target - level.x) < 1e-5 && Math.abs(level.v) < 1e-5) {
        level.x = target;
        level.v = 0;
      }
    }

    baseY = levelToY(clamp(level.x, 0, 1.004));
    const amp = clamp(level.x * 10, 0.3, 1);
    for (let i = 0; i < ys.length; i++) {
      const x = i * STEP;
      ys[i] = baseY + wave(x, now) * amp + rippleAt(x, now);
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (now - ripples[i].t0 > ripples[i].tau * 4.5) ripples.splice(i, 1);
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt; d.vy += 1500 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      if ((d.vy > 0 && d.y > surfaceAt(d.x) + 2) || d.age > 1.5) drops.splice(i, 1);
    }

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.vy += (-(30 + b.r * 14) - b.vy) * Math.min(1, dt * 2);
      b.ph += dt * (3 + b.r);
      b.x += Math.sin(b.ph) * b.wob * dt * 20;
      b.y += b.vy * dt;
      if (b.y - b.r * PX <= surfaceAt(b.x) + PX) {
        if (b.r > 1.8) addRipple(b.x, 0.8, { tau: 0.6, speed: 60, wl: 18, w: 8 });
        bubbles.splice(i, 1);
      }
    }
    if (now > nextAmbientBubble) {
      nextAmbientBubble = now + 2.5 + Math.random() * 5;
      addBubble(Math.random() * W, H - 6 - Math.random() * 30);
    }

    for (let i = steams.length - 1; i >= 0; i--) {
      const s = steams[i];
      s.age += dt; s.y += s.vy * dt; s.sway += dt * 2;
      if (s.age > s.life) steams.splice(i, 1);
    }

    updateCursor();
    updateFishes(dt);
    for (const h of highlights) {
      h.u += h.speed * dt;
      if (h.u < -0.02) h.u += 1.04; else if (h.u > 1.02) h.u -= 1.04;
    }
  }

  function bandCRow() {
    const depth = Math.max(0, H - baseY);
    return Math.round((baseY + Math.max(BAND_A_ROWS * PX + 9, depth * BAND_C_FROM)) / PX);
  }

  // 每列从水面线向下绘制五层色带，边界使用错落像素台阶。
  function paintWater() {
    buf.fill(0);
    const surf = new Int32Array(LW);
    for (let cx = 0; cx < LW; cx++) {
      const sy = Math.round(surfaceAt(cx * PX + PX / 2) / PX);
      surf[cx] = sy;
      if (sy >= LH) continue;
      const y0 = Math.max(0, sy);
      const depth = LH - sy;
      const bend = (k) => Math.round(Math.sin(cx * .027 + k * 2.1 + now * .035) * 2 + Math.sin(cx * .073 - k + now * .02) * 1.2);
      const boundaries = [sy + 2, sy + depth * .25 + bend(1), sy + depth * .51 + bend(2), sy + depth * .77 + bend(3)];
      const palette = [rgb(100,211,197), rgb(49,169,188), rgb(35,128,170), rgb(28,92,145), rgb(22,62,112)];
      for (let y = y0; y < LH; y++) {
        let band = 0;
        for (let k = 0; k < boundaries.length; k++) {
          const edge = Math.round(boundaries[k]);
          if (y > edge + (((cx * 17 + y * 11) % 7 === 0) ? 1 : 0)) band = k + 1;
        }
        let col = y === sy ? C.line : palette[band];
        buf[y * LW + cx] = col;
      }
      // 水面线比左右邻居高出一格时，补一格台阶，线才是连着的
      if (cx > 0) {
        const a = surf[cx - 1], b = sy;
        if (a < LH && Math.abs(a - b) > 1) {
          const top = Math.min(a, b), bot = Math.max(a, b);
          const col = a < b ? cx : cx - 1;
          for (let y = top + 1; y < bot; y++) if (y >= 0 && y < LH) buf[y * LW + col] = C.line;
        }
      }
    }

    // 白色高光：几小段，沿着水面慢慢漂
    for (const h of highlights) {
      const cx0 = Math.floor(h.u * LW);
      const blink = Math.sin(now * .8 + h.ph) > .89;
      if (!blink) continue;
      for (let k = 0; k < h.len; k++) {
        const cx = cx0 + k;
        if (cx < 0 || cx >= LW) continue;
        const y = surf[cx];
        if (y >= 0 && y < LH) buf[y * LW + cx] = C.hi;
      }
    }

    // 满了：一道白光沿水面从左扫到右
    if (fullFx) {
      const p = (now - fullFx.t0 - 0.35) / 2.6;
      if (p > 1) fullFx = null;
      else if (p >= 0) {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const mid = Math.round(-20 + e * (LW + 40));
        for (let cx = mid - 14; cx <= mid + 14; cx++) {
          if (cx < 0 || cx >= LW) continue;
          if (Math.abs(cx - mid) > 8 && (cx & 1)) continue;   // 两头稀一点
          const y = surf[cx];
          if (y >= 0 && y < LH) buf[y * LW + cx] = C.hi;
          if (Math.abs(cx - mid) < 4 && y + 1 < LH) buf[(y + 1) * LW + cx] = C.line;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function px(x, y, w = 1, h = 1) {
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function drawAtmosphere() {

    // Stepped shafts are clipped column by column to the actual waving surface.
    for (let b = 0; b < 3; b++) {
      const origin = LW * [.16,.48,.79][b] + Math.sin(now * .16 + b) * 5;
      for (let y = Math.max(0, Math.floor(baseY / PX)); y < LH; y++) {
        const d = y - baseY / PX;
        const mid = Math.round(origin + d * .48);
        const width = Math.round(5 + d * .055);
        const alpha = (.04 + .016 * Math.sin(now * .35 + b * 2)) * (1 - d / Math.max(1, LH - baseY/PX) * .65);
        ctx.fillStyle = `rgba(179,247,210,${alpha})`;
        for (let x = mid - width; x <= mid + width; x++) {
          if (y > surfaceAt(x * PX) / PX + 2) px(x,y);
        }
      }
    }
    ctx.fillStyle = '#79b8c7';
    for (const p of particles) {
      const x = Math.round((p.u * LW + Math.sin(now * .15 + p.phase * 20) * 2));
      const top = surfaceAt(x * PX) / PX + 4;
      const depth = Math.max(1,LH-top);
      const y = LH - ((now * p.speed + p.phase * depth) % depth);
      if (y > top) px(x,y);
    }
  }

  function drawBubbles() {
    ctx.fillStyle = C.bubble;
    for (const b of bubbles) {
      const x = Math.round(b.x / PX), y = Math.round(b.y / PX);
      if (b.r < 1.6) {
        px(x, y);
      } else if (b.r < 2.6) {                     // 小圈
        px(x, y - 1); px(x - 1, y); px(x + 1, y); px(x, y + 1);
      } else {                                    // 大圈 + 一颗高光
        px(x - 1, y - 2, 2, 1); px(x - 1, y + 1, 2, 1);
        px(x - 2, y - 1, 1, 2); px(x + 1, y - 1, 1, 2);
        ctx.fillStyle = '#ffffff';
        px(x - 1, y - 1);
        ctx.fillStyle = C.bubble;
      }
    }
  }

  function drawDrops() {
    ctx.fillStyle = C.foam;
    for (const d of drops) px(d.x / PX, d.y / PX);
  }

  function drawSteam() {
    ctx.fillStyle = C.steam;
    for (const s of steams) {
      const k = s.age / s.life;
      // 一缕水汽：几颗像素，越往上越稀，最后一闪一闪地没了
      if (k > 0.6 && (Math.floor(now * 12 + s.sway) & 1)) continue;
      const x = s.x / PX + Math.sin(s.sway) * 1.2;
      const y = s.y / PX;
      px(x, y);
      if (k < 0.5) px(x + 1, y + 2);
      if (k < 0.3) px(x - 1, y + 4);
    }
  }

  function drawFlights() {
    for (const f of flights) {
      const headTau = Math.min(now - f.tStart, f.tl);
      const tailTau = f.tEnd == null ? 0 : Math.max(0, now - f.tEnd);
      if (tailTau >= headTau) continue;
      const lx = Math.round(f.x0 / PX);
      const yTop = Math.round(headY(f, tailTau) / PX);
      const yBot = Math.round(headY(f, headTau) / PX);
      if (f.kind === 'drop') {
        ctx.fillStyle = C.streamB;
        px(lx, yBot - 1, 1, 2);
        ctx.fillStyle = C.streamA;
        px(lx, yBot - 1);
        continue;
      }
      // 两格宽的水柱：左边亮、右边浅蓝；越往下偶尔抖一格
      for (let y = yTop; y <= yBot; y++) {
        const fall = (y - yTop) / Math.max(1, yBot - yTop);
        const jit = fall > 0.6 && ((y + Math.floor(now * 20)) % 7 === 0) ? -1 : 0;
        ctx.fillStyle = C.streamA;
        px(lx - 1 + jit, y);
        ctx.fillStyle = C.streamB;
        px(lx + jit, y);
      }
    }
  }

  function draw() {
    paintWater();
    drawAtmosphere();
    drawFishes();
    drawBubbles();
    drawFlights();
    drawDrops();
    drawSteam();
  }

  function frame(ms) {
    requestAnimationFrame(frame);
    if (paused || !ready) return;
    const t = ms / 1000;
    if (!isBusy() && t - lastDraw < 1 / IDLE_FPS - 0.004) return;
    const dt = Math.min(0.05, Math.max(0.001, t - (lastFrame || t)));
    lastFrame = t;
    lastDraw = t;
    now = t;
    update(dt);
    draw();
  }

  // ---------- 消息 ----------

  function applyState(s) {
    if (s.collection) collection = s.collection;
    if (s.fishCatalog) catalog = s.fishCatalog;
    if (s.settings) settings = s.settings;
    if (Number.isFinite(s.totalMl)) stateMl = s.totalMl;
  }

  function applyGeometry(g) {
    if (!g) return;
    if (Number.isFinite(g.baseRatio)) BASE_RATIO = g.baseRatio;
    if (Number.isFinite(g.menuBar)) menuBar = g.menuBar;
    if (Number.isFinite(g.fullRatio) && g.fullRatio > 0) FULL_RATIO = g.fullRatio;
  }

  api.on('state', applyState);
  api.on('fish-arrive', (a) => {
    now = performance.now() / 1000;
    triggerFull();
    arrivals.push({...a, at: now + 1});
  });

  api.on('drink', (d) => {
    now = performance.now() / 1000;
    if (d.kind === 'stream-end') endStream(d.ml);
    else if (d.ml > 0 && d.from) addSlug(d.from, d.ml, d.kind);
    applyState(d);
  });

  api.on('cursor', setCursor);

  api.on('stream-move', (d) => {
    for (const f of flights) {
      if (f.kind === 'stream' && f.tEnd == null) { f.x0 = d.from.x; f.y0 = d.from.y; }
    }
  });

  api.on('stream-start', (d) => {
    now = performance.now() / 1000;
    startStream(d.from, d.rate);
  });

  api.on('evaporate', (d) => {
    now = performance.now() / 1000;
    startEvaporate(d.fromLevel);
  });

  api.on('hidden', (h) => {
    paused = !!h;
    if (h) ctx.clearRect(0, 0, LW, LH);
  });
  api.on('geometry', (g) => { applyGeometry(g); resize(); });

  window.addEventListener('resize', resize);

  api.invoke('water-ready').then((init) => {
    applyGeometry(init.geometry);
    applyState(init);
    resize();
    paused = !!init.hidden;
    level.x = targetLevel();
    lastTarget = level.x;
    now = performance.now() / 1000;
    if (init.evaporateFrom) {
      level.x = init.evaporateFrom;
      baseY = levelToY(level.x);
      for (const g of catalog) if (collection.fish[g.id] && level.x >= g.threshold) {
        const f = spawnGroup(g); f.x = W * (.2 + Math.random() * .6);
      }
      startEvaporate(init.evaporateFrom);
    }
    if (init.dev) window.__sipInspect = () => ({level: level.x, surfaceY:baseY, height:H, evaporating: !!evap, fish: fishes.map(f => ({id:f.name,x:f.x,y:f.y,mode:f.mode,star:f.starUntil>now, width:f.frames[0][0].width,height:f.frames[0][0].height}))});
    ready = true;
  });

  requestAnimationFrame(frame);

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rgb(r, g, b) { return (0xff << 24 | b << 16 | g << 8 | r) >>> 0; }

  // ---------- 预览模式：直接在浏览器里打开时使用 ----------

  function createPreviewApi() {
    const handlers = {};
    const emit = (ch, d) => (handlers[ch] || []).forEach((f) => f(d));
    const s = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
    const RATE = 200;
    let total = 0;
    let previewCatalog = [], previewFish = {}, awarded = false;
    const previewState = () => ({totalMl:total,settings:s,fishCatalog:previewCatalog,collection:{fish:previewFish}});
    const award = () => {
      if (awarded || total < s.goalMl || !previewCatalog.length) return;
      const missing = previewCatalog.filter(g => !previewFish[g.id]);
      const choices = missing.length ? missing : previewCatalog;
      const g = Object.keys(previewFish).length ? choices[Math.floor(Math.random()*choices.length)] : previewCatalog[0];
      const cm = Math.round((g.minCm + Math.random()*(g.maxCm-g.minCm))*10)/10;
      const prev = previewFish[g.id];
      previewFish[g.id]={firstSeen:prev?.firstSeen || new Date().toLocaleDateString('sv'),count:(prev?.count||0)+1,maxCm:Math.max(prev?.maxCm||0,cm),lastCm:cm};
      awarded=true;emit('fish-arrive',{id:g.id,cm});emit('state',previewState());
    };
    let pourStart = null;

    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('beforeend', `
      <div class="menubar"></div>
      <div class="doc"><b>周五的剪辑笔记</b><br>开场 3 秒先给画面，不要先给字。<br>
      第二段节奏放慢，留出呼吸。<br>结尾那条水波要等它完全散开再切。</div>
      <div class="dock"></div>
      <div class="help">0–4 水位 · S 菜单栏一口 · 按住 H 倒水（一直按一直倒） · U 撤回 · F 今日喝满 · E 第二天 · R 清空收藏</div>`);

    const cupFrom = () => ({ x: Math.round((window.innerWidth - 60) / PX) * PX, y: 25 + 60 });
    const drink = (kind, ml, from) => {
      total += ml;
      award();
      emit('drink', { kind, ml, from, totalMl: total, settings: s });
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k >= '0' && k <= '4') { total = Math.round(s.goalMl * Number(k) / 4); emit('state', { totalMl: total, settings: s }); }
      if (k === 's') drink('drop', s.sipMl, { x: window.innerWidth - 160, y: 25 });
      if (k === 'h') { pourStart = performance.now(); emit('stream-start', { from: cupFrom(), rate: RATE }); }
      if (k === 'u') { total = Math.max(0, total - s.sipMl); emit('state', { totalMl: total, settings: s }); }
      if (k === 'f') {
        total = Math.round(s.goalMl * 0.9);
        emit('state', { totalMl: total, settings: s });
        setTimeout(() => drink('cup', s.goalMl - total, cupFrom()), 1400);
      }
      if (k === 'r') { previewFish={};awarded=false;total=0;emit('state',previewState()); }
      if (k === 'e') {
        awarded = false;
        const from = Math.min(1, total / s.goalMl);
        total = 0;
        emit('evaporate', { fromLevel: from });
        emit('state', { totalMl: 0, settings: s });
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'h' && pourStart != null) {
        const sec = (performance.now() - pourStart) / 1000;
        pourStart = null;
        drink('stream-end', Math.max(s.sipMl, Math.round(RATE * sec)));
      }
    });
    window.addEventListener('mousemove', (e) => emit('cursor', { x: e.clientX, y: e.clientY }));
    window.__sip = { emit, get total() { return total; } };

    return {
      on(ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); },
      send() {},
      invoke(ch) {
        if (ch === 'water-ready') {
          return fetch('../fish/fish.json').then(r => r.json()).then(data => {
            previewCatalog = data;
            return {...previewState(),hidden:false,dev:true,geometry:{menuBar:25,fullRatio:FULL_RATIO,baseRatio:BASE_RATIO}};
          });
        }
        return Promise.resolve(null);
      },
    };
  }
})();
