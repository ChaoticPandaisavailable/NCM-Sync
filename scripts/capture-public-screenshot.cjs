const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-public-library-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-public-user-'));
  const outputPath = path.join(projectRoot, 'docs', 'images', 'ncm-sync-overview.png');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      CLOUDMUSIC_ROOT: libraryRoot,
      CLOUDMUSIC_MOCK: '1',
      CLOUDMUSIC_MOCK_AUDIO_DELAY_MS: '30',
      CLOUDMUSIC_REALTIME_INTERVAL_MS: '60000'
    }
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByText('夜航测试集', { exact: true }).click();
    await page.getByRole('button', { name: /添加到本地歌单/ }).click();
    await page.getByRole('button', { name: '一键同步' }).click();
    await page.locator('.local-pane .status-badge.synced').waitFor({ timeout: 10_000 });
    await page.locator('.realtime-switch').click();
    await page.getByText('实时同步正在监测所有未暂停歌单').waitFor({ timeout: 10_000 });
    await page.addStyleTag({ content: String.raw`
      .library-location code { font-size: 0 !important; }
      .library-location code::after { content: 'C:\\Music\\NCM Sync Library'; font: 10px Consolas, monospace; }
    ` });
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(outputPath);
  } finally {
    await app.close();
    for (const target of [libraryRoot, userData]) {
      if (path.basename(target).startsWith('ncmsync-public-')) fs.rmSync(target, { recursive: true, force: true });
    }
  }
})().catch((error) => { console.error(error); process.exit(1); });
