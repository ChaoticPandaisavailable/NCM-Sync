const { EventEmitter } = require('node:events');

class CancelledError extends Error {
  constructor() { super('任务已取消'); this.name = 'CancelledError'; }
}

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.paused = false;
    this.cancelled = false;
    this.abortController = null;
    this.waiters = [];
    this.artifacts = [];
    this.state = { active: false, paused: false, source: '', current: 0, total: 0, playlistId: null, downloaded: 0, downloadTotal: 0, activeDownloads: 0, concurrency: 1, error: '' };
  }

  begin(total, source = 'manual', concurrency = 1) {
    if (this.active) throw new Error('已有同步任务正在运行');
    this.active = true; this.paused = false; this.cancelled = false;
    this.abortController = new AbortController();
    this.artifacts = [];
    this.update({ active: true, paused: false, source, current: 0, total, playlistId: null, downloaded: 0, downloadTotal: 0, activeDownloads: 0, concurrency, error: '' });
    return this.control();
  }

  control() {
    return {
      signal: this.abortController.signal,
      waitIfPaused: () => this.waitIfPaused(),
      throwIfCancelled: () => this.throwIfCancelled()
    };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  pause() { if (this.active) { this.paused = true; this.update({ paused: true }); } }
  resume() {
    if (!this.active) return;
    this.paused = false; this.update({ paused: false });
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  cancel() {
    if (!this.active) return;
    this.cancelled = true; this.paused = false;
    this.abortController.abort();
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  recordArtifact(artifact) { this.artifacts.push(artifact); }
  takeArtifacts() { return this.artifacts.splice(0); }
  async waitIfPaused() {
    while (this.paused && !this.cancelled) await new Promise((resolve) => this.waiters.push(resolve));
    this.throwIfCancelled();
  }
  throwIfCancelled() { if (this.cancelled) throw new CancelledError(); }
  finish(error = '') {
    this.active = false; this.paused = false;
    this.update({ active: false, paused: false, playlistId: null, activeDownloads: 0, error });
  }
  getState() { return { ...this.state }; }
}

module.exports = { TaskManager, CancelledError };
