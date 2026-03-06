'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { create, VirtualFileSystem, SqliteProvider, VirtualProvider } = require('../index.js');

describe('SqliteProvider - constructor + stat', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('is a VirtualProvider', () => {
    assert.ok(provider instanceof VirtualProvider);
  });

  it('root exists', () => {
    const stats = provider.statSync('/');
    assert.ok(stats.isDirectory());
  });

  it('statSync on root returns directory stats', () => {
    const stats = provider.statSync('/');
    assert.ok(stats.isDirectory());
    assert.strictEqual(stats.isFile(), false);
    assert.strictEqual(stats.isSymbolicLink(), false);
  });

  it('supportsWatch is true', () => {
    assert.strictEqual(provider.supportsWatch, true);
  });

  it('supportsSymlinks is true', () => {
    assert.strictEqual(provider.supportsSymlinks, true);
  });

  it('readonly is false by default', () => {
    assert.strictEqual(provider.readonly, false);
  });

  it('throws ENOENT for non-existing path', () => {
    assert.throws(() => provider.statSync('/nonexistent'), {
      code: 'ENOENT',
    });
  });

  it('constructor accepts :memory: explicitly', () => {
    const p = new SqliteProvider(':memory:');
    const stats = p.statSync('/');
    assert.ok(stats.isDirectory());
    p.close();
  });
});

describe('SqliteProvider - file handles + open', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('openSync with w flag creates a file', () => {
    const handle = provider.openSync('/test.txt', 'w');
    handle.closeSync();
    const stats = provider.statSync('/test.txt');
    assert.ok(stats.isFile());
  });

  it('openSync with r flag on existing file returns handle', () => {
    provider.writeFileSync('/read.txt', 'hello');
    const handle = provider.openSync('/read.txt', 'r');
    const content = handle.readFileSync('utf8');
    assert.strictEqual(content, 'hello');
    handle.closeSync();
  });

  it('openSync with r flag on non-existing file throws ENOENT', () => {
    assert.throws(() => provider.openSync('/nope.txt', 'r'), {
      code: 'ENOENT',
    });
  });

  it('handle write and read', () => {
    const handle = provider.openSync('/write.txt', 'w');
    const buf = Buffer.from('hello world');
    handle.writeSync(buf, 0, buf.length, null);
    handle.closeSync();

    const readHandle = provider.openSync('/write.txt', 'r');
    const result = Buffer.alloc(11);
    const bytesRead = readHandle.readSync(result, 0, 11, 0);
    assert.strictEqual(bytesRead, 11);
    assert.strictEqual(result.toString(), 'hello world');
    readHandle.closeSync();
  });

  it('handle truncate', () => {
    provider.writeFileSync('/trunc.txt', 'hello world');
    const handle = provider.openSync('/trunc.txt', 'w+');
    handle.writeFileSync('hello world');
    handle.truncateSync(5);
    const content = handle.readFileSync('utf8');
    assert.strictEqual(content, 'hello');
    handle.closeSync();
  });

  it('handle stat returns file stats', () => {
    provider.writeFileSync('/stat-handle.txt', 'content');
    const handle = provider.openSync('/stat-handle.txt', 'r');
    const stats = handle.statSync();
    assert.ok(stats.isFile());
    assert.strictEqual(stats.size, 7);
    handle.closeSync();
  });

  it('openSync on directory throws EISDIR', () => {
    provider.mkdirSync('/dir');
    assert.throws(() => provider.openSync('/dir', 'r'), {
      code: 'EISDIR',
    });
  });

  it('append mode positions at end', () => {
    provider.writeFileSync('/append.txt', 'Hello');
    const handle = provider.openSync('/append.txt', 'a');
    handle.writeFileSync(' World');
    handle.closeSync();

    const content = provider.readFileSync('/append.txt', 'utf8');
    assert.strictEqual(content, 'Hello World');
  });
});

