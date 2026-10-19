const fs = require('fs');
const os = require('os');
const path = require('path');

function pathExists(target) {
  try {
    return !!target && fs.existsSync(target);
  } catch {
    return false;
  }
}

function firstExistingPath(...candidates) {
  for (const candidate of candidates.flat()) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function isContainerRuntime() {
  return pathExists('/.dockerenv')
    || process.env.CONTAINER === 'true'
    || Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

// #1021: the host user's home. QUOX_HOST_HOME wins (dev compose pins it, since the
// container user's HOME is not the host owner's home); else the running user's home.
function hostHome() {
  return process.env.QUOX_HOST_HOME || os.homedir();
}

function hostPath(...parts) {
  return path.join(hostHome(), ...parts);
}

// Claude names a project dir by its path with separators turned into '-'.
function claudeProjectDir() {
  return path.join(hostHome(), '.claude', 'projects', hostHome().replace(/[\\/]/g, '-'));
}

function resolveRuntimeHomeDir() {
  return firstExistingPath(
    process.env.HOME,
    process.env.USERPROFILE,
    '/home/quox',
    '/root',
    process.cwd(),
    '/tmp',
  ) || '/tmp';
}

function resolveRuntimeUser(homeDir = resolveRuntimeHomeDir()) {
  return process.env.USER
    || process.env.LOGNAME
    || (homeDir ? path.basename(homeDir) : null)
    || 'control';
}

function resolveTerminalCwd(preferred) {
  return firstExistingPath(preferred, resolveRuntimeHomeDir(), process.cwd(), '/tmp') || '/tmp';
}

function resolveQuoxCliEntryPath() {
  return firstExistingPath(
    process.env.QUOX_CLI_BIN,
    path.resolve(__dirname, '../../../cli/bin/quox.js'),
    path.resolve(process.cwd(), 'cli/bin/quox.js'),
    '/app/cli/bin/quox.js',
  );
}

function resolveServiceUrl(explicitUrl, containerDefault, localDefault) {
  if (explicitUrl) return explicitUrl;
  return isContainerRuntime() ? containerDefault : localDefault;
}

function resolveBastionSshKeyPath(homeDir = resolveRuntimeHomeDir()) {
  return firstExistingPath(
    process.env.BASTION_SSH_KEY_PATH,
    path.join(homeDir, '.ssh', 'id_ed25519'),
    '/home/quox/.ssh/id_ed25519',
  ) || path.join(homeDir, '.ssh', 'id_ed25519');
}

module.exports = {
  claudeProjectDir,
  firstExistingPath,
  hostHome,
  hostPath,
  isContainerRuntime,
  resolveBastionSshKeyPath,
  resolveQuoxCliEntryPath,
  resolveRuntimeHomeDir,
  resolveRuntimeUser,
  resolveServiceUrl,
  resolveTerminalCwd,
};
