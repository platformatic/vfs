'use strict';

const path = require('node:path');
const { dirname, extname, isAbsolute, resolve } = path;
const pathPosix = path.posix;
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createENOENT } = require('./errors.js');

const kEmptyObject = Object.freeze(Object.create(null));
const NodeModule = require('node:module');
const builtinSet = new Set(NodeModule.builtinModules);

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

function findVFSForFsStat(filename) {
  const normalized = normalizeVFSPath(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      if (vfs.existsSync(normalized)) {
        try {
          const stats = vfs.statSync(normalized);
          return { vfs, stats };
        } catch (e) {
          if (vfs.mounted) {
            throw e;
          }
        }
      } else if (vfs.mounted) {
        throw createENOENT('stat', filename);
      }
    }
  }
  return null;
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

function findVFSForWatch(filename) {
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
  let currentDir = dirname(filePath);
  let lastDir;
  while (currentDir !== lastDir) {
    if (currentDir.endsWith('/node_modules') ||
        currentDir.endsWith('\\node_modules')) {
      break;
    }
    const pjsonPath = normalizeVFSPath(resolve(currentDir, 'package.json'));
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
    currentDir = dirname(currentDir);
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

// CJS index files follow Node.js require() resolution order.
// ESM index files (in tryIndexFiles) additionally include .mjs/.cjs
// because ESM hooks handle all module formats.
const CJS_INDEX_FILES = ['index.js', 'index.json', 'index.node'];

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

function makeResolveResult(vfs, filePath) {
  return {
    url: vfsPathToURL(filePath),
    format: getVFSFormat(vfs, filePath),
    shortCircuit: true,
  };
}

function tryExtensions(vfs, basePath) {
  const extensions = ['.js', '.json', '.node', '.mjs', '.cjs'];
  for (let i = 0; i < extensions.length; i++) {
    const candidate = basePath + extensions[i];
    if (vfs.internalModuleStat(candidate) === 0) {
      return candidate;
    }
  }
  return null;
}

function tryIndexFiles(vfs, dirPath) {
  const indexFiles = ['index.js', 'index.mjs', 'index.cjs', 'index.json'];
  for (let i = 0; i < indexFiles.length; i++) {
    const candidate = normalizeVFSPath(resolve(dirPath, indexFiles[i]));
    if (vfs.internalModuleStat(candidate) === 0) {
      return makeResolveResult(vfs, candidate);
    }
  }
  return null;
}

function tryCJSIndexFiles(vfs, dirPath) {
  for (let i = 0; i < CJS_INDEX_FILES.length; i++) {
    const candidate = normalizeVFSPath(
      joinVFSParts(dirPath, CJS_INDEX_FILES[i]));
    if (vfs.internalModuleStat(candidate) === 0) {
      return candidate;
    }
  }
  return null;
}

function resolveConditions(vfs, pkgDir, condMap, conditions) {
  return resolveConditionsWithPattern(vfs, pkgDir, condMap, conditions, null);
}

function resolveConditionsWithPattern(vfs, pkgDir, condMap, conditions, patternMatch) {
  const keys = Object.getOwnPropertyNames(condMap);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'default' || conditions.indexOf(key) !== -1) {
      const value = condMap[key];
      if (typeof value === 'string') {
        const expanded = patternMatch !== null ? value.replace(/\*/g, patternMatch) : value;
        const resolved = normalizeVFSPath(resolve(pkgDir, expanded));
        if (vfs.internalModuleStat(resolved) === 0) {
          return makeResolveResult(vfs, resolved);
        }
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = resolveConditionsWithPattern(vfs, pkgDir, value, conditions, patternMatch);
        if (result) return result;
        continue;
      }
    }
  }
  return null;
}

function resolvePackageExports(vfs, pkgDir, packageSubpath, exports, context) {
  const conditions = context.conditions || [];

  if (typeof exports === 'string') {
    if (packageSubpath === '.') {
      const resolved = normalizeVFSPath(resolve(pkgDir, exports));
      if (vfs.internalModuleStat(resolved) === 0) {
        return makeResolveResult(vfs, resolved);
      }
    }
    return null;
  }

  if (typeof exports !== 'object' || exports === null) {
    return null;
  }

  const keys = Object.getOwnPropertyNames(exports);
  if (keys.length === 0) return null;

  const isConditional = keys[0] !== '' && keys[0][0] !== '.';
  if (isConditional) {
    if (packageSubpath !== '.') return null;
    return resolveConditions(vfs, pkgDir, exports, conditions);
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
    const expanded = patternMatch !== null ? target.replace(/\*/g, patternMatch) : target;
    const resolved = normalizeVFSPath(resolve(pkgDir, expanded));
    if (vfs.internalModuleStat(resolved) === 0) {
      return makeResolveResult(vfs, resolved);
    }
    return null;
  }

  if (typeof target === 'object' && target !== null) {
    if (Array.isArray(target)) return null;
    return resolveConditionsWithPattern(vfs, pkgDir, target, conditions, patternMatch);
  }

  return null;
}

