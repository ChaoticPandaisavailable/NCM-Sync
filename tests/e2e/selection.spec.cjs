const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('歌单复选框、逐曲选择、整批撤回和不同本地状态颜色', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-selection-'));
  const musicRoot = path.join(base, 'library');
  const folder = path.join(musicRoot, 'DJ', '夜航测试集');
  const ignored = path.join(musicRoot, 'DJ', '收藏节拍');
  fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(ignored);
  fs.writeFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'unchanged-song');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: musicRoot, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await expect(page.getByRole('button', { name: '同步所选' })).toBeDisabled();
    await page.getByRole('button', { name: '刷新歌单' }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(0);
    await page.getByRole('button', { name: '全选当前列表' }).click();
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).toBeChecked();
    await expect(page.getByLabel('同步歌单：超大歌单测试', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '取消全选', exact: true }).click();
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).not.toBeChecked();
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '匹配所选歌单的现有目录' }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(folder);
    await page.locator('.online-pane tbody tr').filter({ hasText: '夜航测试集' }).dblclick();
    const local = page.getByLabel('同步歌曲：Neon Run', { exact: true });
    const missing = page.getByLabel('同步歌曲：Last Train', { exact: true });
    await expect(local).toBeChecked(); await expect(missing).toBeChecked();
    await expect(page.locator('.editor-track.is-local')).toContainText('本地已有');
    await expect(page.locator('.editor-track.is-missing')).toContainText('尚未下载');
    const colors = await page.locator('.editor-track-info small').evaluateAll((items) => items.map((item) => getComputedStyle(item).color));
    expect(new Set(colors).size).toBe(2);
    await page.getByRole('button', { name: '取消全选歌曲' }).click();
    await expect(local).not.toBeChecked(); await expect(missing).not.toBeChecked();
    await page.getByRole('button', { name: '撤回', exact: true }).click();
    await expect(local).toBeChecked(); await expect(missing).toBeChecked();
    await page.getByRole('button', { name: '取消全选歌曲' }).click();
    await page.getByRole('button', { name: '全选歌曲', exact: true }).click();
    await local.uncheck();
    await expect(missing).toBeChecked();
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'song-selection.png'), fullPage: true });
    await page.getByRole('button', { name: '返回歌单' }).click();
    await page.locator('.local-pane tbody tr').dblclick();
    await expect(local).not.toBeChecked(); await expect(missing).toBeChecked();
    await page.getByRole('button', { name: '同步当前歌单', exact: true }).click();
    await expect.poll(() => fs.readdirSync(folder).length).toBe(2);
    expect(fs.readFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'utf8')).toBe('unchanged-song');
    expect(fs.readdirSync(ignored)).toHaveLength(0);
    expect(fs.existsSync(path.join(musicRoot, '超大歌单测试'))).toBe(false);
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '清空选择' }).click();
    await expect(page.getByRole('button', { name: '同步所选' })).toBeDisabled();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'selection-workspace.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (path.basename(base).startsWith('ncmsync-e2e-selection-')) fs.rmSync(base, { recursive: true, force: true });
  }
});
