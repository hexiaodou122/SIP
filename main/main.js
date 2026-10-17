// Sip 主进程：窗口、菜单栏图标、右上角热区、日期分界

const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, powerMonitor, nativeImage, globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const store = require('./store');
const { awardFish, emptyCollection } = require('./collection');
const fishCatalog = require('../renderer/fish/fish.json');

const DEV = process.env.SIP_DEV === '1';
let newDayRequested = DEV && process.argv.includes('--new-day');

// 起始浅水与满水高度统一在 renderer/shared/constants.js 调整。
const { WATER_BASE_RATIO, WATER_FULL_RATIO } = require('../renderer/shared/constants');
// 像素格大小（屏幕 px），水、杯子、鱼都在这个网格上。和 renderer 里的 PX 一致。
const { PX } = require('../renderer/shared/constants');

const CORNER_SIZE = 60;        // 右上角热区 60×60
const CORNER_DWELL_MS = 100;   // 鼠标一到角落就降下杯子（留一点点防误触）
const CUP_LEAVE_MS = 600;      // 离开多久收回杯子
const POLL_MS = 40;
const POUR_RATE = 200;         // 按住杯子时每秒倒多少 ml（一直按一直倒）
const POUR_MAX_SEC = 30;
const SUMMON_HOLD_MS = 280;    // 在桌面上按住这么久：杯子出现并直接开始倒
const DRAG_CANCEL_PX = 6;      // 按下后挪动超过这么多：当作框选/拖图标，不出杯子
const HERE_LEAVE_MS = 1200;    // 点出来的杯子，鼠标离开多久收起
const CUP_ANCHOR = { x: 22 * PX, y: 14 * PX }; // 杯身中心在杯子窗口里的位置
const CUP_WIN = { width: 40 * PX, height: 40 * PX };

let data = null;
let waterWin = null;
let cupWin = null;
let tray = null;
let settingsWin = null;
let collectionWin = null;
let devDayKey = null;
let evaporatingUntil = 0;
let onboardingWin = null;
let waterReady = false;
let pendingEvaporate = null;   // 启动时发现跨天：先给水窗口看旧水位，再蒸发

// 测试时可以指定另一个数据目录，不碰真实数据
// Keep the existing data location stable when the display name changes.
const defaultDataDir = path.join(app.getPath('appData'), 'sip');
if (process.env.SIP_DATA_DIR) app.setPath('userData', process.env.SIP_DATA_DIR);
else app.setPath('userData', DEV ? path.join(defaultDataDir, 'development') : defaultDataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- 小工具 ----------

const display = () => screen.getPrimaryDisplay();
const menuBarHeight = () => {
  const d = display();
  return Math.max(0, d.workArea.y - d.bounds.y);
};
// 水窗口需要知道菜单栏多高、满水位比例；Dock 顶边用来排除 Dock 上的点击
const geometry = () => {
  const d = display();
  const b = d.bounds;
  const wa = d.workArea;
  const gapBottom = b.y + b.height - (wa.y + wa.height);
  return {
    menuBar: menuBarHeight(),
    dockTop: gapBottom > 8 ? wa.y + wa.height - b.y : null,
    fullRatio: WATER_FULL_RATIO,
    baseRatio: WATER_BASE_RATIO,
  };
};
const totalMl = () => store.totalMl(data.today);
const progress = () => (data.settings ? Math.min(1, totalMl() / data.settings.goalMl) : 0);
const save = () => store.save(data);
const alive = (w) => w && !w.isDestroyed();

function sendWater(channel, payload) {
  if (alive(waterWin) && waterReady) waterWin.webContents.send(channel, payload);
}

function statePayload() {
  return {
    totalMl: totalMl(),
    collection: data.collection,
    fishCatalog,
    settings: data.settings || store.DEFAULT_SETTINGS,
    hidden: data.today.hidden,
  };
}

function broadcastState() {
  sendWater('state', statePayload());
  if (alive(collectionWin)) collectionWin.webContents.send('state', statePayload());
  updateTrayIcon();
}

// 记录一次喝水。visual 是给水窗口的动画信息（从哪里落下来）
function recordDrink(ml, visual) {
  checkDay();
  ml = Math.round(ml);
  if (ml > 0) {
    data.today.entries.push({ t: Date.now(), ml });
  }
  const arrival = awardFish(data, fishCatalog);
  save();
  if (arrival) sendWater('fish-arrive', arrival);
  if (visual) sendWater('drink', { ...visual, ml, totalMl: totalMl() });
  broadcastState();
}

// ---------- 窗口 ----------

function commonWebPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
  };
}