function resolveDirectoryEntry(vfs, dirPath, context) {
  const pjsonPath = normalizeVFSPath(resolve(dirPath, 'package.json'));
  if (vfs.internalModuleStat(pjsonPath) === 0) {
    try {
      const content = vfs.readFileSync(pjsonPath, 'utf8');
      const parsed = JSON.parse(content);

      if (parsed.exports != null) {
        const resolved = resolvePackageExports(
          vfs, dirPath, '.', parsed.exports, context);
        if (resolved) return resolved;
      }

      if (parsed.main) {
        const mainPath = normalizeVFSPath(resolve(dirPath, parsed.main));
        if (vfs.internalModuleStat(mainPath) === 0) {
          return makeResolveResult(vfs, mainPath);
        }
        const withExt = tryExtensions(vfs, mainPath);
        if (withExt) return makeResolveResult(vfs, withExt);
        // main points to a directory — try index files inside it
        if (vfs.internalModuleStat(mainPath) === 1) {
          const mainIndexResult = tryIndexFiles(vfs, mainPath);
          if (mainIndexResult) return mainIndexResult;
        }
      }
    } catch {
      // Invalid package.json
    }
  }
  return tryIndexFiles(vfs, dirPath);
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
    const withExt = tryExtensions(vfs, normalized);
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
  while (currentDir !== lastDir) {
    const pkgDir = normalizeVFSPath(
      joinVFSParts(currentDir, 'node_modules', packageName));

    if (vfs.shouldHandle(pkgDir) &&
        vfs.internalModuleStat(pkgDir) === 1) {
      const pjsonPath = normalizeVFSPath(
        joinVFSParts(pkgDir, 'package.json'));
      if (vfs.internalModuleStat(pjsonPath) === 0) {
        try {
          const content = vfs.readFileSync(pjsonPath, 'utf8');
          const parsed = JSON.parse(content);

          if (parsed.exports != null) {
            const resolved = resolvePackageExports(
              vfs, pkgDir, packageSubpath, parsed.exports, context);
            if (resolved) return resolved;
          }

          if (packageSubpath === '.') {
            if (parsed.main) {
              const mainPath = normalizeVFSPath(
                joinVFSParts(pkgDir, parsed.main));
              if (vfs.internalModuleStat(mainPath) === 0) {
                return makeResolveResult(vfs, mainPath);
              }
              const withExt = tryExtensions(vfs, mainPath);
              if (withExt) return makeResolveResult(vfs, withExt);
              // main points to a directory — try index files inside it
              if (vfs.internalModuleStat(mainPath) === 1) {
                const mainIndexResult = tryIndexFiles(vfs, mainPath);
                if (mainIndexResult) return mainIndexResult;
              }
            }
            const indexResult = tryIndexFiles(vfs, pkgDir);
            if (indexResult) return indexResult;
          } else {
            const subResolved = normalizeVFSPath(
              joinVFSParts(pkgDir, packageSubpath));
            if (vfs.internalModuleStat(subResolved) === 0) {
              return makeResolveResult(vfs, subResolved);
            }
            const withExt = tryExtensions(vfs, subResolved);
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

function resolveCJSExportsPath(vfs, pkgDir, target, patternMatch) {
  if (typeof target !== 'string') return null;
  const expanded = patternMatch !== null ? target.replace(/\*/g, patternMatch) : target;
  const resolved = normalizeVFSPath(resolve(pkgDir, expanded));
  if (vfs.internalModuleStat(resolved) === 0) return resolved;
  const withExt = tryExtensions(vfs, resolved);
  if (withExt) return withExt;
  return null;
}

function resolveCJSConditions(vfs, pkgDir, condMap, patternMatch) {
  const keys = Object.getOwnPropertyNames(condMap);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'default' || key === 'require' || key === 'node') {
      const value = condMap[key];
      if (typeof value === 'string') {
        const result = resolveCJSExportsPath(vfs, pkgDir, value, patternMatch);
        if (result) return result;
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = resolveCJSConditions(vfs, pkgDir, value, patternMatch);
        if (result) return result;
        continue;
      }
    }
  }
  return null;
}

function resolveCJSPackageExports(vfs, pkgDir, packageSubpath, exports) {
  if (typeof exports === 'string') {
    if (packageSubpath === '.') {
      return resolveCJSExportsPath(vfs, pkgDir, exports, null);
    }
    return null;
  }
  if (typeof exports !== 'object' || exports === null) return null;
  const keys = Object.getOwnPropertyNames(exports);
  if (keys.length === 0) return null;
  const isConditional = keys[0] !== '' && keys[0][0] !== '.';
  if (isConditional) {
    if (packageSubpath !== '.') return null;
    return resolveCJSConditions(vfs, pkgDir, exports, null);
  }
  let target = exports[packageSubpath];
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
    return resolveCJSExportsPath(vfs, pkgDir, target, patternMatch);
  }
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    return resolveCJSConditions(vfs, pkgDir, target, patternMatch);
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
        const exportsResult = resolveCJSPackageExports(
          vfs, pkgDir, packageSubpath, parsed.exports);
        if (exportsResult) return exportsResult;
      }

      if (packageSubpath === '.') {
        if (parsed?.main) {
          const mainPath = normalizeVFSPath(
            joinVFSParts(pkgDir, parsed.main));
          if (vfs.internalModuleStat(mainPath) === 0) {
            return mainPath;
          }
          const withExt = tryExtensions(vfs, mainPath);
          if (withExt) return withExt;
          // main points to a directory — try index files inside it
          if (vfs.internalModuleStat(mainPath) === 1) {
            const mainIdx = tryCJSIndexFiles(vfs, mainPath);
            if (mainIdx) return mainIdx;
          }
        }
        const idxResult = tryCJSIndexFiles(vfs, pkgDir);
        if (idxResult) return idxResult;
      } else {
        const subResolved = normalizeVFSPath(
          joinVFSParts(pkgDir, packageSubpath));
        const subStat = vfs.internalModuleStat(subResolved);
        if (subStat === 0) {
          return subResolved;
        }
        const withExt = tryExtensions(vfs, subResolved);
        if (withExt) return withExt;
        // Subpath resolves to a directory — try package.json main, then index files
        if (subStat === 1) {
          const subPjsonPath = normalizeVFSPath(
            joinVFSParts(subResolved, 'package.json'));
          if (vfs.internalModuleStat(subPjsonPath) === 0) {
            try {
              const subParsed = JSON.parse(vfs.readFileSync(subPjsonPath, 'utf8'));
              if (subParsed.main) {
                const mainPath = normalizeVFSPath(
                  joinVFSParts(subResolved, subParsed.main));
                if (vfs.internalModuleStat(mainPath) === 0) return mainPath;
                const mainExt = tryExtensions(vfs, mainPath);
                if (mainExt) return mainExt;
                if (vfs.internalModuleStat(mainPath) === 1) {
                  const mainIdx = tryCJSIndexFiles(vfs, mainPath);
                  if (mainIdx) return mainIdx;
                }
              }
            } catch { /* ignore */ }
          }
          const subIdx = tryCJSIndexFiles(vfs, subResolved);
          if (subIdx) return subIdx;
        }
      }
    }
    lastDir = currentDir;
    currentDir = dirnameVFS(currentDir);
  }

  return null;
}

