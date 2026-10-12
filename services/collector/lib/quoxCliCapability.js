function buildQuoxCliCapabilityStatus({
  ptyAvailable,
  ptyError = null,
  cliPath = null,
  validationError = null,
  missingDependency = null,
}) {
  if (!ptyAvailable) {
    return {
      available: false,
      reason: 'node_pty_unavailable',
      recommendation: 'QuoxCLI is unavailable because PTY support is not installed in the collector runtime. Install build tooling so node-pty can compile, or use the supported container deployment.',
      detail: ptyError || null,
    };
  }

  if (!cliPath) {
    return {
      available: false,
      reason: 'quoxcli_files_missing',
      recommendation: 'QuoxCLI is unavailable because the CLI files are not present in this deployment. Restore the bundled cli/ package before using the browser CLI view.',
      detail: null,
    };
  }

  if (validationError) {
    return {
      available: false,
      reason: 'quoxcli_runtime_invalid',
      recommendation: 'QuoxCLI is unavailable because the bundled CLI runtime is incomplete or corrupted. Reinstall the cli/ package dependencies and retry.',
      detail: validationError,
    };
  }

  if (missingDependency) {
    return {
      available: false,
      reason: 'quoxcli_dependencies_missing',
      recommendation: 'QuoxCLI is unavailable because its runtime dependencies are missing. Install the cli/ package dependencies before using the browser CLI view.',
      detail: missingDependency,
    };
  }

  return {
    available: true,
    reason: null,
    recommendation: null,
    detail: null,
  };
}

module.exports = {
  buildQuoxCliCapabilityStatus,
};
