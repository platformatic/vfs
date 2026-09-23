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

// Mount in an isolated namespace; the returned path is platform-dependent.
const mountPoint = vfs.mount();
const mod = require(`${mountPoint}/app/index.js`); // 'hello'

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
| `mountPoint` | `string \| null` | Current isolated mount path, or `null` |
| `mounted` | `boolean` | Whether the VFS is currently mounted |
| `readonly` | `boolean` | Whether the provider is read-only |
| `overlay` | `boolean` | Whether overlay mode is enabled |

#### Mount / Unmount

```js
const mountPoint = vfs.mount(); // e.g. '/dev/null/vfs/0' (platform-dependent)
vfs.mountPointURL;             // file: URL for import()
vfs.unmount();                 // Stop intercepting
```

`mount()` returns a unique mount point inside `os.devNull/vfs/` (matching Node.js core's namespace). It takes no arguments; passing a prefix throws a `TypeError`. The mount point avoids shadowing real paths and can be addressed through `mountPointURL`. When mounted with `moduleHooks: true` (the default), this package patches selected `require()`, `import`, `fs`, and `fs.promises` entry points; see the limitations below.

Emits `vfs-mount` and `vfs-unmount` events on `process`.

Supports `Symbol.dispose` — works with `using` declarations in environments that support it.

#### `shouldHandle(path)`

Returns `true` if the given path would be handled by this VFS instance. In overlay mode, only returns `true` for paths that actually exist in the VFS.

#### Sync API

The synchronous VFS API includes:

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
vfs.rmSync(path[, options])              // { recursive, force }
vfs.truncateSync(path[, len])
vfs.ftruncateSync(fd[, len])
vfs.mkdtempSync(prefix)
```

#### File descriptors

```js
const fd = vfs.openSync(path[, flags[, mode]]);
vfs.readSync(fd, buffer, offset, length, position);
vfs.fstatSync(fd[, options]);
vfs.closeSync(fd);
```

#### Callback API

Some sync methods have callback counterparts following the standard Node.js `(err, result)` convention:

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
await vfs.promises.rm('/tree', { recursive: true });
await vfs.promises.truncate('/file.txt', 0);
const tmp = await vfs.promises.mkdtemp('/tmp-');
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
const mountPoint = vfs.mount();

vfs.chdir(`${mountPoint}/app`);
vfs.cwd(); // `${mountPoint}/app`
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
2. **Patches selected `fs` functions** — path-based reads, writes, directory mutation, `rm`, `truncate`, `mkdtemp`, `rename`, `copyFile`, symlinks and watchers, plus the sync/callback descriptor family `open`, `read`, `close`, and `fstat`. Cross-mount rename/copy returns `EXDEV`.

This covers calls made through patched `fs` properties, not every way Node.js or an addon can access the filesystem.

Module resolution supports package.json `exports`, `main`, and bare specifier resolution walking `node_modules`.

## Differences from Node.js core VFS

This is a **userland compatibility layer**, not a direct extraction of the current `node:vfs` implementation (experimental in Node.js 26). It tracks the mount namespace and some of the `fs` API, but monkey-patching cannot intercept Node's native filesystem binding, built-in loader internals, or references to `fs` methods captured before mounting. In particular:

- Core's full `fs`/`fs.promises` surface is **not provided**: descriptor writes (`fs.write`), `fs.promises.open`/`FileHandle`, write streams, `opendir`, `openAsBlob`, `link`, permission/ownership/time operations, and startup flags (`--vfs-mount`, `--vfs-load`) remain unsupported by the mounted shim. Direct VFS methods are independent of the patched `fs` surface.
- Native addon and FFI library loading from virtual bytes, SEA integration, and transparent interception of Node's internal module-resolution filesystem calls require Node core and are **not supported**. Core's `ZipProvider` and automatic ZIP loading are also **not included**; this package ships memory, real-filesystem, and SQLite providers. The userland resolver approximates CJS/ESM resolution; package edge cases can differ.
- Core invalidates both CJS and ESM module caches on unmount. This shim evicts its CJS cache entries, but cannot invalidate ESM's internal cache. Re-mounting assigns a new URL, avoiding a stale ESM cache entry.
- Overlay and virtual-cwd options are shim-only and can interact with other monkey patches. Overlay mode routes missing paths to disk, including creates; disable it when isolation matters.
- `fs` path dispatch is synchronous under the hood even for callback and promise methods. Direct provider async methods are separate; this shim does not provide core's libuv-backed concurrency guarantees. Recursive `readdir` is implemented for the memory provider without following directory symlinks; other providers may not implement it.

Use built-in `node:vfs` when running a Node version that provides it. The shim remains useful for Node 22+ and for `SqliteProvider`.

## License

MIT
