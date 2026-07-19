const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-packaged-root-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-packaged-user-'));
  const executablePath = process.env.NCMSYNC_PACKAGED_EXE
    ? path.resolve(process.env.NCMSYNC_PACKAGED_EXE)
    : path.resolve(__dirname, '../release/win-unpacked/NCM Sync.exe');
  if (!fs.existsSync(executablePath)) throw new Error('请先运行 npm run dist:dir');
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('text=连接你的网易云音乐', { timeout: 15_000 });
    console.log(JSON.stringify({ packagedLaunch: true, title: await page.title(), executablePath }));
  } finally {
    await app.close();
    for (const target of [root, userData]) {
      if (path.basename(target).startsWith('cloudmusic-packaged-')) fs.rmSync(target, { recursive: true, force: true });
    }
  }
})().catch((error) => { console.error(error); process.exit(1); });