function createWaterWindow() {
  const b = display().bounds;
  waterWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    // 桌面层：在壁纸之上、所有窗口和 Dock 之下，永远不会盖住任何 App
    type: 'desktop',
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: {
      ...commonWebPrefs(),
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  waterWin.setIgnoreMouseEvents(true);
  waterWin.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  waterWin.loadFile(path.join(__dirname, '../renderer/water/index.html'));
  waterWin.once('ready-to-show', () => {
    waterWin.setBounds(display().bounds);
    if (!data.today.hidden) waterWin.showInactive();
  });
  waterWin.webContents.on('render-process-gone', () => { waterReady = false; });
}

// 窗口位置对齐到像素网格，杯子和水才是同一套格子，水柱接得上
function snap(v, origin, up = false) {
  const k = (v - origin) / PX;
  return origin + (up ? Math.ceil(k) : Math.round(k)) * PX;
}

function cupBounds() {
  const d = display();
  return {
    x: snap(d.bounds.x + d.bounds.width - CUP_WIN.width, d.bounds.x),
    y: snap(d.workArea.y, d.bounds.y, true),
    width: CUP_WIN.width,
    height: CUP_WIN.height,
  };
}

function createCupWindow() {
  cupWin = new BrowserWindow({
    ...cupBounds(),
    type: 'panel',
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    show: false,
    roundedCorners: false,
    webPreferences: { ...commonWebPrefs(), backgroundThrottling: false },
  });
  cupWin.setIgnoreMouseEvents(true);
  cupWin.setAlwaysOnTop(true, 'screen-saver', 1);
  cupWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  cupWin.loadFile(path.join(__dirname, '../renderer/cup/index.html'));
  cupWin.once('ready-to-show', () => cupWin.showInactive());
}

function smallWindow(file, opts) {
  const win = new BrowserWindow({
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: commonWebPrefs(),
    ...opts,
  });
  win.loadFile(path.join(__dirname, '../renderer', file));
  win.once('ready-to-show', () => {
    app.focus({ steal: true });
    win.show();
  });
  return win;
}

function openOnboarding() {
  if (alive(onboardingWin)) { onboardingWin.focus(); return; }
  onboardingWin = smallWindow('onboarding/index.html', { width: 560, height: 740, title: '喝水养鱼 · SIP' });
  onboardingWin.on('closed', () => {
    onboardingWin = null;
    // 没选就关掉：先按 1500 用着，以后可在设置里改
    if (!data.settings) {
      data.settings = { ...store.DEFAULT_SETTINGS };
      save();
      broadcastState();
    }
  });
}

function openSettings() {
  if (alive(settingsWin)) { app.focus({ steal: true }); settingsWin.focus(); return; }
  settingsWin = smallWindow('settings/index.html', { width: 420, height: 580, title: '设置' });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function openCollection() {
  data.collection.unseenBadge = false;
  save();
  broadcastState();
  if (alive(collectionWin)) { app.focus({ steal: true }); collectionWin.focus(); return; }
  collectionWin = smallWindow('fish/index.html', { width: 940, height: 750, title: '图鉴' });
  collectionWin.on('closed', () => { collectionWin = null; });
}

// ---------- 菜单栏 ----------

function trayLevel() {
  const p = progress();
  if (p <= 0) return 0;
  if (p >= 1) return 4;
  return 1 + Math.min(2, Math.floor(p * 3));
}

function trayImage(level, tilt = '') {
  const file = path.join(__dirname, '../assets/tray', `cup${level}${tilt}${data.collection.unseenBadge ? '-dot' : ''}Template.png`);
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true);
  return img;
}

let wiggleTimers = [];
function updateTrayIcon() {
  if (!tray || wiggleTimers.length) return;
  tray.setImage(trayImage(trayLevel()));
}

function wiggleTray() {
  wiggleTimers.forEach(clearTimeout);
  wiggleTimers = [];
  const seq = ['-l', '-r', '-l', ''];
  seq.forEach((tilt, i) => {
    wiggleTimers.push(setTimeout(() => {
      tray.setImage(trayImage(trayLevel(), tilt));
      if (i === seq.length - 1) wiggleTimers = [];
    }, i * 75));
  });
}

function sipFromTray() {
  if (!data.settings) { openOnboarding(); return; }
  const b = tray.getBounds();
  const d = display();
  recordDrink(data.settings.sipMl, {
    kind: 'drop',
    from: { x: b.x + b.width / 2 - d.bounds.x, y: menuBarHeight() },
  });
  wiggleTray();
}

function undo() {
  if (!data.today.entries.length) return;
  data.today.entries.pop();
  save();
  broadcastState();
}

function setHidden(hidden) {
  data.today.hidden = hidden;
  save();
  applyHidden();
  broadcastState();
}

function applyHidden() {
  if (!alive(waterWin)) return;
  sendWater('hidden', data.today.hidden);
  if (data.today.hidden) {
    waterWin.hide();
    hideCup();
  } else {
    waterWin.showInactive();
  }
}

function buildMenu() {
  const template = [
    { label: '撤回一口', enabled: data.today.entries.length > 0, click: undo },
    {
      label: data.today.hidden ? '把水放回来' : '今天先藏起来',
      click: () => setHidden(!data.today.hidden),
    },
    { type: 'separator' },
    { label: '图鉴', click: openCollection },
    { label: '设置…', click: openSettings },
  ];
  if (DEV) {
    template.push({ type: 'separator' }, {
      label: '开发',
      submenu: [
        ...[0, 0.25, 0.5, 0.75, 1].map((v) => ({
          label: `水位 ${v * 100}%`,
          click: () => devSetLevel(v),
        })),
        { label: '演示：倒满', click: devFill },
        { label: '演示：到了第二天', click: devEvaporate },
        { label: '清空收藏，回到第一天', click: devReset },
        { label: '打开水窗口调试', click: () => waterWin.webContents.openDevTools({ mode: 'detach' }) },
        { label: '打开杯子调试', click: () => cupWin.webContents.openDevTools({ mode: 'detach' }) },
      ],
    });
  }
  template.push({ type: 'separator' }, { label: '退出喝水养鱼', click: () => app.quit() });
  return Menu.buildFromTemplate(template);
}

function createTray() {
  tray = new Tray(trayImage(trayLevel()));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', (event) => {
    if (event.altKey) tray.popUpContextMenu(buildMenu());
    else sipFromTray();
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// ---------- 杯子：右上角热区 / 点桌面召唤 ----------

let cornerSince = null;
let leaveSince = null;
let cupShown = false;
let cupBusy = false;
let cupMode = 'corner';
let cupDrag = null;
let lastSpout = null;          // 出水口在杯子窗口里的位置

function inside(p, r) {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// 水面现在的高度（屏幕坐标），和水窗口里的算法一致
function waterSurfaceY() {
  const d = display();
  const H = d.bounds.height;
  return d.bounds.y + H - H * (WATER_BASE_RATIO + progress() * (WATER_FULL_RATIO - WATER_BASE_RATIO));
}

// 点出来的杯子：杯身在鼠标下面；如果点在水里，杯子浮到水面上方
function hereBounds(p) {
  const d = display();
  let x = p.x - CUP_ANCHOR.x;
  let y = p.y - CUP_ANCHOR.y;
  const surface = waterSurfaceY();
  if (y + 72 > surface - 9) y = surface - 81;          // 杯底在画布第 22 行（66px）
  x = Math.max(d.bounds.x, Math.min(d.bounds.x + d.bounds.width - CUP_WIN.width, x));
  y = Math.max(d.workArea.y, y);
  return { x: snap(x, d.bounds.x), y: snap(y, d.bounds.y), width: CUP_WIN.width, height: CUP_WIN.height };
}

function showCup(mode = 'corner', at = null, pour = false) {
  if (!alive(cupWin) || cupBusy) return;
  if (cupShown && mode === 'corner') return;
  cupShown = true;
  cupMode = mode;
  leaveSince = null;
  cupWin.setBounds(mode === 'here' && at ? hereBounds(at) : cupBounds());
  cupWin.setIgnoreMouseEvents(false);
  cupWin.webContents.send('cup-show', { mode, pour });
}

function hideCup() {
  if (!cupShown || !alive(cupWin)) return;
  cupShown = false;
  cupDrag = null;
  cupBusy = false;
  cornerSince = null;
  cupWin.setIgnoreMouseEvents(true);
  cupWin.webContents.send('cup-hide');
}

function poll() {
  if (!data) return;
  const p = screen.getCursorScreenPoint();
  const d = display();
  const now = Date.now();
  if (cupDrag && cupShown && alive(cupWin)) {
    const x = snap(Math.max(d.bounds.x, Math.min(d.bounds.x + d.bounds.width - CUP_WIN.width, p.x - cupDrag.x)), d.bounds.x);
    const y = snap(Math.max(d.workArea.y, Math.min(d.bounds.y + d.bounds.height - CUP_WIN.height, p.y - cupDrag.y)), d.bounds.y);
    const old = cupWin.getBounds();
    if (old.x !== x || old.y !== y) {
      cupMode = 'here';
      cupWin.setBounds({x,y,...CUP_WIN});
      if (lastSpout) sendWater('stream-move', {from:toWaterPoint(cupWin,lastSpout)});
    }
  }

  const corner = {
    x: d.bounds.x + d.bounds.width - CORNER_SIZE,
    y: d.workArea.y,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  };
  const inCorner = inside(p, corner);
  const usable = data.settings && !data.today.hidden;

  if (!cupShown || cupMode === 'here') {
    if (inCorner && usable && !cupBusy && !mouse.pouring) {
      if (cornerSince == null) cornerSince = now;
      if (now - cornerSince >= CORNER_DWELL_MS) showCup('corner');
    } else {
      cornerSince = null;
    }
  }
  if (cupShown) {
    const pinned = DEV && process.env.SIP_PIN_CUP === '1'; // 调试：杯子一直放着
    const stay = pinned || (cupMode === 'corner' && inCorner) || inside(p, cupWin.getBounds()) || cupBusy || mouse.pouring;
    if (stay) {
      leaveSince = null;
    } else {
      if (leaveSince == null) leaveSince = now;
      if (now - leaveSince >= (cupMode === 'here' ? HERE_LEAVE_MS : CUP_LEAVE_MS)) hideCup();
    }
  }
}

// ---------- 鼠标小助手：点桌面出杯子、划水 ----------

let helper = null;
let quitting = false;
const mouse = { down: null, pouring: false, cursorSent: false };

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'sip-mouse')
    : path.join(__dirname, '../bin/sip-mouse');
}

function startMouseHelper() {
  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    console.warn('[sip] 没有鼠标小助手，点桌面出杯子、划水暂不可用');
    return;
  }
  helper = spawn(bin, [], { stdio: ['ignore', 'pipe', 'ignore'] });
  readline.createInterface({ input: helper.stdout }).on('line', (line) => {
    try { onMouse(JSON.parse(line)); } catch (_) { /* 忽略坏行 */ }
  });
  helper.on('exit', () => {
    helper = null;
    if (!quitting) setTimeout(startMouseHelper, 3000);
  });
}

