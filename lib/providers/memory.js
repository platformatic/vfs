'use strict';

const { Buffer } = require('node:buffer');
const { posix: pathPosix } = require('node:path');
const { VirtualProvider } = require('../provider.js');
const { MemoryFileHandle } = require('../file_handle.js');
const {
  VFSWatcher,
  VFSStatWatcher,
  VFSWatchAsyncIterable,
} = require('../watcher.js');
const {
  ERR_INVALID_STATE,
} = require('../errors.js');
const {
  createENOENT,
  createENOTDIR,
  createENOTEMPTY,
  createEISDIR,
  createEEXIST,
  createEINVAL,
  createELOOP,
  createEROFS,
} = require('../errors.js');
const {
  createFileStats,
  createDirectoryStats,
  createSymlinkStats,
} = require('../stats.js');

// Dirent-like class for withFileTypes support
const UV_DIRENT_FILE = 1;
const UV_DIRENT_DIR = 2;
const UV_DIRENT_LINK = 3;

class VirtualDirent {
  #name;
  #type;
  #parentPath;

  constructor(name, type, parentPath) {
    this.#name = name;
    this.#type = type;
    this.#parentPath = parentPath;
  }

  get name() {
    return this.#name;
  }

  get parentPath() {
    return this.#parentPath;
  }

  set parentPath(value) {
    this.#parentPath = value;
  }

  get path() {
    return this.#parentPath;
  }

  isFile() {
    return this.#type === UV_DIRENT_FILE;
  }

  isDirectory() {
    return this.#type === UV_DIRENT_DIR;
  }

  isSymbolicLink() {
    return this.#type === UV_DIRENT_LINK;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }
}

const kRoot = Symbol('kRoot');
const kReadonly = Symbol('kReadonly');
const kStatWatchers = Symbol('kStatWatchers');

const TYPE_FILE = 0;
const TYPE_DIR = 1;
const TYPE_SYMLINK = 2;

const kMaxSymlinkDepth = 40;

class MemoryEntry {
  constructor(type, options = {}) {
    this.type = type;
    this.mode = options.mode ?? (type === TYPE_DIR ? 0o755 : 0o644);
    this.content = null;
    this.contentProvider = null;
    this.target = null;
    this.children = null;
    this.populate = null;
    this.populated = true;
    const now = Date.now();
    this.mtime = now;
    this.ctime = now;
    this.birthtime = now;
  }

  getContentSync() {
    if (this.contentProvider !== null) {
      const result = this.contentProvider();
      if (result && typeof result.then === 'function') {
        throw new ERR_INVALID_STATE('cannot use sync API with async content provider');
      }
      return typeof result === 'string' ? Buffer.from(result) : result;
    }
    return this.content;
  }

  async getContentAsync() {
    if (this.contentProvider !== null) {
      const result = await this.contentProvider();
      return typeof result === 'string' ? Buffer.from(result) : result;
    }
    return this.content;
  }

  isDynamic() {
    return this.contentProvider !== null;
  }

  isFile() {
    return this.type === TYPE_FILE;
  }

  isDirectory() {
    return this.type === TYPE_DIR;
  }

  isSymbolicLink() {
    return this.type === TYPE_SYMLINK;
  }
}

class MemoryProvider extends VirtualProvider {
  constructor() {
    super();
    this[kRoot] = new MemoryEntry(TYPE_DIR);
    this[kRoot].children = new Map();
    this[kReadonly] = false;
    this[kStatWatchers] = new Map();
  }

  get readonly() {
    return this[kReadonly];
  }

  get supportsWatch() {
    return true;
  }

  setReadOnly() {
    this[kReadonly] = true;
  }

  get supportsSymlinks() {
    return true;
  }

  #normalizePath(path) {
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return pathPosix.normalize(normalized);
  }

