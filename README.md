# @platformatic/vfs

A Virtual File System for Node.js. Provides an in-memory `fs`-compatible API with mount points, overlay mode, symlinks, module loading hooks, and custom storage providers.

## Install

```
npm install @platformatic/vfs
```

Requires Node.js >= 22.

## Quick start

```js
const { create } = require('@platformatic/vfs');

const vfs = create();

vfs.writeFileSync('/app/index.js', 'module.exports = "hello"');

// Mount the VFS at /app — patches require() and fs so that
// the rest of the process sees virtual files transparently.
vfs.mount('/app');

const mod = require('/app/index.js'); // 'hello'

vfs.unmount();
```

## API

### `create([provider], [options])`

Creates a new `VirtualFileSystem` instance.

- **provider** — a `VirtualProvider` instance (defaults to `MemoryProvider`)
- **options.moduleHooks** `<boolean>` — patch `require()`/`import` and core `fs` functions so the process can load modules from the VFS (default `true`)
- **options.overlay** `<boolean>` — when `true`, only files that exist in the VFS are intercepted; everything else falls through to the real filesystem (default `false`)
- **options.virtualCwd** `<boolean>` — enable a virtual working directory that intercepts `process.cwd()` and `process.chdir()` (default `false`)

Returns a `VirtualFileSystem`.

### `VirtualFileSystem`

#### Properties

| Property | Type | Description |
|---|---|---|
| `provider` | `VirtualProvider` | The underlying storage provider |
| `mountPoint` | `string \| null` | Current mount prefix, or `null` |
| `mounted` | `boolean` | Whether the VFS is currently mounted |
| `readonly` | `boolean` | Whether the provider is read-only |
| `overlay` | `boolean` | Whether overlay mode is enabled |

#### Mount / Unmount

```js
vfs.mount('/prefix');   // Start intercepting paths under /prefix
vfs.unmount();          // Stop intercepting
```

`mount()` returns the VFS instance for chaining. When mounted with `moduleHooks: true` (the default), `require()`, `import`, and core `fs` functions (`readFileSync`, `statSync`, `existsSync`, `readdirSync`, `realpathSync`, `openSync`, `watch`, etc.) are patched to serve files from the VFS.

Emits `vfs-mount` and `vfs-unmount` events on `process`.

Supports `Symbol.dispose` — works with `using` declarations in environments that support it.

#### `shouldHandle(path)`

Returns `true` if the given path would be handled by this VFS instance. In overlay mode, only returns `true` for paths that actually exist in the VFS.

#### Sync API

The full synchronous `fs` API:

```js
vfs.writeFileSync(path, data[, options])
vfs.readFileSync(path[, options])          // returns Buffer or string
vfs.existsSync(path)
vfs.statSync(path[, options])
vfs.lstatSync(path[, options])
vfs.readdirSync(path[, options])           // supports { withFileTypes: true }
vfs.mkdirSync(path[, options])             // supports { recursive: true }
vfs.rmdirSync(path)
vfs.unlinkSync(path)
vfs.renameSync(oldPath, newPath)
vfs.copyFileSync(src, dest)
vfs.appendFileSync(path, data[, options])
vfs.accessSync(path[, mode])
vfs.realpathSync(path[, options])
vfs.symlinkSync(target, path[, type])
vfs.readlinkSync(path[, options])
```

#### File descriptors

```js
const fd = vfs.openSync(path[, flags[, mode]]);
vfs.readSync(fd, buffer, offset, length, position);
vfs.fstatSync(fd[, options]);
vfs.closeSync(fd);
```

#### Callback API

Every sync method has a callback counterpart following the standard Node.js `(err, result)` convention:

```js
vfs.readFile(path, options, callback)
vfs.writeFile(path, data, options, callback)
vfs.stat(path, options, callback)
vfs.readdir(path, options, callback)
// ...
```

#### Promises API

```js
const content = await vfs.promises.readFile('/file.txt', 'utf8');
await vfs.promises.writeFile('/file.txt', 'data');
await vfs.promises.mkdir('/dir', { recursive: true });
const entries = await vfs.promises.readdir('/dir');
const stats = await vfs.promises.stat('/file.txt');
await vfs.promises.unlink('/file.txt');
await vfs.promises.rename('/old', '/new');
await vfs.promises.copyFile('/src', '/dest');
await vfs.promises.appendFile('/file.txt', 'more');
await vfs.promises.access('/file.txt');
await vfs.promises.symlink('/target', '/link');
const target = await vfs.promises.readlink('/link');
await vfs.promises.lstat('/link');
await vfs.promises.realpath('/link');
await vfs.promises.rmdir('/dir');
```

