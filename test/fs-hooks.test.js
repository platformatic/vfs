'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { create } = require('../index.js');

// These tests verify that the module hooks patch real fs/fs.promises methods
// so that require('fs').readFileSync, require('fs/promises').readFile, etc.
// transparently serve VFS content.

describe('Module hooks — fs sync patches', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('fs.readFileSync reads from VFS', () => {
    vfs = create();
    vfs.writeFileSync('/data.txt', 'hello from vfs');
    vfs.mount('/vfs-test-sync-read');

    const content = fs.readFileSync('/vfs-test-sync-read/data.txt', 'utf8');
    assert.strictEqual(content, 'hello from vfs');
  });

  it('fs.existsSync returns true for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/exists.txt', 'yes');
    vfs.mount('/vfs-test-sync-exists');

    assert.strictEqual(fs.existsSync('/vfs-test-sync-exists/exists.txt'), true);
    assert.strictEqual(fs.existsSync('/vfs-test-sync-exists/nope.txt'), false);
  });

  it('fs.statSync returns stats for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/stat.txt', 'data');
    vfs.mount('/vfs-test-sync-stat');

    const stats = fs.statSync('/vfs-test-sync-stat/stat.txt');
    assert.ok(stats.isFile());
  });

  it('fs.lstatSync returns stats for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/lstat.txt', 'data');
    vfs.mount('/vfs-test-sync-lstat');

    const stats = fs.lstatSync('/vfs-test-sync-lstat/lstat.txt');
    assert.ok(stats.isFile());
  });

  it('fs.readdirSync lists VFS directory contents', () => {
    vfs = create();
    vfs.writeFileSync('/dir/a.txt', 'a');
    vfs.writeFileSync('/dir/b.txt', 'b');
    vfs.mount('/vfs-test-sync-readdir');

    const entries = fs.readdirSync('/vfs-test-sync-readdir/dir');
    assert.deepStrictEqual(entries.sort(), ['a.txt', 'b.txt']);
  });

  it('fs.realpathSync resolves VFS paths', () => {
    vfs = create();
    vfs.writeFileSync('/real.txt', 'data');
    vfs.mount('/vfs-test-sync-realpath');

    const resolved = fs.realpathSync('/vfs-test-sync-realpath/real.txt');
    assert.strictEqual(resolved, '/vfs-test-sync-realpath/real.txt');
  });

  it('fs.accessSync does not throw for existing VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/access.txt', 'data');
    vfs.mount('/vfs-test-sync-access');

    assert.doesNotThrow(() => fs.accessSync('/vfs-test-sync-access/access.txt'));
  });

  it('fs.accessSync throws ENOENT for missing VFS files', () => {
    vfs = create();
    vfs.mount('/vfs-test-sync-access-miss');

    assert.throws(() => fs.accessSync('/vfs-test-sync-access-miss/nope.txt'), {
      code: 'ENOENT',
    });
  });

  it('fs.readlinkSync reads VFS symlinks', () => {
    vfs = create();
    vfs.writeFileSync('/link-target.txt', 'data');
    vfs.symlinkSync('/link-target.txt', '/my-link.txt');
    vfs.mount('/vfs-test-sync-readlink');

    const target = fs.readlinkSync('/vfs-test-sync-readlink/my-link.txt');
    assert.strictEqual(target, '/vfs-test-sync-readlink/link-target.txt');
  });
});

describe('Module hooks — fs.access callback', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('fs.access calls back without error for existing VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb.txt', 'data');
    vfs.mount('/vfs-test-cb-access');

    fs.access('/vfs-test-cb-access/cb.txt', (err) => {
      assert.ifError(err);
      done();
    });
  });

  it('fs.access calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount('/vfs-test-cb-access-miss');

    fs.access('/vfs-test-cb-access-miss/nope.txt', (err) => {
      assert.ok(err);
      assert.strictEqual(err.code, 'ENOENT');
      done();
    });
  });
});

describe('Module hooks — fs.promises patches', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('fs.promises.access resolves for existing VFS files', async () => {
    vfs = create();
    vfs.writeFileSync('/paccess.txt', 'data');
    vfs.mount('/vfs-test-p-access');

    await assert.doesNotReject(fsp.access('/vfs-test-p-access/paccess.txt'));
  });

  it('fs.promises.access rejects with ENOENT for missing VFS files', async () => {
    vfs = create();
    vfs.mount('/vfs-test-p-access-miss');

    await assert.rejects(fsp.access('/vfs-test-p-access-miss/nope.txt'), {
      code: 'ENOENT',
    });
  });

  it('fs.promises.readFile reads from VFS', async () => {
    vfs = create();
    vfs.writeFileSync('/pread.txt', 'async vfs content');
    vfs.mount('/vfs-test-p-readfile');

    const content = await fsp.readFile('/vfs-test-p-readfile/pread.txt', 'utf8');
    assert.strictEqual(content, 'async vfs content');
  });

  it('fs.promises.stat returns stats for VFS files', async () => {
    vfs = create();
    vfs.writeFileSync('/pstat.txt', 'data');
    vfs.mount('/vfs-test-p-stat');

    const stats = await fsp.stat('/vfs-test-p-stat/pstat.txt');
    assert.ok(stats.isFile());
  });

  it('fs.promises.lstat returns stats for VFS files', async () => {
    vfs = create();
    vfs.writeFileSync('/plstat.txt', 'data');
    vfs.mount('/vfs-test-p-lstat');

    const stats = await fsp.lstat('/vfs-test-p-lstat/plstat.txt');
    assert.ok(stats.isFile());
  });

  it('fs.promises.readdir lists VFS directory contents', async () => {
    vfs = create();
    vfs.writeFileSync('/pdir/x.txt', 'x');
    vfs.writeFileSync('/pdir/y.txt', 'y');
    vfs.mount('/vfs-test-p-readdir');

    const entries = await fsp.readdir('/vfs-test-p-readdir/pdir');
    assert.deepStrictEqual(entries.sort(), ['x.txt', 'y.txt']);
  });

  it('fs.promises.readlink reads VFS symlinks', async () => {
    vfs = create();
    vfs.writeFileSync('/plink-target.txt', 'data');
    vfs.symlinkSync('/plink-target.txt', '/plink.txt');
    vfs.mount('/vfs-test-p-readlink');

    const target = await fsp.readlink('/vfs-test-p-readlink/plink.txt');
    assert.strictEqual(target, '/vfs-test-p-readlink/plink-target.txt');
  });

  it('fs.promises.realpath resolves VFS paths', async () => {
    vfs = create();
    vfs.writeFileSync('/prealpath.txt', 'data');
    vfs.mount('/vfs-test-p-realpath');

    const resolved = await fsp.realpath('/vfs-test-p-realpath/prealpath.txt');
    assert.strictEqual(resolved, '/vfs-test-p-realpath/prealpath.txt');
  });

  it('require("fs/promises") returns the same patched object', async () => {
    vfs = create();
    vfs.writeFileSync('/shared.txt', 'shared content');
    vfs.mount('/vfs-test-p-shared');

    // Both import paths should see VFS content
    const content1 = await fs.promises.readFile('/vfs-test-p-shared/shared.txt', 'utf8');
    const content2 = await fsp.readFile('/vfs-test-p-shared/shared.txt', 'utf8');
    assert.strictEqual(content1, 'shared content');
    assert.strictEqual(content2, 'shared content');
  });
});