  #splitPath(path) {
    if (path === '/') {
      return [];
    }
    return path.slice(1).split('/');
  }

  #getParentPath(path) {
    if (path === '/') {
      return null;
    }
    return pathPosix.dirname(path);
  }

  #getBaseName(path) {
    return pathPosix.basename(path);
  }

  #resolveSymlinkTarget(symlinkPath, target) {
    if (target.startsWith('/')) {
      return this.#normalizePath(target);
    }
    const parentPath = this.#getParentPath(symlinkPath) || '/';
    return this.#normalizePath(pathPosix.join(parentPath, target));
  }

  #lookupEntry(path, followSymlinks = true, depth = 0) {
    const normalized = this.#normalizePath(path);

    if (normalized === '/') {
      return { entry: this[kRoot], resolvedPath: '/' };
    }

    const segments = this.#splitPath(normalized);
    let current = this[kRoot];
    let currentPath = '/';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (current.isSymbolicLink() && followSymlinks) {
        if (depth >= kMaxSymlinkDepth) {
          return { entry: null, resolvedPath: null, eloop: true };
        }
        const targetPath = this.#resolveSymlinkTarget(currentPath, current.target);
        const result = this.#lookupEntry(targetPath, true, depth + 1);
        if (result.eloop) {
          return result;
        }
        if (!result.entry) {
          return { entry: null, resolvedPath: null };
        }
        current = result.entry;
        currentPath = result.resolvedPath;
      }

      if (!current.isDirectory()) {
        return { entry: null, resolvedPath: null };
      }

      this.#ensurePopulated(current, currentPath);

      const entry = current.children.get(segment);
      if (!entry) {
        return { entry: null, resolvedPath: null };
      }

      currentPath = pathPosix.join(currentPath, segment);
      current = entry;
    }

    if (current.isSymbolicLink() && followSymlinks) {
      if (depth >= kMaxSymlinkDepth) {
        return { entry: null, resolvedPath: null, eloop: true };
      }
      const targetPath = this.#resolveSymlinkTarget(currentPath, current.target);
      return this.#lookupEntry(targetPath, true, depth + 1);
    }

    return { entry: current, resolvedPath: currentPath };
  }

  #getEntry(path, syscall, followSymlinks = true) {
    const result = this.#lookupEntry(path, followSymlinks);
    if (result.eloop) {
      throw createELOOP(syscall, path);
    }
    if (!result.entry) {
      throw createENOENT(syscall, path);
    }
    return result.entry;
  }

  #ensureParent(path, create, syscall) {
    const parentPath = this.#getParentPath(path);
    if (parentPath === null) {
      return this[kRoot];
    }

    const segments = this.#splitPath(parentPath);
    let current = this[kRoot];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (current.isSymbolicLink()) {
        const currentPath = pathPosix.join('/', ...segments.slice(0, i));
        const targetPath = this.#resolveSymlinkTarget(currentPath, current.target);
        const result = this.#lookupEntry(targetPath, true, 0);
        if (!result.entry) {
          throw createENOENT(syscall, path);
        }
        current = result.entry;
      }

      if (!current.isDirectory()) {
        throw createENOTDIR(syscall, path);
      }

      const currentPath = pathPosix.join('/', ...segments.slice(0, i));
      this.#ensurePopulated(current, currentPath);

      let entry = current.children.get(segment);
      if (!entry) {
        if (create) {
          entry = new MemoryEntry(TYPE_DIR);
          entry.children = new Map();
          current.children.set(segment, entry);
        } else {
          throw createENOENT(syscall, path);
        }
      }
      current = entry;
    }

    if (!current.isDirectory()) {
      throw createENOTDIR(syscall, path);
    }

    const finalPath = pathPosix.join('/', ...segments);
    this.#ensurePopulated(current, finalPath);

    return current;
  }

  #createStats(entry, size) {
    const options = {
      mode: entry.mode,
      mtimeMs: entry.mtime,
      ctimeMs: entry.ctime,
      birthtimeMs: entry.birthtime,
    };

    if (entry.isFile()) {
      return createFileStats(size !== undefined ? size : entry.content.length, options);
    } else if (entry.isDirectory()) {
      return createDirectoryStats(options);
    } else if (entry.isSymbolicLink()) {
      return createSymlinkStats(entry.target.length, options);
    }

    throw new ERR_INVALID_STATE('Unknown entry type');
  }

  #ensurePopulated(entry, path) {
    if (entry.isDirectory() && !entry.populated && entry.populate) {
      const scopedVfs = {
        addFile: (name, content, opts) => {
          const fileEntry = new MemoryEntry(TYPE_FILE, opts);
          if (typeof content === 'function') {
            fileEntry.content = Buffer.alloc(0);
            fileEntry.contentProvider = content;
          } else {
            fileEntry.content = typeof content === 'string' ? Buffer.from(content) : content;
          }
          entry.children.set(name, fileEntry);
        },
        addDirectory: (name, populate, opts) => {
          const dirEntry = new MemoryEntry(TYPE_DIR, opts);
          dirEntry.children = new Map();
          if (typeof populate === 'function') {
            dirEntry.populate = populate;
            dirEntry.populated = false;
          }
          entry.children.set(name, dirEntry);
        },
        addSymlink: (name, target, opts) => {
          const symlinkEntry = new MemoryEntry(TYPE_SYMLINK, opts);
          symlinkEntry.target = target;
          entry.children.set(name, symlinkEntry);
        },
      };
      entry.populate(scopedVfs);
      entry.populated = true;
    }
  }

  openSync(path, flags, mode) {
    const normalized = this.#normalizePath(path);
    const isCreate = flags === 'w' || flags === 'w+' || flags === 'a' || flags === 'a+';

    if (this.readonly && isCreate) {
      throw createEROFS('open', path);
    }

    let entry;
    try {
      entry = this.#getEntry(normalized, 'open');
    } catch (err) {
      if (err.code === 'ENOENT' && isCreate) {
        const parent = this.#ensureParent(normalized, true, 'open');
        const name = this.#getBaseName(normalized);
        entry = new MemoryEntry(TYPE_FILE, { mode });
        entry.content = Buffer.alloc(0);
        parent.children.set(name, entry);
      } else {
        throw err;
      }
    }

    if (entry.isDirectory()) {
      throw createEISDIR('open', path);
    }

    if (entry.isSymbolicLink()) {
      throw createEINVAL('open', path);
    }

    const getStats = (size) => this.#createStats(entry, size);
    return new MemoryFileHandle(normalized, flags, mode ?? entry.mode, entry.content, entry, getStats);
  }

  async open(path, flags, mode) {
    return this.openSync(path, flags, mode);
  }

  statSync(path, options) {
    const entry = this.#getEntry(path, 'stat', true);
    return this.#createStats(entry);
  }

  async stat(path, options) {
    return this.statSync(path, options);
  }

  lstatSync(path, options) {
    const entry = this.#getEntry(path, 'lstat', false);
    return this.#createStats(entry);
  }

  async lstat(path, options) {
    return this.lstatSync(path, options);
  }

  readdirSync(path, options) {
    const entry = this.#getEntry(path, 'scandir', true);
    if (!entry.isDirectory()) {
      throw createENOTDIR('scandir', path);
    }

    this.#ensurePopulated(entry, path);

    const normalized = this.#normalizePath(path);
    const results = [];
    const visit = (directory, parentPath, prefix) => {
      for (const [name, child] of directory.children) {
        const relative = prefix + name;
        if (options?.withFileTypes) {
          const type = child.isSymbolicLink() ? UV_DIRENT_LINK :
            child.isDirectory() ? UV_DIRENT_DIR : UV_DIRENT_FILE;
          results.push(new VirtualDirent(name, type, parentPath));
        } else {
          results.push(relative);
        }
        // Do not follow symlinks during recursive enumeration: this also
        // avoids cycles through a link to an ancestor.
        if (options?.recursive && child.isDirectory()) {
          const nextPath = pathPosix.join(parentPath, name);
          this.#ensurePopulated(child, nextPath);
          visit(child, nextPath, relative + '/');
        }
      }
    };
    visit(entry, normalized, '');
    return results;
  }

  async readdir(path, options) {
    return this.readdirSync(path, options);
  }

  mkdirSync(path, options) {
    if (this.readonly) {
      throw createEROFS('mkdir', path);
    }

    const normalized = this.#normalizePath(path);
    const recursive = options?.recursive === true;

    const existing = this.#lookupEntry(normalized, true);
    if (existing.entry) {
      if (existing.entry.isDirectory() && recursive) {
        return undefined;
      }
      throw createEEXIST('mkdir', path);
    }

    if (recursive) {
      const segments = this.#splitPath(normalized);
      let current = this[kRoot];
      let currentPath = '';
      let firstCreated;

      for (const segment of segments) {
        currentPath += '/' + segment;
        let entry = current.children.get(segment);
        if (!entry) {
          entry = new MemoryEntry(TYPE_DIR, { mode: options?.mode });
          entry.children = new Map();
          current.children.set(segment, entry);
          firstCreated ??= currentPath;
        } else if (!entry.isDirectory()) {
          throw createENOTDIR('mkdir', path);
        }
        current = entry;
      }
      return firstCreated;
    }
    const parent = this.#ensureParent(normalized, false, 'mkdir');
    const name = this.#getBaseName(normalized);
    const entry = new MemoryEntry(TYPE_DIR, { mode: options?.mode });
    entry.children = new Map();
    parent.children.set(name, entry);
    return undefined;
  }

  async mkdir(path, options) {
    return this.mkdirSync(path, options);
  }

  rmdirSync(path) {
    if (this.readonly) {
      throw createEROFS('rmdir', path);
    }

    const normalized = this.#normalizePath(path);
    const entry = this.#getEntry(normalized, 'rmdir', true);

    if (!entry.isDirectory()) {
      throw createENOTDIR('rmdir', path);
    }

    if (entry.children.size > 0) {
      throw createENOTEMPTY('rmdir', path);
    }

    const parent = this.#ensureParent(normalized, false, 'rmdir');
    const name = this.#getBaseName(normalized);
    parent.children.delete(name);
  }

  async rmdir(path) {
    this.rmdirSync(path);
  }

  unlinkSync(path) {
    if (this.readonly) {
      throw createEROFS('unlink', path);
    }

    const normalized = this.#normalizePath(path);
    const entry = this.#getEntry(normalized, 'unlink', false);

    if (entry.isDirectory()) {
      throw createEISDIR('unlink', path);
    }

    const parent = this.#ensureParent(normalized, false, 'unlink');
    const name = this.#getBaseName(normalized);
    parent.children.delete(name);
  }

  async unlink(path) {
    this.unlinkSync(path);
  }

  renameSync(oldPath, newPath) {
    if (this.readonly) {
      throw createEROFS('rename', oldPath);
    }

    const normalizedOld = this.#normalizePath(oldPath);
    const normalizedNew = this.#normalizePath(newPath);

    const entry = this.#getEntry(normalizedOld, 'rename', false);

    const oldParent = this.#ensureParent(normalizedOld, false, 'rename');
    const oldName = this.#getBaseName(normalizedOld);
    oldParent.children.delete(oldName);

    const newParent = this.#ensureParent(normalizedNew, true, 'rename');
    const newName = this.#getBaseName(normalizedNew);
    newParent.children.set(newName, entry);
  }

  async rename(oldPath, newPath) {
    this.renameSync(oldPath, newPath);
  }

  readlinkSync(path, options) {
    const normalized = this.#normalizePath(path);
    const entry = this.#getEntry(normalized, 'readlink', false);

    if (!entry.isSymbolicLink()) {
      throw createEINVAL('readlink', path);
    }

    return entry.target;
  }

  async readlink(path, options) {
    return this.readlinkSync(path, options);
  }

  symlinkSync(target, path, type) {
    if (this.readonly) {
      throw createEROFS('symlink', path);
    }

    const normalized = this.#normalizePath(path);

    const existing = this.#lookupEntry(normalized, false);
    if (existing.entry) {
      throw createEEXIST('symlink', path);
    }

    const parent = this.#ensureParent(normalized, true, 'symlink');
    const name = this.#getBaseName(normalized);
    const entry = new MemoryEntry(TYPE_SYMLINK);
    entry.target = target;
    parent.children.set(name, entry);
  }

  async symlink(target, path, type) {
    this.symlinkSync(target, path, type);
  }

  realpathSync(path, options) {
    const result = this.#lookupEntry(path, true, 0);
    if (result.eloop) {
      throw createELOOP('realpath', path);
    }
    if (!result.entry) {
      throw createENOENT('realpath', path);
    }
    return result.resolvedPath;
  }

  async realpath(path, options) {
    return this.realpathSync(path, options);
  }

  // === WATCH OPERATIONS ===

  watch(path, options) {
    const normalized = this.#normalizePath(path);
    return new VFSWatcher(this, normalized, options);
  }

  watchAsync(path, options) {
    const normalized = this.#normalizePath(path);
    return new VFSWatchAsyncIterable(this, normalized, options);
  }

  watchFile(path, options, listener) {
    const normalized = this.#normalizePath(path);

    let watcher = this[kStatWatchers].get(normalized);
    if (!watcher) {
      watcher = new VFSStatWatcher(this, normalized, options);
      this[kStatWatchers].set(normalized, watcher);
    }

    if (listener) {
      watcher.addListener(listener);
    }

    return watcher;
  }

  unwatchFile(path, listener) {
    const normalized = this.#normalizePath(path);
    const watcher = this[kStatWatchers].get(normalized);

    if (!watcher) {
      return;
    }

    if (listener) {
      watcher.removeListener(listener);
    } else {
      watcher.removeAllListeners('change');
    }

    if (watcher.hasNoListeners()) {
      watcher.stop();
      this[kStatWatchers].delete(normalized);
    }
  }
}

module.exports = {
  MemoryProvider,
};
