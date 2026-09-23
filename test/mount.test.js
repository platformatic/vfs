'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { devNull } = require('node:os');
const { create } = require('../index.js');

describe('VirtualFileSystem - mount/unmount', () => {
  let vfs;

  beforeEach(() => {
    vfs = create({ moduleHooks: false });
  });

  afterEach(() => {
    if (vfs.mounted) vfs.unmount();
  });

  it('mount returns a unique path in the reserved namespace', () => {
    vfs.writeFileSync('/file.txt', 'data');
    const mountPoint = vfs.mount();
    assert.strictEqual(mountPoint, vfs.mountPoint);
    assert.ok(mountPoint.startsWith(path.join(devNull, 'vfs') + path.sep));
    const other = create({ moduleHooks: false });
    try {
      assert.notStrictEqual(other.mount(), mountPoint);
    } finally {
      other.unmount();
    }
  });

  it('mounted and mountPoint reflect mount state', () => {
    assert.strictEqual(vfs.mounted, false);
    assert.strictEqual(vfs.mountPoint, null);
    const mountPoint = vfs.mount();
    assert.strictEqual(vfs.mounted, true);
    assert.strictEqual(vfs.mountPoint, mountPoint);
    vfs.unmount();
    assert.strictEqual(vfs.mounted, false);
    assert.strictEqual(vfs.mountPoint, null);
  });

  it('shouldHandle only paths under the mount point', () => {
    const mountPoint = vfs.mount();
    assert.strictEqual(vfs.shouldHandle(path.join(mountPoint, 'file.txt')), true);
    assert.strictEqual(vfs.shouldHandle(mountPoint), true);
    assert.strictEqual(vfs.shouldHandle(mountPoint + '-other/file.txt'), false);
    assert.strictEqual(vfs.shouldHandle('/other/file.txt'), false);
  });

  it('readFileSync works through the returned path', () => {
    vfs.writeFileSync('/file.txt', 'mounted content');
    const mountPoint = vfs.mount();
    assert.strictEqual(vfs.readFileSync(path.join(mountPoint, 'file.txt'), 'utf8'), 'mounted content');
  });

  it('rejects prefixes, even an explicit undefined', () => {
    assert.throws(() => vfs.mount('/app'), TypeError);
    assert.throws(() => vfs.mount(undefined), TypeError);
    assert.strictEqual(vfs.mounted, false);
  });

  it('throws when mounting twice', () => {
    vfs.mount();
    assert.throws(() => vfs.mount(), { code: 'ERR_INVALID_STATE' });
  });

  it('throws ENOENT for paths outside mount point', () => {
    vfs.mount();
    assert.throws(() => vfs.readFileSync('/outside/file.txt'), { code: 'ENOENT' });
  });

  it('emits vfs-mount event', (t, done) => {
    process.once('vfs-mount', (info) => {
      assert.strictEqual(info.mountPoint, vfs.mountPoint);
      assert.strictEqual(info.overlay, false);
      assert.strictEqual(info.readonly, false);
      vfs.unmount();
      done();
    });
    vfs.mount();
  });

  it('emits vfs-unmount event', (t, done) => {
    const mountPoint = vfs.mount();
    process.once('vfs-unmount', (info) => {
      assert.strictEqual(info.mountPoint, mountPoint);
      done();
    });
    vfs.unmount();
  });

  it('Symbol.dispose unmounts', () => {
    vfs.mount();
    assert.strictEqual(vfs.mounted, true);
    vfs[Symbol.dispose]();
    assert.strictEqual(vfs.mounted, false);
  });
});

describe('VirtualFileSystem - Windows path I/O', { skip: process.platform !== 'win32' }, () => {
  let vfs;

  beforeEach(() => {
    vfs = create({ moduleHooks: false });
  });

  afterEach(() => {
    if (vfs.mounted) vfs.unmount();
  });

  it('readFileSync works through the Windows mount point', () => {
    vfs.writeFileSync('/file.txt', 'windows mount content');
    const mountPoint = vfs.mount();
    assert.strictEqual(vfs.readFileSync(path.join(mountPoint, 'file.txt'), 'utf8'), 'windows mount content');
  });
});

describe('VirtualFileSystem - overlay mode', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) vfs.unmount();
  });

  it('shouldHandle returns true only for existing files in overlay mode', () => {
    vfs = create({ moduleHooks: false, overlay: true });
    vfs.writeFileSync('/config.json', '{"test": true}');
    const mountPoint = vfs.mount();

    assert.strictEqual(vfs.shouldHandle(path.join(mountPoint, 'config.json')), true);
    assert.strictEqual(vfs.shouldHandle(path.join(mountPoint, 'nonexistent.txt')), false);
  });
});
