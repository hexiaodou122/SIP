# 喝水养鱼 · SIP

**你喝水，桌面养鱼。**

作者：[hexiaodou122](https://github.com/hexiaodou122)

喝水养鱼（SIP）是一个 macOS 像素桌面喝水小工具。桌面底部一直留着浅浅的水，你喝水时顺手添一点；每天达到自己设定的目标，就会遇见一条鱼。

水会在新一天退去，收藏的鱼会留下，等水涨起来再游回来。

![SIP 初始化](docs/images/welcome.png)

## 怎么玩

- 鼠标移到屏幕右上角，或按住 Option 再点击桌面，叫出玻璃杯。
- 左键按住杯子倒水，可边倒边拖，松手停止；轻点至少记一口。
- 右键杯子打开图鉴，也可以按 **Control + Option + G**。
- 菜单栏小杯子左键加一口，右键可撤回、隐藏、打开设置或退出。
- 鼠标划过水面会有涟漪，靠近鱼会吓跑它。

默认目标 **1500 ml**，轻点一口20 ml，按住约200 ml/秒。也可选1700 ml或自定义。SIP根据你的操作手动记账，不会检测你实际喝了多少水。

0%保留屏高6%的环境底水，100%达到40%。水在桌面层，不挡窗口或Dock，桌面点击仍然穿透；全屏App里不会显示。

## 海里的朋友

第一天喝满固定遇见小丑鱼，以后优先随机遇见未收藏的物种，五种齐全后可以重复遇见。每次体型不同，图鉴记录首次日期、次数和最大体型。

| 物种 | 返场水量 | 体型范围 |
|---|---|---|
| 小丑鱼 | 10% | 8–11 cm |
| 蓝倒吊 | 40% | 15–30 cm |
| 河豚 | 40% | 10–30 cm |
| 翻车鱼 | 75% | 100–300 cm |
| 鮟鱇鱼 | 75% | 10–40 cm |

鱼在各自的浅、中、深水层游动。每天凌晨4:00换日，鱼先游出，水再退回浅水；没喝满不会失去已有收藏。

![SIP 图鉴，三种已收藏的测试样本](docs/images/collection.png)。

## 本地运行

已生成Apple Silicon本地试用安装包，最低目标系统macOS 13：`dist/Sip-0.1.1-mac-arm64.dmg`。打开镜像，将应用拖到Applications。当前仅作ad-hoc本地签名，未获Apple开发者签名或公证；尚未验证浏览器下载后的系统拦截和第二台电脑安装。安装包已发布，可在[Releases](https://github.com/hexiaodou122/SIP/releases/tag/v0.1.1)下载，后续设想见[路线图](ROADMAP.md)。

从源码运行需要macOS、Node.js/npm，以及用于编译鼠标小助手的Xcode命令行工具。

```bash
# 如未安装 Xcode 命令行工具
xcode-select --install

# 进入项目目录后
npm ci
npm start
```

首次启动会编译Swift小助手。如果编译失败，右上角杯子等功能仍可用，但桌面召杯和划水不可用。

如果Electron下载受网络影响，可以自行选择镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

## 开发

```bash
npm run dev       # 独立开发数据
npm test          # 收藏、拖动和演示状态规则
npm run preview   # 浏览器预览，端口5178
npm run capture   # 隔离Electron渲染检查与截图
npm run icons     # 生成菜单栏图标
npm run dist      # 构建Apple Silicon试用dmg（需要Electron下载可用）
npm run dist:local # 复用本机已安装的arm64 Electron构建dmg
npm run verify:package # 隔离数据启动打包应用，检查设置和图鉴
```

开发版快捷键为 **Control + Option +**：

| 按键 | 操作 |
|---|---|
| 0 / 1 / 2 / 3 / 4 | 设置0 / 25 / 50 / 75 / 100%水量，不发鱼 |
| F | 模拟当天喝满，每天仍只发一次鱼 |
| E | 模拟下一天，先退鱼再蒸发 |
| R | 清空开发收藏与记录 |
| C | 显示杯子 |

G打开图鉴在正式版也可用。开发模拟日期只在当前进程内持续；重启按真实本地日期检查换日。

```bash
npm run dev -- --welcome             # 重新看介绍
npm run dev -- --collection          # 直接开图鉴
npm run dev -- --new-day             # 启动后模拟一次下一天
npm run dev -- --demo-three-days     # 重置开发数据为三天喝满、三种收藏
```

默认正式数据：`~/Library/Application Support/sip/sip-data.json`；开发数据在其`development`子目录。`SIP_DATA_DIR=/自选目录 npm run dev`可进一步隔离。

## 项目状态

已实现核心互动、五种鱼收藏、分层游动、图鉴和明亮像素欢迎页。只支持主屏幕。已构建本地试用dmg；Apple开发者签名/公证、第二台电脑安装、开机自启和CPU基准仍待验收。

- [后续计划：更多鱼、倒水ml反馈等](ROADMAP.md)

中文名为「喝水养鱼」，英文名SIP。许可证尚未选定，未添加LICENSE，暂不宣称已采用任何开源许可。
