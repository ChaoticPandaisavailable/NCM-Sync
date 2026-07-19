const test = require('node:test');
const assert = require('node:assert/strict');
const { NeteaseClient, cdnCandidates } = require('../../src/backend/netease.cjs');

test('登录后读取账号 ID、昵称和会员类型', async () => {
  const client = new NeteaseClient({ fetchImpl: async () => Response.json({
    code: 200,
    account: { id: 123456789 },
    profile: { nickname: '测试账号', vipType: 11 }
  }) });
  assert.deepEqual(await client.getAccount(), { userId: '123456789', nickname: '测试账号', vipType: 11 });
});

test('播放器 CDN 节点不可用时回退到其他网易云官方节点', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/song/enhance/player/url/v1')) {
      return Response.json({ code: 200, data: [{ code: 200, url: 'http://m704.music.126.net/song.mp3?authSecret=signed' }] });
    }
    if (String(url).includes('m704.music.126.net')) return new Response('<html>403</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    if (String(url).includes('m701.music.126.net')) return new Response('ID3-audio', { status: 206, headers: { 'content-type': 'audio/mpeg' } });
    throw new Error(`不应请求 ${url}`);
  };
  const response = await new NeteaseClient({ cookie: 'MUSIC_U=test', fetchImpl }).getAudioResponse('2650282623');
  assert.equal(response.status, 206);
  assert.match(calls[1], /m704\.music\.126\.net/);
  assert.match(calls[2], /m701\.music\.126\.net/);
});

test('播放器接口没有地址时回退到旧外链', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/song/enhance/player/url/v1')) return Response.json({ code: 200, data: [{ code: -110, url: null }] });
    return new Response('ID3-legacy', { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const response = await new NeteaseClient({ fetchImpl }).getAudioResponse('7');
  assert.equal(response.status, 200);
});

test('CDN 回退只改写网易云官方音频域名并保留签名', () => {
  const urls = cdnCandidates('http://m804.music.126.net/a.mp3?authSecret=abc');
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => new URL(url).searchParams.get('authSecret') === 'abc'));
  assert.deepEqual(cdnCandidates('https://example.com/a.mp3'), ['https://example.com/a.mp3']);
});

test('超大歌单通过小批量 POST 补全全部歌曲元数据', async () => {
  const total = 4867;
  const trackIds = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
  const batchSizes = [];
  const client = new NeteaseClient({ fetchImpl: async (url, options = {}) => {
    if (String(url).includes('/api/v6/playlist/detail')) {
      return Response.json({ code: 200, playlist: { id: 999, name: '超大歌单', trackIds, tracks: [] } });
    }
    assert.equal(options.method, 'POST');
    const batch = JSON.parse(new URLSearchParams(options.body).get('c'));
    batchSizes.push(batch.length);
    return Response.json({ code: 200, songs: batch.map(({ id }) => ({
      id,
      name: `Track ${id}`,
      ar: [{ name: 'Artist' }],
      al: { name: 'Album' },
      dt: 180000
    })) });
  } });

  const detail = await client.getPlaylist('999');
  assert.equal(detail.tracks.length, total);
  assert.equal(detail.tracks.at(-1).name, `Track ${total}`);
  assert.ok(batchSizes.length > 20);
  assert.ok(batchSizes.every((size) => size <= 200));
});
