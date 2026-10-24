'use strict';
const path = require('node:path');
const fs = require('node:fs');

function nativeHelperPaths({ isPackaged, resourcesPath, appPath }) {
  const root = isPackaged ? path.join(resourcesPath, 'native') : path.join(appPath, 'build', 'bin');
  return Object.freeze({
    lineWitness: path.join(root, isPackaged ? 'LineWitness.exe' : path.join('native-host', 'LineWitness.exe')),
    readOnlyRouting: path.join(root, isPackaged ? 'ReadOnlyRouting.exe' : path.join('native-routing', 'ReadOnlyRouting.exe')),
  });
}

function requireNativeHelper(filePath, existsSync = fs.existsSync) {
  if (!path.isAbsolute(filePath) || !existsSync(filePath)) throw new Error('Fixed native helper unavailable');
  return filePath;
}

module.exports = { nativeHelperPaths, requireNativeHelper };
