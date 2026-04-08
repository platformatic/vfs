'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create, SqliteProvider } = require('../index.js');

// Helper: create a mounted VFS with given files, run fn, then clean up.
function withVFS(files, fn) {
  const provider = new SqliteProvider();
  const vfs = create(provider);
  for (const [path, content] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir && dir !== '/') {
      vfs.mkdirSync(dir, { recursive: true });
    }
    vfs.writeFileSync(path, content);
  }
  vfs.mount('/');
  try {
    fn(vfs);
  } finally {
    // Clean up require cache for all VFS paths
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith('/node_modules/') || key.startsWith('/app/')) {
        delete require.cache[key];
      }
    }
    vfs.unmount();
    provider.close();
  }
}

describe('Module resolution — built-in shadowing', () => {
  it('require("buffer") resolves to Node.js built-in, not userland polyfill', () => {
    withVFS({
      '/node_modules/buffer/index.js':
        'module.exports = { __vfsPolyfill: true };',
      '/node_modules/buffer/package.json':
        '{"name":"buffer","main":"index.js"}',
    }, () => {
      const buf = require('buffer');
      // Node.js built-in buffer module exports Buffer constructor
      assert.ok(buf.Buffer, 'should have Buffer from built-in');
      assert.strictEqual(buf.__vfsPolyfill, undefined,
                         'should NOT resolve to userland polyfill');
    });
  });

  it('require("node:buffer") still resolves to built-in', () => {
    withVFS({
      '/node_modules/buffer/index.js':
        'module.exports = { __vfsPolyfill: true };',
      '/node_modules/buffer/package.json':
        '{"name":"buffer","main":"index.js"}',
    }, () => {
      const buf = require('node:buffer');
      assert.ok(buf.Buffer);
      assert.strictEqual(buf.__vfsPolyfill, undefined);
    });
  });
});

describe('Module resolution — file-before-directory', () => {
  it('require("./schema") resolves to schema.js when both schema.js and schema/ exist', () => {
    withVFS({
      '/app/schema.js':
        'module.exports = "file";',
      '/app/schema/index.js':
        'module.exports = "directory";',
      '/app/entry.js':
        'module.exports = require("./schema");',
      '/app/package.json':
        '{"name":"app","main":"entry.js"}',
    }, () => {
      const result = require('/app/entry.js');
      assert.strictEqual(result, 'file',
                         'file.js should take precedence over directory/index.js');
    });
  });
});

describe('Module resolution — require.resolve() interception', () => {
  it('require.resolve() resolves packages inside VFS', () => {
    withVFS({
      '/node_modules/vfs-resolve-test/index.js':
        'module.exports = 42;',
      '/node_modules/vfs-resolve-test/package.json':
        '{"name":"vfs-resolve-test","main":"index.js"}',
    }, () => {
      const resolved = require.resolve('vfs-resolve-test');
      assert.strictEqual(resolved, '/node_modules/vfs-resolve-test/index.js');
    });
  });
});

describe('Module resolution — trailing slash in specifiers', () => {
  it('require("process/") resolves the package entry point', () => {
    // Simulates the pattern used by readable-stream: require('process/')
    // where packageSubpath becomes './' and must be normalized to '.'
    withVFS({
      '/node_modules/vfs-trailing-slash/index.js':
        'module.exports = { trailingSlash: true };',
      '/node_modules/vfs-trailing-slash/package.json':
        '{"name":"vfs-trailing-slash","main":"index.js"}',
    }, () => {
      const mod = require('vfs-trailing-slash/');
      assert.deepStrictEqual(mod, { trailingSlash: true });
    });
  });
});

describe('Module resolution — main pointing to directory', () => {
  it('resolves index.js when package.json main points to a directory', () => {
    // Simulates packages like got v11: "main": "dist/source"
    // where dist/source is a directory containing index.js
    withVFS({
      '/node_modules/vfs-main-dir/package.json':
        '{"name":"vfs-main-dir","main":"dist/source"}',
      '/node_modules/vfs-main-dir/dist/source/index.js':
        'module.exports = { mainDir: true };',
    }, () => {
      const mod = require('vfs-main-dir');
      assert.deepStrictEqual(mod, { mainDir: true });
    });
  });

  it('resolves index.json when main directory has no index.js', () => {
    withVFS({
      '/node_modules/vfs-main-dir-json/package.json':
        '{"name":"vfs-main-dir-json","main":"lib"}',
      '/node_modules/vfs-main-dir-json/lib/index.json':
        '{"fromJson":true}',
    }, () => {
      const mod = require('vfs-main-dir-json');
      assert.deepStrictEqual(mod, { fromJson: true });
    });
  });
});

