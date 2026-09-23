'use strict';

const path = require('node:path');
const { devNull } = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const pathPosix = path.posix;
const { isAbsolute, resolve: resolvePath } = path;

const { MemoryProvider } = require('./providers/memory.js');
const {
  isUnderMountPoint,
  getRelativePath,
} = require('./router.js');
const {
  openVirtualFd,
  getVirtualFd,
  closeFdSync,
  readFdSync,
  fstatFdSync,
  closeFd,
  readFd,
  fstatFd,
} = require('./fd.js');
const {
  createENOENT,
  createENOTDIR,
  createEISDIR,
  createEBADF,
  ERR_INVALID_STATE,
} = require('./errors.js');
const { VirtualReadStream } = require('./streams.js');

const kEmptyObject = Object.freeze(Object.create(null));

function normalizeVFSPath(inputPath) {
  if (inputPath.startsWith('/')) {
    return pathPosix.normalize(inputPath);
  }
  return path.normalize(inputPath);
}

function joinVFSPath(base, part) {
  if (base.startsWith('/')) {
    return pathPosix.join(base, part);
  }
  return path.join(base, part);
}

const kProvider = Symbol('kProvider');
const kMountPoint = Symbol('kMountPoint');
const kMounted = Symbol('kMounted');
const kOverlay = Symbol('kOverlay');
const kModuleHooks = Symbol('kModuleHooks');
const kPromises = Symbol('kPromises');
const kVirtualCwd = Symbol('kVirtualCwd');
const kVirtualCwdEnabled = Symbol('kVirtualCwdEnabled');
const kOriginalChdir = Symbol('kOriginalChdir');
const kOriginalCwd = Symbol('kOriginalCwd');

let registerVFS;
let deregisterVFS;
let nextLayerId = 0;

function loadModuleHooks() {
  if (!registerVFS) {
    const hooks = require('./module_hooks.js');
    registerVFS = hooks.registerVFS;
    deregisterVFS = hooks.deregisterVFS;
  }
}

class VirtualFileSystem {
  constructor(providerOrOptions, options = kEmptyObject) {
    let provider = null;
    if (providerOrOptions !== undefined && providerOrOptions !== null) {
      if (typeof providerOrOptions.openSync === 'function') {
        provider = providerOrOptions;
      } else if (typeof providerOrOptions === 'object') {
        options = providerOrOptions;
        provider = null;
      }
    }

    if (options.moduleHooks !== undefined && typeof options.moduleHooks !== 'boolean') {
      throw new TypeError('options.moduleHooks must be a boolean');
    }
    if (options.virtualCwd !== undefined && typeof options.virtualCwd !== 'boolean') {
      throw new TypeError('options.virtualCwd must be a boolean');
    }
    if (options.overlay !== undefined && typeof options.overlay !== 'boolean') {
      throw new TypeError('options.overlay must be a boolean');
    }

    this[kProvider] = provider ?? new MemoryProvider();
    this[kMountPoint] = null;
    this[kMounted] = false;
    this[kOverlay] = options.overlay === true;
    this[kModuleHooks] = options.moduleHooks !== false;
    this[kPromises] = null;
    this[kVirtualCwdEnabled] = options.virtualCwd === true;
    this[kVirtualCwd] = null;
    this[kOriginalChdir] = null;
    this[kOriginalCwd] = null;
  }

  get provider() {
    return this[kProvider];
  }

  get mountPoint() {
    return this[kMountPoint];
  }

  get mounted() {
    return this[kMounted];
  }

  get mountPointURL() {
    return this[kMountPoint] === null ? null : pathToFileURL(this[kMountPoint]).href;
  }

  get readonly() {
    return this[kProvider].readonly;
  }

  get overlay() {
    return this[kOverlay];
  }

  get virtualCwdEnabled() {
    return this[kVirtualCwdEnabled];
  }

  // ==================== Virtual Working Directory ====================

  cwd() {
    if (!this[kVirtualCwdEnabled]) {
      throw new ERR_INVALID_STATE('virtual cwd is not enabled');
    }
    return this[kVirtualCwd];
  }

