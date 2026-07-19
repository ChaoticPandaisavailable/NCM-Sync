const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Database } = require('../backend/database.cjs');
const { FileStore } = require('../backend/file-store.cjs');
const { NeteaseClient } = require('../backend/netease.cjs');
const { TaskManager } = require('../backend/task-manager.cjs');
const { AppService } = require('../backend/app-service.cjs');
const { createServer } = require('../backend/server.cjs');
const { openNeteaseLogin } = require('./netease-login.cjs');

let mainWindow;
let runtime;
let loginFlow;

// 部分 Windows 驱动/远程桌面环境无法启动 Chromium GPU 子进程；本应用不依赖 GPU 渲染。
app.disableHardwareAcceleration();

function assertMainRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('拒绝未授权的桌面请求');
}

ipcMain.handle('cloudmusic:acquire-netease-account', async (event) => {
  assertMainRenderer(event);
  if (!runtime?.service) throw new Error('应用尚未准备完成');
  let cookie;
  let account;
  if (process.env.CLOUDMUSIC_MOCK === '1') {
    cookie = 'MUSIC_U=mock-login-cookie';
    account = await new NeteaseClient({ cookie, mock: true }).getAccount();
  } else {
    if (!loginFlow) {
      const flow = openNeteaseLogin({ BrowserWindow, parent: mainWindow });
      loginFlow = flow;
      flow.result.then(
        () => { if (loginFlow === flow) loginFlow = null; },
        () => { if (loginFlow === flow) loginFlow = null; }
      );
    } else if (!loginFlow.window.isDestroyed()) {
      loginFlow.window.show();
      loginFlow.window.focus();
    }
    cookie = await loginFlow.result;
    if (!cookie) return { acquired: false };
    account = await new NeteaseClient({ cookie }).getAccount();
  }
  const taskBefore = runtime.service.tasks.getState();
  const updated = runtime.service.updateSettings({ cookie });
  const canResume = taskBefore.active && taskBefore.paused && /Cookie|VIP|无可用音源|HTTP 403/i.test(taskBefore.error);
  if (canResume) runtime.service.tasks.resume();
  return { ...account, acquired: true, resumed: canResume, retryRequired: !taskBefore.active && Boolean(updated.settings.interruptedTask) };
});

ipcMain.handle('cloudmusic:get-saved-cookie', (event) => {
  assertMainRenderer(event);
  if (!runtime?.service) throw new Error('应用尚未准备完成');
  return { cookie: runtime.service.db.getSettings().cookie || '' };
});

ipcMain.handle('cloudmusic:browse-library', async (event, currentPath) => {
  assertMainRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音乐库位置',
    defaultPath: currentPath || resolveRoot(),
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('cloudmusic:window-minimize', (event) => {
  assertMainRenderer(event);
  mainWindow.minimize();
});

ipcMain.handle('cloudmusic:window-toggle-maximize', (event) => {
  assertMainRenderer(event);
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('cloudmusic:window-close', (event) => {
  assertMainRenderer(event);
  mainWindow.close();
});

function locationConfigPath() { return path.join(app.getPath('userData'), 'library-location.json'); }
function defaultLibraryPath() { return path.join(app.getPath('music'), 'music library'); }

function persistLibraryPath(libraryPath) {
  const configPath = locationConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ libraryPath }, null, 2), 'utf8');
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
  fs.renameSync(temporary, configPath);
}

function resolveRoot() {
  if (process.env.CLOUDMUSIC_ROOT) return path.resolve(process.env.CLOUDMUSIC_ROOT);
  try {
    const saved = JSON.parse(fs.readFileSync(locationConfigPath(), 'utf8'));
    if (saved.libraryPath && path.isAbsolute(saved.libraryPath)) return path.resolve(saved.libraryPath);
  } catch { /* 首次运行 */ }
  const legacyDevelopmentRoot = path.resolve(__dirname, '../..');
  if (!app.isPackaged && fs.existsSync(path.join(legacyDevelopmentRoot, '.cloudmusic', 'cloudmusic.sqlite'))) return legacyDevelopmentRoot;
  return defaultLibraryPath();
}

function configureDevelopmentStorage() {
  if (!process.env.CLOUDMUSIC_DEV_URL) return;
  const basePath = path.join(path.resolve(__dirname, '../..'), '.cloudmusic', 'electron-dev');
  const userDataPath = path.join(basePath, 'user-data');
  const sessionDataPath = path.join(basePath, 'session-data');
  const cachePath = path.join(basePath, 'cache');
  for (const target of [userDataPath, sessionDataPath, cachePath]) fs.mkdirSync(target, { recursive: true });
  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);
  app.setPath('cache', cachePath);
  app.commandLine.appendSwitch('disk-cache-dir', cachePath);
}

configureDevelopmentStorage();

async function boot() {
  const rootPath = resolveRoot();
  const initialDefaultLibraryPath = process.env.CLOUDMUSIC_ROOT ? rootPath : defaultLibraryPath();
  const fileStore = new FileStore(rootPath);
  const db = await new Database(path.join(fileStore.dataPath, 'cloudmusic.sqlite')).init();
  const tasks = new TaskManager();
  const netease = new NeteaseClient({ mock: process.env.CLOUDMUSIC_MOCK === '1' });
  const service = new AppService({
    db, fileStore, netease, tasks,
    openPath: (target) => shell.openPath(target),
    rootPath,
    defaultLibraryPath: initialDefaultLibraryPath,
    persistLibraryPath,
    realtimeIntervalMs: Number(process.env.CLOUDMUSIC_REALTIME_INTERVAL_MS) || 15_000,
    downloadConcurrency: Number(process.env.CLOUDMUSIC_DOWNLOAD_CONCURRENCY) || 4
  });
  service.start();
  const devUrl = process.env.CLOUDMUSIC_DEV_URL;
  const staticPath = devUrl ? null : path.resolve(__dirname, '../../dist');
  const port = devUrl ? 37891 : 0;
  const serverRuntime = await createServer({ service, staticPath, port, rendererOrigin: devUrl || '' });
  runtime = { ...serverRuntime, service };

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b101b',
    title: 'NCM Sync',
    icon: path.resolve(__dirname, '../../assets/ncmsync-logo-256.png'),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(devUrl || serverRuntime.url);
  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
}

app.whenReady().then(boot).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on('before-quit', () => {
  runtime?.service.stop();
  runtime?.server.close();
});
