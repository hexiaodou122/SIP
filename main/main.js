// Sip 主进程：窗口、菜单栏图标、右上角热区、日期分界

const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, powerMonitor, nativeImage, globalShortcut,
} = require('electron');
const path = require('path');
const store = require('./store');

const DEV = process.env.SIP_DEV === '1';

const CORNER_SIZE = 60;        // 右上角热区 60×60
const CORNER_DWELL_MS = 100;   // 鼠标一到角落就降下杯子（留一点点防误触）
const CUP_LEAVE_MS = 600;      // 离开多久收回杯子
const POLL_MS = 40;
const POUR_RATE = 200;         // 按住杯子时每秒倒多少 ml（一直按一直倒）
const POUR_MAX_SEC = 30;
const CUP_WIN = { width: 120, height: 120 };

let data = null;
let waterWin = null;
let cupWin = null;
let tray = null;
let settingsWin = null;
let onboardingWin = null;
let waterReady = false;
let pendingEvaporate = null;   // 启动时发现跨天：先给水窗口看旧水位，再蒸发

// 测试时可以指定另一个数据目录，不碰真实数据
if (process.env.SIP_DATA_DIR) app.setPath('userData', process.env.SIP_DATA_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- 小工具 ----------

const display = () => screen.getPrimaryDisplay();
const menuBarHeight = () => {
  const d = display();
  return Math.max(0, d.workArea.y - d.bounds.y);
};
// 水窗口需要知道菜单栏多高、Dock 顶边在哪（起始水位要淹过 Dock）
const geometry = () => {
  const d = display();
  const b = d.bounds;
  const wa = d.workArea;
  const gapBottom = b.y + b.height - (wa.y + wa.height);
  return {
    menuBar: menuBarHeight(),
    dockTop: gapBottom > 8 ? wa.y + wa.height - b.y : null,
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
    settings: data.settings || store.DEFAULT_SETTINGS,
    hidden: data.today.hidden,
  };
}

function broadcastState() {
  sendWater('state', statePayload());
  updateTrayIcon();
}

// 记录一次喝水。visual 是给水窗口的动画信息（从哪里落下来）
function recordDrink(ml, visual) {
  ml = Math.round(ml);
  if (ml > 0) {
    data.today.entries.push({ t: Date.now(), ml });
    save();
  }
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

function cupBounds() {
  const d = display();
  return {
    x: d.bounds.x + d.bounds.width - CUP_WIN.width,
    y: d.workArea.y,
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
  onboardingWin = smallWindow('onboarding/index.html', { width: 440, height: 540, title: 'Sip' });
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

// ---------- 菜单栏 ----------

function trayLevel() {
  const p = progress();
  if (p <= 0) return 0;
  if (p >= 1) return 4;
  return 1 + Math.min(2, Math.floor(p * 3));
}

function trayImage(level, tilt = '') {
  const file = path.join(__dirname, '../assets/tray', `cup${level}${tilt}Template.png`);
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
        { label: '演示：蒸发', click: devEvaporate },
        { label: '打开水窗口调试', click: () => waterWin.webContents.openDevTools({ mode: 'detach' }) },
        { label: '打开杯子调试', click: () => cupWin.webContents.openDevTools({ mode: 'detach' }) },
      ],
    });
  }
  template.push({ type: 'separator' }, { label: '退出 Sip', click: () => app.quit() });
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

// ---------- 右上角热区 + Dock 变淡 ----------

let cornerSince = null;
let leaveSince = null;
let cupShown = false;
let cupBusy = false;

function inside(p, r) {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

function showCup() {
  if (cupShown || !alive(cupWin)) return;
  cupShown = true;
  leaveSince = null;
  cupWin.setBounds(cupBounds());
  cupWin.setIgnoreMouseEvents(false);
  cupWin.webContents.send('cup-show');
}

function hideCup() {
  if (!cupShown || !alive(cupWin)) return;
  cupShown = false;
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

  const corner = {
    x: d.bounds.x + d.bounds.width - CORNER_SIZE,
    y: d.workArea.y,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  };
  const inCorner = inside(p, corner);
  const usable = data.settings && !data.today.hidden;

  if (!cupShown) {
    if (inCorner && usable) {
      if (cornerSince == null) cornerSince = now;
      if (now - cornerSince >= CORNER_DWELL_MS) showCup();
    } else {
      cornerSince = null;
    }
  } else {
    const pinned = DEV && process.env.SIP_PIN_CUP === '1'; // 调试：杯子一直放着
    const stay = pinned || inCorner || inside(p, cupWin.getBounds()) || cupBusy;
    if (stay) {
      leaveSince = null;
    } else {
      if (leaveSince == null) leaveSince = now;
      if (now - leaveSince >= CUP_LEAVE_MS) hideCup();
    }
  }
}

// ---------- 日期分界 ----------

function checkDay() {
  if (!data) return;
  const key = store.dayKey();
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
  else if (fromLevel > 0) sendWater('evaporate', { fromLevel });
  broadcastState();
}

// ---------- 开发预览 ----------

function devSetLevel(v) {
  const goal = data.settings.goalMl;
  data.today.entries = v > 0 ? [{ t: Date.now(), ml: Math.round(goal * v) }] : [];
  save();
  broadcastState();
}

function devFill() {
  devSetLevel(0.9);
  setTimeout(() => {
    const rest = data.settings.goalMl - totalMl();
    const d = display();
    recordDrink(rest, { kind: 'cup', from: { x: d.bounds.width - 80, y: menuBarHeight() + 30 } });
  }, 1600);
}

function devEvaporate() {
  const fromLevel = progress();
  data.today.entries = [];
  save();
  sendWater('evaporate', { fromLevel });
  broadcastState();
}

function registerDevShortcuts() {
  [0, 1, 2, 3, 4].forEach((n) => {
    globalShortcut.register(`Control+Alt+${n}`, () => devSetLevel(n / 4));
  });
  globalShortcut.register('Control+Alt+F', devFill);
  globalShortcut.register('Control+Alt+E', devEvaporate);
  globalShortcut.register('Control+Alt+C', showCup);
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
    return init;
  });

  ipcMain.handle('cup-ready', () => ({ settings: data.settings || store.DEFAULT_SETTINGS }));
  ipcMain.handle('get-settings', () => ({
    settings: data.settings || store.DEFAULT_SETTINGS,
  }));

  // 按下杯子就开始倒，按多久倒多久；轻点一下至少算一口
  ipcMain.on('pour-start', (_e, { spout }) => {
    if (!data.settings) return;
    cupBusy = true;
    sendWater('stream-start', { from: toWaterPoint(cupWin, spout), rate: POUR_RATE });
  });

  ipcMain.on('pour-end', (_e, { seconds }) => {
    if (!data.settings) return;
    const sec = Math.max(0, Math.min(POUR_MAX_SEC, Number(seconds) || 0));
    recordDrink(Math.max(data.settings.sipMl, POUR_RATE * sec), { kind: 'stream-end' });
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
  checkDay();

  setupIpc();
  createWaterWindow();
  createCupWindow();
  createTray();

  if (!data.settings) openOnboarding();

  setInterval(poll, POLL_MS);
  setInterval(checkDay, 60 * 1000);
  powerMonitor.on('resume', checkDay);
  powerMonitor.on('unlock-screen', checkDay);

  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  if (DEV) registerDevShortcuts();
  if (DEV && process.env.SIP_PIN_CUP === '1') setTimeout(showCup, 1500);
});

app.on('second-instance', () => {
  if (!data.settings) openOnboarding();
  else openSettings();
});

// 关掉设置窗口不退出
app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());
