'use strict';

const { isAbsolute, posix: pathPosix } = require('node:path');

function splitPath(normalizedPath) {
  if (normalizedPath === '/') {
    return [];
  }
  return normalizedPath.slice(1).split('/');
}

function getParentPath(normalizedPath) {
  if (normalizedPath === '/') {
    return null;
  }
  return pathPosix.dirname(normalizedPath);
}

function getBaseName(normalizedPath) {
  return pathPosix.basename(normalizedPath);
}

// normalizeVFSPath uses pathPosix.normalize for /-prefixed paths and
// path.normalize for native paths (which produces \ on Windows).  Both
// styles can reach isUnderMountPoint, so we accept either separator.
function isPathSeparator(char) {
  return char === '/' || char === '\\';
}

function isUnderMountPoint(normalizedPath, mountPoint) {
  if (normalizedPath === mountPoint) {
    return true;
  }
  if (!normalizedPath.startsWith(mountPoint)) {
    return false;
  }
  // The path starts with the mount point — accept it only when the very next
  // character is a path separator (e.g. /app  →  /app/file) or the mount
  // point itself already ends with one (e.g. C:\ or /).
  return isPathSeparator(normalizedPath[mountPoint.length]) || isPathSeparator(mountPoint[mountPoint.length - 1]);
}

function getRelativePath(normalizedPath, mountPoint) {
  if (normalizedPath === mountPoint) {
    return '/';
  }
  if (mountPoint === '/') {
    return normalizedPath;
  }
  return normalizedPath.slice(mountPoint.length);
}

module.exports = {
  splitPath,
  getParentPath,
  getBaseName,
  isUnderMountPoint,
  getRelativePath,
  isAbsolutePath: isAbsolute,
};
