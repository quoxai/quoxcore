'use strict';

/**
 * Distinguish a MISSING directory from an UNREADABLE one. fs.existsSync
 * returns false on EACCES/EPERM (e.g. a 0700 parent dir), which made feed
 * sources report ok with 0 files. Probe with readdirSync when existsSync
 * says false so a permission problem surfaces as a failure.
 *
 * @returns {{state:'ok'|'missing'|'denied'|'error', error?:string}}
 */
function probeDir(dir, fsImpl) {
  if (fsImpl.existsSync(dir)) return { state: 'ok' };
  if (typeof fsImpl.readdirSync !== 'function') return { state: 'missing' };
  try {
    fsImpl.readdirSync(dir);
    return { state: 'ok' };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') {
      return { state: 'denied', error: `permission denied reading ${dir} (${code}), check directory permissions` };
    }
    return { state: 'error', error: `cannot read ${dir}, ${err && err.message}` };
  }
}

module.exports = { probeDir };
