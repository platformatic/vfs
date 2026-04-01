'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../index.js');

describe('VirtualFileSystem - mount/unmount', () => {
  let vfs;

  beforeEach(() => {
    vfs = create({ moduleHooks: false });
  });

  afterEach(() => {
    if (vfs.mounted) {
      vfs.unmount();
    }
  });

  it('mount returns the VFS instance for chaining', () => {
    vfs.writeFileSync('/file.txt', 'data');
    const result = vfs.mount('/app');
    assert.strictEqual(result, vfs);
  });

  it('mounted property reflects mount state', () => {
    assert.strictEqual(vfs.mounted, false);
    vfs.mount('/app');
    assert.strictEqual(vfs.mounted, true);
    vfs.unmount();
    assert.strictEqual(vfs.mounted, false);
  });

  it('mountPoint returns the prefix', () => {
    assert.strictEqual(vfs.mountPoint, null);
    vfs.mount('/app');
    assert.strictEqual(vfs.mountPoint, '/app');
    vfs.unmount();
    assert.strictEqual(vfs.mountPoint, null);
  });

  it('shouldHandle returns true for paths under mount point', () => {
    vfs.mount('/app');
    assert.strictEqual(vfs.shouldHandle('/app/file.txt'), true);
    assert.strictEqual(vfs.shouldHandle('/app'), true);
    assert.strictEqual(vfs.shouldHandle('/other/file.txt'), false);
  });

  it('readFileSync works through mount point', () => {
    vfs.writeFileSync('/file.txt', 'mounted content');
    vfs.mount('/mnt');
    const content = vfs.readFileSync('/mnt/file.txt', 'utf8');
    assert.strictEqual(content, 'mounted content');
  });

  it('throws when mounting twice', () => {
    vfs.mount('/app');
    assert.throws(() => vfs.mount('/other'), {
      code: 'ERR_INVALID_STATE',
    });
  });

  it('throws ENOENT for paths outside mount point', () => {
    vfs.mount('/app');
    assert.throws(() => vfs.readFileSync('/outside/file.txt'), {
      code: 'ENOENT',
    });
  });

  it('emits vfs-mount event', (t, done) => {
    process.once('vfs-mount', (info) => {
      assert.strictEqual(info.mountPoint, '/test-mount');
      assert.strictEqual(info.overlay, false);
      assert.strictEqual(info.readonly, false);
      vfs.unmount();
      done();
    });
    vfs.mount('/test-mount');
  });

  it('emits vfs-unmount event', (t, done) => {
    vfs.mount('/test-unmount');
    process.once('vfs-unmount', (info) => {
      assert.strictEqual(info.mountPoint, '/test-unmount');
      done();
    });
    vfs.unmount();
  });

  it('Symbol.dispose unmounts', () => {
    vfs.mount('/disposable');
    assert.strictEqual(vfs.mounted, true);
    vfs[Symbol.dispose]();
    assert.strictEqual(vfs.mounted, false);
  });
});

describe('VirtualFileSystem - backslash path mount', () => {
  let vfs;

  beforeEach(() => {
    vfs = create({ moduleHooks: false });
  });

  afterEach(() => {
    if (vfs.mounted) {
      vfs.unmount();
    }
  });

  it('shouldHandle accepts backslash paths under mount point', () => {
    vfs.mount('C:\\app');
    assert.strictEqual(vfs.shouldHandle('C:\\app\\file.txt'), true);
    assert.strictEqual(vfs.shouldHandle('C:\\app'), true);
  });

  it('shouldHandle rejects backslash paths outside mount point', () => {
    vfs.mount('C:\\app');
    assert.strictEqual(vfs.shouldHandle('C:\\other\\file.txt'), false);
  });

  it('shouldHandle rejects backslash paths that are a prefix but not a child', () => {
    vfs.mount('C:\\app');
    assert.strictEqual(vfs.shouldHandle('C:\\application\\file.txt'), false);
  });

  it('shouldHandle works with a drive root mount', () => {
    vfs.writeFileSync('/data.json', '{}');
    vfs.mount('C:\\');
    assert.strictEqual(vfs.shouldHandle('C:\\data.json'), true);
    assert.strictEqual(vfs.shouldHandle('C:\\deep\\nested\\path'), true);
  });

  it('mountPoint preserves backslashes', () => {
    vfs.mount('C:\\app');
    assert.strictEqual(vfs.mountPoint, 'C:\\app');
  });
});

describe('VirtualFileSystem - Windows path I/O', { skip: process.platform !== 'win32' }, () => {
  let vfs;

  beforeEach(() => {
    vfs = create({ moduleHooks: false });
  });

  afterEach(() => {
    if (vfs.mounted) {
      vfs.unmount();
    }
  });

  it('readFileSync works through a Windows mount point', () => {
    vfs.writeFileSync('/file.txt', 'windows mount content');
    vfs.mount('C:\\mnt');
    const content = vfs.readFileSync('C:\\mnt\\file.txt', 'utf8');
    assert.strictEqual(content, 'windows mount content');
  });

  it('throws ENOENT for paths outside Windows mount point', () => {
    vfs.mount('C:\\app');
    assert.throws(() => vfs.readFileSync('C:\\outside\\file.txt'), {
      code: 'ENOENT',
    });
  });
});

describe('VirtualFileSystem - overlay mode', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('shouldHandle returns true only for existing files in overlay mode', () => {
    vfs = create({ moduleHooks: false, overlay: true });
    vfs.writeFileSync('/config.json', '{"test": true}');
    vfs.mount('/');

    assert.strictEqual(vfs.shouldHandle('/config.json'), true);
    assert.strictEqual(vfs.shouldHandle('/nonexistent.txt'), false);
  });
});
