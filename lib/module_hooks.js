'use strict';

const path = require('node:path');
const { dirname, extname, isAbsolute, resolve } = path;
const pathPosix = path.posix;
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createENOENT } = require('./errors.js');
const {
  getVirtualFd,
  closeFdSync,
  readFdSync,
  fstatFdSync,
  closeFd,
  readFd,
  fstatFd,
} = require('./fd.js');
const { installAdditionalFsPatches, pathString } = require('./fs_patches.js');

const kEmptyObject = Object.freeze(Object.create(null));
const NodeModule = require('node:module');
const builtinSet = new Set(NodeModule.builtinModules);

// Extension and index file sets for ESM vs CJS resolution.
// ESM hooks handle all module formats so they include .mjs/.cjs.
// CJS follows Node.js require() resolution order: .js, .json, .node only.
const ESM_EXTENSIONS = ['.js', '.json', '.node', '.mjs', '.cjs'];
const CJS_EXTENSIONS = ['.js', '.json', '.node'];
const ESM_INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.json'];
const CJS_INDEX_FILES = ['index.js', 'index.json', 'index.node'];
const CJS_CONDITIONS = ['require', 'node', 'default'];

function isNodeBuiltin(name) {
  if (typeof NodeModule.isBuiltin === 'function') {
    return NodeModule.isBuiltin(name);
  }
  const bare = name.startsWith('node:') ? name.slice(5) : name;
  return builtinSet.has(bare);
}

function normalizeVFSPath(inputPath) {
  // Strip sentinel V: drive used for VFS URLs on Windows
  if (process.platform === 'win32' && /^V:[/\\]/.test(inputPath)) {
    inputPath = '/' + inputPath.slice(3).replace(/\\/g, '/');
  }
  if (inputPath.startsWith('/')) {
    return pathPosix.normalize(inputPath);
  }
  return path.normalize(inputPath);
}

function linkTarget(target, options) {
  if (Buffer.isBuffer(target)) return target;
  return (typeof options === 'object' && options?.encoding === 'buffer') ||
    options === 'buffer' ? Buffer.from(target) : target;
}

function joinVFSParts(...parts) {
  if (parts[0]?.startsWith('/')) {
    return pathPosix.resolve(...parts);
  }
  return resolve(...parts);
}

function dirnameVFS(p) {
  if (p.startsWith('/')) {
    return pathPosix.dirname(p);
  }
  return dirname(p);
}

// On Windows, pathToFileURL('/vfs/path') adds a drive letter
// (e.g. file:///D:/vfs/path).  These helpers avoid that for
// VFS POSIX paths so the load hook can recover the original path.
// We use a sentinel drive letter V: so that Node's internal
// fileURLToPath (called by convertURLToCJSFilename) doesn't crash.
function vfsPathToURL(vfsPath) {
  if (vfsPath.startsWith('/') && process.platform === 'win32') {
    return 'file:///V:' + encodeURI(vfsPath);
  }
  return pathToFileURL(vfsPath).href;
}

function urlToVFSPath(url) {
  const parsed = new URL(url);
  const pathname = decodeURIComponent(parsed.pathname);
  // VFS paths use sentinel V: drive: file:///V:/node_modules/...
  // Real Windows paths use real drives: file:///C:/Users/...
  if (process.platform === 'win32' && pathname.startsWith('/V:/')) {
    return pathname.slice(3); // '/V:/foo' → '/foo'
  }
  if (process.platform === 'win32' &&
      pathname.startsWith('/') &&
      !/^\/[A-Za-z]:/.test(pathname)) {
    return pathname;
  }
  return fileURLToPath(url);
}

// Registry of active VFS instances
const activeVFSList = [];

let originalReadFileSync = null;
let originalRealpathSync = null;
let originalLstatSync = null;
let originalStatSync = null;
let originalReaddirSync = null;
let originalExistsSync = null;
let originalWatch = null;
let originalWatchFile = null;
let originalUnwatchFile = null;
let hooksInstalled = false;

function registerVFS(vfs) {
  if (activeVFSList.indexOf(vfs) === -1) {
    activeVFSList.push(vfs);
    if (!hooksInstalled) {
      installHooks();
    }
  }
}

function deregisterVFS(vfs) {
  const index = activeVFSList.indexOf(vfs);
  if (index !== -1) {
    activeVFSList.splice(index, 1);
  }
}

function findVFSForStat(filename) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      const result = vfs.internalModuleStat(normalized);
      if (vfs.mounted || result >= 0) {
        return { vfs, result };
      }
    }
  }
  return null;
}

function findVFSForRead(filename, options) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      if (vfs.existsSync(normalized)) {
        const statResult = vfs.internalModuleStat(normalized);
        if (statResult !== 0) {
          return null;
        }
        try {
          const content = vfs.readFileSync(normalized, options);
          return { vfs, content };
        } catch (e) {
          if (vfs.mounted) {
            throw e;
          }
        }
      } else if (vfs.mounted) {
        throw createENOENT('open', filename);
      }
    }
  }
  return null;
}

function findVFSForExists(filename) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      const exists = vfs.existsSync(normalized);
      if (vfs.mounted || exists) {
        return { vfs, exists };
      }
    }
  }
  return null;
}

function findVFSForRealpath(filename) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      if (vfs.existsSync(normalized)) {
        try {
          const realpath = vfs.realpathSync(normalized);
          return { vfs, realpath };
        } catch (e) {
          if (vfs.mounted) {
            throw e;
          }
        }
      } else if (vfs.mounted) {
        throw createENOENT('realpath', filename);
      }
    }
  }
  return null;
}

