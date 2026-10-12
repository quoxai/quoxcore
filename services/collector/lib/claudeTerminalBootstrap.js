function normalizeTerminalText(value = '') {
  return String(value)
    .replace(/\x1B\][^\u0007]*(?:\u0007|\x1B\\)/g, ' ')
    .replace(/\x1B\[[0-9;?<>]*[ -/]*[@-~]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMenuSelectionInput(choice) {
  const normalizedChoice = String(choice ?? '').trim();
  if (!normalizedChoice || normalizedChoice === 'default' || normalizedChoice === '1') {
    return '\r';
  }
  return `${normalizedChoice}\r`;
}

function createClaudeTerminalBootstrap({
  write,
  schedule = setTimeout,
  cancel = clearTimeout,
  loginDelayMs = 2500,
  themeConfirmDelayMs = 500,
  postThemeLoginDelayMs = 1000,
  themeChoice = '1',
  loginMethodChoice = '1',
} = {}) {
  if (typeof write !== 'function') {
    throw new Error('createClaudeTerminalBootstrap requires a write function');
  }

  let timer = null;
  const state = {
    recentOutput: '',
    recentNormalizedOutput: '',
    themePromptSeen: false,
    themeSelected: false,
    loginRequested: false,
    loginMethodSelected: false,
  };

  const clearTimer = () => {
    if (timer) {
      cancel(timer);
      timer = null;
    }
  };

  const scheduleLogin = (delayMs) => {
    scheduleLoginWithOptions(delayMs, {});
  };

  const scheduleLoginWithOptions = (delayMs, { force = false } = {}) => {
    clearTimer();
    timer = schedule(() => {
      if (state.loginRequested && !force) return;
      state.loginRequested = true;
      write('/login\r');
    }, delayMs);
  };

  const handleData = (chunk = '') => {
    state.recentOutput = `${state.recentOutput}${chunk}`.slice(-12000);
    state.recentNormalizedOutput = normalizeTerminalText(state.recentOutput);

    if (!state.themePromptSeen && state.recentNormalizedOutput.includes('Choose the text style')) {
      state.themePromptSeen = true;
      state.themeSelected = true;
      clearTimer();
      timer = schedule(() => {
        write(buildMenuSelectionInput(themeChoice));
        scheduleLoginWithOptions(postThemeLoginDelayMs, { force: true });
      }, themeConfirmDelayMs);
    }

    if (!state.loginMethodSelected && state.recentNormalizedOutput.includes('Select login method:')) {
      state.loginMethodSelected = true;
      write(buildMenuSelectionInput(loginMethodChoice));
    }
  };

  const start = () => {
    scheduleLogin(loginDelayMs);
  };

  const dispose = () => {
    clearTimer();
  };

  return {
    start,
    handleData,
    dispose,
    getState: () => ({ ...state }),
  };
}

module.exports = {
  buildMenuSelectionInput,
  normalizeTerminalText,
  createClaudeTerminalBootstrap,
};
