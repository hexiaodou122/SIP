// 水窗口（铺在桌面层，所有窗口都在它上面）
// 两层画布：
//   #gl    —— WebGL 画水体：随深度变色、焦散光网、斜射光柱、水面下的银色反光带
//   #water —— 2D 画水面亮线、像素鱼、水柱、水花、气泡、浮游微粒、雾
// 在 Electron 里由主进程驱动；直接用浏览器打开时进入"预览模式"，用键盘调试。

(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const GRAVITY = 2600;          // 水流下落的重力（px/s²）
  const STEP = 4;                // 水面采样间隔（px）
  const IDLE_FPS = 30;           // 平时的帧率（焦散一直在动）

  const glCanvas = document.getElementById('gl');
  const canvas = document.getElementById('water');
  const ctx = canvas.getContext('2d');

  const api = window.sip || createPreviewApi();

  let W = 0, H = 0, DPR = 1;
  let menuBar = 25;
  let dockTop = null;            // Dock 顶边（屏幕坐标），没有就按底部留 70px
  let settings = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
  let stateMl = 0;
  let paused = false;
  let ready = false;

  const level = { x: 0, v: 0 };  // 画面上的水位 0..1，带弹簧
  let lastTarget = 0;

  const flights = [];   // 正在下落的水
  const ripples = [];   // 水面波纹
  const drops = [];     // 溅起的水珠
  const bubbles = [];   // 气泡
  const mists = [];     // 蒸发的雾
  let motes = [];       // 水里漂着的微粒
  let fullFx = null;
  let evap = null;

  let ys = new Float32Array(0);
  let baseY = 0;
  let now = performance.now() / 1000;
  let lastFrame = 0;
  let lastDraw = 0;
  let nextAmbientBubble = 0;

  // 鼠标划水
  let cursor = null;             // { x, y, vx, vy, t }
  let lastCursorFx = 0;
  let lastWake = 0;

  // ---------- 几何 ----------

  const topY = () => menuBar + 8;                         // 满了：水面在菜单栏下面一点
  const floorY = () => (dockTop != null ? dockTop : H - 70) - 30; // 空的时候也淹过 Dock
  const levelToY = (lv) => floorY() - lv * (floorY() - topY());

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ys = new Float32Array(Math.ceil(W / STEP) + 2);
    motes = Array.from({ length: Math.round(W / 26) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.6 + Math.random() * 0.9,
      a: 0.12 + Math.random() * 0.22,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.3) * 2.5,
      ph: Math.random() * TAU,
    }));
    water3d.resize();
  }

  // ---------- 水面 ----------

  function wave(x, t) {
    return 2.6 * Math.sin(x * TAU / 1150 + t * TAU / 11.0)
      + 1.6 * Math.sin(x * TAU / 640 - t * TAU / 8.5 + 1.3)
      + 0.9 * Math.sin(x * TAU / 330 + t * TAU / 9.7 + 4.1)
      + 0.45 * Math.sin(x * TAU / 97 + t * 1.9 + 0.7)     // 细碎的小浪
      + 0.3 * Math.sin(x * TAU / 53 - t * 2.7 + 2.2);
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
      speed: o.speed || 110,
      k: TAU / (o.wl || 44),
      tau: o.tau || 1.1,
      w: o.w || 20,
      spread: o.spread || 18,
    });
    if (ripples.length > 50) ripples.shift();
  }

  function surfaceAt(x) {
    const i = Math.max(0, Math.min(ys.length - 1, Math.round(x / STEP)));
    return ys[i];
  }

  function splash(x, y, strength = 1) {
    const n = Math.round(4 + 6 * strength);
    for (let i = 0; i < n; i++) {
      drops.push({
        x: x + (Math.random() - 0.5) * 5,
        y: y - 1,
        vx: (Math.random() - 0.5) * 120 * strength,
        vy: -(80 + Math.random() * 170) * Math.sqrt(strength),
        r: 0.7 + Math.random() * 1.0,
        age: 0,
      });
    }
    if (drops.length > 200) drops.splice(0, drops.length - 200);
  }

  function addBubble(x, y, r) {
    bubbles.push({
      x, y,
      r: r || 1.2 + Math.random() * 2.3,
      vy: -10,
      wob: 0.4 + Math.random() * 0.8,
      ph: Math.random() * TAU,
    });
    if (bubbles.length > 160) bubbles.shift();
  }

  // ---------- 下落的水 ----------

  function posAt(f, tau) {
    return { x: f.x0 + f.vx * tau, y: f.y0 + f.v0 * tau + 0.5 * GRAVITY * tau * tau };
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
      kind, x0: from.x, y0: from.y,
      vx: drop ? 0 : -55, v0: drop ? 40 : 120,
      tStart: now, tEnd: now + (drop ? 0.035 : 0.2),
      ml, rate: null, landT: null, landedMl: 0, lastFx: 0,
    });
  }

  function startStream(from, rate) {
    flights.push({
      kind: 'stream', x0: from.x, y0: from.y,
      vx: -60, v0: 160,
      tStart: now, tEnd: null,
      ml: null, rate, landT: null, landedMl: 0, lastFx: 0,
    });
  }

  function endStream(ml) {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      if (f.kind === 'stream' && f.tEnd == null) {
        f.tEnd = now;
        f.ml = ml;
        return;
      }
    }
  }

  function updateFlights() {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      const tl = landTau(f);
      f.tl = tl;
      if (f.landT == null && now - f.tStart >= tl) {
        f.landT = now;
        const p = posAt(f, tl);
        const big = f.kind === 'stream' ? 1.3 : f.kind === 'drop' ? 0.55 : 0.9;
        splash(p.x, p.y, big);
        addRipple(p.x, f.kind === 'drop' ? 2.2 : 3.4, { tau: 1.2 });
        for (let b = 0; b < (f.kind === 'drop' ? 2 : 6); b++) {
          addBubble(p.x + (Math.random() - 0.5) * 10, p.y + 8 + Math.random() * 30);
        }
        if (f.kind !== 'stream') f.landedMl = f.ml;
        drip();
      }
      if (f.landT != null && f.kind === 'stream' && (f.tEnd == null || now - f.tEnd < tl)) {
        f.landedMl = f.rate * (now - f.landT);
        if (f.ml != null) f.landedMl = Math.min(f.landedMl, f.ml);
        const p = posAt(f, tl);
        if (now - f.lastFx > 0.07) {
          f.lastFx = now;
          addRipple(p.x + (Math.random() - 0.5) * 8, 1.6, { tau: 0.9, speed: 95 });
          splash(p.x, p.y, 0.4);
          // 水柱扎进水里，带下去一串气泡
          addBubble(p.x + (Math.random() - 0.5) * 12, p.y + 20 + Math.random() * 70);
          if (Math.random() < 0.5) addBubble(p.x + (Math.random() - 0.5) * 8, p.y + 10 + Math.random() * 30, 1 + Math.random());
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
      if (f.ml != null) ml -= f.ml - f.landedMl;  // 已记账、还没落进水里
      else ml += f.landedMl;                      // 还在倒、已落进水里
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
    // 划过水面：荡开涟漪，划得快就溅起水花
    if (Math.abs(dy) < 18 && sp > 50 && now - lastCursorFx > 0.05) {
      lastCursorFx = now;
      addRipple(cursor.x, clamp(sp / 260, 0.4, 3.4), { tau: 1.0, speed: 100 + Math.min(200, sp * 0.1), wl: 36 });
      if (sp > 650) splash(cursor.x, sy, clamp(sp / 1600, 0.3, 1));
    }
    // 在水里移动：身后带出一串小气泡
    if (dy > 18 && sp > 130 && now - lastWake > 0.045) {
      lastWake = now;
      addBubble(cursor.x - cursor.vx * 0.03 + (Math.random() - 0.5) * 6,
        cursor.y + (Math.random() - 0.5) * 6, 0.8 + Math.random() * 1.4);
    }
  }

  // ---------- 像素鱼 ----------
  // 水越多，鱼越多：⅓ 小丑鱼，⅔ 蓝倒吊，满了来一小群银色小鱼

  const SP = window.SipSprites;
  const fishes = [];
  const GROUPS = [
    { name: 'clown', at: 1 / 3 },
    { name: 'tang', at: 2 / 3 },
    { name: 'minnow', at: 0.98, school: 5 },
  ];

  function fishBand() {
    const top = baseY + 34;
    const bottom = Math.max(top + 30, floorY() + 14);
    return { top, bottom };
  }

  function spawnGroup(g) {
    const fromLeft = Math.random() < 0.5;
    const band = fishBand();
    const y0 = band.top + (band.bottom - band.top) * (0.25 + Math.random() * 0.5);
    const n = g.school || 1;
    const leader = makeFish(g.name, fromLeft, y0, null, 0);
    leader.group = g;
    fishes.push(leader);
    for (let i = 1; i < n; i++) {
      const f = makeFish(g.name, fromLeft, y0, leader, i);
      f.group = g;
      fishes.push(f);
    }
  }

  function makeFish(name, fromLeft, y, leader, idx) {
    const sp = SP.SPECIES[name];
    const off = leader ? { x: -14 - idx * 11 - Math.random() * 8, y: (idx % 2 ? -1 : 1) * (6 + idx * 4) } : null;
    return {
      name, sp, leader, off,
      frames: SP.frames(name),
      x: fromLeft ? -50 - (off ? -off.x : 0) : W + 50 + (off ? -off.x : 0),
      y: y + (off ? off.y : 0),
      dir: fromLeft ? 1 : -1,
      flip: fromLeft ? 1 : -1,
      speed: 0,
      tx: fromLeft ? 160 + Math.random() * W * 0.3 : W - 160 - Math.random() * W * 0.3,
      ty: y,
      wait: 0,
      phase: Math.random() * 4,
      bob: Math.random() * TAU,
      mode: 'swim',
      pecking: false,
      fast: false,
      seed: Math.random(),
    };
  }

  function groupActive(g) {
    return fishes.some((f) => f.group === g && f.mode !== 'leave');
  }

  function leaveGroup(g, fast) {
    for (const f of fishes) {
      if (g && f.group !== g) continue;
      if (f.mode === 'leave') continue;
      f.mode = 'leave';
      f.fast = !!fast;
      f.pecking = false;
      f.wait = 0;
      f.tx = f.dir > 0 ? W + 120 : -120;
      f.ty = f.y;
    }
  }

  function pickTarget(f) {
    const band = fishBand();
    if (f.name !== 'minnow' && Math.random() < 0.18) {
      f.pecking = true;               // 游到水面"啄"一下
      f.tx = clamp(f.x + (Math.random() - 0.5) * 260, 60, W - 60);
      f.ty = baseY + 10;
      return;
    }
    f.pecking = false;
    const reach = f.name === 'minnow' ? W : 700;
    f.tx = clamp(f.x + (Math.random() - 0.5) * reach, 80, W - 80);
    f.ty = band.top + Math.random() * (band.bottom - band.top);
  }

  function updateFish(f, dt) {
    const leaving = f.mode === 'leave';
    const band = fishBand();

    // 鼠标在水里靠近：吓一跳，赶紧游开
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
      // 跟着领头的游，保持一点队形
      const L = f.leader;
      f.tx = L.x + f.off.x * L.dir;
      f.ty = L.y + f.off.y + Math.sin(now * 1.3 + f.seed * 9) * 3;
      f.wait = 0;
    } else if (!leaving && !f.pecking) {
      f.ty = clamp(f.ty, band.top, band.bottom);
    }
    if (f.pecking) f.ty = baseY + 10;

    const dx = f.tx - f.x;
    const dy = f.ty - f.y;
    const dist = Math.hypot(dx, dy);
    const cruise = leaving ? (f.fast ? 110 : f.sp.cruise * 1.8) : f.pecking ? f.sp.cruise * 1.2 : f.sp.cruise;

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

    // 像素鱼转身：横向压扁再翻过去，不旋转
    f.flip += clamp(f.dir - f.flip, -dt * 6, dt * 6);

    f.x += f.flip * f.speed * dt;
    const vy = clamp(dy * 1.2, -f.speed * 0.5, f.speed * 0.5);
    f.y += vy * dt;
    f.y = Math.max(f.y, baseY + 9);       // 始终在水面以下
    f.phase += dt * (2.4 + f.speed * 0.12);

    if (leaving) {
      if (f.x < -100 || f.x > W + 100) f.dead = true;
      return;
    }
    if (!f.leader && dist < 14 && f.wait <= 0 && !(f.scared > now)) {
      if (f.pecking) {
        addRipple(f.x + f.dir * 16, 1.6, { tau: 1.0, speed: 70, wl: 30 });
        addBubble(f.x + f.dir * 14, f.y + 2, 1.4);
        f.pecking = false;
        f.tx = f.x + f.dir * 140;
        f.ty = baseY + 70 + Math.random() * 90;
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
      for (const g of GROUPS) {
        const active = groupActive(g);
        if (!active && level.x >= g.at && Math.abs(level.v) < 0.03) spawnGroup(g);
        if (active && level.x < g.at - 0.04) leaveGroup(g, false);
      }
    }
    for (const f of fishes) updateFish(f, dt);
    for (let i = fishes.length - 1; i >= 0; i--) if (fishes[i].dead) fishes.splice(i, 1);
  }

  function drawFishes() {
    ctx.imageSmoothingEnabled = false;
    for (const f of fishes) {
      const depth = f.y - baseY;
      const tint = depth < 140 ? 0 : depth < 340 ? 1 : 2;
      const img = f.frames[tint][Math.floor(f.phase) % 4];
      const s = f.sp.scale;
      const sx = Math.sign(f.flip || 1) * Math.max(0.1, Math.abs(f.flip));
      const bob = Math.sin(now * 1.6 + f.bob) * 1.2;
      ctx.save();
      ctx.translate(Math.round(f.x), Math.round(f.y + bob));
      ctx.scale(sx * s, s);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
  }

  // ---------- 满了 ----------

  function triggerFull() {
    fullFx = { t0: now + 0.45 };
    addRipple(W / 2, 5, { delay: 0.45, speed: 190, wl: 240, tau: 3.4, w: 110, spread: 40 });
  }

  function drawSweep() {
    if (!fullFx) return;
    const p = (now - fullFx.t0 - 0.35) / 2.6;
    if (p < 0) return;
    if (p > 1) { fullFx = null; return; }
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const x = -300 + e * (W + 600);
    const g = ctx.createLinearGradient(x - 280, 0, x + 280, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    const glow = ctx.createLinearGradient(x - 220, 0, x + 220, 0);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(0.5, 'rgba(255,255,255,0.2)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    const i0 = Math.max(0, Math.floor((x - 300) / STEP));
    const i1 = Math.min(ys.length - 1, Math.ceil((x + 300) / STEP));
    if (i1 <= i0) return;
    ctx.beginPath();
    ctx.moveTo(i0 * STEP, ys[i0]);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(i * STEP, ys[i]);
    ctx.lineWidth = 6;
    ctx.strokeStyle = glow;
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = g;
    ctx.stroke();
  }

  // ---------- 蒸发：回到 Dock 上面那一汪浅水 ----------

  function startEvaporate(fromLevel) {
    evap = { t0: now, from: Math.max(level.x, fromLevel || 0) };
    level.x = evap.from;
    level.v = 0;
    fullFx = null;
    leaveGroup(null, true);
  }

  function updateEvap(dt) {
    if (!evap) return;
    const p = now - evap.t0;
    if (p > 0.5 && p < 3.4 && level.x > 0.002 && Math.random() < dt * 6) {
      mists.push({
        x: Math.random() * W, y: baseY - 4,
        r: 40 + Math.random() * 60, age: 0, life: 2.6 + Math.random() * 1.2,
        vy: -(12 + Math.random() * 14), vx: (Math.random() - 0.5) * 10,
      });
    }
    const q = clamp((p - 1.1) / 2.9, 0, 1);
    const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
    level.x = evap.from * (1 - e);
    level.v = 0;
    if (p > 4.0 && mists.length === 0) {
      evap = null;
      level.x = 0;
      lastTarget = targetLevel();
    }
  }

  function drawMists(dt) {
    for (let i = mists.length - 1; i >= 0; i--) {
      const m = mists[i];
      m.age += dt; m.y += m.vy * dt; m.x += m.vx * dt; m.r += dt * 10;
      if (m.age >= m.life) { mists.splice(i, 1); continue; }
      const a = 0.09 * Math.sin(Math.PI * m.age / m.life);
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      g.addColorStop(0, `rgba(236, 244, 248, ${a})`);
      g.addColorStop(1, 'rgba(236, 244, 248, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, m.r, m.r * 0.55, 0, 0, TAU);
      ctx.fill();
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
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1150 + Math.random() * 200, t);
      osc.frequency.exponentialRampToValueAtTime(420, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    } catch (_) { /* 没有声音也没关系 */ }
  }

  // ---------- WebGL 水体 ----------

  const water3d = (() => {
    const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return { ok: false, resize() {}, draw() {}, clear() {} };

    const VS = `#version 300 es
      in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
    const FS = `#version 300 es
      precision highp float;
      uniform sampler2D uSurf;
      uniform int uN;
      uniform float uStep, uScale, uTime, uFloor;
      uniform vec2 uRes;
      out vec4 o;

      float surfAt(float x) {
        float f = x / uStep;
        int i = clamp(int(floor(f)), 0, uN - 1);
        int j = min(i + 1, uN - 1);
        return mix(texelFetch(uSurf, ivec2(i, 0), 0).r, texelFetch(uSurf, ivec2(j, 0), 0).r, fract(f));
      }

      // 焦散：水面把阳光聚成一张会动的光网
      float caustic(vec2 uv, float time) {
        vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
        vec2 i = p;
        float c = 1.0;
        float inten = 0.005;
        for (int n = 0; n < 5; n++) {
          float t = time * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
        }
        c /= 5.0;
        c = 1.17 - pow(c, 1.4);
        return clamp(pow(abs(c), 8.0), 0.0, 1.0);
      }

      void main() {
        vec2 px = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
        float s = surfAt(px.x);
        float d = px.y - s;
        if (d < -1.5) discard;

        float edge = smoothstep(-1.0, 1.0, d);
        float depth = 1.0 - exp(-d / 560.0);

        // 越深越蓝、越暗
        vec3 shallow = vec3(0.56, 0.80, 0.86);
        vec3 deep = vec3(0.07, 0.28, 0.43);
        vec3 col = mix(shallow, deep, depth);
        float a = mix(0.20, 0.60, depth);

        // 斜射下来的光柱，慢慢晃
        float u = px.x + d * 0.38;
        float r = (sin(u * 0.0105 + uTime * 0.19) * 0.5 + 0.5) * (sin(u * 0.0231 - uTime * 0.13 + 1.7) * 0.5 + 0.5);
        r += (sin(u * 0.0047 + uTime * 0.07 + 0.4) * 0.5 + 0.5) * 0.35;
        r = pow(r, 2.4) * smoothstep(0.0, 70.0, d) * exp(-d / 460.0);
        col += vec3(0.78, 0.94, 1.0) * r * 0.42;
        a += r * 0.10;

        // 焦散光网：靠近水面更亮
        float c = caustic(px / vec2(330.0, 260.0), uTime * 0.32);
        float c2 = caustic(px / vec2(170.0, 140.0) + 3.1, uTime * 0.27);
        float ck = (0.6 * exp(-d / 420.0) + 0.12) * smoothstep(0.0, 22.0, d);
        float cc = (c * 0.75 + c2 * 0.35) * ck;
        col += vec3(0.86, 0.98, 1.0) * cc;
        a += cc * 0.28;

        // 从水下看水面：一条银亮的反光带
        float band = exp(-max(d, 0.0) / 5.0);
        float band2 = exp(-max(d, 0.0) / 22.0);
        col = mix(col, vec3(0.88, 0.96, 0.99), band * 0.6 + band2 * 0.12);
        a += band * 0.22 + band2 * 0.04;

        // 底部更沉一点
        float bottom = smoothstep(uFloor - 40.0, uRes.y, px.y);
        col *= 1.0 - bottom * 0.18;
        a += bottom * 0.06;

        a = clamp(a, 0.0, 0.86) * edge;
        o = vec4(col * a, a);
      }`;

    function shader(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      return sh;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return { ok: false, resize() {}, draw() {}, clear() {} };
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const U = {};
    ['uSurf', 'uN', 'uStep', 'uScale', 'uTime', 'uFloor', 'uRes'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

    // 水体很柔，按 1 倍分辨率渲染就够，省电
    const SCALE = 1;

    return {
      ok: true,
      resize() {
        glCanvas.width = Math.round(W * SCALE);
        glCanvas.height = Math.round(H * SCALE);
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      },
      clear() {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      draw() {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, ys.length, 1, 0, gl.RED, gl.FLOAT, ys);
        gl.uniform1i(U.uSurf, 0);
        gl.uniform1i(U.uN, ys.length);
        gl.uniform1f(U.uStep, STEP);
        gl.uniform1f(U.uScale, SCALE);
        gl.uniform1f(U.uTime, now % 10000);
        gl.uniform1f(U.uFloor, floorY());
        gl.uniform2f(U.uRes, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  })();

  // ---------- 每帧 ----------

  function isBusy() {
    return flights.length || ripples.length || drops.length || mists.length || evap || fullFx || cursorLive()
      || Math.abs(level.v) > 1e-4 || Math.abs(targetLevel() - level.x) > 1e-4;
  }

  function update(dt) {
    updateFlights();

    const target = targetLevel();
    if (ready && !evap && lastTarget < 0.9999 && target >= 0.9999) triggerFull();
    lastTarget = target;

    if (evap) {
      updateEvap(dt);
    } else {
      const k = 30, c = 2 * Math.sqrt(k) * 0.66;   // 有一点弹性
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
    for (let i = 0; i < ys.length; i++) {
      const x = i * STEP;
      ys[i] = baseY + wave(x, now) + rippleAt(x, now);
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (now - ripples[i].t0 > ripples[i].tau * 4.5) ripples.splice(i, 1);
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt; d.vy += 1500 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
      if ((d.vy > 0 && d.y > surfaceAt(d.x) + 1) || d.age > 1.5) drops.splice(i, 1);
    }

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.vy += (-(32 + b.r * 16) - b.vy) * Math.min(1, dt * 2);
      b.ph += dt * (3 + b.r);
      b.x += Math.sin(b.ph) * b.wob * dt * 20;
      b.y += b.vy * dt;
      if (b.y - b.r <= surfaceAt(b.x) + 1) {
        if (b.r > 1.8) addRipple(b.x, 0.5, { tau: 0.6, speed: 60, wl: 18, w: 8 });
        bubbles.splice(i, 1);
      }
    }
    // 偶尔从底下冒一个泡，水一直是活的
    if (now > nextAmbientBubble) {
      nextAmbientBubble = now + 2.5 + Math.random() * 5;
      addBubble(Math.random() * W, H - 10 - Math.random() * 40);
    }

    for (const m of motes) {
      m.ph += dt * 0.4;
      m.x += (m.vx + Math.sin(m.ph) * 2) * dt;
      m.y += (m.vy + Math.cos(m.ph * 0.7) * 1.5) * dt;
      if (m.x < -5) m.x = W + 5; else if (m.x > W + 5) m.x = -5;
      if (m.y > H + 5) m.y = baseY + 20;
      if (m.y < baseY + 6) m.y = H;
    }

    updateCursor();
    updateFishes(dt);
  }

  function strokeSurface() {
    ctx.beginPath();
    ctx.moveTo(0, ys[0]);
    for (let i = 1; i < ys.length; i++) ctx.lineTo(i * STEP, ys[i]);
  }

  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    if (water3d.ok) water3d.draw();
    else drawFallbackBody();

    drawMotes();
    drawFishes();
    drawBubbles();

    // 水面亮线：一道细细的反光，亮度沿着水面慢慢游走
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.save();
    ctx.translate(0, -1.4);
    strokeSurface();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.stroke();
    ctx.restore();

    strokeSurface();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.stroke();

    const shimmer = ctx.createLinearGradient(0, 0, W, 0);
    const n = 11;
    for (let i = 0; i <= n; i++) {
      const a = 0.55 + 0.25 * Math.sin(i * 1.7 + now * 0.33) + 0.12 * Math.sin(i * 0.63 - now * 0.21);
      shimmer.addColorStop(i / n, `rgba(255, 255, 255, ${a.toFixed(3)})`);
    }
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = shimmer;
    ctx.stroke();

    drawSweep();
    drawFlights();
    drawDrops();
    drawMists(dt);
  }

  function drawFallbackBody() {
    ctx.beginPath();
    ctx.moveTo(0, H + 20);
    for (let i = 0; i < ys.length; i++) ctx.lineTo(i * STEP, ys[i]);
    ctx.lineTo(W, H + 20);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, baseY, 0, H);
    g.addColorStop(0, 'rgba(150, 205, 220, 0.25)');
    g.addColorStop(1, 'rgba(30, 90, 130, 0.55)');
    ctx.fillStyle = g;
    ctx.fill();
  }

  function drawMotes() {
    ctx.fillStyle = 'rgba(230, 245, 250, 1)';
    for (const m of motes) {
      if (m.y < baseY + 8) continue;
      ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(m.ph * 2));
      ctx.fillRect(m.x, m.y, m.r, m.r);
    }
    ctx.globalAlpha = 1;
  }

  function drawBubbles() {
    for (const b of bubbles) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = 'rgba(210, 238, 248, 0.14)';
      ctx.fill();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(240, 250, 255, 0.55)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.5, b.r * 0.3), 0, TAU);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fill();
    }
  }

  function drawFlights() {
    for (const f of flights) {
      const headTau = Math.min(now - f.tStart, f.tl);
      const tailTau = f.tEnd == null ? 0 : Math.max(0, now - f.tEnd);
      if (tailTau >= headTau) continue;
      const b = posAt(f, headTau);

      if (f.kind === 'drop') {
        const a = posAt(f, tailTau);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 10);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2.2, 0, TAU);
        ctx.fillStyle = 'rgba(214, 236, 245, 0.8)';
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(70, 110, 130, 0.3)';
        ctx.stroke();
        continue;
      }

      // 水柱：外面一层淡淡的水，中间一道亮芯，越往下越细、越抖
      const N = 22;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const tau = tailTau + (headTau - tailTau) * (i / N);
        const p = posAt(f, tau);
        const fall = tau / Math.max(0.05, f.tl);
        p.x += Math.sin(tau * 38 + now * 22) * (0.2 + fall * 0.9);
        pts.push(p);
      }
      const trace = (dx) => {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x + dx, p.y) : ctx.moveTo(p.x + dx, p.y)));
      };
      const thick = f.kind === 'stream' ? 4.2 : 2.6;
      trace(0);
      ctx.lineWidth = thick + 2;
      ctx.strokeStyle = 'rgba(50, 100, 125, 0.16)';
      ctx.stroke();
      ctx.lineWidth = thick;
      ctx.strokeStyle = 'rgba(200, 230, 242, 0.62)';
      ctx.stroke();
      trace(-thick * 0.18);
      ctx.lineWidth = Math.max(0.8, thick * 0.3);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.stroke();
    }
  }

  function drawDrops() {
    if (!drops.length) return;
    ctx.beginPath();
    for (const d of drops) {
      ctx.moveTo(d.x + d.r, d.y);
      ctx.arc(d.x, d.y, d.r, 0, TAU);
    }
    ctx.fillStyle = 'rgba(240, 249, 252, 0.75)';
    ctx.fill();
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
    draw(dt);
  }

  // ---------- 消息 ----------

  function applyState(s) {
    if (s.settings) settings = s.settings;
    if (Number.isFinite(s.totalMl)) stateMl = s.totalMl;
  }

  function applyGeometry(g) {
    if (!g) return;
    if (Number.isFinite(g.menuBar)) menuBar = g.menuBar;
    dockTop = Number.isFinite(g.dockTop) ? g.dockTop : null;
  }

  api.on('state', applyState);

  api.on('drink', (d) => {
    now = performance.now() / 1000;
    if (d.kind === 'stream-end') endStream(d.ml);
    else if (d.ml > 0 && d.from) addSlug(d.from, d.ml, d.kind);
    applyState(d);
  });

  api.on('cursor', setCursor);

  // 倒水时拖着杯子走：水柱的出口跟着挪
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
    if (h) { ctx.clearRect(0, 0, W, H); water3d.clear(); }
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
    if (init.evaporateFrom) startEvaporate(init.evaporateFrom);
    ready = true;
  });

  requestAnimationFrame(frame);

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- 预览模式：直接在浏览器里打开时使用 ----------

  function createPreviewApi() {
    const handlers = {};
    const emit = (ch, d) => (handlers[ch] || []).forEach((f) => f(d));
    const s = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
    const RATE = 200;
    let total = 0;
    let pourStart = null;

    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('beforeend', `
      <div class="menubar"></div>
      <div class="doc"><b>周五的剪辑笔记</b><br>开场 3 秒先给画面，不要先给字。<br>
      第二段节奏放慢，留出呼吸。<br>结尾那条水波要等它完全散开再切。</div>
      <div class="dock"></div>
      <div class="help">0–4 水位 · S 菜单栏一口 · 按住 H 倒水（一直按一直倒） · U 撤回 · F 倒满 · E 蒸发</div>`);

    const cupFrom = () => ({ x: window.innerWidth - 74, y: 25 + 22 });
    const drink = (kind, ml, from) => {
      total += ml;
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
      if (k === 'e') {
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
          return Promise.resolve({
            totalMl: 0, settings: s, hidden: false,
            geometry: { menuBar: 25, dockTop: window.innerHeight - 70 },
          });
        }
        return Promise.resolve(null);
      },
    };
  }
})();