describe('Module resolution — wildcard exports (CJS)', () => {
  it('require("pkg/sub") resolves via "./*" wildcard export', () => {
    withVFS({
      '/node_modules/vfs-wild/package.json': JSON.stringify({
        name: 'vfs-wild',
        exports: { './*': { require: './build/cjs/*/index.js' } },
      }),
      '/node_modules/vfs-wild/build/cjs/utils/index.js':
        'module.exports = { wildcard: true };',
    }, () => {
      const mod = require('vfs-wild/utils');
      assert.deepStrictEqual(mod, { wildcard: true });
    });
  });

  it('direct export key takes priority over wildcard', () => {
    withVFS({
      '/node_modules/vfs-wild-prio/package.json': JSON.stringify({
        name: 'vfs-wild-prio',
        exports: {
          './exact': { require: './exact.js' },
          './*': { require: './fallback/*.js' },
        },
      }),
      '/node_modules/vfs-wild-prio/exact.js':
        'module.exports = "exact";',
      '/node_modules/vfs-wild-prio/fallback/exact.js':
        'module.exports = "fallback";',
    }, () => {
      const mod = require('vfs-wild-prio/exact');
      assert.strictEqual(mod, 'exact');
    });
  });

  it('wildcard with suffix matches correctly', () => {
    withVFS({
      '/node_modules/vfs-wild-suffix/package.json': JSON.stringify({
        name: 'vfs-wild-suffix',
        exports: { './features/*.json': './data/*.json' },
      }),
      '/node_modules/vfs-wild-suffix/data/config.json':
        '{"suffix":true}',
    }, () => {
      const mod = require('vfs-wild-suffix/features/config.json');
      assert.deepStrictEqual(mod, { suffix: true });
    });
  });

  it('wildcard with conditional exports and string target', () => {
    withVFS({
      '/node_modules/vfs-wild-str/package.json': JSON.stringify({
        name: 'vfs-wild-str',
        exports: { './*': './lib/*.js' },
      }),
      '/node_modules/vfs-wild-str/lib/foo.js':
        'module.exports = "str-wildcard";',
    }, () => {
      const mod = require('vfs-wild-str/foo');
      assert.strictEqual(mod, 'str-wildcard');
    });
  });

  it('non-matching wildcard falls through', () => {
    withVFS({
      '/node_modules/vfs-wild-miss/package.json': JSON.stringify({
        name: 'vfs-wild-miss',
        exports: { './lib/*': './lib/*.js' },
      }),
      '/node_modules/vfs-wild-miss/lib/thing.js':
        'module.exports = "ok";',
    }, () => {
      // "./other/thing" does not match "./lib/*"
      assert.throws(() => require('vfs-wild-miss/other/thing'));
    });
  });
});

describe('Module resolution — CJS exports field', () => {
  it('require("pkg/subpath") resolves via exports conditions', () => {
    withVFS({
      '/node_modules/vfs-cjs-exp/package.json': JSON.stringify({
        name: 'vfs-cjs-exp',
        exports: {
          './sub': { require: './lib/sub.js', import: './esm/sub.js' },
        },
      }),
      '/node_modules/vfs-cjs-exp/lib/sub.js':
        'module.exports = "cjs-sub";',
    }, () => {
      const mod = require('vfs-cjs-exp/sub');
      assert.strictEqual(mod, 'cjs-sub');
    });
  });

  it('CJS exports takes priority over main field', () => {
    withVFS({
      '/node_modules/vfs-cjs-prio/package.json': JSON.stringify({
        name: 'vfs-cjs-prio',
        main: './old.js',
        exports: { '.': { require: './new.js' } },
      }),
      '/node_modules/vfs-cjs-prio/old.js':
        'module.exports = "old";',
      '/node_modules/vfs-cjs-prio/new.js':
        'module.exports = "new";',
    }, () => {
      const mod = require('vfs-cjs-prio');
      assert.strictEqual(mod, 'new');
    });
  });

  it('falls back to main when exports does not match', () => {
    withVFS({
      '/node_modules/vfs-cjs-fall/package.json': JSON.stringify({
        name: 'vfs-cjs-fall',
        main: './fallback.js',
        exports: { './other': './other.js' },
      }),
      '/node_modules/vfs-cjs-fall/fallback.js':
        'module.exports = "fallback";',
    }, () => {
      const mod = require('vfs-cjs-fall');
      assert.strictEqual(mod, 'fallback');
    });
  });

  it('CJS exports with conditional string entry point', () => {
    withVFS({
      '/node_modules/vfs-cjs-cond/package.json': JSON.stringify({
        name: 'vfs-cjs-cond',
        exports: { require: './cjs.js', import: './esm.js' },
      }),
      '/node_modules/vfs-cjs-cond/cjs.js':
        'module.exports = "cjs-entry";',
    }, () => {
      const mod = require('vfs-cjs-cond');
      assert.strictEqual(mod, 'cjs-entry');
    });
  });
});