function statFromVFS(vfs, filename, options, lstat = false) {
  try {
    return lstat ? vfs.lstatSync(filename, options) : vfs.statSync(filename, options);
  } catch (err) {
    if (options?.throwIfNoEntry === false && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function findVFSForReaddir(dirname, options) {
  const normalized = normalizeVFSPath(dirname);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      if (vfs.existsSync(normalized)) {
        try {
          const entries = vfs.readdirSync(normalized, options);
          return { vfs, entries };
        } catch (e) {
          if (vfs.mounted) {
            throw e;
          }
        }
      } else if (vfs.mounted) {
        throw createENOENT('scandir', dirname);
      }
    }
  }
  return null;
}

// Which VFS owns this path?  Overlay mounts only claim paths they actually
// hold, so anything else falls through to the real fs.  Used by watch and by
// the fd-opening patches.
function findVFSForExistingPath(filename) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      if (vfs.overlay) {
        if (vfs.existsSync(normalized)) {
          return { vfs };
        }
        continue;
      }
      return { vfs };
    }
  }
  return null;
}

// === Module format detection ===

const VFS_FORMAT_MAP = {
  '__proto__': null,
  '.cjs': 'commonjs',
  '.js': null,
  '.json': 'json',
  '.mjs': 'module',
  '.node': 'addon',
  '.wasm': 'wasm',
};

function getVFSPackageType(vfs, filePath) {
  let currentDir = dirnameVFS(filePath);
  let lastDir;
  while (currentDir !== lastDir) {
    if (currentDir.endsWith('/node_modules') ||
        currentDir.endsWith('\\node_modules')) {
      break;
    }
    const pjsonPath = normalizeVFSPath(joinVFSParts(currentDir, 'package.json'));
    if (vfs.shouldHandle(pjsonPath) && vfs.internalModuleStat(pjsonPath) === 0) {
      try {
        const content = vfs.readFileSync(pjsonPath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed.type === 'module' || parsed.type === 'commonjs') {
          return parsed.type;
        }
        return 'none';
      } catch {
        // Invalid JSON, continue walking
      }
    }
    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }
  return 'none';
}

function getVFSFormat(vfs, filePath) {
  const ext = extname(filePath);
  if (ext === '.js') {
    return getVFSPackageType(vfs, filePath) === 'module' ? 'module' : 'commonjs';
  }
  return VFS_FORMAT_MAP[ext] ?? 'commonjs';
}

// === Resolution helpers ===

// Match a subpath against wildcard export/import keys.
// Returns { key, patternMatch } on match, or null.
function matchWildcardPattern(keys, subpath) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const starIdx = key.indexOf('*');
    if (starIdx === -1) continue;
    const prefix = key.slice(0, starIdx);
    const suffix = key.slice(starIdx + 1);
    if (subpath.startsWith(prefix) &&
        (suffix === '' || subpath.endsWith(suffix)) &&
        subpath.length >= prefix.length + suffix.length) {
      return {
        key,
        patternMatch: subpath.slice(
          prefix.length,
          suffix.length > 0 ? -suffix.length : undefined,
        ),
      };
    }
  }
  return null;
}

function expandPattern(value, patternMatch) {
  return patternMatch !== null ? value.replace(/\*/g, patternMatch) : value;
}

function findVFSForPath(normalizedPath) {
  for (let i = 0; i < activeVFSList.length; i++) {
    if (activeVFSList[i].shouldHandle(normalizedPath)) {
      return activeVFSList[i];
    }
  }
  return null;
}

function makeResolveResult(vfs, filePath) {
  return {
    url: vfsPathToURL(filePath),
    format: getVFSFormat(vfs, filePath),
    shortCircuit: true,
  };
}

function tryExtensions(vfs, basePath, extensions) {
  for (let i = 0; i < extensions.length; i++) {
    const candidate = basePath + extensions[i];
    if (vfs.internalModuleStat(candidate) === 0) {
      return candidate;
    }
  }
  return null;
}

function tryIndexFiles(vfs, dirPath, indexFiles) {
  for (let i = 0; i < indexFiles.length; i++) {
    const candidate = normalizeVFSPath(joinVFSParts(dirPath, indexFiles[i]));
    if (vfs.internalModuleStat(candidate) === 0) {
      return candidate;
    }
  }
  return null;
}

// Resolve a package.json "main" field: exact file → extensions → directory index.
// Saves the stat result to avoid double-calling internalModuleStat.
function resolveMainField(vfs, dirPath, main, extensions, indexFiles) {
  const mainPath = normalizeVFSPath(joinVFSParts(dirPath, main));
  const mainStat = vfs.internalModuleStat(mainPath);
  if (mainStat === 0) return mainPath;
  const withExt = tryExtensions(vfs, mainPath, extensions);
  if (withExt) return withExt;
  if (mainStat === 1) return tryIndexFiles(vfs, mainPath, indexFiles);
  return null;
}

// Resolve a single exports/conditions string target to a path.
// When extensions is non-null, also tries appending extensions (CJS behavior).
function resolveExportTarget(vfs, pkgDir, target, patternMatch, extensions) {
  if (typeof target !== 'string') return null;
  const expanded = expandPattern(target, patternMatch);
  const resolved = normalizeVFSPath(joinVFSParts(pkgDir, expanded));
  if (vfs.internalModuleStat(resolved) === 0) return resolved;
  return extensions ? tryExtensions(vfs, resolved, extensions) : null;
}

// Walk a conditions map (e.g. { "import": "...", "require": "...", "default": "..." })
// and return the first matching path. Handles nested condition objects recursively.
function resolveConditionsToPath(vfs, pkgDir, condMap, conditions, patternMatch, extensions) {
  const keys = Object.getOwnPropertyNames(condMap);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'default' || conditions.indexOf(key) !== -1) {
      const value = condMap[key];
      if (typeof value === 'string') {
        const result = resolveExportTarget(vfs, pkgDir, value, patternMatch, extensions);
        if (result) return result;
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = resolveConditionsToPath(vfs, pkgDir, value, conditions, patternMatch, extensions);
        if (result) return result;
        continue;
      }
    }
  }
  return null;
}

