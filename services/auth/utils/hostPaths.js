// #1021: host-path defaults. QUOX_HOST_HOME wins (the dev compose pins it, since the
// container user's HOME is not the host owner's home); else the running user's home.
import os from 'node:os';
import path from 'node:path';

export function hostHome() {
  return process.env.QUOX_HOST_HOME || os.homedir();
}

export function hostPath(...parts) {
  return path.join(hostHome(), ...parts);
}

// Claude names a project dir by its path with separators turned into '-'.
export function claudeProjectDir() {
  return path.join(hostHome(), '.claude', 'projects', hostHome().replace(/[\\/]/g, '-'));
}
