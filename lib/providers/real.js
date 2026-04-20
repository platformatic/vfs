'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { VirtualProvider } = require('../provider.js');
const { VirtualFileHandle } = require('../file_handle.js');
const {
  createEBADF,
  createENOENT,
  ERR_INVALID_ARG_VALUE,
} = require('../errors.js');

class RealFileHandle extends VirtualFileHandle {
  #fd;
  #realPath;

  #checkClosed() {
    if (this.closed) {
      throw createEBADF('read');
    }
  }

  constructor(path, flags, mode, fd, realPath) {
    super(path, flags, mode);
    this.#fd = fd;
    this.#realPath = realPath;
  }

  get fd() {
    return this.#fd;
  }

  readSync(buffer, offset, length, position) {
    this.#checkClosed();
    return fs.readSync(this.#fd, buffer, offset, length, position);
  }

  async read(buffer, offset, length, position) {
    this.#checkClosed();
    return new Promise((resolve, reject) => {
      fs.read(this.#fd, buffer, offset, length, position, (err, bytesRead) => {
        if (err) reject(err);
        else resolve({ bytesRead, buffer });
      });
    });
  }

  writeSync(buffer, offset, length, position) {
    this.#checkClosed();
    return fs.writeSync(this.#fd, buffer, offset, length, position);
  }

  async write(buffer, offset, length, position) {
    this.#checkClosed();
    return new Promise((resolve, reject) => {
      fs.write(this.#fd, buffer, offset, length, position, (err, bytesWritten) => {
        if (err) reject(err);
        else resolve({ bytesWritten, buffer });
      });
    });
  }

  readFileSync(options) {
    this.#checkClosed();
    return fs.readFileSync(this.#realPath, options);
  }

  async readFile(options) {
    this.#checkClosed();
    return fs.promises.readFile(this.#realPath, options);
  }

  writeFileSync(data, options) {
    this.#checkClosed();
    fs.writeFileSync(this.#fd, data, options);
  }

  async writeFile(data, options) {
    this.#checkClosed();
    return new Promise((resolve, reject) => {
      fs.writeFile(this.#fd, data, options, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  statSync(options) {
    this.#checkClosed();
    return fs.fstatSync(this.#fd, options);
  }

  async stat(options) {
    this.#checkClosed();
    return new Promise((resolve, reject) => {
      fs.fstat(this.#fd, options, (err, stats) => {
        if (err) reject(err);
        else resolve(stats);
      });
    });
  }

  truncateSync(len = 0) {
    this.#checkClosed();
    fs.ftruncateSync(this.#fd, len);
  }

  async truncate(len = 0) {
    this.#checkClosed();
    return new Promise((resolve, reject) => {
      fs.ftruncate(this.#fd, len, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  closeSync() {
    if (!this.closed) {
      fs.closeSync(this.#fd);
      super.closeSync();
    }
  }

  async close() {
    if (!this.closed) {
      return new Promise((resolve, reject) => {
        fs.close(this.#fd, (err) => {
          if (err) reject(err);
          else {
            super.closeSync();
            resolve();
          }
        });
      });
    }
  }
}

class RealFSProvider extends VirtualProvider {
  #rootPath;

  constructor(rootPath) {
    super();
    if (typeof rootPath !== 'string' || rootPath === '') {
      throw new ERR_INVALID_ARG_VALUE('rootPath', rootPath, 'must be a non-empty string');
    }
    this.#rootPath = path.resolve(rootPath);
  }

  get rootPath() {
    return this.#rootPath;
  }

  get readonly() {
    return false;
  }

  get supportsSymlinks() {
    return true;
  }

  #resolvePath(vfsPath) {
    let normalized = vfsPath;
    if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }

    const realPath = path.resolve(this.#rootPath, normalized);

    const rootWithSep = this.#rootPath.endsWith(path.sep) ?
      this.#rootPath :
      this.#rootPath + path.sep;

    if (realPath !== this.#rootPath && !realPath.startsWith(rootWithSep)) {
      throw createENOENT('open', vfsPath);
    }

    return realPath;
  }

  openSync(vfsPath, flags, mode) {
    const realPath = this.#resolvePath(vfsPath);
    const fd = fs.openSync(realPath, flags, mode);
    return new RealFileHandle(vfsPath, flags, mode ?? 0o644, fd, realPath);
  }

  async open(vfsPath, flags, mode) {
    const realPath = this.#resolvePath(vfsPath);
    return new Promise((resolve, reject) => {
      fs.open(realPath, flags, mode, (err, fd) => {
        if (err) reject(err);
        else resolve(new RealFileHandle(vfsPath, flags, mode ?? 0o644, fd, realPath));
      });
    });
  }

  statSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.statSync(realPath, options);
  }

  async stat(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.stat(realPath, options);
  }

  lstatSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.lstatSync(realPath, options);
  }

  async lstat(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.lstat(realPath, options);
  }

  readdirSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.readdirSync(realPath, options);
  }

  async readdir(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.readdir(realPath, options);
  }

  mkdirSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.mkdirSync(realPath, options);
  }

  async mkdir(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.mkdir(realPath, options);
  }

  rmdirSync(vfsPath) {
    const realPath = this.#resolvePath(vfsPath);
    fs.rmdirSync(realPath);
  }

  async rmdir(vfsPath) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.rmdir(realPath);
  }

  unlinkSync(vfsPath) {
    const realPath = this.#resolvePath(vfsPath);
    fs.unlinkSync(realPath);
  }

  async unlink(vfsPath) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.unlink(realPath);
  }

  renameSync(oldVfsPath, newVfsPath) {
    const oldRealPath = this.#resolvePath(oldVfsPath);
    const newRealPath = this.#resolvePath(newVfsPath);
    fs.renameSync(oldRealPath, newRealPath);
  }

  async rename(oldVfsPath, newVfsPath) {
    const oldRealPath = this.#resolvePath(oldVfsPath);
    const newRealPath = this.#resolvePath(newVfsPath);
    return fs.promises.rename(oldRealPath, newRealPath);
  }

  readlinkSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.readlinkSync(realPath, options);
  }

  async readlink(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.readlink(realPath, options);
  }

  symlinkSync(target, vfsPath, type) {
    const realPath = this.#resolvePath(vfsPath);
    fs.symlinkSync(target, realPath, type);
  }

  async symlink(target, vfsPath, type) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.symlink(target, realPath, type);
  }

  realpathSync(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    const resolved = fs.realpathSync(realPath, options);
    if (resolved === this.#rootPath) {
      return '/';
    }
    const rootWithSep = this.#rootPath + path.sep;
    if (resolved.startsWith(rootWithSep)) {
      return '/' + resolved.slice(rootWithSep.length).replace(/\\/g, '/');
    }
    return vfsPath;
  }

  async realpath(vfsPath, options) {
    const realPath = this.#resolvePath(vfsPath);
    const resolved = await fs.promises.realpath(realPath, options);
    if (resolved === this.#rootPath) {
      return '/';
    }
    const rootWithSep = this.#rootPath + path.sep;
    if (resolved.startsWith(rootWithSep)) {
      return '/' + resolved.slice(rootWithSep.length).replace(/\\/g, '/');
    }
    return vfsPath;
  }

  accessSync(vfsPath, mode) {
    const realPath = this.#resolvePath(vfsPath);
    fs.accessSync(realPath, mode);
  }

  async access(vfsPath, mode) {
    const realPath = this.#resolvePath(vfsPath);
    return fs.promises.access(realPath, mode);
  }

  copyFileSync(srcVfsPath, destVfsPath, mode) {
    const srcRealPath = this.#resolvePath(srcVfsPath);
    const destRealPath = this.#resolvePath(destVfsPath);
    fs.copyFileSync(srcRealPath, destRealPath, mode);
  }

  async copyFile(srcVfsPath, destVfsPath, mode) {
    const srcRealPath = this.#resolvePath(srcVfsPath);
    const destRealPath = this.#resolvePath(destVfsPath);
    return fs.promises.copyFile(srcRealPath, destRealPath, mode);
  }
}

module.exports = {
  RealFSProvider,
  RealFileHandle,
};