// Unified exports resolution. Returns a resolved path or null.
// ESM callers pass context.conditions and extensions=null.
// CJS callers pass CJS_CONDITIONS and extensions=CJS_EXTENSIONS.
function resolveExportsToPath(vfs, pkgDir, packageSubpath, exports, conditions, extensions) {
  if (typeof exports === 'string') {
    if (packageSubpath === '.') {
      return resolveExportTarget(vfs, pkgDir, exports, null, extensions);
    }
    return null;
  }

  if (typeof exports !== 'object' || exports === null) return null;

  const keys = Object.getOwnPropertyNames(exports);
  if (keys.length === 0) return null;

  const isConditional = keys[0] !== '' && keys[0][0] !== '.';
  if (isConditional) {
    if (packageSubpath !== '.') return null;
    return resolveConditionsToPath(vfs, pkgDir, exports, conditions, null, extensions);
  }

  let target = exports[packageSubpath];

  // Support wildcard patterns in exports (e.g. "./bindings/*")
  // See: https://nodejs.org/api/packages.html#subpath-patterns
  let patternMatch = null;
  if (target === undefined) {
    const match = matchWildcardPattern(keys, packageSubpath);
    if (match) {
      patternMatch = match.patternMatch;
      target = exports[match.key];
    }
  }
  if (target === undefined) return null;

  if (typeof target === 'string') {
    return resolveExportTarget(vfs, pkgDir, target, patternMatch, extensions);
  }

  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    return resolveConditionsToPath(vfs, pkgDir, target, conditions, patternMatch, extensions);
  }

  return null;
}

function resolveDirectoryEntry(vfs, dirPath, context) {
  const pjsonPath = normalizeVFSPath(joinVFSParts(dirPath, 'package.json'));
  if (vfs.internalModuleStat(pjsonPath) === 0) {
    try {
      const content = vfs.readFileSync(pjsonPath, 'utf8');
      const parsed = JSON.parse(content);

      if (parsed.exports != null) {
        const resolved = resolveExportsToPath(
          vfs, dirPath, '.', parsed.exports, context.conditions || [], null);
        if (resolved) return makeResolveResult(vfs, resolved);
      }

      if (parsed.main) {
        const mainResult = resolveMainField(
          vfs, dirPath, parsed.main, ESM_EXTENSIONS, ESM_INDEX_FILES);
        if (mainResult) return makeResolveResult(vfs, mainResult);
      }
    } catch {
      // Invalid package.json
    }
  }
  const indexResult = tryIndexFiles(vfs, dirPath, ESM_INDEX_FILES);
  return indexResult ? makeResolveResult(vfs, indexResult) : null;
}

function parsePackageName(specifier) {
  let separatorIndex = specifier.indexOf('/');
  if (specifier[0] === '@') {
    if (separatorIndex === -1) {
      return { packageName: specifier, packageSubpath: '.' };
    }
    separatorIndex = specifier.indexOf('/', separatorIndex + 1);
  }
  const packageName = separatorIndex === -1 ?
    specifier : specifier.slice(0, separatorIndex);
  let packageSubpath = separatorIndex === -1 ?
    '.' : '.' + specifier.slice(separatorIndex);
  // Normalize './' to '.' so require('process/') resolves the entry point
  if (packageSubpath === './') packageSubpath = '.';
  return { packageName, packageSubpath };
}

function urlToPath(urlOrPath) {
  if (urlOrPath.startsWith('file:')) {
    return fileURLToPath(urlOrPath);
  }
  return urlOrPath;
}

function resolveVFSPath(checkPath, context, nextResolve, specifier) {
  const normalized = normalizeVFSPath(checkPath);

  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (!vfs.shouldHandle(normalized)) continue;

    const stat = vfs.internalModuleStat(normalized);

    // Exact file match
    if (stat === 0) {
      return makeResolveResult(vfs, normalized);
    }

    // Try extensions BEFORE directory resolution to match Node.js CJS
    // resolution order: file.js > file.json > dir/package.json#main > dir/index.js
    // This handles cases like require('./schema') where both schema.js
    // and schema/ directory exist — the file should win.
    const withExt = tryExtensions(vfs, normalized, ESM_EXTENSIONS);
    if (withExt) return makeResolveResult(vfs, withExt);

    if (stat === 1) {
      const resolved = resolveDirectoryEntry(vfs, normalized, context);
      if (resolved) return resolved;
    }
  }

  return nextResolve(specifier, context);
}

function resolvePackageInVFS(vfs, startDir, packageName, packageSubpath, context) {
  let currentDir = startDir;
  let lastDir;
  const conditions = context.conditions || [];

  while (currentDir !== lastDir) {
    const pkgDir = normalizeVFSPath(
      joinVFSParts(currentDir, 'node_modules', packageName));

    if (vfs.shouldHandle(pkgDir) &&
        vfs.internalModuleStat(pkgDir) === 1) {
      // Read package.json once and reuse for exports + main resolution
      const pjsonPath = normalizeVFSPath(
        joinVFSParts(pkgDir, 'package.json'));
      if (vfs.internalModuleStat(pjsonPath) === 0) {
        try {
          const parsed = JSON.parse(vfs.readFileSync(pjsonPath, 'utf8'));

          if (parsed.exports != null) {
            const resolved = resolveExportsToPath(
              vfs, pkgDir, packageSubpath, parsed.exports, conditions, null);
            if (resolved) return makeResolveResult(vfs, resolved);
          }

          if (packageSubpath === '.') {
            if (parsed.main) {
              const mainResult = resolveMainField(
                vfs, pkgDir, parsed.main, ESM_EXTENSIONS, ESM_INDEX_FILES);
              if (mainResult) return makeResolveResult(vfs, mainResult);
            }
            const indexResult = tryIndexFiles(vfs, pkgDir, ESM_INDEX_FILES);
            if (indexResult) return makeResolveResult(vfs, indexResult);
          } else {
            const subResolved = normalizeVFSPath(
              joinVFSParts(pkgDir, packageSubpath));
            if (vfs.internalModuleStat(subResolved) === 0) {
              return makeResolveResult(vfs, subResolved);
            }
            const withExt = tryExtensions(vfs, subResolved, ESM_EXTENSIONS);
            if (withExt) return makeResolveResult(vfs, withExt);
          }
        } catch {
          // Invalid package.json, continue walking
        }
      }
    }

    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }

  return null;
}

