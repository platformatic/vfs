'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnderMountPoint,
  getRelativePath,
  splitPath,
  getParentPath,
  getBaseName,
} = require('../lib/router.js');

describe('isUnderMountPoint', () => {
  it('returns true when path equals mount point', () => {
    assert.strictEqual(isUnderMountPoint('/app', '/app'), true);
  });

  it('returns true for path under posix mount point', () => {
    assert.strictEqual(isUnderMountPoint('/app/file.txt', '/app'), true);
  });

  it('returns false for path not under mount point', () => {
    assert.strictEqual(isUnderMountPoint('/other/file.txt', '/app'), false);
  });

  it('returns false for path that is a prefix but not a child', () => {
    assert.strictEqual(isUnderMountPoint('/application/file.txt', '/app'), false);
  });

  it('returns true for any path when mount point is /', () => {
    assert.strictEqual(isUnderMountPoint('/file.txt', '/'), true);
    assert.strictEqual(isUnderMountPoint('/deep/nested/path', '/'), true);
  });

  // Windows-style paths (backslash separators)

  it('returns true when Windows path equals mount point', () => {
    assert.strictEqual(isUnderMountPoint('C:\\foo\\mount', 'C:\\foo\\mount'), true);
  });

  it('returns true for Windows path under mount point', () => {
    assert.strictEqual(isUnderMountPoint('C:\\foo\\mount\\file.js', 'C:\\foo\\mount'), true);
  });

  it('returns false for Windows path not under mount point', () => {
    assert.strictEqual(isUnderMountPoint('C:\\bar\\file.js', 'C:\\foo\\mount'), false);
  });

  it('returns false for Windows path that is a prefix but not a child', () => {
    assert.strictEqual(isUnderMountPoint('C:\\foo\\mountextra\\file.js', 'C:\\foo\\mount'), false);
  });

  it('returns true for paths under a Windows drive root mount', () => {
    assert.strictEqual(isUnderMountPoint('C:\\file.txt', 'C:\\'), true);
    assert.strictEqual(isUnderMountPoint('C:\\deep\\nested\\path', 'C:\\'), true);
  });

  it('returns true for nested path under Windows mount point', () => {
    assert.strictEqual(isUnderMountPoint('C:\\foo\\mount\\sub\\dir\\file.js', 'C:\\foo\\mount'), true);
  });
});

describe('getRelativePath', () => {
  it('returns / when path equals mount point', () => {
    assert.strictEqual(getRelativePath('/app', '/app'), '/');
  });

  it('returns full path when mount point is /', () => {
    assert.strictEqual(getRelativePath('/file.txt', '/'), '/file.txt');
  });

  it('strips the mount point prefix', () => {
    assert.strictEqual(getRelativePath('/app/file.txt', '/app'), '/file.txt');
  });
});

describe('splitPath', () => {
  it('returns empty array for root', () => {
    assert.deepStrictEqual(splitPath('/'), []);
  });

  it('splits a path into segments', () => {
    assert.deepStrictEqual(splitPath('/a/b/c'), ['a', 'b', 'c']);
  });
});

describe('getParentPath', () => {
  it('returns null for root', () => {
    assert.strictEqual(getParentPath('/'), null);
  });

  it('returns parent directory', () => {
    assert.strictEqual(getParentPath('/a/b'), '/a');
  });
});

describe('getBaseName', () => {
  it('returns base name', () => {
    assert.strictEqual(getBaseName('/a/b/c.txt'), 'c.txt');
  });
});
