/**
 * Chat Workspace Configuration
 *
 * Centralized constants for the multi-tab chat system.
 * Mirrors the pattern from terminalConfig.js.
 */

export const CHAT_LIMITS = {
    // AOCL-DISPATCH-B11: bumped from 8 to 16. The previous limit silently
    // killed Continue Conversation when 8 tabs were already open, with no
    // visible feedback to the user.
    MAX_TABS: 16,
    TAB_WARN_THRESHOLD: 14,
    MAX_CONVERSATION_DISPLAY: 100, // max messages to render in chat
};

export const CHAT_STORAGE_KEY = 'quox-chat-workspaces';
export const CHAT_CONTINUE_KEY = 'quox-continue-conversation';
export const CHAT_TAB_MESSAGES_PREFIX = 'quox-chat-tab-';