// 菜单栏、Dock 上的点击不算点桌面
function inSystemArea(p) {
  const d = display();
  const g = geometry();
  if (p.y < d.workArea.y) return true;
  const bottom = g.dockTop != null ? d.bounds.y + g.dockTop : d.bounds.y + d.bounds.height - 80;
  return p.y >= bottom;
}

function onMouse(ev) {
  if (!data) return;
  const p = { x: ev.x, y: ev.y };
  const db = display().bounds;
  const usable = data.settings && !data.today.hidden;
  const onDesk = !!ev.desk && !inSystemArea(p);

  if (ev.t === 'move' || ev.t === 'drag') {
    // 划水：只在看得见水的地方
    if (onDesk && usable) {
      sendWater('cursor', { x: p.x - db.x, y: p.y - db.y });
      mouse.cursorSent = true;
    } else if (mouse.cursorSent) {
      sendWater('cursor', null);
      mouse.cursorSent = false;
    }
    if (ev.t === 'drag' && mouse.down) {
      const moved = Math.hypot(p.x - mouse.down.x, p.y - mouse.down.y);
      if (mouse.pouring) {
        // 倒水时拖动：杯子跟着走，水柱跟着挪
        cupWin.setBounds(hereBounds(p));
        if (lastSpout) sendWater('stream-move', { from: toWaterPoint(cupWin, lastSpout) });
      } else if (moved > DRAG_CANCEL_PX) {
        clearTimeout(mouse.down.timer);
        mouse.down.cancelled = true;
      }
    }
    return;
  }

  if (ev.t === 'down') {
    const onCup = cupShown && inside(p, cupWin.getBounds());
    // Window hit testing cannot distinguish Finder icons from empty desktop.
    // Require the explicit Option gesture; fail closed with older helpers.
    if (ev.summon !== true || !usable || !onDesk || onCup || cupBusy) return;
    mouse.down = { x: p.x, y: p.y, cancelled: false };
    mouse.down.timer = setTimeout(() => {
      if (!mouse.down || mouse.down.cancelled) return;
      mouse.pouring = true;
      cupBusy = false;
      showCup('here', p, true);
    }, SUMMON_HOLD_MS);
    return;
  }

  if (ev.t === 'up') {
    const down = mouse.down;
    mouse.down = null;
    if (!down) return;
    clearTimeout(down.timer);
    if (mouse.pouring) {
      mouse.pouring = false;
      if (alive(cupWin)) cupWin.webContents.send('cup-release');
    } else if (!down.cancelled) {
      // 轻点桌面：杯子出现在这里，等你按住它倒水
      showCup('here', { x: down.x, y: down.y }, false);
    }
  }
}

