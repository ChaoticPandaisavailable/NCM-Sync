const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('子目录映射、三栏拖拽、撤回重做与按歌单同步完整流程', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-mapping-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-mapping-user-'));
  const original = path.join(musicRoot, 'DJ', '夜航测试集');
  const target = path.join(musicRoot, 'DJ', 'Custom mix');
  fs.mkdirSync(original, { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(path.join(original, 'Test Artist - Neon Run.mp3'), 'legacy-track');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: musicRoot, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(original);
    await page.getByRole('button', { name: '修改映射', exact: true }).click();
    await expect(page.getByLabel('映射的网易云歌单')).toHaveValue('1001');
    await page.getByLabel('映射的本地文件夹').fill(target);
    fs.mkdirSync(path.join(projectRoot, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-mapping.png'), fullPage: true });
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(target);
    const response = await page.evaluate(() => fetch('/api/local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onlineIds: ['1002'] }) }).then((res) => res.json()));
    expect(response.added).toHaveLength(1);
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(2);
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-paths.png'), fullPage: true });
    const row = page.locator('.local-pane tbody tr').filter({ hasText: 'Custom mix' });
    await row.dblclick();
    const added = page.getByTestId('lane-add');
    const kept = page.getByTestId('lane-keep');
    const removed = page.getByTestId('lane-remove');
    await expect(added.locator('.editor-track')).toHaveCount(2);
    const neon = added.locator('[data-track-id="501"]');
    await expect(neon).toHaveAttribute('draggable', 'true');
    await neon.dragTo(kept, { sourcePosition: { x: 8, y: 8 }, targetPosition: { x: 20, y: 130 } });
    await expect(kept.locator('.editor-track')).toHaveCount(1);
    await expect(added.locator('.editor-track')).toHaveCount(1);
    await page.locator('.playlist-editor').press('Control+z');
    await expect(added.locator('.editor-track')).toHaveCount(2);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(kept.locator('.editor-track')).toHaveCount(1);
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    expect(fs.readdirSync(target)).toHaveLength(0);
    await page.getByRole('button', { name: '撤回', exact: true }).click();
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    await expect(added.locator('.editor-track')).toHaveCount(2);
    await added.locator('[data-track-id="501"]').dragTo(kept, { sourcePosition: { x: 8, y: 8 }, targetPosition: { x: 20, y: 130 } });
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-editor.png'), fullPage: true });
    await page.getByRole('button', { name: '同步当前歌单', exact: true }).click();
    await expect(page.locator('.dialog')).toHaveCount(0);
    await expect.poll(() => fs.readdirSync(target).length).toBe(1);
    expect(fs.readdirSync(path.join(musicRoot, '收藏节拍'))).toHaveLength(0);
    expect(fs.readdirSync(original)).toHaveLength(1);
    await expect(row.locator('.status-badge')).toHaveText('同步');
    await row.dblclick();
    await expect(kept.locator('[data-track-id="502"]')).toBeVisible();
    await kept.getByRole('button', { name: 'Last Train：移到删除 / 跳过', exact: true }).click();
    await expect(removed.locator('[data-track-id="502"]')).toBeVisible();
    expect(fs.readdirSync(target)).toHaveLength(1);
    await page.getByRole('button', { name: '同步当前歌单', exact: true }).click();
    await expect.poll(() => fs.readdirSync(target).length).toBe(0);
    expect(fs.readdirSync(original)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    for (const target of [musicRoot, userData]) {
      if (path.basename(target).startsWith('ncmsync-e2e-mapping-')) fs.rmSync(target, { recursive: true, force: true });
    }
  }
});
