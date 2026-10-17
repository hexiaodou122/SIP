// 生成菜单栏小杯子图标：5 档填充 × (正 / 左歪 / 右歪)，@1x 与 @2x
// 用法：npm run icons
// 不依赖任何第三方库：自己栅格化 + 写 PNG。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '../assets/tray');
const PT = 18;          // 图标尺寸（pt）
const SS = 5;           // 每像素超采样 5×5

// 杯子形状（pt 坐标）：上宽下窄的梯形，开口朝上
const TOP = 2.6, BOTTOM = 15.6;
const TOP_L = 3.6, TOP_R = 14.4;
const BOT_L = 5.3, BOT_R = 12.7;
const STROKE = 1.35;
const GAP = 0.85;       // 杯壁和水之间留一点缝
const PIVOT = { x: 9, y: BOTTOM };

// 点到直线 (a→b) 的有符号距离，杯子内侧为负
function edgeDist(px, py, ax, ay, bx, by, inside) {
  const nx = by - ay, ny = -(bx - ax);
  const len = Math.hypot(nx, ny);
  let d = ((px - ax) * nx + (py - ay) * ny) / len;
  const di = ((inside.x - ax) * nx + (inside.y - ay) * ny) / len;
  if (di > 0) d = -d;
  return d;
}

const C = { x: 9, y: 9 };
function sdfSides(x, y) {
  const l = edgeDist(x, y, TOP_L, TOP, BOT_L, BOTTOM, C);
  const r = edgeDist(x, y, TOP_R, TOP, BOT_R, BOTTOM, C);
  const b = y - BOTTOM;
  return Math.max(l, r, b);
}

function coverage(px, py, scale, fill, angle) {
  let hit = 0;
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) {
      // 采样点 → pt 坐标，再反向旋转回杯子坐标
      let x = (px + (i + 0.5) / SS) / scale;
      let y = (py + (j + 0.5) / SS) / scale;
      const dx = x - PIVOT.x, dy = y - PIVOT.y;
      x = PIVOT.x + dx * cos - dy * sin;
      y = PIVOT.y + dx * sin + dy * cos;

      const d = sdfSides(x, y);
      const wall = y >= TOP - 0.2 && d <= 0 && d >= -STROKE;
      const innerTop = TOP + 1.6;
      const innerBottom = BOTTOM - STROKE - GAP;
      const fillTop = innerBottom - fill * (innerBottom - innerTop);
      const water = fill > 0 && d <= -(STROKE + GAP) && y >= fillTop;
      if (wall || water) hit++;
    }
  }
  return hit / (SS * SS);
}

function render(scale, fill, angle) {
  const size = PT * scale;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, scale, fill, angle);
      const o = (y * size + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// ---------- 极简 PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 输出 ----------
fs.mkdirSync(OUT, { recursive: true });
const FILLS = [0, 0.25, 0.5, 0.75, 1];
const TILTS = { '': 0, '-l': -10 * Math.PI / 180, '-r': 8 * Math.PI / 180 };
for (let level = 0; level < FILLS.length; level++) {
  for (const [suffix, angle] of Object.entries(TILTS)) {
    const base = `cup${level}${suffix}Template`;
    fs.writeFileSync(path.join(OUT, `${base}.png`), render(1, FILLS[level], angle));
    fs.writeFileSync(path.join(OUT, `${base}@2x.png`), render(2, FILLS[level], angle));
  }
}
console.log('tray icons →', OUT);
