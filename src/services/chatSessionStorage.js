export function getChatStorageKey(agent, sessionPrefix = 'CONV') {
  return sessionPrefix !== 'CONV' ? sessionPrefix : agent;
}

export function getStoredChatSessionId(storageKey) {
  try {
    return localStorage.getItem(`quox-session-${storageKey}`);
  } catch {
    return null;
  }
}

export function getStoredChatConversation(storageKey, sessionId) {
  if (!sessionId) return null;
  try {
    return localStorage.getItem(`quox-convo-${storageKey}-${sessionId}`);
  } catch {
    return null;
  }
}

export function clearStoredChatState(storageKey, sessionId = null) {
  try {
    const resolvedSessionId = sessionId || getStoredChatSessionId(storageKey);
    if (resolvedSessionId) {
      localStorage.removeItem(`quox-convo-${storageKey}-${resolvedSessionId}`);
    }
    localStorage.removeItem(`quox-session-${storageKey}`);
    localStorage.removeItem(`quox-corr-${storageKey}`);
  } catch {
    // Ignore storage failures during best-effort cleanup.
  }
}
