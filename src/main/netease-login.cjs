const LOGIN_URL = 'https://music.163.com/#/login';

function isAllowedNeteaseUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === 'https:' && (hostname === 'music.163.com' || hostname.endsWith('.music.163.com'));
  } catch {
    return false;
  }
}

function cookieHeader(cookie) {
  if (!cookie?.value) return '';
  return `MUSIC_U=${cookie.value}`;
}

async function clearMusicCookie(cookies) {
  const existing = await cookies.get({ name: 'MUSIC_U' });
  await Promise.all(existing.map((cookie) => {
    const host = (cookie.domain || 'music.163.com').replace(/^\./, '');
    const protocol = cookie.secure === false ? 'http:' : 'https:';
    return cookies.remove(`${protocol}//${host}${cookie.path || '/'}`, cookie.name);
  }));
}

function openNeteaseLogin({ BrowserWindow, parent, partition = 'netease-login' }) {
  let loginWindow;
  let internalClose = false;
  let settled = false;

  const result = new Promise((resolve, reject) => {
    loginWindow = new BrowserWindow({
      parent,
      modal: true,
      width: 1080,
      height: 760,
      minWidth: 820,
      minHeight: 620,
      show: false,
      title: '登录网易云音乐',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const cookies = loginWindow.webContents.session.cookies;
    const cleanup = () => cookies.removeListener('changed', onCookieChanged);
    const closeWindow = () => {
      if (!loginWindow.isDestroyed()) {
        internalClose = true;
        loginWindow.close();
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
      closeWindow();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      if (!loginWindow.isDestroyed()) loginWindow.destroy();
    };
    const readCookie = async () => {
      const matches = await cookies.get({ url: 'https://music.163.com', name: 'MUSIC_U' });
      return cookieHeader(matches[0]);
    };
    function onCookieChanged(_event, cookie, _cause, removed) {
      const domainUrl = `https://${(cookie.domain || 'music.163.com').replace(/^\./, '')}`;
      if (!removed && cookie.name === 'MUSIC_U' && isAllowedNeteaseUrl(domainUrl)) finish(cookieHeader(cookie));
    }

    cookies.on('changed', onCookieChanged);
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNeteaseUrl(url)) setImmediate(() => loginWindow.loadURL(url));
      return { action: 'deny' };
    });
    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNeteaseUrl(url)) event.preventDefault();
    });
    loginWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fail(new Error(`网易云登录页加载失败：${description}`));
    });
    loginWindow.on('close', (event) => {
      if (internalClose || settled) return;
      event.preventDefault();
      readCookie().then((value) => finish(value || null), fail);
    });
    loginWindow.on('closed', () => {
      if (!settled) finish(null);
    });

    clearMusicCookie(cookies)
      .then(() => loginWindow.loadURL(LOGIN_URL))
      .then(() => { if (!loginWindow.isDestroyed()) loginWindow.show(); })
      .catch(fail);
  });

  return { window: loginWindow, result };
}

module.exports = { LOGIN_URL, isAllowedNeteaseUrl, cookieHeader, clearMusicCookie, openNeteaseLogin };
