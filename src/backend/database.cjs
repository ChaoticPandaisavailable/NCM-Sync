const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const data = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : undefined;
    this.db = new SQL.Database(data);
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS online_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        track_count INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        cover_url TEXT,
        raw_json TEXT,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_playlists (
        id TEXT PRIMARY KEY,
        online_id TEXT,
        name TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        track_count INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        offline INTEGER NOT NULL DEFAULT 0,
        previous_name TEXT,
        pending_name TEXT,
        added_at INTEGER NOT NULL,
        last_sync_at INTEGER,
        last_scan_at INTEGER,
        added_json TEXT NOT NULL DEFAULT '[]',
        removed_json TEXT NOT NULL DEFAULT '[]',
        existing_json TEXT NOT NULL DEFAULT '[]',
        sync_progress TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS songs (
        track_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        artists TEXT NOT NULL DEFAULT '[]',
        album TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        entity_path TEXT NOT NULL,
        extension TEXT NOT NULL DEFAULT 'mp3',
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES local_playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES songs(track_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
    `);
    const defaults = {
      userId: '', initialized: false, autoScan: false, autoSync: false, realtimeSync: false,
      scanHours: 1, scanMinutes: 0, deleteRemoved: false,
      renamePolicy: 'ask', cancelDeleteDownloaded: false,
      cancelDontAsk: false, removeLocalDontAsk: false, cookie: '', interruptedTask: false,
      lastGlobalStatus: '', libraryPath: '', lastScanAt: null, lastSyncAt: null
    };
    for (const [key, value] of Object.entries(defaults)) {
      this.db.run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }
    this.save();
    return this;
  }

  save() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(this.db.export()));
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
    fs.renameSync(tempPath, this.filePath);
  }

  run(sql, params = [], save = true) {
    this.db.run(sql, params);
    if (save) this.save();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  get(sql, params = []) { return this.all(sql, params)[0] || null; }

  transaction(callback) {
    this.db.run('BEGIN');
    try {
      const result = callback();
      this.db.run('COMMIT');
      this.save();
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  getSettings() {
    const output = {};
    for (const row of this.all('SELECT key, value FROM settings')) {
      try { output[row.key] = JSON.parse(row.value); } catch { output[row.key] = row.value; }
    }
    return output;
  }

  setSettings(values) {
    this.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        this.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
      }
    });
  }
}

module.exports = { Database };
