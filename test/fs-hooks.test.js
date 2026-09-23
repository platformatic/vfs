'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
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
    vfs.mount();

    const content = fs.readFileSync(path.join(vfs.mountPoint, 'data.txt'), 'utf8');
    assert.strictEqual(content, 'hello from vfs');
  });

  it('fs.existsSync returns true for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/exists.txt', 'yes');
    vfs.mount();

    assert.strictEqual(fs.existsSync(path.join(vfs.mountPoint, 'exists.txt')), true);
    assert.strictEqual(fs.existsSync(path.join(vfs.mountPoint, 'nope.txt')), false);
  });

  it('fs.statSync returns stats for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/stat.txt', 'data');
    vfs.mount();

    const stats = fs.statSync(path.join(vfs.mountPoint, 'stat.txt'));
    assert.ok(stats.isFile());
  });

  it('fs.lstatSync returns stats for VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/lstat.txt', 'data');
    vfs.mount();

    const stats = fs.lstatSync(path.join(vfs.mountPoint, 'lstat.txt'));
    assert.ok(stats.isFile());
  });

  it('fs.readdirSync lists VFS directory contents', () => {
    vfs = create();
    vfs.writeFileSync('/dir/a.txt', 'a');
    vfs.writeFileSync('/dir/b.txt', 'b');
    vfs.mount();

    const entries = fs.readdirSync(path.join(vfs.mountPoint, 'dir'));
    assert.deepStrictEqual(entries.sort(), ['a.txt', 'b.txt']);
  });

  it('fs.realpathSync resolves VFS paths', () => {
    vfs = create();
    vfs.writeFileSync('/real.txt', 'data');
    vfs.mount();

    const resolved = fs.realpathSync(path.join(vfs.mountPoint, 'real.txt'));
    assert.strictEqual(resolved, path.join(vfs.mountPoint, 'real.txt'));
  });

  it('fs.accessSync does not throw for existing VFS files', () => {
    vfs = create();
    vfs.writeFileSync('/access.txt', 'data');
    vfs.mount();

    assert.doesNotThrow(() => fs.accessSync(path.join(vfs.mountPoint, 'access.txt')));
  });

  it('fs.accessSync throws ENOENT for missing VFS files', () => {
    vfs = create();
    vfs.mount();

    assert.throws(() => fs.accessSync(path.join(vfs.mountPoint, 'nope.txt')), {
      code: 'ENOENT',
    });
  });

  it('fs.readlinkSync reads VFS symlinks', () => {
    vfs = create();
    vfs.writeFileSync('/link-target.txt', 'data');
    vfs.symlinkSync('/link-target.txt', '/my-link.txt');
    vfs.mount();

    const target = fs.readlinkSync(path.join(vfs.mountPoint, 'my-link.txt'));
    assert.strictEqual(target, '/link-target.txt');
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
    vfs.mount();

    fs.access(path.join(vfs.mountPoint, 'cb.txt'), (err) => {
      assert.ifError(err);
      done();
    });
  });

  it('fs.access calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount();

    fs.access(path.join(vfs.mountPoint, 'nope.txt'), (err) => {
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
    vfs.mount();

    fs.stat(path.join(vfs.mountPoint, 'cb-stat.txt'), (err, stats) => {
      assert.ifError(err);
      assert.ok(stats.isFile());
      done();
    });
  });

  it('fs.stat calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount();

    fs.stat(path.join(vfs.mountPoint, 'nope.txt'), (err) => {
      assert.ok(err);
      assert.strictEqual(err.code, 'ENOENT');
      done();
    });
  });

  it('fs.lstat calls back with stats for VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-lstat.txt', 'data');
    vfs.mount();

    fs.lstat(path.join(vfs.mountPoint, 'cb-lstat.txt'), (err, stats) => {
      assert.ifError(err);
      assert.ok(stats.isFile());
      done();
    });
  });

  it('fs.readFile calls back with VFS content', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-read.txt', 'callback content');
    vfs.mount();

    fs.readFile(path.join(vfs.mountPoint, 'cb-read.txt'), 'utf8', (err, content) => {
      assert.ifError(err);
      assert.strictEqual(content, 'callback content');
      done();
    });
  });

  it('fs.readFile calls back with ENOENT for missing VFS files', (_, done) => {
    vfs = create();
    vfs.mount();

    fs.readFile(path.join(vfs.mountPoint, 'nope.txt'), 'utf8', (err) => {
      assert.ok(err);
      assert.strictEqual(err.code, 'ENOENT');
      done();
    });
  });

  it('fs.readdir calls back with VFS directory entries', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cbdir/a.txt', 'a');
    vfs.writeFileSync('/cbdir/b.txt', 'b');
    vfs.mount();

    fs.readdir(path.join(vfs.mountPoint, 'cbdir'), (err, entries) => {
      assert.ifError(err);
      assert.deepStrictEqual(entries.sort(), ['a.txt', 'b.txt']);
      done();
    });
  });

  it('fs.readlink calls back with VFS symlink target', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-link-target.txt', 'data');
    vfs.symlinkSync('/cb-link-target.txt', '/cb-link.txt');
    vfs.mount();

    fs.readlink(path.join(vfs.mountPoint, 'cb-link.txt'), (err, target) => {
      assert.ifError(err);
      assert.strictEqual(target, '/cb-link-target.txt');
      done();
    });
  });

  it('fs.realpath calls back with resolved VFS path', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/cb-real.txt', 'data');
    vfs.mount();

    fs.realpath(path.join(vfs.mountPoint, 'cb-real.txt'), (err, resolved) => {
      assert.ifError(err);
      assert.strictEqual(resolved, path.join(vfs.mountPoint, 'cb-real.txt'));
      done();
    });
  });

  it('fs.createReadStream returns a readable stream for VFS files', (_, done) => {
    vfs = create();
    vfs.writeFileSync('/stream.txt', 'streamed data');
    vfs.mount();

    const chunks = [];
    const stream = fs.createReadStream(path.join(vfs.mountPoint, 'stream.txt'));
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
    vfs.mount();

    await assert.doesNotReject(fsp.access(path.join(vfs.mountPoint, 'paccess.txt')));
  });

  it('fs.promises.access rejects with ENOENT for missing VFS files', async () => {
    vfs = create();
    vfs.mount();

    await assert.rejects(fsp.access(path.join(vfs.mountPoint, 'nope.txt')), {
      code: 'ENOENT',
    });
  });

  it('fs.promises.readFile reads from VFS', async () => {
    vfs = create();
    vfs.writeFileSync('/pread.txt', 'async vfs content');
    vfs.mount();

    const content = await fsp.readFile(path.join(vfs.mountPoint, 'pread.txt'), 'utf8');
    assert.strictEqual(content, 'async vfs content');
  });

  it('fs.promises.stat returns stats for VFS files', async () => {
    vfs = create();
    vfs.writeFileSync('/pstat.txt', 'data');
    vfs.mount();

    const stats = await fsp.stat(path.join(vfs.mountPoint, 'pstat.txt'));
    assert.ok(stats.isFile());
  });

  it('fs.promises.lstat returns stats for VFS files', async () => {
    vfs = create();
    vfs.writeFileSync('/plstat.txt', 'data');
    vfs.mount();

    const stats = await fsp.lstat(path.join(vfs.mountPoint, 'plstat.txt'));
    assert.ok(stats.isFile());
  });

  it('fs.promises.readdir lists VFS directory contents', async () => {
    vfs = create();
    vfs.writeFileSync('/pdir/x.txt', 'x');
    vfs.writeFileSync('/pdir/y.txt', 'y');
    vfs.mount();

    const entries = await fsp.readdir(path.join(vfs.mountPoint, 'pdir'));
    assert.deepStrictEqual(entries.sort(), ['x.txt', 'y.txt']);
  });

  it('fs.promises.readlink reads VFS symlinks', async () => {
    vfs = create();
    vfs.writeFileSync('/plink-target.txt', 'data');
    vfs.symlinkSync('/plink-target.txt', '/plink.txt');
    vfs.mount();

    const target = await fsp.readlink(path.join(vfs.mountPoint, 'plink.txt'));
    assert.strictEqual(target, '/plink-target.txt');
  });

  it('fs.promises.realpath resolves VFS paths', async () => {
    vfs = create();
    vfs.writeFileSync('/prealpath.txt', 'data');
    vfs.mount();

    const resolved = await fsp.realpath(path.join(vfs.mountPoint, 'prealpath.txt'));
    assert.strictEqual(resolved, path.join(vfs.mountPoint, 'prealpath.txt'));
  });

  it('require("fs/promises") returns the same patched object', async () => {
    vfs = create();
    vfs.writeFileSync('/shared.txt', 'shared content');
    vfs.mount();

    // Both import paths should see VFS content
    const content1 = await fs.promises.readFile(path.join(vfs.mountPoint, 'shared.txt'), 'utf8');
    const content2 = await fsp.readFile(path.join(vfs.mountPoint, 'shared.txt'), 'utf8');
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
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'fd.txt'));
    const buffer = Buffer.alloc(5);
    const bytesRead = fs.readSync(fd, buffer, 0, 5, 0);
    fs.closeSync(fd);

    assert.strictEqual(bytesRead, 5);
    assert.strictEqual(buffer.toString(), 'hello');
  });

  it('fs.openSync throws ENOENT for a missing VFS file', () => {
    vfs = create();
    vfs.writeFileSync('/present.txt', 'x');
    vfs.mount();

    assert.throws(
      () => fs.openSync(path.join(vfs.mountPoint, 'absent.txt')),
      (err) => err.code === 'ENOENT',
    );
  });

  it('fs.readSync accepts the options-object overload', () => {
    vfs = create();
    vfs.writeFileSync('/opts.txt', 'abcdefgh');
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'opts.txt'));
    const buffer = Buffer.alloc(3);
    const bytesRead = fs.readSync(fd, buffer, { offset: 0, length: 3, position: 2 });
    fs.closeSync(fd);

    assert.strictEqual(bytesRead, 3);
    assert.strictEqual(buffer.toString(), 'cde');
  });

  it('fs.fstatSync returns stats for a VFS fd', () => {
    vfs = create();
    vfs.writeFileSync('/stat-fd.txt', 'data');
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'stat-fd.txt'));
    const stats = fs.fstatSync(fd);
    fs.closeSync(fd);

    assert.ok(stats.isFile());
    assert.strictEqual(stats.size, 4);
  });

  it('sequential fs.readSync calls advance the file position', () => {
    vfs = create();
    vfs.writeFileSync('/seq.txt', 'abcdef');
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'seq.txt'));
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
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'stale.txt'));
    fs.closeSync(fd);

    assert.throws(() => fs.closeSync(fd), (err) => err.code === 'EBADF');
  });

  it('fs.open + fs.read + fs.close read a VFS file', (_t, done) => {
    vfs = create();
    vfs.writeFileSync('/cb.txt', 'callback content');
    vfs.mount();

    fs.open(path.join(vfs.mountPoint, 'cb.txt'), 'r', (openErr, fd) => {
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
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'fstat-cb.txt'));
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
    vfs.mount();

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
    vfs = create({ overlay: true });
    vfs.writeFileSync('/only-here.txt', 'vfs');
    vfs.mount();

    const fd = fs.openSync(path.join(vfs.mountPoint, 'only-here.txt'));
    assert.strictEqual(fs.fstatSync(fd).size, 3);
    fs.closeSync(fd);

    assert.strictEqual(vfs.shouldHandle(path.join(vfs.mountPoint, 'not-here.txt')), false);
    const realFd = fs.openSync(__filename);
    assert.ok(fs.fstatSync(realFd).size > 0);
    fs.closeSync(realFd);
  });
});