// ---------- 日期分界 ----------

function checkDay() {
  if (!data) return;
  const key = DEV && devDayKey ? devDayKey : store.dayKey();
  if (key === data.today.dayKey) return;
  const wasHidden = data.today.hidden;
  const fromLevel = progress();
  store.rollover(data, key);
  save();
  if (!waterReady) {
    if (!wasHidden && fromLevel > 0) pendingEvaporate = fromLevel;
    return;
  }
  if (wasHidden) applyHidden();
  else if (fromLevel > 0) {
    evaporatingUntil = Date.now() + 6000;
    sendWater('evaporate', { fromLevel, exitDuration: 2, duration: 6 });
  }
  broadcastState();
}

// ---------- 开发预览 ----------

function devSetLevel(v) {
  if (!DEV) return;
  if (!data.settings) data.settings = { ...store.DEFAULT_SETTINGS };
  const goal = data.settings.goalMl;
  data.today.entries = v > 0 ? [{ t: Date.now(), ml: Math.round(goal * v) }] : [];
  save();
  broadcastState();
}

function devFill() {
  if (!DEV || Date.now() < evaporatingUntil) return;
  devSetLevel(0.9);
  setTimeout(() => {
    const rest = data.settings.goalMl - totalMl();
    const d = display();
    recordDrink(rest, { kind: 'cup', from: { x: d.bounds.width - 80, y: menuBarHeight() + 30 } });
  }, 1600);
}

