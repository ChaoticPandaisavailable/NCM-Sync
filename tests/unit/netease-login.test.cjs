const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedNeteaseUrl, cookieHeader, clearMusicCookie } = require('../../src/main/netease-login.cjs');

test('网易云登录窗口只允许受信任的 HTTPS 域名', () => {
  assert.equal(isAllowedNeteaseUrl('https://music.163.com/#/login'), true);
  assert.equal(isAllowedNeteaseUrl('https://interface.music.163.com/api'), true);
  assert.equal(isAllowedNeteaseUrl('http://music.163.com/'), false);
  assert.equal(isAllowedNeteaseUrl('https://music.163.com.example.com/'), false);
});

test('只把 MUSIC_U 值组装为请求 Cookie', () => {
  assert.equal(cookieHeader({ value: 'secret-value' }), 'MUSIC_U=secret-value');
  assert.equal(cookieHeader({ value: '' }), '');
});

test('开始新登录前清理登录会话中的旧 MUSIC_U', async () => {
  const removed = [];
  const cookies = {
    get: async () => [
      { name: 'MUSIC_U', domain: '.music.163.com', path: '/', secure: true },
      { name: 'MUSIC_U', domain: 'music.163.com', path: '/weapi', secure: false }
    ],
    remove: async (url, name) => removed.push([url, name])
  };
  await clearMusicCookie(cookies);
  assert.deepEqual(removed, [
    ['https://music.163.com/', 'MUSIC_U'],
    ['http://music.163.com/weapi', 'MUSIC_U']
  ]);
});
