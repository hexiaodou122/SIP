// 读写本地数据：userData/sip-data.json
// 数据一律以 ml 记录；"一天"以凌晨 4:00 为分界。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { sanitizeCollection } = require('./collection');
const fishCatalog = require('../renderer/fish/fish.json');

const DAY_START_HOUR = 4;
const HISTORY_LIMIT = 400;

const DEFAULT_SETTINGS = {
  goalMl: 1500,
  sipMl: 20,
  cupMl: 250,
  sound: false,
  launchAtLogin: false,
};

function filePath() {
  return path.join(app.getPath('userData'), 'sip-data.json');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 凌晨 4 点之前算作前一天
function dayKey(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyToday(key = dayKey()) {
  return { dayKey: key, entries: [], hidden: false };
}

function sanitizeSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    goalMl: num(s.goalMl, 300, 6000, DEFAULT_SETTINGS.goalMl),
    sipMl: num(s.sipMl, 5, 200, DEFAULT_SETTINGS.sipMl),
    cupMl: num(s.cupMl, 50, 1000, DEFAULT_SETTINGS.cupMl),
    sound: !!s.sound,
    launchAtLogin: !!s.launchAtLogin,
  };
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (_) {
    raw = null;
  }
  const data = {
    collection: sanitizeCollection(raw && raw.collection, fishCatalog),
    settings: sanitizeSettings(raw && raw.settings), // null = 还没做过首次选择
    today: emptyToday(),
    history: Array.isArray(raw && raw.history) ? raw.history : [],
  };
  if (raw && raw.today && typeof raw.today.dayKey === 'string') {
    data.today = {
      dayKey: raw.today.dayKey,
      entries: Array.isArray(raw.today.entries)
        ? raw.today.entries.filter((e) => e && Number.isFinite(e.ml) && e.ml > 0)
        : [],
      hidden: !!raw.today.hidden,
    };
  }
  return data;
}

function save(data) {
  const file = filePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[sip] 保存失败', err);
  }
}

function totalMl(today) {
  return today.entries.reduce((sum, e) => sum + e.ml, 0);
}

// 跨过分界点：把旧的一天收进 history（不展示，只备用），今天从空开始
function rollover(data, key = dayKey()) {
  const old = data.today;
  if (old.entries.length) {
    data.history.push({
      dayKey: old.dayKey,
      totalMl: totalMl(old),
      goalMl: data.settings ? data.settings.goalMl : null,
    });
    if (data.history.length > HISTORY_LIMIT) data.history.splice(0, data.history.length - HISTORY_LIMIT);
  }
  data.today = emptyToday(key);
}

module.exports = { DEFAULT_SETTINGS, dayKey, load, save, totalMl, rollover, sanitizeSettings };
