// 像素鱼：按参数生成像素画（自动描边、明暗、尾巴摆动帧），缓存成小画布
// 风格参考《潜水员戴夫》：小而清楚的像素鱼，深色描边，颜色干净

(() => {
  'use strict';

  const SPECIES = {
    // 小丑鱼：橘色，两条白带，白带边上一圈黑
    clown: {
      len: 15, h: 9, tail: 4, scale: 3, cruise: 26,
      base: '#f07a22', light: '#ffab4a', dark: '#bd4c14', line: '#2b160d',
      tailColor: '#e8701c', finColor: '#e8701c',
      paint(s, rel) {
        const band = (c, w) => Math.abs(s - c) <= w;
        if (band(0.32, 0.07) || band(0.64, 0.05)) return rel < -0.5 ? '#ffffff' : '#f4efe6';
        if (band(0.32, 0.12) || band(0.64, 0.1)) return this.line;
        return null;
      },
    },
    // 蓝倒吊：宝蓝身体，黑色"调色板"花纹，黄尾巴
    tang: {
      len: 16, h: 10, tail: 4, scale: 3, cruise: 30,
      base: '#2f6fd8', light: '#62a2f2', dark: '#1d3f8c', line: '#0e1a38',
      tailColor: '#f3c33c', finColor: '#25519f',
      paint(s, rel) {
        // 背上一道深色的"调色板"纹，中间鼓、两头收
        if (s > 0.1 && s < 0.64) {
          const top = -0.5 + (s - 0.1) * 0.2;
          const bot = 0.28 - Math.abs(s - 0.36) * 0.95;
          if (rel > top && rel < bot) return '#162a5c';
        }
        return null;
      },
    },
    // 银色小鱼（成群）
    minnow: {
      len: 7, h: 3, tail: 2, scale: 3, cruise: 44,
      base: '#9fbfcb', light: '#e4f2f6', dark: '#5f8291', line: '#2a3f49',
      tailColor: '#8fb1be', finColor: null,
      paint(s, rel) { return Math.abs(rel) < 0.2 && s > 0.15 && s < 0.85 ? '#d6ecf3' : null; },
    },
  };

  const FLAPS = [0, 1, 0, -1];

  function profile(s) {
    // s：0 = 尾根，1 = 鼻尖。前面饱满，鼻子圆，尾根收细
    if (s < 0.62) return 0.42 + 0.58 * Math.sin((s / 0.62) * Math.PI / 2);
    const k = (s - 0.62) / 0.38;
    return Math.sqrt(Math.max(0, 1 - k * k * 0.92));
  }

  function build(sp, flap) {
    const W = sp.tail + sp.len + 3;
    const H = sp.h + 5;
    const grid = Array.from({ length: H }, () => Array(W).fill(null));
    const c = H / 2;
    const x0 = sp.tail + 1;
    const half = sp.h / 2;

    // 身体
    for (let x = 0; x < sp.len; x++) {
      const s = (x + 0.5) / sp.len;
      const hh = half * profile(s);
      for (let y = 0; y < H; y++) {
        const dy = y + 0.5 - c;
        if (Math.abs(dy) <= hh) {
          const rel = dy / Math.max(hh, 0.5);
          let col = sp.paint(s, rel);
          if (!col) col = rel < -0.4 ? sp.light : rel > 0.45 ? sp.dark : sp.base;
          grid[y][x0 + x] = col;
        }
      }
    }

    // 背鳍
    if (sp.finColor) {
      for (let x = Math.round(sp.len * 0.36); x <= Math.round(sp.len * 0.62); x++) {
        const s = (x + 0.5) / sp.len;
        const top = Math.floor(c - half * profile(s) + 0.5);
        const tall = x > sp.len * 0.42 && x < sp.len * 0.56 ? 2 : 1;
        for (let k = 1; k <= tall; k++) if (top - k >= 0) grid[top - k][x0 + x] = sp.finColor;
      }
    }

    // 尾巴：随帧上下摆，末端开叉
    for (let k = 1; k <= sp.tail; k++) {
      const x = x0 - k;
      const spread = 0.6 + k * (sp.h > 5 ? 0.85 : 0.6);
      const off = flap * k * 0.45;
      for (let y = 0; y < H; y++) {
        const dy = y + 0.5 - c - off;
        if (Math.abs(dy) <= spread && !(k === sp.tail && Math.abs(dy) < spread * 0.4)) {
          grid[y][x] = sp.tailColor;
        }
      }
    }

    // 眼睛
    const ex = x0 + Math.round(sp.len * 0.78);
    const ey = Math.floor(c - half * 0.28);
    if (sp.h > 5) {
      grid[ey][ex] = '#0b0b0b';
      grid[ey - 1] && (grid[ey - 1][ex + 1] = grid[ey - 1][ex + 1] ? '#ffffff' : grid[ey - 1][ex + 1]);
    } else {
      grid[ey][ex] = '#0b0b0b';
    }

    // 描边：空格子只要挨着鱼，就涂成深色
    const out = grid.map((r) => r.slice());
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[y][x]) continue;
        const n = (yy, xx) => grid[yy] && grid[yy][xx];
        if (n(y - 1, x) || n(y + 1, x) || n(y, x - 1) || n(y, x + 1)) out[y][x] = sp.line;
      }
    }

    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!out[y][x]) continue;
        g.fillStyle = out[y][x];
        g.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  }

  // 水越深，鱼越偏蓝一点
  const TINTS = [0, 0.16, 0.3];
  function tinted(src, t) {
    if (!t) return src;
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(30, 96, 140, ${t})`;
    g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }

  const cache = {};
  function frames(name) {
    if (cache[name]) return cache[name];
    const sp = SPECIES[name];
    cache[name] = TINTS.map((t) => FLAPS.map((f) => tinted(build(sp, f), t)));
    return cache[name];
  }

  window.SipSprites = { SPECIES, frames, TINT_LEVELS: TINTS.length };
})();
