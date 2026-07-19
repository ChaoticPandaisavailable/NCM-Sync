const test = require('node:test');
const assert = require('node:assert/strict');

test('列表按状态、更新总数和常规字段排序', async () => {
  const { sortRows } = await import('../../src/renderer/sorting.mjs');
  const rows = [
    { id: 'offline', status: 'offline', displayName: 'D', trackCount: 8, createdAt: 40, added: [], removed: [] },
    { id: 'paused', status: 'paused', displayName: 'C', trackCount: 4, createdAt: 30, added: [{}], removed: [] },
    { id: 'pending', status: 'pending', displayName: 'B', trackCount: 2, createdAt: 20, added: Array(9).fill({}), removed: Array(3).fill({}) },
    { id: 'synced', status: 'synced', displayName: 'A', trackCount: 1, createdAt: 10, added: [{}], removed: [{}] }
  ];

  assert.deepEqual(sortRows(rows, { key: 'status', direction: 1 }).map((row) => row.id), ['synced', 'pending', 'paused', 'offline']);
  assert.deepEqual(sortRows(rows, { key: 'updateCount', direction: -1 }).map((row) => row.id), ['pending', 'synced', 'paused', 'offline']);
  assert.deepEqual(sortRows(rows, { key: 'displayName', direction: 1 }).map((row) => row.displayName), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sortRows(rows, { key: 'trackCount', direction: -1 }).map((row) => row.trackCount), [8, 4, 2, 1]);
  assert.deepEqual(sortRows(rows, { key: 'createdAt', direction: 1 }).map((row) => row.createdAt), [10, 20, 30, 40]);
});
