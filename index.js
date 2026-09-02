'use strict';

const { VirtualFileSystem } = require('./lib/file_system.js');
const { VirtualProvider } = require('./lib/provider.js');
const { MemoryProvider } = require('./lib/providers/memory.js');
const { RealFSProvider } = require('./lib/providers/real.js');

/**
 * Creates a new VirtualFileSystem instance.
 * @param {VirtualProvider} [provider] The provider to use (defaults to MemoryProvider)
 * @param {object} [options] Configuration options
 * @param {boolean} [options.moduleHooks] Whether to enable require/import hooks (default: true)
 * @param {boolean} [options.virtualCwd] Whether to enable virtual working directory
 * @param {boolean} [options.overlay] Whether to enable overlay mode
 * @returns {VirtualFileSystem}
 */
function create(provider, options) {
  if (provider != null &&
      !(provider instanceof VirtualProvider) &&
      typeof provider === 'object') {
    options = provider;
    provider = undefined;
  }
  return new VirtualFileSystem(provider, options);
}

module.exports = {
  create,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
};

// Lazy-load SqliteProvider so that `node:sqlite` (and its ExperimentalWarning)
// is only required when a consumer actually reads `vfs.SqliteProvider`.
Object.defineProperty(module.exports, 'SqliteProvider', {
  enumerable: true,
  configurable: true,
  get() {
    const { SqliteProvider } = require('./lib/providers/sqlite.js');
    Object.defineProperty(module.exports, 'SqliteProvider', {
      value: SqliteProvider,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return SqliteProvider;
  },
});