describe('SqliteProvider - readFile/writeFile', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('writeFileSync and readFileSync round-trip', () => {
    provider.writeFileSync('/hello.txt', 'Hello, World!');
    const content = provider.readFileSync('/hello.txt', 'utf8');
    assert.strictEqual(content, 'Hello, World!');
  });

  it('readFileSync returns Buffer by default', () => {
    provider.writeFileSync('/data.bin', Buffer.from([1, 2, 3]));
    const content = provider.readFileSync('/data.bin');
    assert.ok(Buffer.isBuffer(content));
    assert.deepStrictEqual([...content], [1, 2, 3]);
  });

  it('writeFileSync with encoding', () => {
    provider.writeFileSync('/encoded.txt', 'café', { encoding: 'utf8' });
    const content = provider.readFileSync('/encoded.txt', 'utf8');
    assert.strictEqual(content, 'café');
  });

  it('appendFileSync appends data', () => {
    provider.writeFileSync('/append.txt', 'Hello');
    provider.appendFileSync('/append.txt', ' World');
    const content = provider.readFileSync('/append.txt', 'utf8');
    assert.strictEqual(content, 'Hello World');
  });

  it('copyFileSync copies a file', () => {
    provider.writeFileSync('/original.txt', 'original content');
    provider.copyFileSync('/original.txt', '/copy.txt');
    const content = provider.readFileSync('/copy.txt', 'utf8');
    assert.strictEqual(content, 'original content');
  });

  it('readFileSync throws ENOENT for non-existing file', () => {
    assert.throws(() => provider.readFileSync('/nonexistent.txt'), {
      code: 'ENOENT',
    });
  });
});

describe('SqliteProvider - directories', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('mkdirSync creates a directory', () => {
    provider.mkdirSync('/mydir');
    const stats = provider.statSync('/mydir');
    assert.ok(stats.isDirectory());
  });

  it('mkdirSync with recursive creates nested dirs', () => {
    provider.mkdirSync('/a/b/c', { recursive: true });
    assert.ok(provider.statSync('/a').isDirectory());
    assert.ok(provider.statSync('/a/b').isDirectory());
    assert.ok(provider.statSync('/a/b/c').isDirectory());
  });

  it('mkdirSync recursive returns path', () => {
    const result = provider.mkdirSync('/a/b/c', { recursive: true });
    assert.strictEqual(result, '/a/b/c');
  });

  it('mkdirSync recursive on existing returns undefined', () => {
    provider.mkdirSync('/existing');
    const result = provider.mkdirSync('/existing', { recursive: true });
    assert.strictEqual(result, undefined);
  });

  it('mkdirSync throws EEXIST for existing path', () => {
    provider.mkdirSync('/existing');
    assert.throws(() => provider.mkdirSync('/existing'), {
      code: 'EEXIST',
    });
  });

  it('mkdirSync throws ENOENT for missing parent', () => {
    assert.throws(() => provider.mkdirSync('/a/b'), {
      code: 'ENOENT',
    });
  });

  it('readdirSync lists directory contents', () => {
    provider.writeFileSync('/dir-test/file1.txt', 'a');
    provider.writeFileSync('/dir-test/file2.txt', 'b');
    const entries = provider.readdirSync('/dir-test');
    assert.deepStrictEqual(entries.sort(), ['file1.txt', 'file2.txt']);
  });

  it('readdirSync with withFileTypes returns dirents', () => {
    provider.writeFileSync('/typed/file.txt', 'data');
    provider.mkdirSync('/typed/subdir');
    const entries = provider.readdirSync('/typed', { withFileTypes: true });
    assert.strictEqual(entries.length, 2);

    const file = entries.find((e) => e.name === 'file.txt');
    const dir = entries.find((e) => e.name === 'subdir');
    assert.ok(file.isFile());
    assert.ok(dir.isDirectory());
    assert.strictEqual(file.parentPath, '/typed');
    assert.strictEqual(file.path, '/typed');
  });

  it('rmdirSync removes an empty directory', () => {
    provider.mkdirSync('/empty-dir');
    provider.rmdirSync('/empty-dir');
    assert.strictEqual(provider.existsSync('/empty-dir'), false);
  });

  it('rmdirSync throws ENOTEMPTY for non-empty directory', () => {
    provider.writeFileSync('/notempty/file.txt', 'data');
    assert.throws(() => provider.rmdirSync('/notempty'), {
      code: 'ENOTEMPTY',
    });
  });

  it('readdirSync throws ENOENT for non-existing dir', () => {
    assert.throws(() => provider.readdirSync('/nonexistent'), {
      code: 'ENOENT',
    });
  });

  it('readdirSync throws ENOTDIR for file', () => {
    provider.writeFileSync('/file.txt', 'data');
    assert.throws(() => provider.readdirSync('/file.txt'), {
      code: 'ENOTDIR',
    });
  });
});

