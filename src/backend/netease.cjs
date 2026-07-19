const { formatTrack } = require('./utils.cjs');

class NeteaseClient {
  constructor({ cookie = '', fetchImpl = global.fetch, mock = false } = {}) {
    this.cookie = cookie;
    this.fetch = fetchImpl;
    this.mock = mock;
  }

  setCookie(cookie) { this.cookie = cookie || ''; }

  headers() {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://music.163.com/',
      Accept: 'application/json,text/plain,*/*'
    };
    if (this.cookie) headers.Cookie = this.cookie;
    return headers;
  }

  async json(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      headers: { ...this.headers(), ...(options.headers || {}) },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`网易云服务器返回 ${response.status}`);
    const data = await response.json();
    if (data.code !== 200) throw new Error(data.message || `网易云接口错误 ${data.code}`);
    return data;
  }

  async getAccount() {
    if (this.mock) return { userId: '123456789', nickname: '测试账号', vipType: 11 };
    const data = await this.json('https://music.163.com/api/nuser/account/get');
    const userId = data.account?.id || data.profile?.userId;
    if (!userId) throw new Error('登录成功，但未能读取网易云账号 ID');
    return {
      userId: String(userId),
      nickname: data.profile?.nickname || '',
      vipType: data.profile?.vipType ?? data.account?.vipType ?? 0
    };
  }

  async getUserPlaylists(userId) {
    if (this.mock) return mockPlaylists(userId);
    const all = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.json(`https://music.163.com/api/user/playlist?uid=${encodeURIComponent(userId)}&limit=50&offset=${offset}`);
      const list = data.playlist || [];
      for (const item of list) {
        if (!all.some((existing) => String(existing.id) === String(item.id))) all.push(item);
      }
      if (!data.more || list.length === 0) break;
      offset += 50;
    }
    if (!all.length) throw new Error('未找到用户，请检查是否输入正确');
    return all.map((item) => ({
      id: String(item.id),
      name: item.name,
      creatorId: String(item.creator?.userId || ''),
      createdAt: item.createTime || 0,
      trackCount: item.trackCount || 0,
      kind: String(item.creator?.userId) === String(userId) ? 'created' : 'saved',
      coverUrl: item.coverImgUrl || ''
    }));
  }

  async getPlaylist(playlistId) {
    if (this.mock) return mockPlaylistDetail(playlistId);
    const data = await this.json(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=1000&s=8`);
    if (!data.playlist) throw new Error('歌单已失效或无权访问');
    const playlist = data.playlist;
    const trackIds = (playlist.trackIds || []).map((item) => String(item.id));
    const known = new Map((playlist.tracks || []).map((track) => [String(track.id), formatTrack(track)]));
    const missing = trackIds.filter((id) => !known.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const ids = missing.slice(i, i + 200);
      const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
      let detail;
      try {
        detail = await this.json('https://music.163.com/api/v3/song/detail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: `c=${encodeURIComponent(c)}`
        });
      } catch (postError) {
        detail = await this.json(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(c)}`).catch(() => { throw postError; });
      }
      for (const track of detail.songs || []) known.set(String(track.id), formatTrack(track));
    }
    const tracks = trackIds.map((id) => known.get(id) || { id, name: `歌曲 ${id}`, artists: [], album: '', duration: 0 });
    return { id: String(playlist.id), name: playlist.name, tracks, trackCount: trackIds.length };
  }

  async getAudioResponse(trackId, signal) {
    if (this.mock) {
      let index = 0;
      const mockDelay = Math.max(0, Number(process.env.CLOUDMUSIC_MOCK_AUDIO_DELAY_MS) || 18);
      const stream = new ReadableStream({
        async pull(controller) {
          if (signal?.aborted) return controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          await new Promise((resolve) => setTimeout(resolve, mockDelay));
          if (index >= 6) return controller.close();
          const prefix = index === 0 ? 'ID3\u0004\u0000\u0000' : '';
          controller.enqueue(Buffer.from(`${prefix}mock-audio-${trackId}-${index}-${'x'.repeat(256)}`));
          index += 1;
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    const candidates = [];
    let playerError = '';
    try {
      const ids = encodeURIComponent(JSON.stringify([Number(trackId)]));
      const data = await this.json(`https://music.163.com/api/song/enhance/player/url/v1?ids=${ids}&level=exhigh&encodeType=mp3`);
      const audio = data.data?.[0];
      if (audio?.url && audio.code === 200) candidates.push(...cdnCandidates(audio.url));
      else playerError = audio?.message || (audio?.code ? `音源代码 ${audio.code}` : '账号没有可用播放地址');
    } catch (error) {
      playerError = error.message;
    }
    candidates.push(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(trackId)}.mp3`);

    const failures = [];
    for (const url of [...new Set(candidates)]) {
      try {
        const response = await this.fetch(url, { headers: this.headers(), redirect: 'follow', signal });
        const type = (response.headers.get('content-type') || '').toLowerCase();
        if (response.ok && !type.includes('text/html') && !type.includes('application/json')) return response;
        failures.push(`HTTP ${response.status}${type ? ` ${type.split(';')[0]}` : ''}`);
        await response.body?.cancel();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        failures.push(error.message);
      }
    }
    const reason = playerError || failures.at(-1) || '未知错误';
    throw new Error(`歌曲无可用音源：${reason}。请确认会员或数字专辑权限，或稍后重试`);
  }
}

function cdnCandidates(value) {
  try {
    const original = new URL(value);
    if (!/^m\d+\.music\.126\.net$/i.test(original.hostname)) return [original.toString()];
    const candidates = [original.toString()];
    for (const host of ['m701.music.126.net', 'm801.music.126.net']) {
      const alternate = new URL(original);
      alternate.hostname = host;
      candidates.push(alternate.toString());
    }
    return candidates;
  } catch {
    return [];
  }
}

function mockPlaylists(userId) {
  if (String(userId) === '0') throw new Error('未找到用户，请检查是否输入正确');
  return [
    { id: '1001', name: '夜航测试集', creatorId: String(userId), createdAt: 1710000000000, trackCount: 2, kind: 'created', coverUrl: '' },
    { id: '1999', name: '超大歌单测试', creatorId: String(userId), createdAt: 1600000000000, trackCount: 4867, kind: 'created', coverUrl: '' },
    { id: '1002', name: '收藏节拍', creatorId: '9000', createdAt: 1700000000000, trackCount: 1, kind: 'saved', coverUrl: '' }
  ];
}

function mockPlaylistDetail(playlistId) {
  if (String(playlistId) === '1999') {
    const tracks = Array.from({ length: 4867 }, (_, index) => ({
      id: `large-${index + 1}`,
      name: `Large Track ${index + 1}`,
      artists: [`Artist ${index % 37}`],
      album: 'Large Playlist',
      duration: 180000 + (index % 60) * 1000
    }));
    return { id: '1999', name: '超大歌单测试', tracks, trackCount: tracks.length };
  }
  const lists = {
    '1001': { id: '1001', name: '夜航测试集', tracks: [
      { id: '501', name: 'Neon Run', artists: ['Test Artist'], album: 'Night', duration: 180000 },
      { id: '502', name: 'Last Train', artists: ['Demo Unit'], album: 'Night', duration: 210000 }
    ] },
    '1002': { id: '1002', name: '收藏节拍', tracks: [
      { id: '503', name: 'Saved Groove', artists: ['Friend'], album: 'Box', duration: 160000 }
    ] }
  };
  const value = lists[String(playlistId)];
  if (!value) throw new Error('歌单已失效或无权访问');
  return { ...value, trackCount: value.tracks.length };
}

module.exports = { NeteaseClient, cdnCandidates, mockPlaylists, mockPlaylistDetail };