function devEvaporate() {
  if (!DEV || Date.now() < evaporatingUntil) return;
  const fromLevel = progress();
  const next = new Date(data.today.dayKey + 'T12:00:00');
  next.setDate(next.getDate() + 1);
  devDayKey = store.dayKey(next);
  store.rollover(data, devDayKey);
  save();
  evaporatingUntil = Date.now() + 6000;
  sendWater('evaporate', { fromLevel, exitDuration: 2, duration: 6 });
  applyHidden();
  broadcastState();
}

function devReset() {
  if (!DEV) return;
  data.collection = emptyCollection();
  data.history = [];
  devDayKey = null;
  store.rollover(data, store.dayKey());
  data.history = [];
  evaporatingUntil = 0;
  save();
  applyHidden();
  broadcastState();
}

// Explicit development demo: three completed days ending today, using real award rules.
function seedThreeDays() {
  data.settings = data.settings || {...store.DEFAULT_SETTINGS};
  data.collection = emptyCollection();
  data.history = [];
  const end = new Date(store.dayKey() + 'T12:00:00');
  for (let i = 0; i < 3; i++) {
    const date = new Date(end); date.setDate(date.getDate() - 2 + i);
    const key = store.dayKey(date);
    if (i) store.rollover(data, key);
    else data.today = {dayKey:key, entries:[], hidden:false};
    data.today.entries = [{t:date.getTime(),ml:data.settings.goalMl}];
    awardFish(data,fishCatalog);
  }
  save();
  console.log('[sip] 三天喝满演示已准备：', Object.keys(data.collection.fish).join(', '));
}

function registerDevShortcuts() {
  [0, 1, 2, 3, 4].forEach((n) => {
    globalShortcut.register(`Control+Alt+${n}`, () => devSetLevel(n / 4));
  });
  globalShortcut.register('Control+Alt+F', devFill);
  globalShortcut.register('Control+Alt+E', devEvaporate);
  globalShortcut.register('Control+Alt+R', devReset);
  globalShortcut.register('Control+Alt+C', () => showCup('corner'));
}

// ---------- IPC ----------