describe('SqliteProvider - unlink + rename', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('unlinkSync removes a file', () => {
    provider.writeFileSync('/to-delete.txt', 'bye');
    assert.strictEqual(provider.existsSync('/to-delete.txt'), true);
    provider.unlinkSync('/to-delete.txt');
    assert.strictEqual(provider.existsSync('/to-delete.txt'), false);
  });

  it('unlinkSync throws EISDIR for directory', () => {
    provider.mkdirSync('/dir');
    assert.throws(() => provider.unlinkSync('/dir'), {
      code: 'EISDIR',
    });
  });

  it('unlinkSync throws ENOENT for non-existing file', () => {
    assert.throws(() => provider.unlinkSync('/nope'), {
      code: 'ENOENT',
    });
  });

  it('renameSync moves a file', () => {
    provider.writeFileSync('/old-name.txt', 'data');
    provider.renameSync('/old-name.txt', '/new-name.txt');
    assert.strictEqual(provider.existsSync('/old-name.txt'), false);
    assert.strictEqual(provider.readFileSync('/new-name.txt', 'utf8'), 'data');
  });

  it('renameSync moves a directory with descendants', () => {
    provider.mkdirSync('/src/sub', { recursive: true });
    provider.writeFileSync('/src/file.txt', 'a');
    provider.writeFileSync('/src/sub/deep.txt', 'b');

    provider.renameSync('/src', '/dst');

    assert.strictEqual(provider.existsSync('/src'), false);
    assert.ok(provider.statSync('/dst').isDirectory());
    assert.strictEqual(provider.readFileSync('/dst/file.txt', 'utf8'), 'a');
    assert.strictEqual(provider.readFileSync('/dst/sub/deep.txt', 'utf8'), 'b');
  });

  it('renameSync throws ENOENT for non-existing source', () => {
    assert.throws(() => provider.renameSync('/nope', '/dest'), {
      code: 'ENOENT',
    });
  });
});

describe('SqliteProvider - symlinks', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('symlinkSync and readlinkSync', () => {
    provider.writeFileSync('/target.txt', 'target content');
    provider.symlinkSync('/target.txt', '/link.txt');

    const target = provider.readlinkSync('/link.txt');
    assert.strictEqual(target, '/target.txt');
  });

  it('symlinks are followed for readFileSync', () => {
    provider.writeFileSync('/real.txt', 'real content');
    provider.symlinkSync('/real.txt', '/sym.txt');

    const content = provider.readFileSync('/sym.txt', 'utf8');
    assert.strictEqual(content, 'real content');
  });

  it('lstatSync returns symlink stats', () => {
    provider.writeFileSync('/real2.txt', 'data');
    provider.symlinkSync('/real2.txt', '/sym2.txt');

    const lstat = provider.lstatSync('/sym2.txt');
    assert.ok(lstat.isSymbolicLink());

    const stat = provider.statSync('/sym2.txt');
    assert.ok(stat.isFile());
  });

  it('realpathSync resolves symlinks', () => {
    provider.writeFileSync('/realfile.txt', 'data');
    provider.symlinkSync('/realfile.txt', '/symfile.txt');

    const realpath = provider.realpathSync('/symfile.txt');
    assert.strictEqual(realpath, '/realfile.txt');
  });

  it('throws EEXIST when creating symlink over existing', () => {
    provider.writeFileSync('/existing-file.txt', 'data');
    assert.throws(() => provider.symlinkSync('/somewhere', '/existing-file.txt'), {
      code: 'EEXIST',
    });
  });

  it('readlinkSync throws EINVAL on non-symlink', () => {
    provider.writeFileSync('/file.txt', 'data');
    assert.throws(() => provider.readlinkSync('/file.txt'), {
      code: 'EINVAL',
    });
  });

  it('relative symlinks resolve correctly', () => {
    provider.mkdirSync('/dir');
    provider.writeFileSync('/dir/target.txt', 'hello');
    provider.symlinkSync('target.txt', '/dir/link.txt');

    const content = provider.readFileSync('/dir/link.txt', 'utf8');
    assert.strictEqual(content, 'hello');
  });

  it('throws ELOOP on circular symlinks', () => {
    provider.symlinkSync('/b', '/a');
    provider.symlinkSync('/a', '/b');

    assert.throws(() => provider.statSync('/a'), {
      code: 'ELOOP',
    });
  });

  it('realpathSync throws ELOOP on circular symlinks', () => {
    provider.symlinkSync('/b', '/a');
    provider.symlinkSync('/a', '/b');

    assert.throws(() => provider.realpathSync('/a'), {
      code: 'ELOOP',
    });
  });
});