function resolveCJSPackageInVFS(vfs, startDir, packageName, packageSubpath) {
  let currentDir = startDir;
  let lastDir;

  while (currentDir !== lastDir) {
    const pkgDir = normalizeVFSPath(
      joinVFSParts(currentDir, 'node_modules', packageName));
    if (vfs.shouldHandle(pkgDir) &&
        vfs.internalModuleStat(pkgDir) === 1) {

      // Read package.json once and reuse for exports + main resolution
      const pjsonPath = normalizeVFSPath(
        joinVFSParts(pkgDir, 'package.json'));
      let parsed = null;
      if (vfs.internalModuleStat(pjsonPath) === 0) {
        try {
          parsed = JSON.parse(vfs.readFileSync(pjsonPath, 'utf8'));
        } catch { /* ignore */ }
      }

      // Try exports field first (supports wildcards and conditions)
      if (parsed?.exports != null) {
        const exportsResult = resolveExportsToPath(
          vfs, pkgDir, packageSubpath, parsed.exports,
          CJS_CONDITIONS, CJS_EXTENSIONS);
        if (exportsResult) return exportsResult;
      }

      if (packageSubpath === '.') {
        if (parsed?.main) {
          const mainResult = resolveMainField(
            vfs, pkgDir, parsed.main, CJS_EXTENSIONS, CJS_INDEX_FILES);
          if (mainResult) return mainResult;
        }
        const idxResult = tryIndexFiles(vfs, pkgDir, CJS_INDEX_FILES);
        if (idxResult) return idxResult;
      } else {
        const subResolved = normalizeVFSPath(
          joinVFSParts(pkgDir, packageSubpath));
        const subStat = vfs.internalModuleStat(subResolved);
        if (subStat === 0) {
          return subResolved;
        }
        const withExt = tryExtensions(vfs, subResolved, CJS_EXTENSIONS);
        if (withExt) return withExt;
        // Subpath resolves to a directory — try package.json main, then index files
        if (subStat === 1) {
          const subPjsonPath = normalizeVFSPath(
            joinVFSParts(subResolved, 'package.json'));
          if (vfs.internalModuleStat(subPjsonPath) === 0) {
            try {
              const subParsed = JSON.parse(vfs.readFileSync(subPjsonPath, 'utf8'));
              if (subParsed.main) {
                const mainResult = resolveMainField(
                  vfs, subResolved, subParsed.main,
                  CJS_EXTENSIONS, CJS_INDEX_FILES);
                if (mainResult) return mainResult;
              }
            } catch { /* ignore */ }
          }
          const subIdx = tryIndexFiles(vfs, subResolved, CJS_INDEX_FILES);
          if (subIdx) return subIdx;
        }
      }
    }
    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }

  return null;
}

// === Hash imports (#imports) ===

// Resolve a single import target string for ESM.
// Handles both relative paths and bare specifier re-resolution.
function resolveImportTarget(vfs, baseDir, value, patternMatch, context, nextResolve) {
  const expanded = expandPattern(value, patternMatch);
  if (!expanded.startsWith('.') && !expanded.startsWith('/')) {
    return resolveBareSpecifier(expanded, context, nextResolve);
  }
  const resolved = normalizeVFSPath(joinVFSParts(baseDir, expanded));
  if (vfs.internalModuleStat(resolved) === 0) {
    return makeResolveResult(vfs, resolved);
  }
  return null;
}

// Resolve conditions in an imports field for ESM. Properly recursive
// to handle nested condition objects (e.g. { "node": { "require": "..." } }).
function resolveImportConditions(vfs, baseDir, condMap, conditions, patternMatch, context, nextResolve) {
  const keys = Object.getOwnPropertyNames(condMap);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'default' || conditions.indexOf(key) !== -1) {
      const value = condMap[key];
      if (typeof value === 'string') {
        const result = resolveImportTarget(vfs, baseDir, value, patternMatch, context, nextResolve);
        if (result) return result;
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = resolveImportConditions(vfs, baseDir, value, conditions, patternMatch, context, nextResolve);
        if (result) return result;
        continue;
      }
    }
  }
  return null;
}

function resolveHashImport(specifier, context, nextResolve) {
  if (!context.parentURL) {
    return nextResolve(specifier, context);
  }

  let parentPath;
  try {
    parentPath = urlToPath(context.parentURL);
  } catch {
    return nextResolve(specifier, context);
  }

  const parentNorm = normalizeVFSPath(parentPath);
  const parentVfs = findVFSForPath(parentNorm);
  if (!parentVfs) {
    return nextResolve(specifier, context);
  }

  // Walk up from parent to find nearest package.json with imports field
  const conditions = context.conditions || [];
  let currentDir = dirnameVFS(parentNorm);
  let lastDir;
  while (currentDir !== lastDir) {
    const pjsonPath = normalizeVFSPath(
      joinVFSParts(currentDir, 'package.json'));
    if (parentVfs.shouldHandle(pjsonPath) &&
        parentVfs.internalModuleStat(pjsonPath) === 0) {
      try {
        const parsed = JSON.parse(parentVfs.readFileSync(pjsonPath, 'utf8'));
        if (parsed.imports) {
          let target = parsed.imports[specifier];
          let patternMatch = null;

          // Support wildcard patterns in imports
          if (target === undefined) {
            const impKeys = Object.getOwnPropertyNames(parsed.imports);
            const match = matchWildcardPattern(impKeys, specifier);
            if (match) {
              patternMatch = match.patternMatch;
              target = parsed.imports[match.key];
            }
          }

          if (target !== undefined) {
            if (typeof target === 'string') {
              const result = resolveImportTarget(
                parentVfs, currentDir, target, patternMatch,
                context, nextResolve);
              if (result) return result;
            }
            if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
              const result = resolveImportConditions(
                parentVfs, currentDir, target, conditions, patternMatch,
                context, nextResolve);
              if (result) return result;
            }
          }
          break; // Found a package.json with imports — stop walking up
        }
      } catch { /* ignore invalid JSON */ }
    }
    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }

  return nextResolve(specifier, context);
}

