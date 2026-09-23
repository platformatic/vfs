'use strict';

const { fileURLToPath } = require('node:url');

function pathString(value) {
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : null;
}

function crossDeviceError(syscall, from, to) {
  const err = new Error(`EXDEV: cross-device link not permitted, ${syscall} '${from}' -> '${to}'`);
  err.code = 'EXDEV';
  err.errno = -18;
  err.syscall = syscall;
  err.path = from;
  err.dest = to;
  return err;
}

// Only operations whose path arguments can be dispatched without a native
// libuv fd are intercepted here. Keep the originals for real paths.
function installAdditionalFsPatches(fs, findVFS) {
  function patch(name, pathIndex = 0, otherIndex = -1) {
    const syncName = `${name}Sync`;
    const originalSync = fs[syncName];
    const originalCallback = fs[name];
    const originalPromise = fs.promises[name];
    if (typeof originalSync !== 'function') return;

    function select(args) {
      const first = pathString(args[pathIndex]);
      if (first === null) return null;
      const vfs = findVFS(first);
      if (otherIndex !== -1) {
        const second = pathString(args[otherIndex]);
        const other = second === null ? null : findVFS(second);
        if (vfs !== other && (vfs || other)) {
          throw crossDeviceError(name, args[pathIndex], args[otherIndex]);
        }
      }
      return vfs;
    }

    function dispatch(vfs, args) {
      const converted = args.slice();
      converted[pathIndex] = pathString(args[pathIndex]);
      if (otherIndex !== -1) converted[otherIndex] = pathString(args[otherIndex]);
      return vfs[syncName](...converted);
    }

    fs[syncName] = function(...args) {
      const vfs = select(args);
      return vfs ? dispatch(vfs, args) : originalSync.apply(fs, args);
    };

    if (typeof originalCallback === 'function') {
      fs[name] = function(...args) {
        const callback = args[args.length - 1];
        // Let Node validate malformed callback calls itself.
        if (typeof callback !== 'function') return originalCallback.apply(fs, args);
        let vfs;
        try {
          vfs = select(args);
        } catch (err) {
          process.nextTick(callback, err);
          return;
        }
        if (!vfs) return originalCallback.apply(fs, args);
        process.nextTick(() => {
          let result;
          try {
            result = dispatch(vfs, args.slice(0, -1));
          } catch (err) {
            callback(err);
            return;
          }
          callback(null, result);
        });
      };
    }

    if (typeof originalPromise === 'function') {
      fs.promises[name] = async function(...args) {
        const vfs = select(args);
        return vfs ? dispatch(vfs, args) : originalPromise.apply(fs.promises, args);
      };
    }
  }

  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rmdir', 'unlink',
                      'rm', 'truncate', 'mkdtemp']) patch(name);
  for (const name of ['rename', 'copyFile']) patch(name, 0, 1);
  patch('symlink', 1);
}

module.exports = { installAdditionalFsPatches, pathString };
