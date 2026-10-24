'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A content-free marker keeps incomplete deletion blocked across app restarts.
function createResetIntentStore(directory, serviceIds) {
  const allowed = new Set(serviceIds);
  function marker(id) {
    if (!allowed.has(id) || !/^[a-z]+$/.test(id)) throw new Error('Unsupported reset intent');
    return path.join(directory, `${id}.pending`);
  }
  return {
    pending: () => [...allowed].filter(id => {
      try { fs.statSync(marker(id)); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }),
    mark: id => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      let descriptor;
      try {
        descriptor = fs.openSync(marker(id), 'wx', 0o600);
        fs.fsyncSync(descriptor);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    },
    clear: id => {
      try { fs.unlinkSync(marker(id)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
module.exports = { createResetIntentStore };