  chdir(dirPath) {
    if (!this[kVirtualCwdEnabled]) {
      throw new ERR_INVALID_STATE('virtual cwd is not enabled');
    }

    const providerPath = this.#toProviderPath(dirPath);
    const stats = this[kProvider].statSync(providerPath);

    if (!stats.isDirectory()) {
      throw createENOTDIR('chdir', dirPath);
    }

    this[kVirtualCwd] = this.#toMountedPath(providerPath);
  }

  resolvePath(inputPath) {
    if (isAbsolute(inputPath)) {
      return normalizeVFSPath(inputPath);
    }

    if (this[kVirtualCwdEnabled] && this[kVirtualCwd] !== null) {
      const resolved = `${this[kVirtualCwd]}/${inputPath}`;
      return normalizeVFSPath(resolved);
    }

    return resolvePath(inputPath);
  }

  // ==================== Mount ====================

  mount() {
    if (this[kMounted]) {
      throw new ERR_INVALID_STATE('VFS is already mounted');
    }
    if (arguments.length !== 0) {
      throw new TypeError('mount() does not accept a prefix');
    }
    this[kMountPoint] = path.join(devNull, 'vfs', String(nextLayerId++));
    this[kMounted] = true;
    if (this[kModuleHooks]) {
      loadModuleHooks();
      registerVFS(this);
    }
    if (this[kVirtualCwdEnabled]) {
      this.#hookProcessCwd();
    }

    process.emit('vfs-mount', {
      mountPoint: this[kMountPoint],
      overlay: this[kOverlay],
      readonly: this[kProvider].readonly,
    });

    return this[kMountPoint];
  }

  unmount() {
    if (this[kMounted]) {
      process.emit('vfs-unmount', {
        mountPoint: this[kMountPoint],
        overlay: this[kOverlay],
        readonly: this[kProvider].readonly,
      });
    }

    this.#unhookProcessCwd();
    if (this[kModuleHooks]) {
      loadModuleHooks();
      deregisterVFS(this);
    }
    // CJS's global cache survives unmounts unless entries are evicted.
    // ESM's cache cannot be invalidated from userland.
    if (this[kMountPoint] !== null) {
      for (const filename of Object.keys(require.cache)) {
        if (isUnderMountPoint(filename, this[kMountPoint])) {
          delete require.cache[filename];
        }
      }
    }
    this[kMountPoint] = null;
    this[kMounted] = false;
    this[kVirtualCwd] = null;
  }

  [Symbol.dispose]() {
    if (this[kMounted]) {
      this.unmount();
    }
  }

  #hookProcessCwd() {
    if (this[kOriginalChdir] !== null) {
      return;
    }

    const vfs = this;

    this[kOriginalChdir] = process.chdir;
    this[kOriginalCwd] = process.cwd;

    process.chdir = function chdir(directory) {
      const normalized = isAbsolute(directory) ?
        normalizeVFSPath(directory) :
        resolvePath(directory);

      if (vfs.shouldHandle(normalized)) {
        vfs.chdir(normalized);
        return;
      }

      return vfs[kOriginalChdir].call(process, directory);
    };