function toWaterPoint(win, p) {
  const wb = win.getBounds();
  const db = display().bounds;
  return { x: wb.x + p.x - db.x, y: wb.y + p.y - db.y };
}

function setupIpc() {
  ipcMain.handle('water-ready', () => {
    waterReady = true;
    const init = {
      ...statePayload(),
      geometry: geometry(),
      evaporateFrom: pendingEvaporate,
    };
    pendingEvaporate = null;
    if (newDayRequested) { newDayRequested = false; setTimeout(devEvaporate, 300); }
    return init;
  });

  ipcMain.handle('get-collection', () => ({ collection: data.collection, fishCatalog }));

  ipcMain.handle('cup-ready', () => ({ settings: data.settings || store.DEFAULT_SETTINGS }));
  ipcMain.handle('get-settings', () => ({
    settings: data.settings || store.DEFAULT_SETTINGS,
  }));

  // 按下杯子就开始倒，按多久倒多久；轻点一下至少算一口
  ipcMain.on('pour-start', (_e, { spout }) => {
    if (!data.settings) return;
    cupBusy = true;
    lastSpout = spout;
    sendWater('stream-start', { from: toWaterPoint(cupWin, spout), rate: POUR_RATE });
  });

  ipcMain.on('pour-end', (_e, { seconds }) => {
    if (!data.settings) return;
    const sec = Math.max(0, Math.min(POUR_MAX_SEC, Number(seconds) || 0));
    recordDrink(Math.max(data.settings.sipMl, POUR_RATE * sec), { kind: 'stream-end' });
  });

  ipcMain.on('cup-drag-start', (e) => {
    if (!alive(cupWin) || e.sender !== cupWin.webContents || !cupShown) return;
    const p = screen.getCursorScreenPoint(), b = cupWin.getBounds();
    cupDrag = {x:p.x-b.x,y:p.y-b.y};
  });
  ipcMain.on('cup-drag-end', (e) => {
    if (alive(cupWin) && e.sender === cupWin.webContents) cupDrag = null;
  });
  ipcMain.on('open-collection', (e) => {
    if (alive(cupWin) && e.sender === cupWin.webContents) openCollection();
  });
  ipcMain.on('cup-busy', (_e, busy) => { cupBusy = !!busy; });
  ipcMain.on('cup-retracted', () => {});

  ipcMain.on('save-settings', (_e, s) => {
    const next = store.sanitizeSettings({ ...(data.settings || store.DEFAULT_SETTINGS), ...s });
    if (!next) return;
    data.settings = next;
    save();
    applyLoginItem();
    broadcastState();
  });

  ipcMain.on('onboarding-done', (_e, s) => {
    data.settings = store.sanitizeSettings({ ...store.DEFAULT_SETTINGS, ...s });
    save();
    broadcastState();
    if (alive(onboardingWin)) onboardingWin.close();
  });

  ipcMain.on('close-window', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.close();
  });
}

function applyLoginItem() {
  if (!app.isPackaged) return; // 开发时不改开机启动项
  app.setLoginItemSettings({ openAtLogin: !!data.settings.launchAtLogin });
}

function onDisplayChange() {
  if (alive(waterWin)) waterWin.setBounds(display().bounds);
  if (alive(cupWin)) cupWin.setBounds(cupBounds());
  sendWater('geometry', geometry());
}

// ---------- 启动 ----------

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  data = store.load();
  if (DEV && process.argv.includes('--demo-three-days')) seedThreeDays();
  checkDay();
  if (DEV && !data.settings) data.settings = { ...store.DEFAULT_SETTINGS };

  setupIpc();
  createWaterWindow();
  createCupWindow();
  createTray();

  if (!data.settings || process.argv.includes('--welcome')) openOnboarding();

  setInterval(poll, POLL_MS);
  setInterval(checkDay, 60 * 1000);
  powerMonitor.on('resume', checkDay);
  powerMonitor.on('unlock-screen', checkDay);

  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  startMouseHelper();
  if (!globalShortcut.register('Control+Alt+G', openCollection)) console.warn('[sip] 图鉴快捷键被占用');
  if (process.argv.includes('--collection')) openCollection();
  if (DEV) registerDevShortcuts();
  if (DEV && process.env.SIP_PIN_CUP === '1') setTimeout(() => showCup('corner'), 1500);
});

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--collection')) { openCollection(); return; }
  if (!data.settings) openOnboarding();
  else openSettings();
});

// 关掉设置窗口不退出
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (helper) helper.kill();
});
