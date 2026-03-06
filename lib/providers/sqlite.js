'use strict';

const { Buffer } = require('node:buffer');
const { posix: pathPosix } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { VirtualProvider } = require('../provider.js');
const { VirtualFileHandle } = require('../file_handle.js');
const {
  VFSWatcher,
  VFSStatWatcher,
  VFSWatchAsyncIterable,
} = require('../watcher.js');
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

const TYPE_FILE = 0;
const TYPE_DIR = 1;
const TYPE_SYMLINK = 2;

const kMaxSymlinkDepth = 40;

class SqliteFileHandle extends VirtualFileHandle {
  #content;
  #updateStmt;
  #path;
  #getStats;

  #checkClosed() {
    if (this.closed) {
      const { createEBADF } = require('../errors.js');
      throw createEBADF('read');
    }
  }

  constructor(path, flags, mode, content, updateStmt, getStats) {
    super(path, flags, mode);
    this.#content = content;
    this.#updateStmt = updateStmt;
    this.#path = path;
    this.#getStats = getStats;

    if (flags === 'w' || flags === 'w+') {
      this.#content = Buffer.alloc(0);
      this.#flush();
    } else if (flags === 'a' || flags === 'a+') {
      this.position = this.#content.length;
    }
  }

  #flush() {
    const now = Date.now();
    this.#updateStmt.run(this.#content, now, this.#path);
  }

  get content() {
    return this.#content;
  }

  readSync(buffer, offset, length, position) {
    this.#checkClosed();

    const content = this.#content;
    const readPos = position !== null && position !== undefined ? position : this.position;
    const available = content.length - readPos;

    if (available <= 0) {
      return 0;
    }

    const bytesToRead = Math.min(length, available);
    content.copy(buffer, offset, readPos, readPos + bytesToRead);

    if (position === null || position === undefined) {
      this.position = readPos + bytesToRead;
    }

    return bytesToRead;
  }

  async read(buffer, offset, length, position) {
    const bytesRead = this.readSync(buffer, offset, length, position);
    return { bytesRead, buffer };
  }

  writeSync(buffer, offset, length, position) {
    this.#checkClosed();

    const writePos = position !== null && position !== undefined ? position : this.position;
    const data = buffer.subarray(offset, offset + length);

    if (writePos + length > this.#content.length) {
      const newContent = Buffer.alloc(writePos + length);
      this.#content.copy(newContent, 0, 0, this.#content.length);
      this.#content = newContent;
    }

    data.copy(this.#content, writePos);
    this.#flush();

    if (position === null || position === undefined) {
      this.position = writePos + length;
    }

    return length;
  }

  async write(buffer, offset, length, position) {
    const bytesWritten = this.writeSync(buffer, offset, length, position);
    return { bytesWritten, buffer };
  }

  readFileSync(options) {
    this.#checkClosed();

    const content = this.#content;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding) {
      return content.toString(encoding);
    }
    return Buffer.from(content);
  }

  async readFile(options) {
    return this.readFileSync(options);
  }

  writeFileSync(data, options) {
    this.#checkClosed();

    const buffer = typeof data === 'string' ? Buffer.from(data, options?.encoding) : data;

    if (this.flags === 'a' || this.flags === 'a+') {
      const newContent = Buffer.alloc(this.#content.length + buffer.length);
      this.#content.copy(newContent, 0);
      buffer.copy(newContent, this.#content.length);
      this.#content = newContent;
    } else {
      this.#content = Buffer.from(buffer);
    }

    this.#flush();
    this.position = this.#content.length;
  }

  async writeFile(data, options) {
    this.writeFileSync(data, options);
  }

  statSync(options) {
    this.#checkClosed();
    if (this.#getStats) {
      return this.#getStats(this.#content.length);
    }
    const { ERR_INVALID_STATE } = require('../errors.js');
    throw new ERR_INVALID_STATE('stats not available');
  }

  async stat(options) {
    return this.statSync(options);
  }

  truncateSync(len = 0) {
    this.#checkClosed();

    if (len < this.#content.length) {
      this.#content = this.#content.subarray(0, len);
    } else if (len > this.#content.length) {
      const newContent = Buffer.alloc(len);
      this.#content.copy(newContent, 0, 0, this.#content.length);
      this.#content = newContent;
    }

    this.#flush();
  }

  async truncate(len) {
    this.truncateSync(len);
  }
}

class SqliteProvider extends VirtualProvider {
  #db;
  #readonly;
  #statWatchers;

  // Prepared statements
  #stmtGet;
  #stmtInsert;
  #stmtUpdateContent;
  #stmtDelete;
  #stmtChildren;
  #stmtDescendants;

  constructor(pathOrMemory) {
    super();
    this.#readonly = false;
    this.#statWatchers = new Map();

    this.#db = new DatabaseSync(pathOrMemory ?? ':memory:');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        path        TEXT PRIMARY KEY,
        parent_path TEXT,
        name        TEXT,
        type        INTEGER NOT NULL,
        content     BLOB,
        target      TEXT,
        mode        INTEGER NOT NULL,
        mtime       REAL NOT NULL,
        ctime       REAL NOT NULL,
        birthtime   REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_parent ON entries(parent_path);
    `);

    // Seed root if not present
    const root = this.#db.prepare(
      'SELECT path FROM entries WHERE path = ?',
    ).get('/');
    if (!root) {
      const now = Date.now();
      this.#db.prepare(
        'INSERT INTO entries (path, parent_path, name, type,' +
        ' content, target, mode, mtime, ctime, birthtime)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('/', null, '', TYPE_DIR, null, null, 0o755, now, now, now);
    }

    // Cache prepared statements
    this.#stmtGet = this.#db.prepare(
      'SELECT * FROM entries WHERE path = ?',
    );
    this.#stmtInsert = this.#db.prepare(
      'INSERT INTO entries (path, parent_path, name, type,' +
      ' content, target, mode, mtime, ctime, birthtime)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.#stmtUpdateContent = this.#db.prepare(
      'UPDATE entries SET content=?, mtime=? WHERE path=?',
    );
    this.#stmtDelete = this.#db.prepare(
      'DELETE FROM entries WHERE path = ?',
    );
    this.#stmtChildren = this.#db.prepare(
      'SELECT * FROM entries WHERE parent_path = ?',
    );
    this.#stmtDescendants = this.#db.prepare(
      'SELECT * FROM entries WHERE path LIKE ? AND path != ?',
    );
  }

  get readonly() {
    return this.#readonly;
  }

  get supportsWatch() {
    return true;
  }

  get supportsSymlinks() {
    return true;
  }

  setReadOnly() {
    this.#readonly = true;
  }

  close() {
    this.#db.close();
  }

  #normalizePath(path) {
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return pathPosix.normalize(normalized);
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

  #getRow(path) {
    return this.#stmtGet.get(path);
  }

  #lookupEntry(path, followSymlinks = true, depth = 0) {
    const normalized = this.#normalizePath(path);

    if (normalized === '/') {
      const row = this.#getRow('/');
      return { row, resolvedPath: '/' };
    }

    // Walk path components to resolve intermediate symlinks
    const segments = normalized.slice(1).split('/');
    let currentPath = '/';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const nextPath = currentPath === '/' ? '/' + segment : currentPath + '/' + segment;

      // Check current is a directory (or symlink to one)
      const currentRow = this.#getRow(currentPath);
      if (!currentRow) {
        return { row: null, resolvedPath: null };
      }

      if (currentRow.type === TYPE_SYMLINK) {
        if (depth >= kMaxSymlinkDepth) {
          return { row: null, resolvedPath: null, eloop: true };
        }
        const targetPath = this.#resolveSymlinkTarget(currentPath, currentRow.target);
        const result = this.#lookupEntry(targetPath, true, depth + 1);
        if (result.eloop) {
          return result;
        }
        if (!result.row) {
          return { row: null, resolvedPath: null };
        }
        // Continue from resolved path
        const remaining = segments.slice(i).join('/');
        const fullPath = result.resolvedPath === '/' ?
          '/' + remaining :
          result.resolvedPath + '/' + remaining;
        return this.#lookupEntry(fullPath, followSymlinks, depth + 1);
      }

      if (currentRow.type !== TYPE_DIR) {
        return { row: null, resolvedPath: null };
      }

      currentPath = nextPath;
    }

    const row = this.#getRow(currentPath);
    if (!row) {
      return { row: null, resolvedPath: null };
    }

    if (row.type === TYPE_SYMLINK && followSymlinks) {
      if (depth >= kMaxSymlinkDepth) {
        return { row: null, resolvedPath: null, eloop: true };
      }
      const targetPath = this.#resolveSymlinkTarget(currentPath, row.target);
      return this.#lookupEntry(targetPath, true, depth + 1);
    }

    return { row, resolvedPath: currentPath };
  }

  #getEntry(path, syscall, followSymlinks = true) {
    const result = this.#lookupEntry(path, followSymlinks);
    if (result.eloop) {
      throw createELOOP(syscall, path);
    }
    if (!result.row) {
      throw createENOENT(syscall, path);
    }
    return result.row;
  }

  #ensureParent(path, create, syscall) {
    const parentPath = this.#getParentPath(path);
    if (parentPath === null) {
      return this.#getRow('/');
    }

    const result = this.#lookupEntry(parentPath, true);
    if (result.row) {
      if (result.row.type !== TYPE_DIR) {
        throw createENOTDIR(syscall, path);
      }
      return result.row;
    }

    if (create) {
      // Create parent directories recursively
      const segments = parentPath.slice(1).split('/');
      let currentPath = '';
      for (const segment of segments) {
        currentPath += '/' + segment;
        const existing = this.#getRow(currentPath);
        if (!existing) {
          const now = Date.now();
          const pp = this.#getParentPath(currentPath);
          this.#stmtInsert.run(currentPath, pp, segment, TYPE_DIR, null, null, 0o755, now, now, now);
        } else if (existing.type !== TYPE_DIR) {
          throw createENOTDIR(syscall, path);
        }
      }
      return this.#getRow(parentPath);
    }

    throw createENOENT(syscall, path);
  }

  #createStats(row, size) {
    const options = {
      mode: row.mode,
      mtimeMs: row.mtime,
      ctimeMs: row.ctime,
      birthtimeMs: row.birthtime,
    };

    if (row.type === TYPE_FILE) {
      const content = row.content;
      const fileSize = size !== undefined ? size : (content ? content.byteLength : 0);
      return createFileStats(fileSize, options);
    } else if (row.type === TYPE_DIR) {
      return createDirectoryStats(options);
    } else if (row.type === TYPE_SYMLINK) {
      return createSymlinkStats(row.target.length, options);
    }

    const { ERR_INVALID_STATE } = require('../errors.js');
    throw new ERR_INVALID_STATE('Unknown entry type');
  }

  openSync(path, flags, mode) {
    const normalized = this.#normalizePath(path);
    const isCreate = flags === 'w' || flags === 'w+' || flags === 'a' || flags === 'a+';

    if (this.readonly && isCreate) {
      throw createEROFS('open', path);
    }

    let row;
    try {
      row = this.#getEntry(normalized, 'open');
    } catch (err) {
      if (err.code === 'ENOENT' && isCreate) {
        this.#ensureParent(normalized, true, 'open');
        const name = this.#getBaseName(normalized);
        const parentPath = this.#getParentPath(normalized);
        const now = Date.now();
        const fileMode = mode ?? 0o644;
        this.#stmtInsert.run(normalized, parentPath, name, TYPE_FILE, Buffer.alloc(0), null, fileMode, now, now, now);
        row = this.#getRow(normalized);
      } else {
        throw err;
      }
    }

    if (row.type === TYPE_DIR) {
      throw createEISDIR('open', path);
    }

    if (row.type === TYPE_SYMLINK) {
      throw createEINVAL('open', path);
    }

    const content = row.content ? Buffer.from(row.content) : Buffer.alloc(0);
    const getStats = (size) => this.#createStats(this.#getRow(normalized) || row, size);
    return new SqliteFileHandle(normalized, flags, mode ?? row.mode, content, this.#stmtUpdateContent, getStats);
  }

  async open(path, flags, mode) {
    return this.openSync(path, flags, mode);
  }

  statSync(path, options) {
    const row = this.#getEntry(path, 'stat', true);
    return this.#createStats(row);
  }

  async stat(path, options) {
    return this.statSync(path, options);
  }

  lstatSync(path, options) {
    const row = this.#getEntry(path, 'lstat', false);
    return this.#createStats(row);
  }

  async lstat(path, options) {
    return this.lstatSync(path, options);
  }

  readdirSync(path, options) {
    const result = this.#lookupEntry(path, true);
    if (result.eloop) {
      throw createELOOP('scandir', path);
    }
    if (!result.row) {
      throw createENOENT('scandir', path);
    }
    if (result.row.type !== TYPE_DIR) {
      throw createENOTDIR('scandir', path);
    }

    const children = this.#stmtChildren.all(result.resolvedPath);

    if (options?.withFileTypes) {
      const normalized = this.#normalizePath(path);
      return children.map((child) => {
        let type;
        if (child.type === TYPE_SYMLINK) {
          type = UV_DIRENT_LINK;
        } else if (child.type === TYPE_DIR) {
          type = UV_DIRENT_DIR;
        } else {
          type = UV_DIRENT_FILE;
        }
        return new VirtualDirent(child.name, type, normalized);
      });
    }

    return children.map((child) => child.name);
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
    if (existing.row) {
      if (existing.row.type === TYPE_DIR && recursive) {
        return undefined;
      }
      throw createEEXIST('mkdir', path);
    }

    if (recursive) {
      const segments = normalized.slice(1).split('/');
      let currentPath = '';

      for (const segment of segments) {
        currentPath += '/' + segment;
        const row = this.#getRow(currentPath);
        if (!row) {
          const now = Date.now();
          const pp = this.#getParentPath(currentPath);
          this.#stmtInsert.run(currentPath, pp, segment, TYPE_DIR, null, null, options?.mode ?? 0o755, now, now, now);
        } else if (row.type !== TYPE_DIR) {
          throw createENOTDIR('mkdir', path);
        }
      }
    } else {
      this.#ensureParent(normalized, false, 'mkdir');
      const name = this.#getBaseName(normalized);
      const parentPath = this.#getParentPath(normalized);
      const now = Date.now();
      this.#stmtInsert.run(normalized, parentPath, name, TYPE_DIR, null, null, options?.mode ?? 0o755, now, now, now);
    }

    return recursive ? normalized : undefined;
  }

  async mkdir(path, options) {
    return this.mkdirSync(path, options);
  }

  rmdirSync(path) {
    if (this.readonly) {
      throw createEROFS('rmdir', path);
    }

    const normalized = this.#normalizePath(path);
    const row = this.#getEntry(normalized, 'rmdir', true);

    if (row.type !== TYPE_DIR) {
      throw createENOTDIR('rmdir', path);
    }

    const children = this.#stmtChildren.all(normalized);
    if (children.length > 0) {
      throw createENOTEMPTY('rmdir', path);
    }

    this.#stmtDelete.run(normalized);
  }

  async rmdir(path) {
    this.rmdirSync(path);
  }

  unlinkSync(path) {
    if (this.readonly) {
      throw createEROFS('unlink', path);
    }

    const normalized = this.#normalizePath(path);
    const row = this.#getEntry(normalized, 'unlink', false);

    if (row.type === TYPE_DIR) {
      throw createEISDIR('unlink', path);
    }

    this.#stmtDelete.run(normalized);
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

    const row = this.#getEntry(normalizedOld, 'rename', false);

    // Ensure new parent exists
    this.#ensureParent(normalizedNew, true, 'rename');
    const newName = this.#getBaseName(normalizedNew);
    const newParentPath = this.#getParentPath(normalizedNew);

    if (row.type === TYPE_DIR) {
      // Transaction to update dir and all descendants
      this.#db.exec('BEGIN');
      try {
        this.#stmtDelete.run(normalizedOld);
        const now = Date.now();
        this.#stmtDelete.run(normalizedNew);
        this.#stmtInsert.run(
          normalizedNew, newParentPath, newName, row.type,
          row.content, row.target, row.mode, now,
          row.ctime, row.birthtime,
        );

        // Update all descendants
        const prefix = normalizedOld + '/';
        const descendants = this.#stmtDescendants.all(
          prefix + '%', normalizedOld,
        );
        for (const desc of descendants) {
          const suffix = desc.path.slice(normalizedOld.length);
          const newDescPath = normalizedNew + suffix;
          const newDescParent = this.#getParentPath(newDescPath);
          const descName = this.#getBaseName(newDescPath);
          this.#stmtDelete.run(desc.path);
          this.#stmtInsert.run(
            newDescPath, newDescParent, descName, desc.type,
            desc.content, desc.target, desc.mode, desc.mtime,
            desc.ctime, desc.birthtime,
          );
        }

        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // Simple file/symlink rename
      this.#stmtDelete.run(normalizedOld);
      const now = Date.now();
      this.#stmtDelete.run(normalizedNew);
      this.#stmtInsert.run(
        normalizedNew, newParentPath, newName, row.type,
        row.content, row.target, row.mode, now,
        row.ctime, row.birthtime,
      );
    }
  }

  async rename(oldPath, newPath) {
    this.renameSync(oldPath, newPath);
  }

  readlinkSync(path, options) {
    const normalized = this.#normalizePath(path);
    const row = this.#getEntry(normalized, 'readlink', false);

    if (row.type !== TYPE_SYMLINK) {
      throw createEINVAL('readlink', path);
    }

    return row.target;
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
    if (existing.row) {
      throw createEEXIST('symlink', path);
    }

    this.#ensureParent(normalized, true, 'symlink');
    const name = this.#getBaseName(normalized);
    const parentPath = this.#getParentPath(normalized);
    const now = Date.now();
    this.#stmtInsert.run(normalized, parentPath, name, TYPE_SYMLINK, null, target, 0o777, now, now, now);
  }

  async symlink(target, path, type) {
    this.symlinkSync(target, path, type);
  }

  realpathSync(path, options) {
    const result = this.#lookupEntry(path, true, 0);
    if (result.eloop) {
      throw createELOOP('realpath', path);
    }
    if (!result.row) {
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

    let watcher = this.#statWatchers.get(normalized);
    if (!watcher) {
      watcher = new VFSStatWatcher(this, normalized, options);
      this.#statWatchers.set(normalized, watcher);
    }

    if (listener) {
      watcher.addListener(listener);
    }

    return watcher;
  }

  unwatchFile(path, listener) {
    const normalized = this.#normalizePath(path);
    const watcher = this.#statWatchers.get(normalized);

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
      this.#statWatchers.delete(normalized);
    }
  }
}

module.exports = {
  SqliteProvider,
};