function resolveHashImport(specifier, context, nextResolve) {
  // Handle package #imports (subpath imports) for files inside the VFS
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
  let parentVfs = null;
  for (let i = 0; i < activeVFSList.length; i++) {
    if (activeVFSList[i].shouldHandle(parentNorm)) {
      parentVfs = activeVFSList[i];
      break;
    }
  }

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
        const content = parentVfs.readFileSync(pjsonPath, 'utf8');
        const parsed = JSON.parse(content);
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
              const expanded = patternMatch !== null ? target.replace(/\*/g, patternMatch) : target;
              // If the target is a bare specifier (not relative), re-resolve it
              if (!expanded.startsWith('.') && !expanded.startsWith('/')) {
                return resolveBareSpecifier(expanded, context, nextResolve);
              }
              const resolved = normalizeVFSPath(resolve(currentDir, expanded));
              if (parentVfs.internalModuleStat(resolved) === 0) {
                return makeResolveResult(parentVfs, resolved);
              }
            }
            if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
              // Resolve conditions
              const condKeys = Object.getOwnPropertyNames(target);
              for (let i = 0; i < condKeys.length; i++) {
                const ckey = condKeys[i];
                if (ckey === 'default' || conditions.indexOf(ckey) !== -1) {
                  const value = target[ckey];
                  if (typeof value === 'string') {
                    const expanded = patternMatch !== null ? value.replace(/\*/g, patternMatch) : value;
                    // If the target is a bare specifier, re-resolve it
                    if (!expanded.startsWith('.') && !expanded.startsWith('/')) {
                      return resolveBareSpecifier(expanded, context, nextResolve);
                    }
                    const resolved = normalizeVFSPath(resolve(currentDir, expanded));
                    if (parentVfs.internalModuleStat(resolved) === 0) {
                      return makeResolveResult(parentVfs, resolved);
                    }
                  }
                }
              }
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
  let parentVfs = null;
  for (let i = 0; i < activeVFSList.length; i++) {
    if (activeVFSList[i].shouldHandle(parentNorm)) {
      parentVfs = activeVFSList[i];
      break;
    }
  }

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