describe('SqliteProvider - read-only', () => {
  it('setReadOnly prevents writes', () => {
    const provider = new SqliteProvider();

    provider.writeFileSync('/before.txt', 'ok');
    provider.setReadOnly();

    assert.throws(() => provider.writeFileSync('/after.txt', 'fail'), {
      code: 'EROFS',
    });
    assert.strictEqual(provider.readFileSync('/before.txt', 'utf8'), 'ok');

    provider.close();
  });

  it('setReadOnly prevents mkdir', () => {
    const provider = new SqliteProvider();
    provider.setReadOnly();

    assert.throws(() => provider.mkdirSync('/dir'), {
      code: 'EROFS',
    });

    provider.close();
  });

  it('setReadOnly prevents rmdir', () => {
    const provider = new SqliteProvider();
    provider.mkdirSync('/dir');
    provider.setReadOnly();

    assert.throws(() => provider.rmdirSync('/dir'), {
      code: 'EROFS',
    });

    provider.close();
  });

  it('setReadOnly prevents unlink', () => {
    const provider = new SqliteProvider();
    provider.writeFileSync('/file.txt', 'data');
    provider.setReadOnly();

    assert.throws(() => provider.unlinkSync('/file.txt'), {
      code: 'EROFS',
    });

    provider.close();
  });

  it('setReadOnly prevents rename', () => {
    const provider = new SqliteProvider();
    provider.writeFileSync('/file.txt', 'data');
    provider.setReadOnly();

    assert.throws(() => provider.renameSync('/file.txt', '/new.txt'), {
      code: 'EROFS',
    });

    provider.close();
  });

  it('setReadOnly prevents symlink', () => {
    const provider = new SqliteProvider();
    provider.setReadOnly();

    assert.throws(() => provider.symlinkSync('/target', '/link'), {
      code: 'EROFS',
    });

    provider.close();
  });

  it('setReadOnly prevents open with write flag', () => {
    const provider = new SqliteProvider();
    provider.setReadOnly();

    assert.throws(() => provider.openSync('/file.txt', 'w'), {
      code: 'EROFS',
    });

    provider.close();
  });
});

describe('SqliteProvider - watch', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('watch returns a watcher that emits change events', async () => {
    provider.writeFileSync('/watch-test.txt', 'initial');
    const watcher = provider.watch('/watch-test.txt', { persistent: false, interval: 50 });

    const event = await new Promise((resolve) => {
      watcher.on('change', (eventType, filename) => {
        resolve({ eventType, filename });
      });

      // Trigger change after watcher starts
      setTimeout(() => {
        provider.writeFileSync('/watch-test.txt', 'changed!');
      }, 60);
    });

    assert.strictEqual(event.eventType, 'change');
    watcher.close();
  });

  it('watchAsync returns an async iterable', async () => {
    provider.writeFileSync('/async-watch.txt', 'initial');
    const watcher = provider.watchAsync('/async-watch.txt', { persistent: false, interval: 50 });

    setTimeout(() => {
      provider.writeFileSync('/async-watch.txt', 'changed!');
    }, 60);

    const result = await watcher.next();
    assert.strictEqual(result.done, false);
    assert.strictEqual(result.value.eventType, 'change');

    await watcher.return();
  });

  it('watchFile returns a stat watcher', (t, done) => {
    provider.writeFileSync('/stat-watch.txt', 'initial');
    const listener = (curr, prev) => {
      assert.ok(curr.mtimeMs > prev.mtimeMs);
      provider.unwatchFile('/stat-watch.txt', listener);
      done();
    };

    provider.watchFile('/stat-watch.txt', { persistent: false, interval: 50 }, listener);

    setTimeout(() => {
      provider.writeFileSync('/stat-watch.txt', 'changed!');
    }, 60);
  });

  it('unwatchFile without listener removes all listeners', () => {
    provider.writeFileSync('/unwatch.txt', 'data');
    provider.watchFile('/unwatch.txt', { persistent: false, interval: 50 }, () => {});
    provider.unwatchFile('/unwatch.txt');
    // Should not throw
  });
});