#### Streams

```js
const stream = vfs.createReadStream(path[, options]);
```

Returns a `Readable` stream. Options support `start`, `end`, and `autoClose`.

#### Watch

```js
const watcher = vfs.watch(path[, options][, listener]);
vfs.watchFile(path[, options], listener);
vfs.unwatchFile(path[, listener]);
```

#### Virtual working directory

When created with `{ virtualCwd: true }`:

```js
const vfs = create({ virtualCwd: true });
vfs.writeFileSync('/app/file.txt', 'data');
vfs.mount('/app');

vfs.chdir('/app');
vfs.cwd(); // '/app'
```

When mounted, `process.cwd()` and `process.chdir()` are patched to work with the virtual directory.

### Providers

#### `MemoryProvider`

The default provider. Stores everything in memory. Supports symlinks, watching, and read-only mode.

```js
const { MemoryProvider, create } = require('@platformatic/vfs');

const provider = new MemoryProvider();
const vfs = create(provider);

vfs.writeFileSync('/file.txt', 'hello');

// Freeze the provider to prevent writes
provider.setReadOnly();
vfs.writeFileSync('/other.txt', 'fail'); // throws EROFS
```

#### `SqliteProvider`

A persistent provider backed by Node.js built-in `node:sqlite`. Stores files, directories, and symlinks in a SQLite database. Supports both in-memory and file-backed databases.

```js
const { SqliteProvider, create } = require('@platformatic/vfs');

// In-memory (default)
const mem = new SqliteProvider();
const vfs1 = create(mem);

// File-backed — data persists across restarts
const disk = new SqliteProvider('/tmp/myfs.db');
const vfs2 = create(disk);

vfs2.writeFileSync('/file.txt', 'hello');
disk.close();

// Reopen later — files are still there
const disk2 = new SqliteProvider('/tmp/myfs.db');
const vfs3 = create(disk2);
vfs3.readFileSync('/file.txt', 'utf8'); // 'hello'
disk2.close();
```

Requires Node.js >= 22. Call `provider.close()` when done to close the database.

#### `RealFSProvider`

Delegates to the real filesystem, sandboxed under a root directory. Directory traversal outside the root is prevented.

```js
const { RealFSProvider, create } = require('@platformatic/vfs');

const provider = new RealFSProvider('/tmp/sandbox');
const vfs = create(provider);

// All paths are resolved relative to /tmp/sandbox
vfs.writeFileSync('/file.txt', 'data'); // writes to /tmp/sandbox/file.txt
```

#### Custom providers

Extend `VirtualProvider` and implement the essential primitives:

```js
const { VirtualProvider, create } = require('@platformatic/vfs');

class MyProvider extends VirtualProvider {
  openSync(path, flags, mode) { /* ... */ }
  statSync(path, options) { /* ... */ }
  readdirSync(path, options) { /* ... */ }
  mkdirSync(path, options) { /* ... */ }
  rmdirSync(path) { /* ... */ }
  unlinkSync(path) { /* ... */ }
  renameSync(oldPath, newPath) { /* ... */ }
}

const vfs = create(new MyProvider());
```

Higher-level operations (`readFile`, `writeFile`, `copyFile`, `exists`, `access`, etc.) are provided automatically by the base class using the primitives above.

## Module hooks

When `moduleHooks` is enabled (the default), mounting a VFS instance:

1. **Patches `require()` and `import`** — On Node.js 23.5+ uses `Module.registerHooks()`. On older versions falls back to `Module._resolveFilename` + `Module._extensions` patching.
2. **Patches core `fs` functions** — `readFileSync`, `statSync`, `lstatSync`, `readdirSync`, `existsSync`, `realpathSync`, `watch`, `watchFile`, `unwatchFile`, and the descriptor family `openSync`/`open`, `readSync`/`read`, `closeSync`/`close`, `fstatSync`/`fstat`.

This means third-party code using `require()` or `fs.readFileSync()` will transparently pick up files from the VFS.

Module resolution supports package.json `exports`, `main`, and bare specifier resolution walking `node_modules`.

## Node.js core VFS support

This package is a direct extraction of the Virtual File System being added to Node.js core ([nodejs/node#61478](https://github.com/nodejs/node/pull/61478)), allowing it to be used on Node.js 22+. Once the core PR lands, this package will no longer be necessary (except for `SqliteProvider`).

## License

MIT
