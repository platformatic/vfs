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

describe('Module hooks — fs callback patches', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('fs.stat calls back with stats for VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-stat.txt', 'data');
    vfs.mount('/vfs-test-cb-stat');

    fs.stat('/vfs-test-cb-stat/cb-stat.txt', (err, stats) => {
      assert.ifError(err);
      assert.ok(stats.isFile());
      done();
    });
  });

  it('fs.stat calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount('/vfs-test-cb-stat-miss');

    fs.stat('/vfs-test-cb-stat-miss/nope.txt', (err) => {
      assert.ok(err);
      assert.strictEqual(err.code, 'ENOENT');
      done();
    });
  });

  it('fs.lstat calls back with stats for VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-lstat.txt', 'data');
    vfs.mount('/vfs-test-cb-lstat');

    fs.lstat('/vfs-test-cb-lstat/cb-lstat.txt', (err, stats) => {
      assert.ifError(err);
      assert.ok(stats.isFile());
      done();
    });
  });

  it('fs.readFile calls back with VFS content', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-read.txt', 'callback content');
    vfs.mount('/vfs-test-cb-readfile');

    fs.readFile('/vfs-test-cb-readfile/cb-read.txt', 'utf8', (err, content) => {
      assert.ifError(err);
      assert.strictEqual(content, 'callback content');
      done();
    });
  });

  it('fs.readFile calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount('/vfs-test-cb-readfile-miss');

    fs.readFile('/vfs-test-cb-readfile-miss/nope.txt', 'utf8', (err) => {
      assert.ok(err);
      assert.strictEqual(err.code, 'ENOENT');
      done();
    });
  });

  it('fs.readdir calls back with VFS directory entries', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cbdir/a.txt', 'a');
    vfs.writeFileSync('/cbdir/b.txt', 'b');
    vfs.mount('/vfs-test-cb-readdir');

    fs.readdir('/vfs-test-cb-readdir/cbdir', (err, entries) => {
      assert.ifError(err);
      assert.deepStrictEqual(entries.sort(), ['a.txt', 'b.txt']);
      done();
    });
  });

  it('fs.readlink calls back with VFS symlink target', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-link-target.txt', 'data');
    vfs.symlinkSync('/cb-link-target.txt', '/cb-link.txt');
    vfs.mount('/vfs-test-cb-readlink');

    fs.readlink('/vfs-test-cb-readlink/cb-link.txt', (err, target) => {
      assert.ifError(err);
      assert.strictEqual(target, '/vfs-test-cb-readlink/cb-link-target.txt');
      done();
    });
  });

  it('fs.realpath calls back with resolved VFS path', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-real.txt', 'data');
    vfs.mount('/vfs-test-cb-realpath');

    fs.realpath('/vfs-test-cb-realpath/cb-real.txt', (err, resolved) => {
      assert.ifError(err);
      assert.strictEqual(resolved, '/vfs-test-cb-realpath/cb-real.txt');
      done();
    });
  });

  it('fs.createReadStream returns a readable stream for VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/stream.txt', 'streamed data');
    vfs.mount('/vfs-test-cb-stream');

    const chunks = [];
    const stream = fs.createReadStream('/vfs-test-cb-stream/stream.txt');
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      assert.strictEqual(Buffer.concat(chunks).toString(), 'streamed data');
      done();
    });
    stream.on('error', done);
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