describe('SqliteProvider - async wrappers', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('stat resolves', async () => {
    const stats = await provider.stat('/');
    assert.ok(stats.isDirectory());
  });

  it('lstat resolves', async () => {
    provider.writeFileSync('/file.txt', 'data');
    const stats = await provider.lstat('/file.txt');
    assert.ok(stats.isFile());
  });

  it('readdir resolves', async () => {
    provider.writeFileSync('/dir/file.txt', 'data');
    const entries = await provider.readdir('/dir');
    assert.deepStrictEqual(entries, ['file.txt']);
  });

  it('mkdir resolves', async () => {
    await provider.mkdir('/async-dir');
    assert.ok(provider.statSync('/async-dir').isDirectory());
  });

  it('rmdir resolves', async () => {
    provider.mkdirSync('/rm-dir');
    await provider.rmdir('/rm-dir');
    assert.strictEqual(provider.existsSync('/rm-dir'), false);
  });

  it('unlink resolves', async () => {
    provider.writeFileSync('/rm-file.txt', 'data');
    await provider.unlink('/rm-file.txt');
    assert.strictEqual(provider.existsSync('/rm-file.txt'), false);
  });

  it('rename resolves', async () => {
    provider.writeFileSync('/old.txt', 'data');
    await provider.rename('/old.txt', '/new.txt');
    assert.strictEqual(provider.readFileSync('/new.txt', 'utf8'), 'data');
  });

  it('readlink resolves', async () => {
    provider.writeFileSync('/target.txt', 'data');
    provider.symlinkSync('/target.txt', '/link.txt');
    const target = await provider.readlink('/link.txt');
    assert.strictEqual(target, '/target.txt');
  });

  it('symlink resolves', async () => {
    provider.writeFileSync('/target2.txt', 'data');
    await provider.symlink('/target2.txt', '/link2.txt');
    assert.strictEqual(provider.readlinkSync('/link2.txt'), '/target2.txt');
  });

  it('realpath resolves', async () => {
    provider.writeFileSync('/real.txt', 'data');
    provider.symlinkSync('/real.txt', '/sym.txt');
    const rp = await provider.realpath('/sym.txt');
    assert.strictEqual(rp, '/real.txt');
  });

  it('open resolves', async () => {
    provider.writeFileSync('/open-async.txt', 'data');
    const handle = await provider.open('/open-async.txt', 'r');
    const content = handle.readFileSync('utf8');
    assert.strictEqual(content, 'data');
    handle.closeSync();
  });
});

describe('SqliteProvider - integration with VirtualFileSystem', () => {
  let vfs;
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
    vfs = create(provider, { moduleHooks: false });
  });

  afterEach(() => {
    provider.close();
  });

  it('creates VFS with SqliteProvider', () => {
    assert.ok(vfs instanceof VirtualFileSystem);
    assert.ok(vfs.provider instanceof SqliteProvider);
  });

  it('writeFileSync and readFileSync through VFS', () => {
    vfs.writeFileSync('/hello.txt', 'Hello from VFS');
    const content = vfs.readFileSync('/hello.txt', 'utf8');
    assert.strictEqual(content, 'Hello from VFS');
  });

  it('directory operations through VFS', () => {
    vfs.mkdirSync('/a/b/c', { recursive: true });
    assert.ok(vfs.statSync('/a/b/c').isDirectory());

    vfs.writeFileSync('/a/b/file.txt', 'nested');
    const entries = vfs.readdirSync('/a/b');
    assert.deepStrictEqual(entries.sort(), ['c', 'file.txt']);
  });

  it('symlinks through VFS', () => {
    vfs.writeFileSync('/target.txt', 'target content');
    vfs.symlinkSync('/target.txt', '/link.txt');
    assert.strictEqual(vfs.readFileSync('/link.txt', 'utf8'), 'target content');
  });

  it('file descriptor operations through VFS', () => {
    vfs.writeFileSync('/fd-test.txt', 'hello');
    const fd = vfs.openSync('/fd-test.txt');
    assert.ok(typeof fd === 'number');
    const stats = vfs.fstatSync(fd);
    assert.ok(stats.isFile());
    vfs.closeSync(fd);
  });
});