    process.cwd = function cwd() {
      if (vfs[kVirtualCwd] !== null) {
        return vfs[kVirtualCwd];
      }

      return vfs[kOriginalCwd].call(process);
    };
  }

  #unhookProcessCwd() {
    if (this[kOriginalChdir] === null) {
      return;
    }

    process.chdir = this[kOriginalChdir];
    process.cwd = this[kOriginalCwd];

    this[kOriginalChdir] = null;
    this[kOriginalCwd] = null;
  }

  // ==================== Path Resolution ====================

  #toProviderPath(inputPath) {
    const resolved = this.resolvePath(inputPath);

    if (this[kMounted] && this[kMountPoint]) {
      if (!isUnderMountPoint(resolved, this[kMountPoint])) {
        throw createENOENT('open', inputPath);
      }
      return getRelativePath(resolved, this[kMountPoint]);
    }

    return resolved;
  }

  #toMountedPath(providerPath) {
    if (this[kMounted] && this[kMountPoint]) {
      return providerPath === '/' ? this[kMountPoint] :
        joinVFSPath(this[kMountPoint], providerPath);
    }
    return providerPath;
  }

  shouldHandle(inputPath) {
    if (!this[kMounted] || !this[kMountPoint]) {
      return false;
    }

    const normalized = normalizeVFSPath(inputPath);
    if (!isUnderMountPoint(normalized, this[kMountPoint])) {
      return false;
    }

    if (this[kOverlay]) {
      try {
        const providerPath = getRelativePath(normalized, this[kMountPoint]);
        return this[kProvider].existsSync(providerPath);
      } catch {
        return false;
      }
    }

    return true;
  }

  // ==================== FS Operations (Sync) ====================

  existsSync(filePath) {
    try {
      const providerPath = this.#toProviderPath(filePath);
      return this[kProvider].existsSync(providerPath);
    } catch {
      return false;
    }
  }

  statSync(filePath, options) {
    const providerPath = this.#toProviderPath(filePath);
    return this[kProvider].statSync(providerPath, options);
  }

  lstatSync(filePath, options) {
    const providerPath = this.#toProviderPath(filePath);
    return this[kProvider].lstatSync(providerPath, options);
  }

  readFileSync(filePath, options) {
    const providerPath = this.#toProviderPath(filePath);
    return this[kProvider].readFileSync(providerPath, options);
  }

  writeFileSync(filePath, data, options) {
    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].writeFileSync(providerPath, data, options);
  }

  appendFileSync(filePath, data, options) {
    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].appendFileSync(providerPath, data, options);
  }

  #mapDirents(entries, options, dirPath, providerPath) {
    if (options?.withFileTypes) {
      const sourceRoot = this[kProvider].rootPath ?
        path.join(this[kProvider].rootPath, providerPath) : providerPath;
      for (const entry of entries) {
        const subdir = options.recursive ? path.relative(sourceRoot, entry.parentPath) : '';
        entry.parentPath = subdir ? joinVFSPath(dirPath, subdir) : dirPath;
      }
    }
    return entries;
  }

  readdirSync(dirPath, options) {
    const providerPath = this.#toProviderPath(dirPath);
    const entries = this[kProvider].readdirSync(providerPath, options);
    return this.#mapDirents(entries, options, dirPath, providerPath);
  }

  mkdirSync(dirPath, options) {
    const providerPath = this.#toProviderPath(dirPath);
    const result = this[kProvider].mkdirSync(providerPath, options);
    if (result !== undefined) {
      return this.#toMountedPath(result);
    }
    return undefined;
  }

  rmdirSync(dirPath) {
    const providerPath = this.#toProviderPath(dirPath);
    this[kProvider].rmdirSync(providerPath);
  }

  unlinkSync(filePath) {
    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].unlinkSync(providerPath);
  }

  renameSync(oldPath, newPath) {
    const oldProviderPath = this.#toProviderPath(oldPath);
    const newProviderPath = this.#toProviderPath(newPath);
    this[kProvider].renameSync(oldProviderPath, newProviderPath);
  }

  copyFileSync(src, dest, mode) {
    const srcProviderPath = this.#toProviderPath(src);
    const destProviderPath = this.#toProviderPath(dest);
    this[kProvider].copyFileSync(srcProviderPath, destProviderPath, mode);
  }

  realpathSync(filePath, options) {
    const providerPath = this.#toProviderPath(filePath);
    const realProviderPath = this[kProvider].realpathSync(providerPath, options);
    return this.#toMountedPath(realProviderPath);
  }

  readlinkSync(linkPath, options) {
    const providerPath = this.#toProviderPath(linkPath);
    return this[kProvider].readlinkSync(providerPath, options);
  }

  symlinkSync(target, path, type) {
    const providerPath = this.#toProviderPath(path);
    this[kProvider].symlinkSync(target, providerPath, type);
  }

  accessSync(filePath, mode) {
    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].accessSync(providerPath, mode);
  }

  internalModuleStat(filePath) {
    try {
      const providerPath = this.#toProviderPath(filePath);
      return this[kProvider].internalModuleStat(providerPath);
    } catch {
      return -2;
    }
  }

  rmSync(filePath, options) {
    const recursive = options?.recursive === true;
    let stats;
    try {
      stats = this.lstatSync(filePath);
    } catch (err) {
      if (options?.force === true && err.code === 'ENOENT') return;
      throw err;
    }
    if (stats.isDirectory()) {
      if (!recursive) throw createEISDIR('rm', filePath);
      for (const name of this.readdirSync(filePath)) {
        this.rmSync(joinVFSPath(filePath, name), options);
      }
      this.rmdirSync(filePath);
    } else {
      this.unlinkSync(filePath);
    }
  }

  truncateSync(filePath, len = 0) {
    const fd = this.openSync(filePath, 'r+');
    try {
      this.ftruncateSync(fd, len);
    } finally {
      this.closeSync(fd);
    }
  }

  ftruncateSync(fd, len = 0) {
    const vfd = getVirtualFd(fd);
    if (!vfd) throw createEBADF('ftruncate');
    vfd.entry.truncateSync(len);
  }

  mkdtempSync(prefix) {
    // A trailing separator is part of the prefix, not a path component.
    const trailing = prefix.endsWith(path.sep) || prefix.endsWith('/');
    const providerPrefix = this.#toProviderPath(prefix);
    const dir = (trailing && providerPrefix !== '/' ? providerPrefix + '/' : providerPrefix) +
      randomBytes(6).toString('hex').slice(0, 6);
    this[kProvider].mkdirSync(dir);
    return this.#toMountedPath(dir);
  }

  // ==================== File Descriptor Operations ====================

  openSync(filePath, flags = 'r', mode) {
    const providerPath = this.#toProviderPath(filePath);
    const handle = this[kProvider].openSync(providerPath, flags, mode);
    return openVirtualFd(handle);
  }

  closeSync(fd) {
    closeFdSync(fd);
  }

  readSync(fd, buffer, offset, length, position) {
    return readFdSync(fd, buffer, offset, length, position);
  }

  fstatSync(fd, options) {
    return fstatFdSync(fd, options);
  }

  // ==================== FS Operations (Async with Callbacks) ====================

  readFile(filePath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].readFile(this.#toProviderPath(filePath), options)
      .then((data) => callback(null, data), (err) => callback(err));
  }

  writeFile(filePath, data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].writeFile(this.#toProviderPath(filePath), data, options)
      .then(() => callback(null), (err) => callback(err));
  }

  stat(filePath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].stat(this.#toProviderPath(filePath), options)
      .then((stats) => callback(null, stats), (err) => callback(err));
  }

  lstat(filePath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].lstat(this.#toProviderPath(filePath), options)
      .then((stats) => callback(null, stats), (err) => callback(err));
  }

  readdir(dirPath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    const providerPath = this.#toProviderPath(dirPath);
    this[kProvider].readdir(providerPath, options)
      .then((entries) => callback(null, this.#mapDirents(entries, options, dirPath, providerPath)),
            (err) => callback(err));
  }

  realpath(filePath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].realpath(this.#toProviderPath(filePath), options)
      .then((realPath) => callback(null, this.#toMountedPath(realPath)), (err) => callback(err));
  }

  readlink(linkPath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    this[kProvider].readlink(this.#toProviderPath(linkPath), options)
      .then((target) => callback(null, target), (err) => callback(err));
  }

  access(filePath, mode, callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = undefined;
    }

    this[kProvider].access(this.#toProviderPath(filePath), mode)
      .then(() => callback(null), (err) => callback(err));
  }

  open(filePath, flags, mode, callback) {
    if (typeof flags === 'function') {
      callback = flags;
      flags = 'r';
      mode = undefined;
    } else if (typeof mode === 'function') {
      callback = mode;
      mode = undefined;
    }

    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].open(providerPath, flags, mode)
      .then((handle) => {
        const fd = openVirtualFd(handle);
        callback(null, fd);
      }, (err) => callback(err));
  }

  close(fd, callback) {
    closeFd(fd, callback);
  }

  read(fd, buffer, offset, length, position, callback) {
    readFd(fd, buffer, offset, length, position, callback);
  }

  fstat(fd, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }

    fstatFd(fd, options, callback);
  }

  rm(filePath, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    process.nextTick(() => {
      try { this.rmSync(filePath, options); } catch (err) { callback(err); return; }
      callback(null);
    });
  }

  truncate(filePath, len, callback) {
    if (typeof len === 'function') {
      callback = len;
      len = 0;
    }
    process.nextTick(() => {
      try { this.truncateSync(filePath, len); } catch (err) { callback(err); return; }
      callback(null);
    });
  }

  mkdtemp(prefix, options, callback) {
    if (typeof options === 'function') callback = options;
    process.nextTick(() => {
      let result;
      try { result = this.mkdtempSync(prefix); } catch (err) { callback(err); return; }
      callback(null, result);
    });
  }

  // ==================== Stream Operations ====================

  createReadStream(filePath, options) {
    return new VirtualReadStream(this, filePath, options);
  }

  // ==================== Watch Operations ====================

  watch(filePath, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = {};
    }

    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].statSync(providerPath);
    const watcher = this[kProvider].watch(providerPath, options);

    if (listener) {
      watcher.on('change', listener);
    }

    return watcher;
  }

  watchFile(filePath, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = {};
    }

    const providerPath = this.#toProviderPath(filePath);
    return this[kProvider].watchFile(providerPath, options, listener);
  }

  unwatchFile(filePath, listener) {
    const providerPath = this.#toProviderPath(filePath);
    this[kProvider].unwatchFile(providerPath, listener);
  }

  // ==================== Promise API ====================

  get promises() {
    if (this[kPromises] === null) {
      this[kPromises] = this.#createPromisesAPI();
    }
    return this[kPromises];
  }

  #createPromisesAPI() {
    const provider = this[kProvider];
    const thisVfs = this;

    const toProviderPath = (p) => this.#toProviderPath(p);
    const toMountedPath = (p) => this.#toMountedPath(p);

    return Object.freeze({
      async readFile(filePath, options) {
        const providerPath = toProviderPath(filePath);
        return provider.readFile(providerPath, options);
      },

      async writeFile(filePath, data, options) {
        const providerPath = toProviderPath(filePath);
        return provider.writeFile(providerPath, data, options);
      },

      async appendFile(filePath, data, options) {
        const providerPath = toProviderPath(filePath);
        return provider.appendFile(providerPath, data, options);
      },

      async stat(filePath, options) {
        const providerPath = toProviderPath(filePath);
        return provider.stat(providerPath, options);
      },

      async lstat(filePath, options) {
        const providerPath = toProviderPath(filePath);
        return provider.lstat(providerPath, options);
      },

      async readdir(dirPath, options) {
        const providerPath = toProviderPath(dirPath);
        const entries = await provider.readdir(providerPath, options);
        return thisVfs.#mapDirents(entries, options, dirPath, providerPath);
      },

      async mkdir(dirPath, options) {
        const providerPath = toProviderPath(dirPath);
        const result = await provider.mkdir(providerPath, options);
        if (result !== undefined) {
          return toMountedPath(result);
        }
        return undefined;
      },

      async rm(filePath, options) {
        return thisVfs.rmSync(filePath, options);
      },

      async truncate(filePath, len) {
        return thisVfs.truncateSync(filePath, len);
      },

      async mkdtemp(prefix) {
        return thisVfs.mkdtempSync(prefix);
      },

      async rmdir(dirPath) {
        const providerPath = toProviderPath(dirPath);
        return provider.rmdir(providerPath);
      },

      async unlink(filePath) {
        const providerPath = toProviderPath(filePath);
        return provider.unlink(providerPath);
      },

      async rename(oldPath, newPath) {
        const oldProviderPath = toProviderPath(oldPath);
        const newProviderPath = toProviderPath(newPath);
        return provider.rename(oldProviderPath, newProviderPath);
      },

      async copyFile(src, dest, mode) {
        const srcProviderPath = toProviderPath(src);
        const destProviderPath = toProviderPath(dest);
        return provider.copyFile(srcProviderPath, destProviderPath, mode);
      },

      async realpath(filePath, options) {
        const providerPath = toProviderPath(filePath);
        const realPath = await provider.realpath(providerPath, options);
        return toMountedPath(realPath);
      },

      async readlink(linkPath, options) {
        const providerPath = toProviderPath(linkPath);
        return provider.readlink(providerPath, options);
      },

      async symlink(target, path, type) {
        const providerPath = toProviderPath(path);
        return provider.symlink(target, providerPath, type);
      },

      async access(filePath, mode) {
        const providerPath = toProviderPath(filePath);
        return provider.access(providerPath, mode);
      },

      watch(filePath, options) {
        const providerPath = toProviderPath(filePath);
        provider.statSync(providerPath);
        return provider.watchAsync(providerPath, options);
      },
    });
  }
}

module.exports = {
  VirtualFileSystem,
};