describe('Module hooks — fd family patches', () => {
  let vfs;

  afterEach(() => {
    if (vfs?.mounted) {
      vfs.unmount();
    }
  });

  it('fs.openSync + fs.readSync + fs.closeSync read a VFS file', () => {
    vfs = create();
    vfs.writeFileSync('/fd.txt', 'hello from vfs');
    vfs.mount('/vfs-test-fd-sync');

    const fd = fs.openSync('/vfs-test-fd-sync/fd.txt');
    const buffer = Buffer.alloc(5);
    const bytesRead = fs.readSync(fd, buffer, 0, 5, 0);
    fs.closeSync(fd);

    assert.strictEqual(bytesRead, 5);
    assert.strictEqual(buffer.toString(), 'hello');
  });

  it('fs.openSync throws ENOENT for a missing VFS file', () => {
    vfs = create();
    vfs.writeFileSync('/present.txt', 'x');
    vfs.mount('/vfs-test-fd-missing');

    assert.throws(
      () => fs.openSync('/vfs-test-fd-missing/absent.txt'),
      (err) => err.code === 'ENOENT',
    );
  });

  it('fs.readSync accepts the options-object overload', () => {
    vfs = create();
    vfs.writeFileSync('/opts.txt', 'abcdefgh');
    vfs.mount('/vfs-test-fd-opts');

    const fd = fs.openSync('/vfs-test-fd-opts/opts.txt');
    const buffer = Buffer.alloc(3);
    const bytesRead = fs.readSync(fd, buffer, { offset: 0, length: 3, position: 2 });
    fs.closeSync(fd);

    assert.strictEqual(bytesRead, 3);
    assert.strictEqual(buffer.toString(), 'cde');
  });

  it('fs.fstatSync returns stats for a VFS fd', () => {
    vfs = create();
    vfs.writeFileSync('/stat-fd.txt', 'data');
    vfs.mount('/vfs-test-fd-fstat');

    const fd = fs.openSync('/vfs-test-fd-fstat/stat-fd.txt');
    const stats = fs.fstatSync(fd);
    fs.closeSync(fd);

    assert.ok(stats.isFile());
    assert.strictEqual(stats.size, 4);
  });

  it('sequential fs.readSync calls advance the file position', () => {
    vfs = create();
    vfs.writeFileSync('/seq.txt', 'abcdef');
    vfs.mount('/vfs-test-fd-seq');

    const fd = fs.openSync('/vfs-test-fd-seq/seq.txt');
    const first = Buffer.alloc(3);
    const second = Buffer.alloc(3);
    fs.readSync(fd, first, 0, 3, null);
    fs.readSync(fd, second, 0, 3, null);
    fs.closeSync(fd);

    assert.strictEqual(first.toString(), 'abc');
    assert.strictEqual(second.toString(), 'def');
  });

  it('fs.closeSync on a stale VFS fd throws EBADF', () => {
    vfs = create();
    vfs.writeFileSync('/stale.txt', 'x');
    vfs.mount('/vfs-test-fd-stale');

    const fd = fs.openSync('/vfs-test-fd-stale/stale.txt');
    fs.closeSync(fd);

    assert.throws(() => fs.closeSync(fd), (err) => err.code === 'EBADF');
  });

  it('fs.open + fs.read + fs.close read a VFS file', (_t, done) => {
    vfs = create();
    vfs.writeFileSync('/cb.txt', 'callback content');
    vfs.mount('/vfs-test-fd-cb');

    fs.open('/vfs-test-fd-cb/cb.txt', 'r', (openErr, fd) => {
      assert.ifError(openErr);
      const buffer = Buffer.alloc(8);
      fs.read(fd, buffer, 0, 8, 0, (readErr, bytesRead) => {
        assert.ifError(readErr);
        assert.strictEqual(bytesRead, 8);
        assert.strictEqual(buffer.toString(), 'callback');
        fs.close(fd, (closeErr) => {
          assert.ifError(closeErr);
          done();
        });
      });
    });
  });

  it('fs.fstat returns stats for a VFS fd', (_t, done) => {
    vfs = create();
    vfs.writeFileSync('/fstat-cb.txt', 'seven..');
    vfs.mount('/vfs-test-fd-fstat-cb');

    const fd = fs.openSync('/vfs-test-fd-fstat-cb/fstat-cb.txt');
    fs.fstat(fd, (err, stats) => {
      assert.ifError(err);
      assert.ok(stats.isFile());
      assert.strictEqual(stats.size, 7);
      fs.closeSync(fd);
      done();
    });
  });

  it('real-fs descriptors still work while a VFS is mounted', () => {
    vfs = create();
    vfs.writeFileSync('/unused.txt', 'x');
    vfs.mount('/vfs-test-fd-passthrough');

    const fd = fs.openSync(__filename, 'r');
    const buffer = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buffer, 0, 12, 0);
    const stats = fs.fstatSync(fd);
    fs.closeSync(fd);

    assert.strictEqual(bytesRead, 12);
    assert.strictEqual(buffer.toString(), "'use strict'");
    assert.ok(stats.size > 0);
  });

  it('an overlay mount leaves non-VFS paths on the real fs', () => {
    vfs = create();
    vfs.writeFileSync('/only-here.txt', 'vfs');
    vfs.mount('/vfs-test-fd-overlay', { overlay: true });

    const fd = fs.openSync('/vfs-test-fd-overlay/only-here.txt');
    assert.strictEqual(fs.fstatSync(fd).size, 3);
    fs.closeSync(fd);

    assert.throws(
      () => fs.openSync('/vfs-test-fd-overlay/not-here.txt'),
      (err) => err.code === 'ENOENT',
    );
  });
});