describe('SqliteProvider - require/import with module hooks', () => {
  it('require() loads a JS module from SqliteProvider', () => {
    const provider = new SqliteProvider();
    const vfs = create(provider);
    vfs.writeFileSync(
      '/node_modules/sqlite-test-mod/index.js',
      'module.exports = { answer: 42 };',
    );
    vfs.writeFileSync(
      '/node_modules/sqlite-test-mod/package.json',
      '{"name":"sqlite-test-mod","main":"index.js"}',
    );
    vfs.mount('/');
    try {
      const mod = require('sqlite-test-mod');
      assert.deepStrictEqual(mod, { answer: 42 });
    } finally {
      delete require.cache['/node_modules/sqlite-test-mod/index.js'];
      vfs.unmount();
      provider.close();
    }
  });

  it('require() loads a JSON module from SqliteProvider', () => {
    const provider = new SqliteProvider();
    const vfs = create(provider);
    vfs.writeFileSync(
      '/node_modules/sqlite-test-json/data.json',
      '{"hello":"world"}',
    );
    vfs.writeFileSync(
      '/node_modules/sqlite-test-json/package.json',
      '{"name":"sqlite-test-json","main":"data.json"}',
    );
    vfs.mount('/');
    try {
      const mod = require('sqlite-test-json');
      assert.deepStrictEqual(mod, { hello: 'world' });
    } finally {
      delete require.cache['/node_modules/sqlite-test-json/data.json'];
      vfs.unmount();
      provider.close();
    }
  });
});

describe('SqliteProvider - persistence', () => {
  it('file-backed DB survives close/reopen', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vfs-sqlite-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      // Write data with first provider
      const provider1 = new SqliteProvider(dbPath);
      provider1.writeFileSync('/persistent.txt', 'I persist!');
      provider1.mkdirSync('/mydir');
      provider1.writeFileSync('/mydir/nested.txt', 'also persists');
      provider1.close();

      // Reopen and verify
      const provider2 = new SqliteProvider(dbPath);
      const content = provider2.readFileSync('/persistent.txt', 'utf8');
      assert.strictEqual(content, 'I persist!');

      assert.ok(provider2.statSync('/mydir').isDirectory());
      assert.strictEqual(provider2.readFileSync('/mydir/nested.txt', 'utf8'), 'also persists');
      provider2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('symlinks persist across close/reopen', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vfs-sqlite-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      const provider1 = new SqliteProvider(dbPath);
      provider1.writeFileSync('/target.txt', 'target');
      provider1.symlinkSync('/target.txt', '/link.txt');
      provider1.close();

      const provider2 = new SqliteProvider(dbPath);
      assert.strictEqual(provider2.readlinkSync('/link.txt'), '/target.txt');
      assert.strictEqual(provider2.readFileSync('/link.txt', 'utf8'), 'target');
      provider2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('SqliteProvider - exists and access', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('existsSync returns true for existing file', () => {
    provider.writeFileSync('/exists.txt', 'yes');
    assert.strictEqual(provider.existsSync('/exists.txt'), true);
  });

  it('existsSync returns false for non-existing file', () => {
    assert.strictEqual(provider.existsSync('/nope.txt'), false);
  });

  it('accessSync does not throw for existing file', () => {
    provider.writeFileSync('/access.txt', 'ok');
    assert.doesNotThrow(() => provider.accessSync('/access.txt'));
  });

  it('accessSync throws for non-existing file', () => {
    assert.throws(() => provider.accessSync('/no-access.txt'), {
      code: 'ENOENT',
    });
  });

  it('internalModuleStat returns 1 for directory', () => {
    assert.strictEqual(provider.internalModuleStat('/'), 1);
  });

  it('internalModuleStat returns 0 for file', () => {
    provider.writeFileSync('/file.txt', 'data');
    assert.strictEqual(provider.internalModuleStat('/file.txt'), 0);
  });

  it('internalModuleStat returns -2 for non-existing', () => {
    assert.strictEqual(provider.internalModuleStat('/nope'), -2);
  });
});

describe('SqliteProvider - path normalization', () => {
  let provider;

  beforeEach(() => {
    provider = new SqliteProvider();
  });

  afterEach(() => {
    provider.close();
  });

  it('normalizes backslashes to forward slashes', () => {
    provider.writeFileSync('/dir/file.txt', 'data');
    const content = provider.readFileSync('\\dir\\file.txt', 'utf8');
    assert.strictEqual(content, 'data');
  });

  it('normalizes paths with double slashes', () => {
    provider.writeFileSync('/dir/file.txt', 'data');
    const content = provider.readFileSync('/dir//file.txt', 'utf8');
    assert.strictEqual(content, 'data');
  });

  it('normalizes paths with trailing dots', () => {
    provider.writeFileSync('/dir/file.txt', 'data');
    const content = provider.readFileSync('/dir/./file.txt', 'utf8');
    assert.strictEqual(content, 'data');
  });
});
