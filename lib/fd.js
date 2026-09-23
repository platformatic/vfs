'use strict';

const { createEBADF } = require('./errors.js');

const kFd = Symbol('kFd');
const kEntry = Symbol('kEntry');

// FD range: 10000+ to avoid conflicts with real fds
let nextFd = 10_000;

const openFDs = new Map();

class VirtualFD {
  constructor(fd, entry) {
    this[kFd] = fd;
    this[kEntry] = entry;
  }

  get fd() {
    return this[kFd];
  }

  get entry() {
    return this[kEntry];
  }
}

function openVirtualFd(entry) {
  const fd = nextFd++;
  const vfd = new VirtualFD(fd, entry);
  openFDs.set(fd, vfd);
  return fd;
}

function getVirtualFd(fd) {
  return openFDs.get(fd);
}

function closeVirtualFd(fd) {
  return openFDs.delete(fd);
}

function requireVirtualFd(fd, syscall) {
  const vfd = getVirtualFd(fd);
  if (!vfd) {
    throw createEBADF(syscall);
  }
  return vfd;
}

const DEFAULT_READ_SIZE = 16384;
const kEmptyOptions = Object.freeze({});

function fromReadOptions(buffer, options) {
  const buf = buffer ?? options.buffer ?? Buffer.alloc(DEFAULT_READ_SIZE);
  return [buf, options.offset ?? 0, options.length ?? buf.byteLength, options.position ?? null];
}

// fs.read/readSync accept (fd, buffer, offset, length, position),
// (fd, buffer, options), (fd, options) and (fd).  Collapse to positional form.
function normalizeReadArgs(buffer, offset, length, position) {
  if (buffer == null) {
    return fromReadOptions(null, kEmptyOptions);
  }

  if (!ArrayBuffer.isView(buffer)) {
    return fromReadOptions(null, buffer);
  }

  if (offset !== null && typeof offset === 'object') {
    return fromReadOptions(buffer, offset);
  }

  return [buffer, offset ?? 0, length ?? buffer.byteLength, position ?? null];
}

// The callback is always the last function argument, whichever overload was used.
function splitCallback(args) {
  const at = args.findIndex((arg) => typeof arg === 'function');
  if (at === -1) {
    return null;
  }
  const callback = args[at];
  args.length = at;
  return callback;
}

// The operations below are keyed on the fd alone: a handle carries its own
// content and position, so which VirtualFileSystem opened it is irrelevant.
// VirtualFileSystem and the node:fs patches both delegate here.

function closeFdSync(fd) {
  const vfd = requireVirtualFd(fd, 'close');
  vfd.entry.closeSync();
  closeVirtualFd(fd);
}

function readFdSync(fd, buffer, offset, length, position) {
  const vfd = requireVirtualFd(fd, 'read');
  const args = normalizeReadArgs(buffer, offset, length, position);
  return vfd.entry.readSync(args[0], args[1], args[2], args[3]);
}

function fstatFdSync(fd, options) {
  return requireVirtualFd(fd, 'fstat').entry.statSync(options);
}

function noop() {}

function closeFd(fd, callback = noop) {
  const vfd = getVirtualFd(fd);
  if (!vfd) {
    process.nextTick(callback, createEBADF('close'));
    return;
  }

  vfd.entry.close().then(() => {
    closeVirtualFd(fd);
    callback(null);
  }, callback);
}

function readFd(fd, buffer, offset, length, position, callback) {
  const rest = [buffer, offset, length, position];
  callback = splitCallback(rest) ?? callback;

  const vfd = getVirtualFd(fd);
  if (!vfd) {
    process.nextTick(callback, createEBADF('read'));
    return;
  }

  const args = normalizeReadArgs(rest[0], rest[1], rest[2], rest[3]);
  vfd.entry.read(args[0], args[1], args[2], args[3])
    .then(({ bytesRead }) => callback(null, bytesRead, args[0]), callback);
}

function fstatFd(fd, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  const vfd = getVirtualFd(fd);
  if (!vfd) {
    process.nextTick(callback, createEBADF('fstat'));
    return;
  }

  vfd.entry.stat(options).then((stats) => callback(null, stats), callback);
}

module.exports = {
  VirtualFD,
  openVirtualFd,
  getVirtualFd,
  closeVirtualFd,
  closeFdSync,
  readFdSync,
  fstatFdSync,
  closeFd,
  readFd,
  fstatFd,
};
