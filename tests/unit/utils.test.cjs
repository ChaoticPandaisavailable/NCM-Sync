const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeName, trackFilename, normalizeInterval, isPathInside } = require('../../src/backend/utils.cjs');

test('Windows 文件名清理会移除非法字符和尾部句点', () => {
  assert.equal(sanitizeName('  A/B:C*?  ... '), 'A B C');
  assert.match(sanitizeName('CON'), /^未命名-/);
});

test('歌曲实体名稳定包含曲目 ID', () => {
  assert.equal(trackFilename({ id: '42', name: 'Song: One', artists: ['DJ/Test'] }), 'DJ Test - Song One [42].mp3');
});

test('自动扫描周期会把 1 小时 70 分换算为 2 小时 10 分', () => {
  assert.deepEqual(normalizeInterval(1, 70), { hours: 2, minutes: 10, totalMinutes: 130 });
  assert.throws(() => normalizeInterval(0, 0), /不能少于/);
});

test('路径边界检查拒绝父目录逃逸', () => {
  assert.equal(isPathInside('C:\\MusicLibrary', 'C:\\MusicLibrary\\Playlist'), true);
  assert.equal(isPathInside('C:\\MusicLibrary', 'C:\\Elsewhere'), false);
});
