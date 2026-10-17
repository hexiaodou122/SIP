// 开发预览：在浏览器里单独打开水窗口 / 杯子，用键盘调试画面
// 用法：npm run preview
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 5178;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/renderer/water/index.html`;
  console.log('水：', url);
  console.log('杯子：', `http://127.0.0.1:${PORT}/renderer/cup/index.html`);
  exec(`open ${url}`);
});