// Resolve a single import target string for CJS.
// startDir is the parent file's directory (for node_modules walking).
// baseDir is the package.json directory (for relative path resolution).
function resolveCJSImportTarget(vfs, startDir, baseDir, value, patternMatch) {
  const expanded = expandPattern(value, patternMatch);
  if (!expanded.startsWith('.') && !expanded.startsWith('/')) {
    const { packageName, packageSubpath } = parsePackageName(expanded);
    return resolveCJSPackageInVFS(vfs, startDir, packageName, packageSubpath);
  }
  const resolved = normalizeVFSPath(joinVFSParts(baseDir, expanded));
  if (vfs.internalModuleStat(resolved) === 0) return resolved;
  return tryExtensions(vfs, resolved, CJS_EXTENSIONS);
}

// Resolve conditions in an imports field for CJS. Properly recursive.
function resolveCJSImportConditions(vfs, startDir, baseDir, condMap, patternMatch) {
  const keys = Object.getOwnPropertyNames(condMap);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'default' || CJS_CONDITIONS.indexOf(key) !== -1) {
      const value = condMap[key];
      if (typeof value === 'string') {
        const result = resolveCJSImportTarget(vfs, startDir, baseDir, value, patternMatch);
        if (result) return result;
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = resolveCJSImportConditions(vfs, startDir, baseDir, value, patternMatch);
        if (result) return result;
        continue;
      }
    }
  }
  return null;
}

function resolveCJSHashImport(specifier, parentDir) {
  const parentNorm = normalizeVFSPath(parentDir);
  const parentVfs = findVFSForPath(parentNorm);
  if (!parentVfs) return null;

  let currentDir = parentNorm;
  let lastDir;
  while (currentDir !== lastDir) {
    const pjsonPath = normalizeVFSPath(
      joinVFSParts(currentDir, 'package.json'));
    if (parentVfs.shouldHandle(pjsonPath) &&
        parentVfs.internalModuleStat(pjsonPath) === 0) {
      try {
        const parsed = JSON.parse(parentVfs.readFileSync(pjsonPath, 'utf8'));
        if (parsed.imports) {
          let target = parsed.imports[specifier];
          let patternMatch = null;

          if (target === undefined) {
            const impKeys = Object.getOwnPropertyNames(parsed.imports);
            const match = matchWildcardPattern(impKeys, specifier);
            if (match) {
              patternMatch = match.patternMatch;
              target = parsed.imports[match.key];
            }
          }

          if (target !== undefined) {
            if (typeof target === 'string') {
              return resolveCJSImportTarget(
                parentVfs, parentNorm, currentDir, target, patternMatch);
            }
            if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
              return resolveCJSImportConditions(
                parentVfs, parentNorm, currentDir, target, patternMatch);
            }
          }
          break;
        }
      } catch { /* ignore */ }
    }
    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }
  return null;
}

// === Bare specifier resolution ===

function resolveBareSpecifier(specifier, context, nextResolve) {
  if (isNodeBuiltin(specifier)) {
    return nextResolve(specifier, context);
  }

  if (specifier[0] === '#') {
    return resolveHashImport(specifier, context, nextResolve);
  }

  if (!context.parentURL) {
    return nextResolve(specifier, context);
  }

  let parentPath;
  try {
    parentPath = urlToPath(context.parentURL);
  } catch {
    return nextResolve(specifier, context);
  }

  const parentNorm = normalizeVFSPath(parentPath);
  const parentVfs = findVFSForPath(parentNorm);

  const { packageName, packageSubpath } = parsePackageName(specifier);

  if (parentVfs) {
    const result = resolvePackageInVFS(
      parentVfs, dirnameVFS(parentNorm),
      packageName, packageSubpath, context);
    if (result) return result;
  } else {
    // Parent file is outside all VFS mount points (e.g. Windows
    // paths when the VFS is mounted at '/').  Try resolving from
    // each active VFS's mount point root.
    for (let i = 0; i < activeVFSList.length; i++) {
      const vfs = activeVFSList[i];
      const mp = vfs.mountPoint;
      if (!mp) continue;
      const result = resolvePackageInVFS(
        vfs, mp, packageName, packageSubpath, context);
      if (result) return result;
    }
  }

  return nextResolve(specifier, context);
}

// === Hooks ===

function vfsResolveHook(specifier, context, nextResolve) {
  if (isNodeBuiltin(specifier)) {
    return nextResolve(specifier, context);
  }

  let checkPath;
  if (specifier.startsWith('file:')) {
    checkPath = urlToVFSPath(specifier);
  } else if (isAbsolute(specifier)) {
    checkPath = specifier;
  } else if (specifier[0] === '.') {
    if (context.parentURL) {
      const parentPath = urlToPath(context.parentURL);
      const parentDir = dirname(parentPath);
      checkPath = resolve(parentDir, specifier);
    } else {
      return nextResolve(specifier, context);
    }
  } else {
    return resolveBareSpecifier(specifier, context, nextResolve);
  }

  return resolveVFSPath(checkPath, context, nextResolve, specifier);
}

function vfsLoadHook(url, context, nextLoad) {
  if (url.startsWith('node:')) {
    return nextLoad(url, context);
  }

  if (!url.startsWith('file:')) {
    return nextLoad(url, context);
  }

  const filePath = urlToVFSPath(url);
  const normalized = normalizeVFSPath(filePath);

  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized) && vfs.existsSync(normalized)) {
      const statResult = vfs.internalModuleStat(normalized);
      if (statResult !== 0) {
        return nextLoad(url, context);
      }
      try {
        const content = vfs.readFileSync(normalized, 'utf8');
        const format = context.format || getVFSFormat(vfs, normalized);
        return {
          format,
          source: content,
          shortCircuit: true,
        };
      } catch (e) {
        if (vfs.mounted) {
          throw e;
        }
      }
    }
  }

  return nextLoad(url, context);
}