describe('Module resolution — CJS subpath directory', () => {
  it('require("pkg/subdir") resolves subdir/index.js', () => {
    withVFS({
      '/node_modules/vfs-subdir/package.json':
        '{"name":"vfs-subdir"}',
      '/node_modules/vfs-subdir/lib/index.js':
        'module.exports = "subdir-index";',
    }, () => {
      const mod = require('vfs-subdir/lib');
      assert.strictEqual(mod, 'subdir-index');
    });
  });

  it('require("pkg/subdir") resolves subdir/package.json main', () => {
    withVFS({
      '/node_modules/vfs-subdir-main/package.json':
        '{"name":"vfs-subdir-main"}',
      '/node_modules/vfs-subdir-main/sub/package.json':
        '{"main":"./entry.js"}',
      '/node_modules/vfs-subdir-main/sub/entry.js':
        'module.exports = "subdir-main";',
    }, () => {
      const mod = require('vfs-subdir-main/sub');
      assert.strictEqual(mod, 'subdir-main');
    });
  });
});

describe('Module resolution — package #imports', () => {
  it('#import resolves to a relative path', () => {
    withVFS({
      '/node_modules/vfs-hash/package.json': JSON.stringify({
        name: 'vfs-hash',
        imports: { '#config': './src/config.js' },
        main: './index.js',
      }),
      '/node_modules/vfs-hash/src/config.js':
        'module.exports = { hashImport: true };',
      '/node_modules/vfs-hash/index.js':
        'module.exports = require("#config");',
    }, () => {
      const mod = require('vfs-hash');
      assert.deepStrictEqual(mod, { hashImport: true });
    });
  });

  it('#import with conditions resolves based on context', () => {
    withVFS({
      '/node_modules/vfs-hash-cond/package.json': JSON.stringify({
        name: 'vfs-hash-cond',
        imports: {
          '#util': { require: './cjs-util.js', import: './esm-util.js' },
        },
        main: './index.js',
      }),
      '/node_modules/vfs-hash-cond/cjs-util.js':
        'module.exports = "cjs-util";',
      '/node_modules/vfs-hash-cond/index.js':
        'module.exports = require("#util");',
    }, () => {
      // CJS require should match the "require" condition
      // or fall back to "default"
      const mod = require('vfs-hash-cond');
      assert.strictEqual(mod, 'cjs-util');
    });
  });

  it('#import with wildcard pattern', () => {
    withVFS({
      '/node_modules/vfs-hash-wild/package.json': JSON.stringify({
        name: 'vfs-hash-wild',
        imports: { '#bindings/*': './src/bindings/*.js' },
        main: './index.js',
      }),
      '/node_modules/vfs-hash-wild/src/bindings/fs.js':
        'module.exports = "fs-binding";',
      '/node_modules/vfs-hash-wild/index.js':
        'module.exports = require("#bindings/fs");',
    }, () => {
      const mod = require('vfs-hash-wild');
      assert.strictEqual(mod, 'fs-binding');
    });
  });

  it('#import that maps to a bare specifier re-resolves', () => {
    withVFS({
      '/node_modules/vfs-hash-bare/package.json': JSON.stringify({
        name: 'vfs-hash-bare',
        imports: { '#dep': 'vfs-hash-dep' },
        main: './index.js',
      }),
      '/node_modules/vfs-hash-bare/index.js':
        'module.exports = require("#dep");',
      '/node_modules/vfs-hash-dep/package.json':
        '{"name":"vfs-hash-dep","main":"./index.js"}',
      '/node_modules/vfs-hash-dep/index.js':
        'module.exports = "from-dep";',
    }, () => {
      const mod = require('vfs-hash-bare');
      assert.strictEqual(mod, 'from-dep');
    });
  });

  it('#import with nested condition objects', () => {
    withVFS({
      '/node_modules/vfs-hash-nested-cond/package.json': JSON.stringify({
        name: 'vfs-hash-nested-cond',
        imports: {
          '#util': { node: { require: './cjs-util.js', import: './esm-util.js' } },
        },
        main: './index.js',
      }),
      '/node_modules/vfs-hash-nested-cond/cjs-util.js':
        'module.exports = "nested-cjs-util";',
      '/node_modules/vfs-hash-nested-cond/index.js':
        'module.exports = require("#util");',
    }, () => {
      const mod = require('vfs-hash-nested-cond');
      assert.strictEqual(mod, 'nested-cjs-util');
    });
  });

  it('#import from nested file walks up to find package.json', () => {
    withVFS({
      '/node_modules/vfs-hash-nested/package.json': JSON.stringify({
        name: 'vfs-hash-nested',
        imports: { '#secret': './secret.js' },
        main: './index.js',
      }),
      '/node_modules/vfs-hash-nested/secret.js':
        'module.exports = "found";',
      '/node_modules/vfs-hash-nested/index.js':
        'module.exports = require("./lib/deep");',
      '/node_modules/vfs-hash-nested/lib/deep.js':
        'module.exports = require("#secret");',
    }, () => {
      const mod = require('vfs-hash-nested');
      assert.strictEqual(mod, 'found');
    });
  });
});
