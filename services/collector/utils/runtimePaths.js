const fs = require('fs');
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

function resolveRuntimeHomeDir() {
  return firstExistingPath(
    process.env.HOME,
    process.env.USERPROFILE,
    '/opt/quoxcore',
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
  firstExistingPath,
  isContainerRuntime,
  resolveBastionSshKeyPath,
  resolveQuoxCliEntryPath,
  resolveRuntimeHomeDir,
  resolveRuntimeUser,
  resolveServiceUrl,
  resolveTerminalCwd,
};
