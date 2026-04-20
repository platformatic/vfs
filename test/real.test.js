'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create, RealFSProvider } = require('../index.js');

describe('RealFSProvider', () => {
  let rootPath;
  let vfs;

  beforeEach(() => {
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-real-'));
    const provider = new RealFSProvider(rootPath);
    vfs = create(provider, { moduleHooks: false });
  });

  afterEach(() => {
    fs.rmSync(rootPath, { recursive: true, force: true });
  });

  it('writeFileSync and readFileSync', () => {
    vfs.writeFileSync('/test.txt', 'hello');
    const content = vfs.readFileSync('/test.txt', 'utf8');
    assert.strictEqual(content, 'hello');

    // Verify on real fs
    assert.strictEqual(fs.readFileSync(path.join(rootPath, 'test.txt'), 'utf8'), 'hello');
  });

  it('appendFileSync appends data', () => {
    vfs.writeFileSync('/append.txt', 'Hello');
    vfs.appendFileSync('/append.txt', ' World');
    const content = vfs.readFileSync('/append.txt', 'utf8');
    assert.strictEqual(content, 'Hello World');

    // Verify on real fs
    assert.strictEqual(fs.readFileSync(path.join(rootPath, 'append.txt'), 'utf8'), 'Hello World');
  });

  it('appendFileSync creates file if not exists', () => {
    vfs.appendFileSync('/new.txt', 'first');
    const content = vfs.readFileSync('/new.txt', 'utf8');
    assert.strictEqual(content, 'first');
  });

  it('appendFileSync appends multiple times', () => {
    vfs.appendFileSync('/multi.txt', 'a\n');
    vfs.appendFileSync('/multi.txt', 'b\n');
    vfs.appendFileSync('/multi.txt', 'c\n');
    const content = vfs.readFileSync('/multi.txt', 'utf8');
    assert.strictEqual(content, 'a\nb\nc\n');
  });

  it('writeFileSync overwrites existing content', () => {
    vfs.writeFileSync('/overwrite.txt', 'original');
    vfs.writeFileSync('/overwrite.txt', 'replaced');
    const content = vfs.readFileSync('/overwrite.txt', 'utf8');
    assert.strictEqual(content, 'replaced');
  });

  it('mkdirSync and readdirSync', () => {
    vfs.mkdirSync('/subdir', { recursive: true });
    vfs.writeFileSync('/subdir/file.txt', 'nested');
    const entries = vfs.readdirSync('/subdir');
    assert.deepStrictEqual(entries, ['file.txt']);
  });

  it('promises.appendFile appends data', async () => {
    vfs.writeFileSync('/async-append.txt', 'Hello');
    await vfs.promises.appendFile('/async-append.txt', ' World');
    const content = vfs.readFileSync('/async-append.txt', 'utf8');
    assert.strictEqual(content, 'Hello World');
  });

  it('handles paths that already include the root path', () => {
    vfs.writeFileSync('/test.txt', 'content');

    // Read using a path that includes the rootPath (simulates cwd resolution)
    const content = vfs.readFileSync(rootPath + '/test.txt', 'utf8');
    assert.strictEqual(content, 'content');
  });

  it('write and read with rootPath-prefixed path', () => {
    vfs.writeFileSync(rootPath + '/prefixed.txt', 'hello');
    const content = vfs.readFileSync('/prefixed.txt', 'utf8');
    assert.strictEqual(content, 'hello');
  });

  it('data persists across provider instances', () => {
    vfs.mkdirSync('/session', { recursive: true });
    vfs.writeFileSync('/session/data.txt', 'persistent');

    // Create new provider from same rootPath
    const provider2 = new RealFSProvider(rootPath);
    const vfs2 = create(provider2, { moduleHooks: false });
    const content = vfs2.readFileSync('/session/data.txt', 'utf8');
    assert.strictEqual(content, 'persistent');
  });
});
