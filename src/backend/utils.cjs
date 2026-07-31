const path = require('node:path');

const WINDOWS_RESERVED = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function sanitizeName(value, fallback = '未命名') {
  let name = String(value || '').replace(WINDOWS_RESERVED, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/g, '').slice(0, 120);
  if (!name || RESERVED_NAMES.test(name)) name = `${fallback}-${name || 'item'}`;
  return name;
}

function trackFilename(track, extension = 'mp3') {
  const artists = (track.artists || []).join(', ') || '未知艺术家';
  const base = sanitizeName(`${artists} - ${track.name}`, `歌曲-${track.id}`);
  return `${base} [${track.id}].${extension.replace(/^\./, '')}`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeInterval(hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) {
    throw new Error('自动扫描周期必须是非负数字');
  }
  const totalMinutes = Math.round(h * 60 + m);
  if (totalMinutes < 1) throw new Error('自动扫描周期不能少于 1 分钟');
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60, totalMinutes };
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatTrack(raw) {
  return {
    id: String(raw.id),
    name: raw.name || `歌曲 ${raw.id}`,
    artists: (raw.ar || raw.artists || []).map((item) => item.name || item).filter(Boolean),
    album: raw.al?.name || raw.album?.name || raw.album || '',
    coverUrl: raw.al?.picUrl || raw.picUrl || '',
    duration: raw.dt || raw.duration || 0
  };
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
  sanitizeName,
  trackFilename,
  normalizeText,
  normalizeInterval,
  isPathInside,
  formatTrack,
  parseJson
};
