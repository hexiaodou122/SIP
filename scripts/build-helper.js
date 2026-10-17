// 编译鼠标小助手（Swift）。只在没编译过或源码改过时才编译，npm start 前自动跑。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const src = path.join(__dirname, '../native/sip-mouse.swift');
const out = path.join(__dirname, '../bin/sip-mouse');

const stale = !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
if (stale) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log('正在编译鼠标小助手（第一次大约 20 秒）…');
  try {
    execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' });
  } catch (err) {
    console.warn('鼠标小助手编译失败：点桌面出杯子、划水先用不了，其它功能不受影响。');
    console.warn('可以先装 Xcode 命令行工具：xcode-select --install');
  }
}
