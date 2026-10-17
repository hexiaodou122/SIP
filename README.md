# Sip

用屏幕上的水位陪你喝水。完整设计见 [AGENTS.md](AGENTS.md)。

## 运行

```bash
npm install
npm start
```

如果 `npm install` 卡在下载 Electron，用国内镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## 怎么用

- **右上角**（菜单栏正下方）鼠标一到 → 降下玻璃杯。按住就倒水，按多久倒多久，松手停。
- **桌面任意处**：轻点 → 杯子出现在那里；按住 → 直接开始倒，拖着走水柱跟着挪。
- **划水**：鼠标在桌面上划过水面会荡开涟漪；在水里移动会带出气泡，鱼会被吓跑。
- 第一次 `npm start` 会花约 20 秒编译一个鼠标小助手（需要 Xcode 命令行工具；没有的话运行 `xcode-select --install`）。
- **菜单栏小杯子**：左键 = 一口；右键（或 Option + 左键）= 撤回 / 今天先藏起来 / 设置 / 退出。

## 开发

- `npm run dev`：开发模式。右键菜单里多一个"开发"子菜单；全局快捷键 `Ctrl+Option+0~4` 设水位 0–100%，`Ctrl+Option+F` 倒满，`Ctrl+Option+E` 蒸发，`Ctrl+Option+C` 降下杯子。
- `npm run preview`：在浏览器里单独打开水的画面，用键盘调试（页面左下角有按键说明）。
- `npm run icons`：重新生成菜单栏图标。
- `npm run dist`：打包 `.dmg`。
- `SIP_DATA_DIR=/某个目录 npm start`：用另一份数据测试，不碰真实数据。

数据存在 `~/Library/Application Support/sip/sip-data.json`。
