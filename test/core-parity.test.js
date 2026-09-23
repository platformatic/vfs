'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { create, RealFSProvider } = require('../index.js');

describe('userland core VFS equivalents', () => {
  it('mount() allocates unique reserved paths and exposes their URL', () => {
    const first = create();
    const second = create();
    const mount = first.mount();
    try {
      assert.equal(mount, first.mountPoint);
      assert.ok(mount.startsWith(path.join(os.devNull, 'vfs') + path.sep));
      assert.equal(first.mountPointURL, pathToFileURL(mount).href);
      assert.notEqual(second.mount(), mount);
      assert.equal(second.mountPointURL, pathToFileURL(second.mountPoint).href);
    } finally {
      first.unmount();
      second.unmount();
    }
    assert.equal(first.mountPointURL, null);
  });

  it('dispatches mutations through sync, callback and promise fs APIs', async () => {
    const vfs = create();
    const mount = vfs.mount();
    const file = path.join(mount, 'dir', 'item.txt');
    try {
      assert.equal(fs.mkdirSync(path.join(mount, 'dir'), { recursive: true }), path.join(mount, 'dir'));
      fs.writeFileSync(pathToFileURL(file), 'abcdef');
      assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
      await new Promise((resolve, reject) => fs.appendFile(file, '!', (err) => {
        if (err) reject(err);
        else resolve();
      }));
      assert.equal(await fsp.readFile(file, 'utf8'), 'abcdef!');
      await fsp.truncate(file, 3);
      assert.equal(vfs.readFileSync(file, 'utf8'), 'abc');
      await fsp.copyFile(file, path.join(mount, 'copy.txt'));
      await fsp.rename(path.join(mount, 'copy.txt'), path.join(mount, 'moved.txt'));
      assert.equal(fs.readFileSync(path.join(mount, 'moved.txt'), 'utf8'), 'abc');
      assert.throws(() => fs.copyFileSync(file, path.join(os.tmpdir(), 'not-a-vfs-file')), { code: 'EXDEV' });
      await fsp.rm(path.join(mount, 'dir'), { recursive: true });
      assert.equal(fs.existsSync(file), false);
      const temp = fs.mkdtempSync(path.join(mount, 'tmp-'));
      assert.ok(temp.startsWith(path.join(mount, 'tmp-')));
      fs.rmdirSync(temp);
    } finally {
      vfs.unmount();
    }
  });

  it('does not follow symlinks for lstat or readlink, including dangling targets', async () => {
    const vfs = create();
    vfs.symlinkSync('/missing', '/link');
    const mount = vfs.mount();
    const link = path.join(mount, 'link');
    try {
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.ok((await fsp.lstat(link)).isSymbolicLink());
      assert.equal(fs.statSync(path.join(mount, 'missing'), { throwIfNoEntry: false }), undefined);
      assert.equal(await fsp.stat(path.join(mount, 'missing'), { throwIfNoEntry: false }), undefined);
      assert.equal(fs.readlinkSync(link), '/missing');
      assert.equal(await fsp.readlink(link), '/missing');
      const callbackTarget = await new Promise((resolve, reject) => fs.readlink(link, (err, value) => {
        if (err) reject(err);
        else resolve(value);
      }));
      assert.equal(callbackTarget, '/missing');
      assert.throws(() => fs.statSync(link), { code: 'ENOENT' });
      fs.unlinkSync(link);
      assert.equal(vfs.existsSync(link), false);
    } finally {
      vfs.unmount();
    }
  });

  it('enumerates nested memory directories and returns the first mkdir-created path', async () => {
    const vfs = create();
    const mount = vfs.mount();
    try {
      assert.equal(fs.mkdirSync(path.join(mount, 'a', 'b'), { recursive: true }), path.join(mount, 'a'));
      fs.writeFileSync(path.join(mount, 'a', 'b', 'file'), 'data');
      assert.deepEqual(fs.readdirSync(mount, { recursive: true }), ['a', 'a/b', 'a/b/file']);
      const entries = await fsp.readdir(mount, { recursive: true, withFileTypes: true });
      assert.deepEqual(entries.map((entry) => [entry.name, entry.parentPath]), [
        ['a', mount], ['b', path.join(mount, 'a')], ['file', path.join(mount, 'a', 'b')],
      ]);
    } finally {
      vfs.unmount();
    }
  });

  it('maps real-provider dirent parent paths back under the mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-provider-'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'item'), 'data');
    const vfs = create(new RealFSProvider(root));
    const mount = vfs.mount();
    try {
      const entries = fs.readdirSync(mount, { recursive: true, withFileTypes: true });
      assert.deepEqual(entries.map((entry) => [entry.name, entry.parentPath]), [
        ['sub', mount], ['item', path.join(mount, 'sub')],
      ]);
    } finally {
      vfs.unmount();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes fs.promises.watch and rejects missing watch targets', async () => {
    const vfs = create();
    vfs.writeFileSync('/watched', 'a');
    const mount = vfs.mount();
    const file = path.join(mount, 'watched');
    try {
      assert.throws(() => fs.watch(path.join(mount, 'missing')), { code: 'ENOENT' });
      const events = fsp.watch(file);
      const next = events.next();
      fs.writeFileSync(file, 'longer');
      const result = await next;
      assert.equal(result.value.filename, 'watched');
      await events.return();
    } finally {
      vfs.unmount();
    }
  });

  it('removes only its own cached CJS modules when unmounted', () => {
    const vfs = create();
    vfs.writeFileSync('/module.cjs', 'module.exports = 42');
    const mount = vfs.mount();
    const filename = path.join(mount, 'module.cjs');
    try {
      assert.equal(require(filename), 42);
      assert.ok(require.cache[filename]);
    } finally {
      vfs.unmount();
    }
    assert.equal(require.cache[filename], undefined);
  });
});
