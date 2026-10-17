// 水窗口：水体、波浪、水面亮线、小鱼、水柱、涟漪、满了、蒸发
// 在 Electron 里由主进程驱动；直接用浏览器打开时进入"预览模式"，用键盘调试。

(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const GRAVITY = 2600;          // 水流下落的重力（px/s²）
  const STEP = 4;                // 水面采样间隔（px）
  const IDLE_FPS = 20;           // 空闲时的帧率

  const canvas = document.getElementById('water');
  const ctx = canvas.getContext('2d');

  const api = window.sip || createPreviewApi();

  let W = 0, H = 0, DPR = 1;
  let menuBar = 25;
  let settings = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
  let stateMl = 0;
  let paused = false;
  let ready = false;
  let bodyGrad = null;

  // 水位：x 是画面上的水位（0..1），带弹簧
  const level = { x: 0, v: 0 };
  let lastTarget = 0;

  const flights = [];   // 正在下落的水（一口 / 水柱）
  const ripples = [];   // 水面上的波纹
  const drops = [];     // 溅起的小水珠
  const mists = [];     // 蒸发时的雾
  let fullFx = null;    // 满了：水波 + 扫光
  let evap = null;      // 蒸发

  let ys = new Float32Array(0);  // 每帧的水面高度
  let baseY = 0;                 // 当前水位对应的平均水面
  let now = performance.now() / 1000;
  let lastFrame = 0;
  let lastDraw = 0;
  let drewEmpty = false;

  // ---------- 尺寸 ----------

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ys = new Float32Array(Math.ceil(W / STEP) + 2);

    // 水体：从上到下，越往下越深一点；最底下带一层很轻的雾
    bodyGrad = ctx.createLinearGradient(0, topY(), 0, H);
    bodyGrad.addColorStop(0.0, 'rgba(182, 216, 230, 0.10)');
    bodyGrad.addColorStop(0.55, 'rgba(150, 192, 212, 0.17)');
    bodyGrad.addColorStop(0.86, 'rgba(122, 170, 195, 0.26)');
    bodyGrad.addColorStop(1.0, 'rgba(168, 200, 216, 0.33)');
    drewEmpty = false;
  }

  const topY = () => menuBar + 8;          // 满屏时水面在菜单栏下面一点
  const bottomY = () => H + 10;            // 空的时候水面完全藏在屏幕下面
  const levelToY = (lv) => bottomY() - lv * (bottomY() - topY());

  // ---------- 水面 ----------

  function wave(x, t) {
    return 3.0 * Math.sin(x * TAU / 1150 + t * TAU / 11.0)
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
      speed: o.speed || 110,
      k: TAU / (o.wl || 44),
      tau: o.tau || 1.1,
      w: o.w || 20,
      spread: o.spread || 18,
    });
    if (ripples.length > 40) ripples.shift();
  }

  function surfaceAt(x) {
    const i = Math.max(0, Math.min(ys.length - 1, Math.round(x / STEP)));
    return ys[i];
  }

  function splash(x, y, strength = 1) {
    const n = Math.round(4 + 5 * strength);
    for (let i = 0; i < n; i++) {
      drops.push({
        x: x + (Math.random() - 0.5) * 4,
        y: y - 1,
        vx: (Math.random() - 0.5) * 110 * strength,
        vy: -(70 + Math.random() * 150) * Math.sqrt(strength),
        r: 0.7 + Math.random() * 0.9,
        age: 0,
      });
    }
    if (drops.length > 160) drops.splice(0, drops.length - 160);
  }

  // ---------- 下落的水 ----------
  // 一股水沿抛物线落下：从出口出发经过时间 τ 后的位置
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
      kind,
      x0: from.x, y0: from.y,
      vx: drop ? 0 : -55,
      v0: drop ? 40 : 120,
      tStart: now,
      tEnd: now + (drop ? 0.035 : 0.2),
      ml,
      rate: null,
      landT: null,
      landedMl: 0,
      lastRipple: 0,
    });
  }

  function startStream(from, rate) {
    flights.push({
      kind: 'stream',
      x0: from.x, y0: from.y,
      vx: -70, v0: 150,
      tStart: now,
      tEnd: null,
      ml: null,
      rate,
      landT: null,
      landedMl: 0,
      lastRipple: 0,
      lastDrip: 0,
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
      const headTau = now - f.tStart;
      if (f.landT == null && headTau >= tl) {
        f.landT = now;
        const p = posAt(f, tl);
        const big = f.kind === 'stream' ? 1.2 : f.kind === 'drop' ? 0.55 : 0.85;
        splash(p.x, p.y, big);
        addRipple(p.x, f.kind === 'drop' ? 2.2 : 3.2, { tau: 1.2 });
        if (f.kind !== 'stream') f.landedMl = f.ml;
        drip();
      }
      if (f.landT != null && f.kind === 'stream') {
        f.landedMl = f.rate * (now - f.landT);
        if (f.ml != null) f.landedMl = Math.min(f.landedMl, f.ml);
        const p = posAt(f, tl);
        if (now - f.lastRipple > 0.09) {
          f.lastRipple = now;
          addRipple(p.x + (Math.random() - 0.5) * 6, 1.3, { tau: 0.9, speed: 90 });
          splash(p.x, p.y, 0.35);
        }
      }
      // 水的尾巴也落进水里了：这一股水结束
      if (f.tEnd != null && now - f.tEnd >= tl && f.landT != null) {
        f.landedMl = f.ml;
        flights.splice(i, 1);
      }
    }
  }

  // ---------- 水位目标 ----------

  function targetLevel() {
    let ml = stateMl;
    for (const f of flights) {
      if (f.ml != null) ml -= f.ml - f.landedMl;  // 已经记账但还没落到水里的
      else ml += f.landedMl;                      // 还在倒、还没记账但已经落进去的
    }
    return Math.max(0, Math.min(1, ml / settings.goalMl));
  }

  // ---------- 小鱼 ----------

  const fish = {
    mode: 'off', x: 0, y: 0, yaw: 0, pitch: 0, speed: 0, phase: 0,
    tx: 0, ty: 0, wait: 0, pecking: false, alpha: 0, fast: false,
  };

  function fishRegion() {
    const top = baseY + 34;
    const bottom = Math.max(top + 20, H - 36);
    return { top, bottom };
  }

  function fishEnter() {
    const fromLeft = Math.random() < 0.5;
    const r = fishRegion();
    fish.mode = 'swim';
    fish.x = fromLeft ? -40 : W + 40;
    fish.y = r.top + (r.bottom - r.top) * (0.3 + Math.random() * 0.4);
    fish.yaw = fromLeft ? 0 : Math.PI;
    fish.pitch = 0;
    fish.speed = 0;
    fish.alpha = 0;
    fish.fast = false;
    fish.pecking = false;
    fish.tx = fromLeft ? 140 + Math.random() * W * 0.3 : W - 140 - Math.random() * W * 0.3;
    fish.ty = fish.y;
  }

  function fishLeave(fast) {
    if (fish.mode === 'off' || fish.mode === 'leave') return;
    fish.mode = 'leave';
    fish.fast = !!fast;
    fish.pecking = false;
    fish.wait = 0;
    fish.tx = Math.cos(fish.yaw) >= 0 ? W + 80 : -80;
    fish.ty = fish.y;
  }

  function fishPickTarget() {
    const r = fishRegion();
    if (Math.random() < 0.2) {
      // 游到水面附近"啄"一下
      fish.pecking = true;
      fish.tx = clamp(fish.x + (Math.random() - 0.5) * 260, 60, W - 60);
      fish.ty = baseY + 9;
      return;
    }
    fish.pecking = false;
    fish.tx = clamp(fish.x + (Math.random() - 0.5) * 700, 70, W - 70);
    fish.ty = r.top + Math.random() * (r.bottom - r.top);
  }

  function updateFish(dt) {
    if (fish.mode === 'off') return;
    const leaving = fish.mode === 'leave';
    fish.alpha = Math.min(1, fish.alpha + dt * 0.6);

    if (!leaving && !fish.pecking) {
      const r = fishRegion();
      fish.ty = clamp(fish.ty, r.top, r.bottom);
    }
    if (fish.pecking) fish.ty = baseY + 9;

    const dx = fish.tx - fish.x;
    const dy = fish.ty - fish.y;
    const dist = Math.hypot(dx, dy);

    if (fish.wait > 0) {
      fish.wait -= dt;
      fish.speed += (6 - fish.speed) * Math.min(1, dt * 1.5);
    } else {
      const cruise = leaving ? (fish.fast ? 85 : 50) : fish.pecking ? 34 : 26;
      const want = leaving ? cruise : Math.min(cruise, 8 + dist * 0.5);
      fish.speed += (want - fish.speed) * Math.min(1, dt * 1.2);

      // 转身是在水平面里转（侧面看身子先变短再朝向另一边），上下只允许小角度
      if (Math.abs(dx) > 18) {
        const facing = dx >= 0 ? 0 : Math.PI;
        const turn = (leaving && fish.fast ? 3.2 : 1.9) * dt;
        fish.yaw += clamp(facing - fish.yaw, -turn, turn);
      }
      const pitch = clamp(Math.atan2(dy, Math.abs(dx) + 1e-3), -0.45, 0.45);
      fish.pitch += clamp(pitch - fish.pitch, -dt, dt);
    }

    const dir = Math.cos(fish.yaw);
    fish.x += dir * Math.cos(fish.pitch) * fish.speed * dt;
    fish.y += Math.sin(fish.pitch) * fish.speed * (0.4 + 0.6 * Math.abs(dir)) * dt;
    // 始终待在水面以下
    fish.y = Math.max(fish.y, baseY + 7);
    fish.phase += dt * (2.2 + fish.speed * 0.16);

    if (leaving) {
      if (fish.x < -70 || fish.x > W + 70) fish.mode = 'off';
      return;
    }
    if (dist < 14 && fish.wait <= 0) {
      if (fish.pecking) {
        addRipple(fish.x + Math.cos(fish.yaw) * 15, 1.5, { tau: 1.0, speed: 70, wl: 30 });
        fish.pecking = false;
        fish.tx = fish.x + Math.cos(fish.yaw) * 120;
        fish.ty = baseY + 60 + Math.random() * 80;
        fish.wait = 0.15;
      } else {
        fish.wait = Math.random() * 2.2;
        fishPickTarget();
      }
    }
  }

  function drawFish() {
    if (fish.mode === 'off' || fish.alpha <= 0) return;
    const L = 32;
    ctx.save();
    ctx.translate(fish.x, fish.y);
    // 转身时身子在侧面看来先变窄再翻过去；肚子永远朝下
    const c = Math.cos(fish.yaw);
    ctx.scale(Math.sign(c || 1) * Math.max(0.18, Math.abs(c)), 1);
    ctx.rotate(fish.pitch);
    ctx.globalAlpha = fish.alpha;

    const N = 12;
    const sway = 1.6 + Math.min(1.4, fish.speed * 0.04);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const x = L * 0.48 - s * L * 0.76;
      const y = sway * s * s * Math.sin(fish.phase - s * 2.6);
      const w = 4.3 * Math.sin(Math.PI * Math.pow(s, 0.62)) * (1 - 0.45 * s) + 0.25;
      pts.push({ x, y, w });
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x + 1, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y - p.w);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y + pts[i].w);
    ctx.closePath();
    ctx.fillStyle = 'rgba(52, 86, 102, 0.34)';
    ctx.fill();

    // 尾巴：带一点点橘色
    const tail = pts[N];
    const tw = Math.sin(fish.phase - 3.0) * 0.5;
    ctx.save();
    ctx.translate(tail.x + 0.5, tail.y);
    ctx.rotate(tw);
    ctx.beginPath();
    ctx.moveTo(1.5, 0);
    ctx.quadraticCurveTo(-4, -1.5, -8.5, -5.2);
    ctx.quadraticCurveTo(-6.4, 0, -8.5, 5.2);
    ctx.quadraticCurveTo(-4, 1.5, 1.5, 0);
    ctx.fillStyle = 'rgba(206, 132, 86, 0.40)';
    ctx.fill();
    ctx.restore();

    // 一点胸鳍
    const fin = pts[4];
    ctx.beginPath();
    ctx.ellipse(fin.x - 1.5, fin.y + fin.w * 0.8, 3.0, 1.1, 0.6 + Math.sin(fish.phase) * 0.25, 0, TAU);
    ctx.fillStyle = 'rgba(52, 86, 102, 0.22)';
    ctx.fill();
    ctx.restore();
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
    glow.addColorStop(0.5, 'rgba(255,255,255,0.18)');
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

  // ---------- 蒸发 ----------

  function startEvaporate(fromLevel) {
    evap = { t0: now, from: Math.max(level.x, fromLevel || 0) };
    level.x = evap.from;
    level.v = 0;
    fullFx = null;
    fishLeave(true);
  }

  function updateEvap(dt) {
    if (!evap) return;
    const p = now - evap.t0;
    // 几缕很淡的雾从水面升起
    if (p > 0.5 && p < 3.4 && level.x > 0.002 && Math.random() < dt * 5) {
      mists.push({
        x: Math.random() * W,
        y: baseY - 4,
        r: 40 + Math.random() * 60,
        age: 0,
        life: 2.6 + Math.random() * 1.2,
        vy: -(12 + Math.random() * 14),
        vx: (Math.random() - 0.5) * 10,
      });
    }
    // 水位平滑降到 0
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

  function updateMists(dt) {
    for (let i = mists.length - 1; i >= 0; i--) {
      const m = mists[i];
      m.age += dt;
      m.y += m.vy * dt;
      m.x += m.vx * dt;
      m.r += dt * 10;
      if (m.age >= m.life) mists.splice(i, 1);
    }
  }

  function drawMists() {
    for (const m of mists) {
      const a = 0.085 * Math.sin(Math.PI * m.age / m.life);
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      g.addColorStop(0, `rgba(236, 244, 248, ${a})`);
      g.addColorStop(1, 'rgba(236, 244, 248, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, m.r, m.r * 0.55, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ---------- 声音（默认关闭）：一声很轻的水滴 ----------

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

  // ---------- 每帧 ----------

  function isActive() {
    return flights.length || ripples.length || drops.length || mists.length || evap || fullFx
      || Math.abs(level.v) > 1e-4 || Math.abs(targetLevel() - level.x) > 1e-4
      || (fish.mode !== 'off' && (fish.mode === 'leave' || fish.alpha < 1));
  }

  function update(dt) {
    updateFlights();

    const target = targetLevel();
    if (ready && !evap && lastTarget < 0.9999 && target >= 0.9999) triggerFull();
    lastTarget = target;

    if (evap) {
      updateEvap(dt);
    } else {
      // 有一点弹性的弹簧
      const k = 38, c = 2 * Math.sqrt(k) * 0.62;
      const sub = 2;
      for (let i = 0; i < sub; i++) {
        const h = dt / sub;
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

    // 波浪随水很少时稍微收一点
    const amp = clamp(level.x * 12, 0.25, 1);
    for (let i = 0; i < ys.length; i++) {
      const x = i * STEP;
      ys[i] = baseY + wave(x, now) * amp + rippleAt(x, now);
    }

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      if (now - r.t0 > r.tau * 4.5) ripples.splice(i, 1);
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      d.vy += 1500 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if ((d.vy > 0 && d.y > surfaceAt(d.x) + 1) || d.age > 1.5) drops.splice(i, 1);
    }

    // 过半出现小鱼，跌回一半以下就游走
    if (!evap && fish.mode === 'off' && level.x >= 0.5 && Math.abs(level.v) < 0.02) fishEnter();
    if (!evap && fish.mode !== 'off' && fish.mode !== 'leave' && level.x < 0.46) fishLeave(false);
    updateFish(dt);
    updateMists(dt);
  }

  function strokeSurface() {
    ctx.beginPath();
    ctx.moveTo(0, ys[0]);
    for (let i = 1; i < ys.length; i++) ctx.lineTo(i * STEP, ys[i]);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (level.x <= 0.0003 && !flights.length && !drops.length && !mists.length) return;

    // 水体
    ctx.beginPath();
    ctx.moveTo(0, H + 20);
    for (let i = 0; i < ys.length; i++) ctx.lineTo(i * STEP, ys[i]);
    ctx.lineTo(W, H + 20);
    ctx.closePath();
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // 水面下一层很浅的亮带
    const band = ctx.createLinearGradient(0, baseY - 6, 0, baseY + 46);
    band.addColorStop(0, 'rgba(226, 242, 249, 0.12)');
    band.addColorStop(1, 'rgba(226, 242, 249, 0)');
    ctx.beginPath();
    ctx.moveTo(0, baseY + 50);
    for (let i = 0; i < ys.length; i++) ctx.lineTo(i * STEP, ys[i]);
    ctx.lineTo(W, baseY + 50);
    ctx.closePath();
    ctx.fillStyle = band;
    ctx.fill();

    drawFish();

    // 水面亮线：一道细细的反光，亮度沿着水面慢慢游走
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.save();
    ctx.translate(0, 1.6);
    strokeSurface();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(58, 98, 118, 0.14)';
    ctx.stroke();
    ctx.restore();

    strokeSurface();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.stroke();

    const shimmer = ctx.createLinearGradient(0, 0, W, 0);
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const a = 0.44 + 0.2 * Math.sin(i * 1.7 + now * 0.33) + 0.1 * Math.sin(i * 0.63 - now * 0.21);
      shimmer.addColorStop(i / n, `rgba(255, 255, 255, ${a.toFixed(3)})`);
    }
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = shimmer;
    ctx.stroke();

    drawSweep();
    drawFlights();
    drawDrops();
    drawMists();
  }

  function drawFlights() {
    for (const f of flights) {
      const tl = f.tl;
      const headTau = Math.min(now - f.tStart, tl);
      const tailTau = f.tEnd == null ? 0 : Math.max(0, now - f.tEnd);
      if (tailTau >= headTau) continue;
      const a = posAt(f, tailTau);
      const b = posAt(f, headTau);

      if (f.kind === 'drop') {
        // 一颗小水珠
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 10);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2.1, 0, TAU);
        ctx.fillStyle = 'rgba(214, 236, 245, 0.75)';
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(70, 110, 130, 0.25)';
        ctx.stroke();
        continue;
      }

      ctx.beginPath();
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const tau = tailTau + (headTau - tailTau) * (i / N);
        const p = posAt(f, tau);
        const wob = Math.sin(tau * 40 + now * 18) * 0.35;
        if (i === 0) ctx.moveTo(p.x + wob, p.y);
        else ctx.lineTo(p.x + wob, p.y);
      }
      const width = f.kind === 'stream' ? 2.6 : 2.0;
      ctx.lineWidth = width + 1.2;
      ctx.strokeStyle = 'rgba(64, 104, 124, 0.16)';
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = 'rgba(205, 232, 243, 0.62)';
      ctx.stroke();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
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
    ctx.fillStyle = 'rgba(240, 249, 252, 0.7)';
    ctx.fill();
  }

  function frame(ms) {
    requestAnimationFrame(frame);
    if (paused || !ready) return;
    const t = ms / 1000;
    const active = isActive();
    const visible = level.x > 0.0003 || active;
    if (!visible) {
      if (!drewEmpty) { ctx.clearRect(0, 0, W, H); drewEmpty = true; }
      lastFrame = t;
      return;
    }
    drewEmpty = false;
    if (!active && t - lastDraw < 1 / IDLE_FPS - 0.004) return;
    const dt = Math.min(0.05, Math.max(0.001, t - (lastFrame || t)));
    lastFrame = t;
    lastDraw = t;
    now = t;
    update(dt);
    draw();
  }

  // ---------- 消息 ----------

  function applyState(s) {
    if (s.settings) settings = s.settings;
    if (Number.isFinite(s.totalMl)) stateMl = s.totalMl;
  }

  api.on('state', applyState);

  api.on('drink', (d) => {
    now = performance.now() / 1000;
    if (d.kind === 'stream-end') endStream(d.ml);
    else if (d.ml > 0 && d.from) addSlug(d.from, d.ml, d.kind);
    applyState(d);
  });

  api.on('stream-start', (d) => {
    now = performance.now() / 1000;
    startStream(d.from, d.rate);
  });

  api.on('evaporate', (d) => {
    now = performance.now() / 1000;
    startEvaporate(d.fromLevel);
  });

  api.on('dim', (on) => canvas.classList.toggle('dim', !!on));
  api.on('hidden', (h) => { paused = !!h; if (h) ctx.clearRect(0, 0, W, H); });
  api.on('geometry', (g) => { menuBar = g.menuBar; resize(); });

  window.addEventListener('resize', resize);

  api.invoke('water-ready').then((init) => {
    menuBar = init.geometry ? init.geometry.menuBar : menuBar;
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

  // ---------- 工具 ----------

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------- 预览模式：直接在浏览器里打开时使用 ----------

  function createPreviewApi() {
    const handlers = {};
    const emit = (ch, d) => (handlers[ch] || []).forEach((f) => f(d));
    const s = { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false };
    let total = 0;
    let streamStart = null;
    let dim = false;

    document.body.classList.add('preview');
    document.body.insertAdjacentHTML('afterbegin', `
      <div class="menubar"></div>
      <div class="doc"><b>周五的剪辑笔记</b><br>开场 3 秒先给画面，不要先给字。<br>
      第二段节奏放慢，留出呼吸。<br>结尾那条水波要等它完全散开再切。<br>
      配乐在 1:42 进副歌，画面跟着亮一点。<br>记得导出两个比例：16:9 和 9:16。</div>
      <div class="dark">const sip = 20;<br>const goal = 1500;<br>// 水是攒出来的<br>// 不是欠着的</div>
      <div class="help">0–4 水位 · S 菜单栏一口 · C 杯子一口 · 按住 H 倒一杯 · U 撤回 · F 倒满 · E 蒸发 · D Dock 变淡</div>`);
    canvas.style.zIndex = 10;

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
      if (k === 'c') drink('cup', s.sipMl, cupFrom());
      if (k === 'h') { streamStart = performance.now(); emit('stream-start', { from: cupFrom(), rate: s.cupMl / 1.5 }); }
      if (k === 'u') { total = Math.max(0, total - s.sipMl); emit('state', { totalMl: total, settings: s }); }
      if (k === 'f') {
        total = Math.round(s.goalMl * 0.9);
        emit('state', { totalMl: total, settings: s });
        setTimeout(() => drink('cup', s.goalMl - total, cupFrom()), 1400);
      }
      if (k === 'e') { const from = Math.min(1, total / s.goalMl); total = 0; emit('evaporate', { fromLevel: from }); emit('state', { totalMl: 0, settings: s }); }
      if (k === 'd') { dim = !dim; emit('dim', dim); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'h' && streamStart != null) {
        const frac = Math.min(1, (performance.now() - streamStart) / 1500);
        streamStart = null;
        drink('stream-end', Math.round(s.cupMl * frac));
      }
    });

    return {
      on(ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); },
      send() {},
      invoke(ch) {
        if (ch === 'water-ready') {
          return Promise.resolve({ totalMl: 0, settings: s, hidden: false, geometry: { menuBar: 25 } });
        }
        return Promise.resolve(null);
      },
    };
  }
})();