function installModuleHooks() {
  // Use Module.registerHooks if available (Node.js 23.5+) for ESM support.
  // Note: registerHooks does NOT intercept require.resolve() in Node.js 22,
  // so we always install the _resolveFilename patch below as well.
  // When both are active, require() calls resolve through both paths —
  // _resolveFilename runs first, then registerHooks' resolve hook sees the
  // already-resolved path and short-circuits (stat === 0). The overhead is
  // minimal since VFS stat checks are in-memory.
  if (typeof NodeModule.registerHooks === 'function') {
    NodeModule.registerHooks({
      resolve: vfsResolveHook,
      load: vfsLoadHook,
    });
  }

  // Always patch Module._resolveFilename for CJS require.resolve() support
  const origResolveFilename = NodeModule._resolveFilename;
  NodeModule._resolveFilename = function(request, parent, isMain, options) {
    if (request.startsWith('node:')) {
      return origResolveFilename.call(this, request, parent, isMain, options);
    }

    let checkPath;
    if (isAbsolute(request)) {
      checkPath = request;
    } else if (request[0] === '.') {
      if (parent?.filename) {
        checkPath = resolve(dirname(parent.filename), request);
      }
    }

    if (checkPath) {
      const normalized = normalizeVFSPath(checkPath);
      for (let i = 0; i < activeVFSList.length; i++) {
        const vfs = activeVFSList[i];
        if (!vfs.shouldHandle(normalized)) continue;

        const stat = vfs.internalModuleStat(normalized);
        if (stat === 0) return normalized;

        // Try extensions BEFORE directory resolution to match Node.js
        // resolution order: file.js > file.json > dir/package.json#main > dir/index.js
        const withExt = tryExtensions(vfs, normalized, CJS_EXTENSIONS);
        if (withExt) return withExt;

        if (stat === 1) {
          // Try package.json main / index files
          const pjsonPath = normalizeVFSPath(resolve(normalized, 'package.json'));
          if (vfs.internalModuleStat(pjsonPath) === 0) {
            try {
              const parsed = JSON.parse(vfs.readFileSync(pjsonPath, 'utf8'));
              if (parsed.main) {
                const mainResult = resolveMainField(
                  vfs, normalized, parsed.main,
                  CJS_EXTENSIONS, CJS_INDEX_FILES);
                if (mainResult) return mainResult;
              }
            } catch {
              // ignore
            }
          }
          const idxResult = tryIndexFiles(vfs, normalized, CJS_INDEX_FILES);
          if (idxResult) return idxResult;
        }
      }
    }

    // Handle #imports for CJS
    if (request[0] === '#') {
      const parentDir = parent?.filename ? dirname(parent.filename) : process.cwd();
      const found = resolveCJSHashImport(request, parentDir);
      if (found) return found;
    }

    // Bare specifier - walk node_modules
    if (!isAbsolute(request) && request[0] !== '.' && request[0] !== '#' && !isNodeBuiltin(request)) {
      const parentDir = parent?.filename ? dirname(parent.filename) : process.cwd();
      const parentNorm = normalizeVFSPath(parentDir);
      const { packageName, packageSubpath } = parsePackageName(request);
      let matched = false;

      for (let i = 0; i < activeVFSList.length; i++) {
        const vfs = activeVFSList[i];
        if (!vfs.shouldHandle(parentNorm)) continue;
        matched = true;

        const found = resolveCJSPackageInVFS(
          vfs, parentNorm, packageName, packageSubpath);
        if (found) return found;
      }

      // Parent file is outside all VFS mount points (e.g. Windows
      // paths when the VFS is mounted at '/').  Try resolving from
      // each active VFS's mount point root.
      if (!matched) {
        for (let i = 0; i < activeVFSList.length; i++) {
          const vfs = activeVFSList[i];
          const mp = vfs.mountPoint;
          if (!mp) continue;
          const found = resolveCJSPackageInVFS(
            vfs, mp, packageName, packageSubpath);
          if (found) return found;
        }
      }
    }

    return origResolveFilename.call(this, request, parent, isMain, options);
  };

  // Patch Module._extensions to read from VFS
  const origJsHandler = NodeModule._extensions['.js'];
  NodeModule._extensions['.js'] = function(module, filename) {
    const normalized = normalizeVFSPath(filename);
    for (let i = 0; i < activeVFSList.length; i++) {
      const vfs = activeVFSList[i];
      if (vfs.shouldHandle(normalized) && vfs.existsSync(normalized)) {
        const content = vfs.readFileSync(normalized, 'utf8');
        module._compile(content, filename);
        return;
      }
    }
    return origJsHandler.call(this, module, filename);
  };

  const origJsonHandler = NodeModule._extensions['.json'];
  NodeModule._extensions['.json'] = function(module, filename) {
    const normalized = normalizeVFSPath(filename);
    for (let i = 0; i < activeVFSList.length; i++) {
      const vfs = activeVFSList[i];
      if (vfs.shouldHandle(normalized) && vfs.existsSync(normalized)) {
        const content = vfs.readFileSync(normalized, 'utf8');
        module.exports = JSON.parse(content);
        return;
      }
    }
    return origJsonHandler.call(this, module, filename);
  };
}

