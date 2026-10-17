// 收藏规则独立于 Electron，便于验证每天一次和旧数据兼容。
function emptyCollection() {
  return { fish: {}, unseenBadge: false, fullAwardedFor: null };
}
function sanitizeCollection(raw, catalog) {
  const result = emptyCollection();
  if (!raw || typeof raw !== 'object') return result;
  for (const species of catalog) {
    const entry = raw.fish && raw.fish[species.id];
    if (!entry || !Number.isFinite(entry.count) || entry.count < 1) continue;
    const clamp = (n) => Math.max(species.minCm, Math.min(species.maxCm, Number(n) || species.minCm));
    result.fish[species.id] = {
      firstSeen: typeof entry.firstSeen === 'string' ? entry.firstSeen : '',
      count: Math.floor(entry.count), maxCm: clamp(entry.maxCm), lastCm: clamp(entry.lastCm || entry.maxCm),
    };
  }
  result.unseenBadge = !!raw.unseenBadge;
  result.fullAwardedFor = typeof raw.fullAwardedFor === 'string' ? raw.fullAwardedFor : null;
  return result;
}
function awardFish(data, catalog, random = Math.random) {
  if (!data.settings || data.today.entries.reduce((sum, e) => sum + e.ml, 0) < data.settings.goalMl) return null;
  const collection = data.collection;
  if (collection.fullAwardedFor === data.today.dayKey) return null;
  const missing = catalog.filter((f) => !collection.fish[f.id]);
  const choices = missing.length ? missing : catalog;
  const species = Object.keys(collection.fish).length === 0
    ? catalog.find((f) => f.id === 'clown') || choices[0]
    : choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  if (!species) return null;
  const cm = Math.round((species.minCm + random() * (species.maxCm - species.minCm)) * 10) / 10;
  const previous = collection.fish[species.id];
  collection.fish[species.id] = {
    firstSeen: previous ? previous.firstSeen : data.today.dayKey,
    count: (previous ? previous.count : 0) + 1,
    maxCm: Math.max(previous ? previous.maxCm : 0, cm), lastCm: cm,
  };
  collection.unseenBadge = true;
  collection.fullAwardedFor = data.today.dayKey;
  return { id: species.id, cm };
}
module.exports = { emptyCollection, sanitizeCollection, awardFish };
