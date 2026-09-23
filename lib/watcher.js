'use strict';

const { EventEmitter } = require('node:events');
const { basename, join } = require('node:path');

class VFSWatcher extends EventEmitter {
  #vfs;
  #path;
  #interval;
  #timer = null;
  #lastStats;
  #closed = false;
  #persistent;
  #recursive;
  #trackedFiles;
  #signal;
  #abortHandler = null;

  constructor(provider, path, options = {}) {
    super();

    this.#vfs = provider;
    this.#path = path;
    this.#interval = options.interval ?? 100;
    this.#persistent = options.persistent !== false;
    this.#recursive = options.recursive === true;
    this.#trackedFiles = new Map();
    this.#signal = options.signal;

    if (this.#signal) {
      if (this.#signal.aborted) {
        this.close();
        return;
      }
      this.#abortHandler = () => this.close();
      this.#signal.addEventListener('abort', this.#abortHandler, { once: true });
    }

    this.#lastStats = this.#getStats();

    if (this.#recursive && this.#lastStats?.isDirectory()) {
      this.#buildFileList(this.#path, '');
    }

    this.#startPolling();
  }

  #getStats() {
    try {
      return this.#vfs.statSync(this.#path);
    } catch {
      return null;
    }
  }

  #startPolling() {
    if (this.#closed) return;

    this.#timer = setInterval(() => this.#poll(), this.#interval);

    if (!this.#persistent && this.#timer.unref) {
      this.#timer.unref();
    }
  }

  #poll() {
    if (this.#closed) return;

    if (this.#recursive && this.#trackedFiles.size > 0) {
      for (const [filePath, info] of this.#trackedFiles) {
        const newStats = this.#getStatsFor(filePath);
        if (this.#statsChanged(info.stats, newStats)) {
          const eventType = this.#determineEventType(info.stats, newStats);
          this.emit('change', eventType, info.relativePath);
          info.stats = newStats;
        }
      }
      return;
    }

    const newStats = this.#getStats();

    if (this.#statsChanged(this.#lastStats, newStats)) {
      const eventType = this.#determineEventType(this.#lastStats, newStats);
      const filename = basename(this.#path);
      this.emit('change', eventType, filename);
    }

    this.#lastStats = newStats;
  }

  #getStatsFor(filePath) {
    try {
      return this.#vfs.statSync(filePath);
    } catch {
      return null;
    }
  }

  #buildFileList(dirPath, relativePath) {
    try {
      const entries = this.#vfs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        const relPath = relativePath ? join(relativePath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          this.#buildFileList(fullPath, relPath);
        } else {
          const stats = this.#getStatsFor(fullPath);
          this.#trackedFiles.set(fullPath, {
            stats,
            relativePath: relPath,
          });
        }
      }
    } catch {
      // Directory might not exist or be readable
    }
  }

  #statsChanged(oldStats, newStats) {
    if ((oldStats === null) !== (newStats === null)) {
      return true;
    }
    if (oldStats === null && newStats === null) {
      return false;
    }
    if (oldStats.mtimeMs !== newStats.mtimeMs) {
      return true;
    }
    if (oldStats.size !== newStats.size) {
      return true;
    }
    return false;
  }

  #determineEventType(oldStats, newStats) {
    if ((oldStats === null) !== (newStats === null)) {
      return 'rename';
    }
    return 'change';
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#trackedFiles.clear();

    if (this.#signal && this.#abortHandler) {
      this.#signal.removeEventListener('abort', this.#abortHandler);
    }

    this.emit('close');
  }

  unref() {
    this.#timer?.unref?.();
    return this;
  }

  ref() {
    this.#timer?.ref?.();
    return this;
  }
}

class VFSStatWatcher extends EventEmitter {
  #vfs;
  #path;
  #interval;
  #persistent;
  #closed = false;
  #timer = null;
  #lastStats;
  #listeners;

  constructor(provider, path, options = {}) {
    super();

    this.#vfs = provider;
    this.#path = path;
    this.#interval = options.interval ?? 5007;
    this.#persistent = options.persistent !== false;
    this.#listeners = new Set();

    this.#lastStats = this.#getStats();
    this.#startPolling();
  }

  #getStats() {
    try {
      return this.#vfs.statSync(this.#path);
    } catch {
      const { createFileStats } = require('./stats.js');
      return createFileStats(0, {
        mode: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
      });
    }
  }

  #startPolling() {
    if (this.#closed) return;

    this.#timer = setInterval(() => this.#poll(), this.#interval);

    if (!this.#persistent && this.#timer.unref) {
      this.#timer.unref();
    }
  }

  #poll() {
    if (this.#closed) return;

    const newStats = this.#getStats();

    if (this.#statsChanged(this.#lastStats, newStats)) {
      const prevStats = this.#lastStats;
      this.#lastStats = newStats;
      this.emit('change', newStats, prevStats);
    }
  }

  #statsChanged(oldStats, newStats) {
    if (oldStats.mtimeMs !== newStats.mtimeMs) {
      return true;
    }
    if (oldStats.ctimeMs !== newStats.ctimeMs) {
      return true;
    }
    if (oldStats.size !== newStats.size) {
      return true;
    }
    return false;
  }

  addListener(eventOrListener, listener) {
    if (listener) return super.addListener(eventOrListener, listener);
    this.#listeners.add(eventOrListener);
    this.on('change', eventOrListener);
    return this;
  }

  removeListener(eventOrListener, listener) {
    if (listener) return super.removeListener(eventOrListener, listener);
    const had = this.#listeners.has(eventOrListener);
    this.#listeners.delete(eventOrListener);
    super.removeListener('change', eventOrListener);
    return had;
  }

  hasNoListeners() {
    return this.#listeners.size === 0;
  }

  stop() {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.emit('stop');
  }

  unref() {
    this.#timer?.unref?.();
    return this;
  }

  ref() {
    this.#timer?.ref?.();
    return this;
  }
}

class VFSWatchAsyncIterable {
  #watcher;
  #closed = false;
  #pendingEvents = [];
  #pendingResolvers = [];

  constructor(provider, path, options = {}) {
    this.#watcher = new VFSWatcher(provider, path, options);

    this.#watcher.on('change', (eventType, filename) => {
      const event = { eventType, filename };
      if (this.#pendingResolvers.length > 0) {
        const resolve = this.#pendingResolvers.shift();
        resolve({ value: event, done: false });
      } else {
        this.#pendingEvents.push(event);
      }
    });

    this.#watcher.on('close', () => {
      this.#closed = true;
      while (this.#pendingResolvers.length > 0) {
        const resolve = this.#pendingResolvers.shift();
        resolve({ value: undefined, done: true });
      }
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    if (this.#pendingEvents.length > 0) {
      const event = this.#pendingEvents.shift();
      return Promise.resolve({ value: event, done: false });
    }

    return new Promise((resolve) => {
      this.#pendingResolvers.push(resolve);
    });
  }

  return() {
    this.#watcher.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error) {
    this.#watcher.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}

module.exports = {
  VFSWatcher,
  VFSStatWatcher,
  VFSWatchAsyncIterable,
};
