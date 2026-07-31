const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseJson, normalizeInterval, sanitizeName } = require('./utils.cjs');
const { CancelledError } = require('./task-manager.cjs');
const { FileStore } = require('./file-store.cjs');
const { writeAudioTags } = require('./tag-writer.cjs');

const MAX_TRACK_ATTEMPTS = 2;

class AppService {
  constructor({ db, fileStore, netease, tasks, openPath = async () => '', rootPath, defaultLibraryPath = '', persistLibraryPath = async () => {}, realtimeIntervalMs = 15_000, downloadConcurrency }) {
    this.db = db;
    this.fileStore = fileStore;
    this.netease = netease;
    this.tasks = tasks;
    this.openPath = openPath;
    this.rootPath = rootPath;
    this.defaultLibraryPath = defaultLibraryPath;
    this.persistLibraryPath = persistLibraryPath;
    this.scanning = false;
    this.scanSource = '';
    this.scanStatus = '尚未扫描';
    this.autoTimer = null;
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
    this.realtimeCyclePromise = null;
    this.pendingRealtimeIds = new Set();
    this.realtimeIntervalMs = Math.max(1_000, Number(realtimeIntervalMs) || 15_000);
    const configured = Number(downloadConcurrency ?? this.db.getSettings().downloadConcurrency);
    this.downloadConcurrency = Math.max(1, Math.min(8, Math.floor(configured) || 4));
    this.syncPromise = null;
    this.startupScanPromise = null;
  }

  start() {
    const settings = this.db.getSettings();
    if (!settings.libraryPath) this.db.setSettings({ libraryPath: this.rootPath });
    this.netease.setCookie(settings.cookie);
    if (settings.interruptedTask) this.scanStatus = '上次同步未完成，任务已暂停；请重新发起同步';
    this.configureAutoScan();
    this.configureRealtimeSync(false);
    if (settings.initialized && settings.userId) {
      this.startupScanPromise = this.scanAll('startup').then((result) => {
        const latest = this.db.getSettings();
        if (latest.realtimeSync && result.unsynced > 0 && !this.tasks.active) this.startSync(undefined, 'realtime');
        return result;
      }).catch((error) => {
        this.scanStatus = `启动扫描失败：${error.message}`;
      });
    }
  }