function installFsPatches() {
  const fs = require('node:fs');

  originalReadFileSync = fs.readFileSync;
  originalRealpathSync = fs.realpathSync;
  originalLstatSync = fs.lstatSync;
  originalStatSync = fs.statSync;

  fs.readFileSync = function readFileSync(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForRead(path, options);
      if (vfsResult !== null) {
        return vfsResult.content;
      }
    }
    return originalReadFileSync.call(fs, path, options);
  };

  fs.realpathSync = function realpathSync(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForRealpath(path);
      if (vfsResult !== null) {
        return vfsResult.realpath;
      }
    }
    return originalRealpathSync.call(fs, path, options);
  };
  if (originalRealpathSync.native) {
    fs.realpathSync.native = originalRealpathSync.native;
  }

  fs.lstatSync = function lstatSync(path, options) {
    const name = pathString(path);
    const vfs = name === null ? null : findVFSForPath(normalizeVFSPath(name));
    return vfs ? statFromVFS(vfs, name, options, true) : originalLstatSync.call(fs, path, options);
  };

  fs.statSync = function statSync(path, options) {
    const name = pathString(path);
    const vfs = name === null ? null : findVFSForPath(normalizeVFSPath(name));
    return vfs ? statFromVFS(vfs, name, options) : originalStatSync.call(fs, path, options);
  };

  originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function readdirSync(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForReaddir(path, options);
      if (vfsResult !== null) {
        return vfsResult.entries;
      }
    }
    return originalReaddirSync.call(fs, path, options);
  };

  originalExistsSync = fs.existsSync;
  fs.existsSync = function existsSync(path) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForExists(path);
      if (vfsResult !== null) {
        return vfsResult.exists;
      }
    }
    return originalExistsSync.call(fs, path);
  };

  // readlink must not follow the link (including dangling links).
  const originalReadlinkSync = fs.readlinkSync;
  fs.readlinkSync = function readlinkSync(path, options) {
    const name = pathString(path);
    const vfs = name === null ? null : findVFSForPath(normalizeVFSPath(name));
    if (vfs) return linkTarget(vfs.readlinkSync(name, options), options);
    return originalReadlinkSync.call(fs, path, options);
  };

  // --- Async callback patches (fs.access, fs.accessSync) ---

  const originalAccessSync = fs.accessSync;
  fs.accessSync = function accessSync(path, mode) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForExists(path);
      if (vfsResult !== null) {
        if (!vfsResult.exists) {
          throw createENOENT('access', path);
        }
        return;
      }
    }
    return originalAccessSync.call(fs, path, mode);
  };

  const originalAccess = fs.access;
  fs.access = function access(path, mode, callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = fs.constants.F_OK;
    }
    if (typeof path === 'string') {
      const vfsResult = findVFSForExists(path);
      if (vfsResult !== null) {
        const err = vfsResult.exists ? null : createENOENT('access', path);
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalAccess.call(fs, path, mode, callback);
  };

  // --- Callback patches for fs.stat, fs.lstat, fs.readFile, fs.createReadStream ---

  const originalStat = fs.stat;
  fs.stat = function stat(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfs = findVFSForPath(normalizeVFSPath(path));
        if (vfs) {
          process.nextTick(() => {
            let stats;
            try { stats = statFromVFS(vfs, path, options); } catch (err) { callback(err); return; }
            callback(null, stats);
          });
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalStat.call(fs, path, options, callback);
  };

  const originalLstat = fs.lstat;
  fs.lstat = function lstat(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfs = findVFSForPath(normalizeVFSPath(path));
        if (vfs) {
          process.nextTick(() => {
            let stats;
            try { stats = statFromVFS(vfs, path, options, true); } catch (err) { callback(err); return; }
            callback(null, stats);
          });
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalLstat.call(fs, path, options, callback);
  };

  const originalReadFile = fs.readFile;
  fs.readFile = function readFile(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfsResult = findVFSForRead(path, options);
        if (vfsResult !== null) {
          if (callback) process.nextTick(callback, null, vfsResult.content);
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalReadFile.call(fs, path, options, callback);
  };

  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function createReadStream(path, options) {
    if (typeof path === 'string') {
      try {
        const vfsResult = findVFSForRead(path, options);
        if (vfsResult !== null) {
          const { Readable } = require('node:stream');
          const stream = new Readable({ read() {} });
          stream.push(vfsResult.content);
          stream.push(null);
          return stream;
        }
      } catch (err) {
        const { Readable } = require('node:stream');
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.destroy(err));
        return stream;
      }
    }
    return originalCreateReadStream.call(fs, path, options);
  };

  const originalReaddir = fs.readdir;
  fs.readdir = function readdir(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfsResult = findVFSForReaddir(path, options);
        if (vfsResult !== null) {
          if (callback) process.nextTick(callback, null, vfsResult.entries);
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalReaddir.call(fs, path, options, callback);
  };

  const originalReadlink = fs.readlink;
  fs.readlink = function readlink(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfs = findVFSForPath(normalizeVFSPath(path));
        if (vfs) {
          process.nextTick(() => {
            let target;
            try {
              target = linkTarget(vfs.readlinkSync(path, options), options);
            } catch (err) {
              callback(err);
              return;
            }
            callback(null, target);
          });
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalReadlink.call(fs, path, options, callback);
  };

  const originalRealpath = fs.realpath;
  fs.realpath = function realpath(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof path === 'string') {
      try {
        const vfsResult = findVFSForRealpath(path);
        if (vfsResult !== null) {
          if (callback) process.nextTick(callback, null, vfsResult.realpath);
          return;
        }
      } catch (err) {
        if (callback) process.nextTick(callback, err);
        return;
      }
    }
    return originalRealpath.call(fs, path, options, callback);
  };
  if (originalRealpath.native) {
    fs.realpath.native = originalRealpath.native;
  }

  // --- fs.promises patches ---
  // Patched directly on the shared object so require('fs/promises') also
  // picks up the changes (it returns the same reference as fs.promises).
  // Fixes: https://github.com/platformatic/vfs/issues/8

  const origPAccess = fs.promises.access;
  fs.promises.access = async function access(path, mode) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForExists(path);
      if (vfsResult !== null) {
        if (!vfsResult.exists) {
          throw createENOENT('access', path);
        }
        return;
      }
    }
    return origPAccess.call(fs.promises, path, mode);
  };

  const origPReadFile = fs.promises.readFile;
  fs.promises.readFile = async function readFile(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForRead(path, options);
      if (vfsResult !== null) {
        return vfsResult.content;
      }
    }
    return origPReadFile.call(fs.promises, path, options);
  };

  const origPStat = fs.promises.stat;
  fs.promises.stat = async function stat(path, options) {
    if (typeof path === 'string') {
      const vfs = findVFSForPath(normalizeVFSPath(path));
      if (vfs) return statFromVFS(vfs, path, options);
    }
    return origPStat.call(fs.promises, path, options);
  };

  const origPLstat = fs.promises.lstat;
  fs.promises.lstat = async function lstat(path, options) {
    if (typeof path === 'string') {
      const vfs = findVFSForPath(normalizeVFSPath(path));
      if (vfs) return statFromVFS(vfs, path, options, true);
    }
    return origPLstat.call(fs.promises, path, options);
  };

  const origPReaddir = fs.promises.readdir;
  fs.promises.readdir = async function readdir(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForReaddir(path, options);
      if (vfsResult !== null) {
        return vfsResult.entries;
      }
    }
    return origPReaddir.call(fs.promises, path, options);
  };

  const origPReadlink = fs.promises.readlink;
  fs.promises.readlink = async function readlink(path, options) {
    if (typeof path === 'string') {
      const vfs = findVFSForPath(normalizeVFSPath(path));
      if (vfs) return linkTarget(vfs.readlinkSync(path, options), options);
    }
    return origPReadlink.call(fs.promises, path, options);
  };

  const origPRealpath = fs.promises.realpath;
  fs.promises.realpath = async function realpath(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForRealpath(path);
      if (vfsResult !== null) {
        return vfsResult.realpath;
      }
    }
    return origPRealpath.call(fs.promises, path, options);
  };

  originalWatch = fs.watch;
  fs.watch = function watch(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = kEmptyObject;
    } else options ??= kEmptyObject;

    if (typeof filename === 'string') {
      const vfsResult = findVFSForExistingPath(filename);
      if (vfsResult !== null) {
        return vfsResult.vfs.watch(filename, options, listener);
      }
    }
    return originalWatch.call(fs, filename, options, listener);
  };

  const originalPromisesWatch = fs.promises.watch;
  if (typeof originalPromisesWatch === 'function') {
    fs.promises.watch = function watch(filename, options) {
      const name = pathString(filename);
      const vfs = name === null ? null : findVFSForPath(normalizeVFSPath(name));
      if (vfs) return vfs.promises.watch(name, options);
      return originalPromisesWatch.call(fs.promises, filename, options);
    };
  }

  originalWatchFile = fs.watchFile;
  fs.watchFile = function watchFile(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = kEmptyObject;
    } else options ??= kEmptyObject;

    if (typeof filename === 'string') {
      const vfsResult = findVFSForExistingPath(filename);
      if (vfsResult !== null) {
        return vfsResult.vfs.watchFile(filename, options, listener);
      }
    }
    return originalWatchFile.call(fs, filename, options, listener);
  };

  installAdditionalFsPatches(fs, (name) => findVFSForPath(normalizeVFSPath(name)));

  originalUnwatchFile = fs.unwatchFile;
  fs.unwatchFile = function unwatchFile(filename, listener) {
    if (typeof filename === 'string') {
      const vfsResult = findVFSForExistingPath(filename);
      if (vfsResult !== null) {
        vfsResult.vfs.unwatchFile(filename, listener);
        return;
      }
    }
    return originalUnwatchFile.call(fs, filename, listener);
  };

  // === File descriptor family ===
  //
  // openSync/open resolve a path to a VFS; the rest route on the fd itself,
  // which fd.js allocates from 10000+ so it can never shadow a real one.

  const originalOpenSync = fs.openSync;
  fs.openSync = function openSync(path, flags, mode) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForExistingPath(path);
      if (vfsResult !== null) {
        return vfsResult.vfs.openSync(path, flags ?? 'r', mode);
      }
    }
    return originalOpenSync.call(fs, path, flags, mode);
  };

  const originalOpen = fs.open;
  fs.open = function open(path, flags, mode, callback) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForExistingPath(path);
      if (vfsResult !== null) {
        return vfsResult.vfs.open(path, flags, mode, callback);
      }
    }
    return originalOpen.call(fs, path, flags, mode, callback);
  };

  const originalCloseSync = fs.closeSync;
  fs.closeSync = function closeSync(fd) {
    if (getVirtualFd(fd)) {
      return closeFdSync(fd);
    }
    return originalCloseSync.call(fs, fd);
  };

  const originalClose = fs.close;
  fs.close = function close(fd, callback) {
    if (getVirtualFd(fd)) {
      return closeFd(fd, callback);
    }
    return originalClose.call(fs, fd, callback);
  };

  const originalReadSync = fs.readSync;
  fs.readSync = function readSync(fd, buffer, offset, length, position) {
    if (getVirtualFd(fd)) {
      return readFdSync(fd, buffer, offset, length, position);
    }
    return originalReadSync.call(fs, fd, buffer, offset, length, position);
  };

  const originalRead = fs.read;
  fs.read = function read(fd, buffer, offset, length, position, callback) {
    if (getVirtualFd(fd)) {
      return readFd(fd, buffer, offset, length, position, callback);
    }
    return originalRead.call(fs, fd, buffer, offset, length, position, callback);
  };

  const originalFstatSync = fs.fstatSync;
  fs.fstatSync = function fstatSync(fd, options) {
    if (getVirtualFd(fd)) {
      return fstatFdSync(fd, options);
    }
    return originalFstatSync.call(fs, fd, options);
  };

  const originalFstat = fs.fstat;
  fs.fstat = function fstat(fd, options, callback) {
    if (getVirtualFd(fd)) {
      return fstatFd(fd, options, callback);
    }
    return originalFstat.call(fs, fd, options, callback);
  };
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }

  installModuleHooks();
  installFsPatches();

  hooksInstalled = true;
}

module.exports = {
  registerVFS,
  deregisterVFS,
  findVFSForStat,
  findVFSForRead,
};