function isNodeBuiltin(name) {
  if (typeof NodeModule.isBuiltin === 'function') {
    return NodeModule.isBuiltin(name);
  }
  const bare = name.startsWith('node:') ? name.slice(5) : name;
  return builtinSet.has(bare);
}

function vfsResolveHook(specifier, context, nextResolve) {
  if (specifier.startsWith('node:') || isNodeBuiltin(specifier)) {
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
        const withExt = tryExtensions(vfs, normalized);
        if (withExt) return withExt;

        if (stat === 1) {
          // Try package.json main / index files
          const pjsonPath = normalizeVFSPath(resolve(normalized, 'package.json'));
          if (vfs.internalModuleStat(pjsonPath) === 0) {
            try {
              const content = vfs.readFileSync(pjsonPath, 'utf8');
              const parsed = JSON.parse(content);
              if (parsed.main) {
                const mainPath = normalizeVFSPath(resolve(normalized, parsed.main));
                if (vfs.internalModuleStat(mainPath) === 0) return mainPath;
                const mainWithExt = tryExtensions(vfs, mainPath);
                if (mainWithExt) return mainWithExt;
                // main points to a directory — try index files inside it
                if (vfs.internalModuleStat(mainPath) === 1) {
                  const mainIdx = tryCJSIndexFiles(vfs, mainPath);
                  if (mainIdx) return mainIdx;
                }
              }
            } catch {
              // ignore
            }
          }
          const idxResult = tryCJSIndexFiles(vfs, normalized);
          if (idxResult) return idxResult;
        }
      }
    }

    // Bare specifier - walk node_modules
    if (!isAbsolute(request) && request[0] !== '.' && !isNodeBuiltin(request)) {
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
    if (typeof path === 'string') {
      const vfsResult = findVFSForFsStat(path);
      if (vfsResult !== null) {
        return vfsResult.stats;
      }
    }
    return originalLstatSync.call(fs, path, options);
  };

  fs.statSync = function statSync(path, options) {
    if (typeof path === 'string') {
      const vfsResult = findVFSForFsStat(path);
      if (vfsResult !== null) {
        return vfsResult.stats;
      }
    }
    return originalStatSync.call(fs, path, options);
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

  originalWatch = fs.watch;
  fs.watch = function watch(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = kEmptyObject;
    } else options ??= kEmptyObject;

    if (typeof filename === 'string') {
      const vfsResult = findVFSForWatch(filename);
      if (vfsResult !== null) {
        return vfsResult.vfs.watch(filename, options, listener);
      }
    }
    return originalWatch.call(fs, filename, options, listener);
  };

  originalWatchFile = fs.watchFile;
  fs.watchFile = function watchFile(filename, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = kEmptyObject;
    } else options ??= kEmptyObject;

    if (typeof filename === 'string') {
      const vfsResult = findVFSForWatch(filename);
      if (vfsResult !== null) {
        return vfsResult.vfs.watchFile(filename, options, listener);
      }
    }
    return originalWatchFile.call(fs, filename, options, listener);
  };

  originalUnwatchFile = fs.unwatchFile;
  fs.unwatchFile = function unwatchFile(filename, listener) {
    if (typeof filename === 'string') {
      const vfsResult = findVFSForWatch(filename);
      if (vfsResult !== null) {
        vfsResult.vfs.unwatchFile(filename, listener);
        return;
      }
    }
    return originalUnwatchFile.call(fs, filename, listener);
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