  stop() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.autoTimer = null;
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
  }

  configureAutoScan() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    const settings = this.db.getSettings();
    if (!settings.autoScan) return;
    const interval = normalizeInterval(settings.scanHours, settings.scanMinutes).totalMinutes * 60_000;
    this.autoTimer = setInterval(() => this.runAutomaticCycle('auto', this.db.getSettings().autoSync), interval);
    this.autoTimer.unref?.();
  }

  configureRealtimeSync(runImmediately = true) {
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
    const settings = this.db.getSettings();
    if (!settings.realtimeSync || !settings.initialized || !settings.userId) return;
    this.realtimeTimer = setInterval(() => this.runAutomaticCycle('realtime', true), this.realtimeIntervalMs);
    this.realtimeTimer.unref?.();
    if (runImmediately) this.scheduleRealtimeCycle(0);
  }

  scheduleRealtimeCycle(delay = 0) {
    if (!this.db.getSettings().realtimeSync) return;
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.realtimeKickTimer = setTimeout(() => {
      this.realtimeKickTimer = null;
      this.runAutomaticCycle('realtime', true);
    }, delay);
    this.realtimeKickTimer.unref?.();
  }

  runAutomaticCycle(source, shouldSync) {
    if (this.realtimeCyclePromise || this.scanning || this.tasks.active || this.tasks.paused) return this.realtimeCyclePromise;
    if (source === 'realtime' && !this.db.getSettings().realtimeSync) return null;
    const cycle = (async () => {
      try {
        const result = await this.scanAll(source);
        const stillEnabled = source !== 'realtime' || this.db.getSettings().realtimeSync;
        if (shouldSync && stillEnabled && result.unsynced > 0 && !this.tasks.active) this.startSync(undefined, source);
        return result;
      } catch (error) {
        this.scanStatus = `${source === 'realtime' ? '实时同步检测' : '自动扫描'}失败：${error.message}`;
        return null;
      } finally {
        if (this.realtimeCyclePromise === cycle) this.realtimeCyclePromise = null;
      }
    })();
    this.realtimeCyclePromise = cycle;
    return cycle;
  }

  bootstrap() {
    const settings = this.db.getSettings();
    return {
      settings: { ...settings, cookie: settings.cookie ? '••••••••' : '' },
      initialized: Boolean(settings.initialized),
      online: this.onlinePlaylists(),
      local: this.localPlaylists(),
      scanning: this.scanning,
      scanSource: this.scanSource,
      scanStatus: this.scanStatus,
      task: this.tasks.getState(),
      rootPath: this.rootPath,
      lastScanAt: settings.lastScanAt || null,
      lastSyncAt: settings.lastSyncAt || null
    };
  }

  onlinePlaylists() {
    return this.db.all('SELECT * FROM online_playlists ORDER BY created_at DESC').map((row) => ({
      id: row.id, name: row.name, creatorId: row.creator_id, createdAt: row.created_at,
      trackCount: row.track_count, kind: row.kind, coverUrl: row.cover_url || ''
    }));
  }

  localPlaylists() {
    return this.db.all('SELECT * FROM local_playlists ORDER BY added_at DESC').map((row) => this.mapLocal(row));
  }

  mapLocal(row) {
    const added = parseJson(row.added_json, []);
    const removed = parseJson(row.removed_json, []);
    const removedIds = new Set(removed.map((track) => String(track.id)));
    const existing = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [row.id])
      .map(dbTrack).filter((track) => !removedIds.has(String(track.id)));
    let status = 'synced';
    if (row.paused) status = 'paused';
    else if (row.offline) status = 'offline';
    else if (added.length || removed.length || row.pending_name || row.error) status = 'pending';
    const displayName = sanitizeName(row.name) === row.folder_name ? row.name : `${row.name}（${row.folder_name}）`;
    return {
      id: row.id, onlineId: row.online_id, name: row.name, folderName: row.folder_name,
      displayName,
      folderPath: this.fileStore.playlistPath(row.folder_name), createdAt: row.created_at,
      trackCount: row.track_count, paused: Boolean(row.paused), offline: Boolean(row.offline),
      previousName: row.previous_name, pendingName: row.pending_name,
      added, removed, existing,
      lastSyncAt: row.last_sync_at, lastScanAt: row.last_scan_at,
      syncProgress: row.sync_progress, error: row.error, status
    };
  }

  async setupUser(userId, changing = false) {
    const normalized = String(userId || '').trim();
    if (!/^\d+$/.test(normalized)) throw new Error('用户 ID 只能包含数字');
    const current = this.db.getSettings();
    const playlists = await this.netease.getUserPlaylists(normalized);
    if (changing && current.userId && current.userId !== normalized) {
      this.db.run('UPDATE local_playlists SET offline=1, error=?', ['用户 ID 已更换，请重定向歌单']);
    }
    this.db.setSettings({ userId: normalized, initialized: true, lastScanAt: Date.now() });
    this.storeOnline(playlists);
    const hadLocalPlaylists = Boolean(this.db.get('SELECT COUNT(*) AS count FROM local_playlists')?.count);
    const discovered = !current.userId ? await this.discoverExistingPlaylistFolders() : { matched: 0, added: 0, ids: [] };
    if (hadLocalPlaylists) await this.scan('setup');
    else if (discovered.matched) this.scanStatus = `已获取 ${playlists.length} 个在线歌单，并从音乐库识别 ${discovered.matched} 个本地歌单`;
    else this.scanStatus = `已获取 ${playlists.length} 个在线歌单`;
    this.configureRealtimeSync();
    return this.bootstrap();
  }

  dismissSetup() {
    this.db.setSettings({ initialized: true });
    this.scanStatus = '当前未设置用户 ID，请先设置用户 ID 后使用同步功能';
    return this.bootstrap();
  }

  async refreshOnline(markScan = true) {
    const { userId } = this.db.getSettings();
    if (!userId) throw new Error('当前未设置用户 ID');
    if (markScan) this.db.setSettings({ lastScanAt: Date.now() });
    const playlists = await this.netease.getUserPlaylists(userId);
    this.storeOnline(playlists);
    if (markScan) this.db.setSettings({ lastScanAt: Date.now() });
    this.scanStatus = `已刷新 ${playlists.length} 个在线歌单`;
    return playlists;
  }

  async scanAll(source = 'manual') {
    if (this.scanning) throw new Error('扫描已在进行中');
    if (this.tasks.active) throw new Error('同步任务进行中，暂时不能扫描');
    this.scanning = true;
    this.scanSource = source;
    this.scanStatus = scanMessage(source);
    this.db.setSettings({ lastScanAt: Date.now() });
    try {
      await this.refreshOnline(false);
      return await this.scan(source, true);
    } finally {
      this.scanning = false;
      this.scanSource = '';
    }
  }

  storeOnline(playlists) {
    const now = Date.now();
    this.db.transaction(() => {
      const ids = playlists.map((item) => item.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        this.db.db.run(`DELETE FROM online_playlists WHERE id NOT IN (${placeholders})`, ids);
      } else this.db.db.run('DELETE FROM online_playlists');
      for (const item of playlists) {
        this.db.db.run(`INSERT INTO online_playlists(id,name,creator_id,created_at,track_count,kind,cover_url,raw_json,fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,creator_id=excluded.creator_id,
          created_at=excluded.created_at,track_count=excluded.track_count,kind=excluded.kind,cover_url=excluded.cover_url,fetched_at=excluded.fetched_at`,
        [item.id, item.name, item.creatorId, item.createdAt, item.trackCount, item.kind, item.coverUrl, '{}', now]);
      }
    });
  }

  async playlistDetail(id) { return this.netease.getPlaylist(id); }

  async addLocal(onlineIds) {
    if (this.scanning) throw new Error('扫描进行中，暂时不能添加歌单');
    const unique = [...new Set((onlineIds || []).map(String))];
    const added = [];
    for (const onlineId of unique) {
      if (this.db.get('SELECT id FROM local_playlists WHERE online_id=?', [onlineId])) continue;
      const online = this.db.get('SELECT * FROM online_playlists WHERE id=?', [onlineId]);
      if (!online) throw new Error(`在线歌单 ${onlineId} 不存在`);
      const detail = await this.netease.getPlaylist(onlineId);
      const id = crypto.randomUUID();
      const rows = this.db.all('SELECT id,folder_name FROM local_playlists');
      const folderName = this.fileStore.chooseFolderName(online.name, id, rows);
      this.fileStore.ensurePlaylistFolder(folderName);
      this.db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,created_at,track_count,added_at,added_json,removed_json,existing_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, onlineId, online.name, folderName, online.created_at, 0, Date.now(), '[]', '[]', '[]']);
      await this.adoptAndDiff(id, detail);
      added.push(id);
    }
    if (added.length && this.db.getSettings().realtimeSync) {
      if (!this.tasks.active && !this.scanning) this.startSync(added, 'realtime');
      else for (const id of added) this.pendingRealtimeIds.add(id);
    }
    return { added, local: this.localPlaylists() };
  }

  async discoverExistingPlaylistFolders() {
    const folders = this.fileStore.listPlaylistFolders();
    if (!folders.length) return { matched: 0, added: 0, ids: [] };
    const available = new Map(folders.map((folder) => [folder.toLowerCase(), folder]));
    const claimed = new Set();
    const onlineRows = this.db.all('SELECT * FROM online_playlists ORDER BY created_at DESC');
    const localRows = this.db.all('SELECT * FROM local_playlists');
    const localsByOnlineId = new Map(localRows.filter((row) => row.online_id).map((row) => [String(row.online_id), row]));
    const baseNameCounts = new Map();
    for (const online of onlineRows) {
      const key = sanitizeName(online.name).toLowerCase();
      baseNameCounts.set(key, (baseNameCounts.get(key) || 0) + 1);
    }
    const result = { matched: 0, added: 0, ids: [] };
    for (const online of onlineRows) {
      const onlineId = String(online.id);
      const local = localsByOnlineId.get(onlineId);
      const baseName = sanitizeName(online.name);
      const candidates = [];
      if (local?.folder_name) candidates.push(local.folder_name);
      candidates.push(`${baseName} [${onlineId}]`);
      if (local || baseNameCounts.get(baseName.toLowerCase()) === 1) candidates.push(baseName);
      const folderName = candidates
        .map((candidate) => available.get(candidate.toLowerCase()))
        .find((candidate) => candidate && !claimed.has(candidate.toLowerCase()));
      if (!folderName) continue;
      claimed.add(folderName.toLowerCase());
      let localId = local?.id;
      if (local) {
        this.db.run(`UPDATE local_playlists SET name=?,folder_name=?,created_at=?,offline=0,error=NULL WHERE id=?`,
          [online.name, folderName, online.created_at, local.id]);
      } else {
        localId = crypto.randomUUID();
        this.db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,created_at,track_count,added_at,added_json,removed_json,existing_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [localId, onlineId, online.name, folderName, online.created_at, 0, Date.now(), '[]', '[]', '[]']);
        localsByOnlineId.set(onlineId, { id: localId, online_id: onlineId, folder_name: folderName });
        result.added += 1;
      }
      try {
        const detail = await this.netease.getPlaylist(onlineId);
        await this.adoptAndDiff(localId, detail);
      } catch (error) {
        this.db.run('UPDATE local_playlists SET error=? WHERE id=?', [`识别文件夹后读取歌单失败：${error.message}`, localId]);
      }
      result.matched += 1;
      result.ids.push(localId);
    }
    return result;
  }

  async adoptAndDiff(localId, detail) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [localId]);
    const knownRows = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [localId]);
    const known = new Set(knownRows.map((item) => item.track_id));
    const files = this.fileStore.listAudioFiles(row.folder_name);
    const claimed = new Set(knownRows.map((item) => path.join(this.fileStore.playlistPath(row.folder_name), item.filename)));
    for (const track of detail.tracks) {
      if (known.has(track.id)) continue;
      const match = this.fileStore.findLegacyMatch(track, files, claimed);
      if (!match) continue;
      const adopted = await this.fileStore.adoptLegacyFile(track, match);
      this.db.transaction(() => {
        this.db.db.run(`INSERT OR IGNORE INTO songs(track_id,name,artists,album,duration,entity_path,extension,size,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [track.id, track.name, JSON.stringify(track.artists), track.album, track.duration, adopted.entityPath, adopted.extension, adopted.size, Date.now()]);
        this.db.db.run('INSERT OR IGNORE INTO playlist_tracks(playlist_id,track_id,filename,linked_at) VALUES (?,?,?,?)', [localId, track.id, adopted.filename, Date.now()]);
      });
      known.add(track.id);
    }
    this.db.transaction(() => {
      for (const track of detail.tracks) {
        if (!track.coverUrl) continue;
        this.db.db.run('UPDATE songs SET cover_url=? WHERE track_id=? AND cover_url=?', [track.coverUrl, track.id, '']);
      }
    });
    const remoteIds = new Set(detail.tracks.map((item) => item.id));
    const current = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [localId]);
    const added = detail.tracks.filter((item) => !current.some((knownTrack) => knownTrack.track_id === item.id));
    const removed = current.filter((item) => !remoteIds.has(item.track_id)).map(dbTrack);
    const existing = current.filter((item) => remoteIds.has(item.track_id)).map(dbTrack);
    const nameChanged = row.name !== detail.name;
    let folderName = row.folder_name;
    const targetFolderName = sanitizeName(detail.name);
    let pendingName = folderName === targetFolderName ? null : detail.name;
    if (folderName !== targetFolderName && this.db.getSettings().renamePolicy === 'auto') {
      try {
        folderName = await this.fileStore.renamePlaylistFolder(row.folder_name, detail.name);
        pendingName = null;
      } catch { /* 保留提示，让用户处理同名冲突 */ }
    }
    this.db.run(`UPDATE local_playlists SET name=?,previous_name=?,pending_name=?,offline=0,error=NULL,
      folder_name=?,added_json=?,removed_json=?,existing_json=?,track_count=?,last_scan_at=? WHERE id=?`, [
      detail.name, nameChanged ? row.name : row.previous_name, pendingName, folderName,
      JSON.stringify(added), JSON.stringify(removed), JSON.stringify(existing), current.length, Date.now(), localId
    ]);
    return { added, removed, existing };
  }

  async scan(source = 'manual', withinScanAll = false) {
    if (!withinScanAll && this.scanning) throw new Error('扫描已在进行中');
    if (!withinScanAll && this.tasks.active) throw new Error('同步任务进行中，暂时不能扫描');
    if (!withinScanAll) {
      this.scanning = true;
      this.scanSource = source;
    }
    this.scanStatus = scanMessage(source);
    this.db.setSettings({ lastScanAt: Date.now() });
    let unsynced = 0;
    try {
      const rows = this.db.all('SELECT * FROM local_playlists WHERE paused=0');
      const onlineIds = new Set(this.onlinePlaylists().map((item) => item.id));
      const managedFolders = this.db.all('SELECT folder_name FROM local_playlists').map((item) => item.folder_name);
      for (const row of rows) {
        if (!fs.existsSync(this.fileStore.playlistPath(row.folder_name))) {
          const filenames = this.db.all('SELECT filename FROM playlist_tracks WHERE playlist_id=?', [row.id]).map((item) => item.filename);
          const moved = this.fileStore.detectMovedFolder(row.folder_name, filenames, managedFolders);
          if (moved) this.db.run('UPDATE local_playlists SET name=?,folder_name=?,previous_name=?,pending_name=NULL,offline=1,error=? WHERE id=?', [moved, moved, row.name, '检测到本地文件夹已重命名，请重定向后恢复同步', row.id]);
          else this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', ['本地歌单文件夹不存在', row.id]);
          continue;
        }
        if (!row.online_id || !onlineIds.has(row.online_id)) {
          this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', ['在线歌单不可访问', row.id]);
          continue;
        }
        try {
          const detail = await this.netease.getPlaylist(row.online_id);
          const diff = await this.adoptAndDiff(row.id, detail);
          if (diff.added.length || diff.removed.length || row.name !== detail.name) unsynced += 1;
        } catch (error) {
          this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', [error.message, row.id]);
        }
      }
      const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
      this.scanStatus = `扫描完成，${unsynced} 个歌单未同步，扫描时间：${timestamp}`;
      this.db.setSettings({ lastScanAt: Date.now() });
      return { unsynced, status: this.scanStatus, local: this.localPlaylists() };
    } finally {
      if (!withinScanAll) {
        this.scanning = false;
        this.scanSource = '';
      }
    }
  }

  startSync(ids, source = 'manual') {
    if (this.scanning) throw new Error('扫描进行中，暂时不能同步');
    const selected = ids?.length ? new Set(ids.map(String)) : null;
    const settings = this.db.getSettings();
    const rows = this.db.all('SELECT * FROM local_playlists WHERE paused=0 AND offline=0')
      .filter((row) => !selected || selected.has(row.id))
      .filter((row) => source === 'manual' || parseJson(row.added_json, []).length || (settings.deleteRemoved && parseJson(row.removed_json, []).length));
    if (!rows.length) {
      if (source !== 'manual') return this.tasks.getState();
      throw new Error('没有可同步的歌单');
    }
    const control = this.tasks.begin(rows.length, source, this.downloadConcurrency);
    this.db.setSettings({ interruptedTask: true });
    this.syncPromise = this.runSync(rows, control).catch(() => {});
    return this.tasks.getState();
  }

  async runSync(rows, control) {
    let finalError = '';
    const allFailures = [];
    try {
      for (let index = 0; index < rows.length; index += 1) {
        control.throwIfCancelled();
        await control.waitIfPaused();
        const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [rows[index].id]);
        if (!row || row.paused || row.offline) continue;
        let added = parseJson(row.added_json, []);
        if (!row.last_scan_at) {
          const detail = await this.netease.getPlaylist(row.online_id);
          await this.adoptAndDiff(row.id, detail);
          added = parseJson(this.db.get('SELECT added_json FROM local_playlists WHERE id=?', [row.id]).added_json, []);
        }
        this.tasks.update({ current: index + 1, playlistId: row.id, downloaded: 0, downloadTotal: added.length, error: '' });
        if (added.length) this.db.run('UPDATE local_playlists SET sync_progress=?,error=NULL WHERE id=?', [`正在同步：0/${added.length}`, row.id]);
        const failures = await this.syncTracksConcurrently(row, added, control);
        await this.applyRemovals(row);
        await this.ensureTrackCovers(row, control);
        allFailures.push(...failures);
        const latest = this.db.get('SELECT * FROM local_playlists WHERE id=?', [row.id]);
        const remainingRemoved = this.db.getSettings().deleteRemoved ? [] : parseJson(latest.removed_json, []);
        const currentTracks = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
          FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [row.id]).map(dbTrack);
        this.db.run(`UPDATE local_playlists SET added_json=?,removed_json=?,existing_json=?,track_count=?,last_sync_at=?,sync_progress=NULL,error=NULL WHERE id=?`, [
          JSON.stringify(failures.map((item) => item.track)), JSON.stringify(remainingRemoved), JSON.stringify(currentTracks), currentTracks.length, Date.now(), row.id
        ]);
      }
      finalError = '';
      this.db.setSettings({ interruptedTask: false, lastSyncAt: Date.now() });
      this.scanStatus = allFailures.length
        ? `同步完成，${allFailures.length} 首下载失败已跳过`
        : '同步完成';
    } catch (error) {
      if (!(error instanceof CancelledError)) finalError = error.message;
      if (error instanceof CancelledError) this.scanStatus = '同步任务已取消';
    } finally {
      this.tasks.finish(finalError);
      this.syncPromise = null;
      if (this.db.getSettings().realtimeSync && this.pendingRealtimeIds.size) {
        const queued = [...this.pendingRealtimeIds];
        this.pendingRealtimeIds.clear();
        queueMicrotask(() => {
          try { this.startSync(queued, 'realtime'); }
          catch { for (const id of queued) this.pendingRealtimeIds.add(id); }
        });
      }
    }
  }

  async syncTracksConcurrently(row, tracks, control) {
    if (!tracks.length) return [];
    const failures = [];
    let nextIndex = 0;
    let completed = 0;
    let activeDownloads = 0;
    const worker = async () => {
      while (true) {
        await control.waitIfPaused();
        control.throwIfCancelled();
        const trackIndex = nextIndex;
        nextIndex += 1;
        if (trackIndex >= tracks.length) return;
        const track = tracks[trackIndex];
        let countedActive = false;
        try {
          await control.waitIfPaused();
          control.throwIfCancelled();
          activeDownloads += 1;
          countedActive = true;
          this.tasks.update({ activeDownloads });
          let lastError = null;
          for (let attempt = 0; attempt < MAX_TRACK_ATTEMPTS; attempt += 1) {
            try {
              await this.syncTrack(row, track, control);
              completed += 1;
              this.tasks.update({ downloaded: completed, error: '' });
              this.db.run('UPDATE local_playlists SET sync_progress=?,error=NULL WHERE id=?', [`正在同步：${completed}/${tracks.length}`, row.id]);
              lastError = null;
              break;
            } catch (error) {
              if (error instanceof CancelledError || error.name === 'AbortError') throw new CancelledError();
              lastError = error;
            }
          }
          if (lastError) failures.push({ track, error: lastError });
        } finally {
          if (countedActive) {
            activeDownloads = Math.max(0, activeDownloads - 1);
            this.tasks.update({ activeDownloads });
          }
        }
      }
    };
    const workerCount = Math.min(this.downloadConcurrency, tracks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return failures;
  }

  async fetchCover(track, control) {
    const url = track?.coverUrl || track?.cover_url;
    if (!url) return null;
    try {
      const bytes = await this.netease.getCover(url, control?.signal);
      return Buffer.isBuffer(bytes) && bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  async writeTrackTags(entityPath, extension, track, source = {}) {
    const artists = Array.isArray(track.artists) ? track.artists : parseJson(track.artists, []);
    const meta = {
      title: source.metadata?.musicName || track.name,
      artist: flattenArtists(source.metadata?.artist) || artists.join(', '),
      album: source.metadata?.album || track.album || '',
      cover: source.cover || null
    };
    if (entityPath && (extension === 'mp3' || extension === 'flac')) {
      await writeAudioTags(entityPath, extension, meta);
    }
    return Boolean(meta.cover);
  }

  async ensureTrackCovers(row, control) {
    const pending = this.db.all(`SELECT s.track_id,s.name,s.artists,s.album,s.entity_path,s.extension,s.cover_url
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id
      WHERE pt.playlist_id=? AND s.cover_url != '' AND s.cover_embedded = 0`, [row.id]);
    if (!pending.length) return;
    let nextIndex = 0;
    let updated = false;
    const worker = async () => {
      while (true) {
        await control.waitIfPaused();
        control.throwIfCancelled();
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pending.length) return;
        const song = pending[index];
        try {
          const bytes = await this.netease.getCover(song.cover_url, control.signal);
          if (!Buffer.isBuffer(bytes) || !bytes.length) continue;
          const coverEmbedded = await this.writeTrackTags(song.entity_path, song.extension, song, { cover: bytes });
          const size = fs.statSync(song.entity_path).size;
          this.db.run('UPDATE songs SET cover_embedded=?,size=? WHERE track_id=?', [coverEmbedded ? 1 : 0, size, song.track_id], false);
          updated = true;
        } catch (error) {
          if (error instanceof CancelledError || error.name === 'AbortError') throw new CancelledError();
          // 封面失败跳过，下次同步重试
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.downloadConcurrency, pending.length) }, () => worker()));
    if (updated) this.db.save();
  }

  async syncTrack(row, track, control) {
    let song = this.db.get('SELECT * FROM songs WHERE track_id=?', [track.id]);
    let downloaded;
    let needsCover = false;
    if (!song || !fs.existsSync(song.entity_path) || fs.statSync(song.entity_path).size === 0) {
      const response = await this.netease.getAudioResponse(track.id, control.signal);
      downloaded = await this.fileStore.downloadTrack(track, response, control);
      if (downloaded.encrypted) {
        downloaded = await this.fileStore.finishNcm(track, downloaded.ncmPath);
      }
      const coverEmbedded = await this.writeTrackTags(downloaded.entityPath, downloaded.extension, track, { ...downloaded, cover: downloaded.cover || null });
      downloaded.size = fs.statSync(downloaded.entityPath).size;
      this.db.run(`INSERT INTO songs(track_id,name,artists,album,duration,entity_path,extension,size,cover_url,cover_embedded,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET name=excluded.name,artists=excluded.artists,album=excluded.album,
        duration=excluded.duration,entity_path=excluded.entity_path,extension=excluded.extension,size=excluded.size,
        cover_url=excluded.cover_url,cover_embedded=excluded.cover_embedded`, [
        track.id, track.name, JSON.stringify(track.artists), track.album, track.duration, downloaded.entityPath,
        downloaded.extension, downloaded.size, track.coverUrl || '', coverEmbedded ? 1 : 0, Date.now()
      ]);
      song = this.db.get('SELECT * FROM songs WHERE track_id=?', [track.id]);
      needsCover = !coverEmbedded && Boolean(track.coverUrl);
    }
    const filename = path.basename(song.entity_path);
    await this.fileStore.createPlaylistLink(song.entity_path, row.folder_name, filename);
    this.db.run('INSERT OR REPLACE INTO playlist_tracks(playlist_id,track_id,filename,linked_at) VALUES (?,?,?,?)', [row.id, track.id, filename, Date.now()]);
    this.tasks.recordArtifact({ playlistId: row.id, trackId: track.id, folderName: row.folder_name, filename, entityPath: song.entity_path, createdEntity: Boolean(downloaded?.created) });
    if (needsCover) {
      const fetched = await this.fetchCover(track, control);
      if (fetched) {
        await this.writeTrackTags(song.entity_path, song.extension, song, { cover: fetched });
        this.db.run('UPDATE songs SET cover_embedded=1,size=? WHERE track_id=?', [fs.statSync(song.entity_path).size, track.id]);
      }
    }
  }

  async applyRemovals(row) {
    const settings = this.db.getSettings();
    if (!settings.deleteRemoved) return;
    const latest = this.db.get('SELECT * FROM local_playlists WHERE id=?', [row.id]);
    const removedTrackIds = [];
    for (const track of parseJson(latest.removed_json, [])) {
      const link = this.db.get('SELECT filename FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
      if (link) await this.fileStore.removePlaylistLink(row.folder_name, link.filename);
      this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
      removedTrackIds.push(track.id);
    }
    await this.pruneOrphanedSongs(removedTrackIds);
  }

  async pruneOrphanedSongs(trackIds = []) {
    const ids = [...new Set(trackIds.map(String).filter(Boolean))];
    const songs = ids.length
      ? this.db.all(`SELECT * FROM songs WHERE track_id IN (${ids.map(() => '?').join(',')})`, ids)
      : this.db.all('SELECT * FROM songs');
    for (const song of songs) {
      const references = this.db.get('SELECT COUNT(*) AS count FROM playlist_tracks WHERE track_id=?', [song.track_id]);
      if (Number(references?.count) > 0) continue;
      await this.fileStore.removeSongEntity(song.entity_path);
      this.db.run('DELETE FROM songs WHERE track_id=?', [song.track_id]);
    }
  }

  setLocalPaused(ids, paused) {
    for (const id of ids || []) this.db.run('UPDATE local_playlists SET paused=? WHERE id=?', [paused ? 1 : 0, id]);
    if (!paused && this.db.getSettings().realtimeSync) {
      const resumable = (ids || []).filter((id) => {
        const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
        return row && !row.offline && (parseJson(row.added_json, []).length || (this.db.getSettings().deleteRemoved && parseJson(row.removed_json, []).length));
      });
      if (resumable.length && !this.tasks.active && !this.scanning) this.startSync(resumable, 'realtime');
      else for (const id of resumable) this.pendingRealtimeIds.add(id);
    }
    return this.localPlaylists();
  }

  async removeLocal(ids) {
    const removedTrackIds = [];
    for (const id of ids || []) {
      const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
      if (!row) continue;
      removedTrackIds.push(...this.db.all('SELECT track_id FROM playlist_tracks WHERE playlist_id=?', [id]).map((track) => track.track_id));
      await this.fileStore.removePlaylistFolder(row.folder_name);
      this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=?', [id]);
      this.db.run('DELETE FROM local_playlists WHERE id=?', [id]);
    }
    await this.pruneOrphanedSongs(removedTrackIds);
    return this.localPlaylists();
  }

  async redirectLocal(id, onlineId) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    const online = this.db.get('SELECT * FROM online_playlists WHERE id=?', [String(onlineId)]);
    if (!row || !online) throw new Error('歌单不存在');
    const conflict = this.db.get('SELECT id FROM local_playlists WHERE online_id=? AND id<>?', [String(onlineId), id]);
    if (conflict) throw new Error('该在线歌单已经在本地列表中');
    const pendingName = row.folder_name === sanitizeName(online.name) ? null : online.name;
    this.db.run('UPDATE local_playlists SET online_id=?,name=?,previous_name=?,pending_name=?,offline=0,error=NULL WHERE id=?', [String(onlineId), online.name, row.name, pendingName, id]);
    const detail = await this.netease.getPlaylist(onlineId);
    await this.adoptAndDiff(id, detail);
    return this.localPlaylists();
  }

  async syncFolderName(id) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    if (!row) throw new Error('歌单不存在');
    const newName = await this.fileStore.renamePlaylistFolder(row.folder_name, row.name);
    this.db.run('UPDATE local_playlists SET folder_name=?,previous_name=NULL,pending_name=NULL WHERE id=?', [newName, id]);
    return this.localPlaylists();
  }

  async openLocal(id) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    if (!row) throw new Error('歌单不存在');
    this.fileStore.ensurePlaylistFolder(row.folder_name);
    const result = await this.openPath(this.fileStore.playlistPath(row.folder_name));
    if (result) throw new Error(result);
  }

  async openLibrary() {
    const result = await this.openPath(this.rootPath);
    if (result) throw new Error(result);
  }

  async changeLibrary(newPath, migrate, removeEmptySource = false) {
    if (this.tasks.active || this.scanning) throw new Error('请等待当前任务结束后再修改音乐库位置');
    const rawPath = String(newPath || '').trim();
    if (!path.isAbsolute(rawPath)) throw new Error('音乐库位置必须是绝对路径');
    const targetPath = path.resolve(rawPath);
    if (targetPath === this.rootPath) return this.bootstrap();
    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) throw new Error('目标音乐库位置不是文件夹');
    const oldStore = this.fileStore;
    const oldDbPath = this.db.filePath;
    const targetStore = new FileStore(targetPath);
    const playlists = this.db.all('SELECT * FROM local_playlists');
    if (migrate) {
      const songs = this.db.all('SELECT * FROM songs');
      const relations = this.db.all(`SELECT pt.*,lp.folder_name FROM playlist_tracks pt
        JOIN local_playlists lp ON lp.id=pt.playlist_id`);
      await oldStore.migrateManagedLibrary(targetStore, playlists, songs, relations);
      this.db.transaction(() => {
        for (const song of songs) {
          this.db.db.run('UPDATE songs SET entity_path=? WHERE track_id=?', [path.join(targetStore.songsPath, path.basename(song.entity_path)), song.track_id]);
        }
      });
    } else {
      this.db.transaction(() => {
        this.db.db.run('DELETE FROM playlist_tracks');
        this.db.db.run('DELETE FROM songs');
        this.db.db.run(`UPDATE local_playlists SET track_count=0,added_json='[]',removed_json='[]',existing_json='[]',
          last_scan_at=NULL,last_sync_at=NULL,offline=0,sync_progress=NULL,error='音乐库位置已更改，请重新扫描同步'`);
      });
    }
    this.fileStore = targetStore;
    this.rootPath = targetPath;
    this.db.filePath = path.join(targetStore.dataPath, 'cloudmusic.sqlite');
    this.db.setSettings({ libraryPath: targetPath, lastScanAt: migrate ? this.db.getSettings().lastScanAt : null, lastSyncAt: migrate ? this.db.getSettings().lastSyncAt : null });
    const discovered = await this.discoverExistingPlaylistFolders();
    for (const playlist of this.db.all('SELECT folder_name FROM local_playlists')) targetStore.ensurePlaylistFolder(playlist.folder_name);
    this.scanStatus = migrate
      ? `音乐库已迁移到新位置${discovered.added ? `，另识别 ${discovered.added} 个本地歌单` : ''}`
      : discovered.matched
        ? `音乐库位置已更改，已识别 ${discovered.matched} 个本地歌单`
        : '音乐库位置已更改，请扫描后重新同步';
    await this.persistLibraryPath(targetPath);
    if (path.resolve(oldDbPath) !== path.resolve(this.db.filePath)) await fs.promises.rm(oldDbPath, { force: true });
    if (removeEmptySource && this.defaultLibraryPath && path.resolve(oldStore.rootPath) === path.resolve(this.defaultLibraryPath)) {
      await oldStore.removeEmptyManagedRoot(this.defaultLibraryPath);
    }
    if (this.db.getSettings().realtimeSync && discovered.ids.length && !this.tasks.active) this.startSync(discovered.ids, 'realtime');
    return this.bootstrap();
  }

  updateSettings(values) {
    const current = this.db.getSettings();
    const allowed = ['autoScan','autoSync','realtimeSync','scanHours','scanMinutes','deleteRemoved','downloadConcurrency','renamePolicy','cancelDeleteDownloaded','cancelDontAsk','removeLocalDontAsk','cookie'];
    const next = {};
    for (const key of allowed) if (Object.hasOwn(values, key)) next[key] = values[key];
    if (next.cookie === '••••••••') delete next.cookie;
    const interval = normalizeInterval(next.scanHours ?? current.scanHours, next.scanMinutes ?? current.scanMinutes);
    next.scanHours = interval.hours; next.scanMinutes = interval.minutes;
    if (Object.hasOwn(next, 'downloadConcurrency')) {
      next.downloadConcurrency = Math.max(1, Math.min(8, Math.floor(Number(next.downloadConcurrency) || 4)));
      this.downloadConcurrency = next.downloadConcurrency;
    }
    this.db.setSettings(next);
    this.netease.setCookie(this.db.getSettings().cookie);
    this.configureAutoScan();
    this.configureRealtimeSync();
    return this.bootstrap();
  }

  async cancelTask(deleteDownloaded = false) {
    this.tasks.cancel();
    const running = this.syncPromise;
    if (running) await running;
    if (deleteDownloaded) {
      const artifacts = this.tasks.takeArtifacts().reverse();
      const removedTrackIds = [];
      for (const artifact of artifacts) {
        await this.fileStore.removePlaylistLink(artifact.folderName, artifact.filename);
        this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [artifact.playlistId, artifact.trackId]);
        removedTrackIds.push(artifact.trackId);
      }
      await this.pruneOrphanedSongs(removedTrackIds);
    } else this.tasks.takeArtifacts();
    this.db.setSettings({ interruptedTask: false });
    return this.tasks.getState();
  }
}

function dbTrack(row) {
  return { id: row.track_id, name: row.name, artists: parseJson(row.artists, []), album: row.album, duration: row.duration };
}

function flattenArtists(artist) {
  if (!Array.isArray(artist)) return '';
  return artist
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    .filter(Boolean)
    .join(' / ');
}

function scanMessage(source) {
  return {
    auto: '自动扫描正在检查歌单更新…',
    realtime: '实时同步正在检测歌单更新…',
    startup: '启动扫描正在检查歌单更新…',
    setup: '正在扫描新账号的歌单更新…',
    manual: '正在扫描本地与在线歌单差异…'
  }[source] || '正在扫描本地与在线歌单差异…';
}

module.exports = { AppService };
