/**
 * ChatView — Full-screen chat with CommanderQ (and any org agent)
 *
 * Uses FullLayout (single panel, full width) instead of the standard two-panel layout.
 *
 * Features:
 *   - Real input line: left/right cursor movement, Ctrl+A/Ctrl+E (Home/End),
 *     backspace/delete at the caret, and Up/Down history recall of
 *     previously-sent messages
 *   - Agent picker: Tab (with an empty input box) opens a picker of the
 *     org's agents fetched from GET /api/orgs/:orgId/agents; Tab/↑↓ move,
 *     Enter confirms. Typing `@name ` at the start of a message routes
 *     just that message to `name` without changing the sticky selection.
 *   - Scrollback: PgUp/PgDn (and Ctrl+U/Ctrl+D) scroll a viewport window
 *     over the message list, auto-sticking to the newest messages unless
 *     the user has scrolled up
 *   - Message history scrolls up
 *   - Streams from POST /chat/stream (SSE, prompt in the body) on the collector service — same
 *     wire contract as `quox chat` (see lib/commands/chat.js buildStreamQuery)
 *   - Shows the assistant reply growing token-by-token, with a live
 *     thinking/tool-call status line beneath it
 *   - Keeps conversation_id (session_id) for continuity
 *   - Enter sends message, Esc goes back to menu
 *
 * API:
 *   POST /chat/stream (service: collector, body: { query_id, prompt, assistant, session_id? })
 *   GET /api/orgs/:orgId/agents (service: auth) -> data.agents
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { FullLayout } from '../components/Layout.jsx';
import { ChatInput } from '../components/ChatInput.jsx';
import { useTui } from '../app.jsx';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { colors } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// Batch token appends into React state on this interval instead of a
// setState-per-chunk, which would cause Ink to re-render (and flicker)
// the whole frame for every token on long replies.
const FLUSH_INTERVAL_MS = 50;

// Rows reserved by chrome around the scrollable message list: header (1) +
// separator (1) + footer (1) + input box (3, incl. borders) + a little
// breathing room for the streaming status line.
const RESERVED_ROWS = 7;
const MIN_VIEWPORT = 3;

function getOrgId(ctx) {
  return ctx?.auth?.getUser?.()?.org_id || ctx?.config?.getActiveProfile?.()?.auth?.org_id || null;
}

// ── Component ─────────────────────────────────────────────────────────
export function ChatView() {
  const ctx = useTui();
  const { client, screen, setInputMode } = ctx;
  const isActive = screen === 'chat';
  const orgId = getOrgId(ctx);
  const { rows } = useTerminalSize();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [conversationId, setConversationId] = useState(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [streamLabel, setStreamLabel] = useState('');

  // ── Sent-message history (Up/Down recall) ───────────────────────────
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const draftRef = useRef('');

  // ── Agent picker (Tab) + `@name ` per-message routing ───────────────
  const [agent, setAgent] = useState(null);
  const [agents, setAgents] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);

  // ── Scrollback viewport ──────────────────────────────────────────────
  const [scrollOffset, setScrollOffset] = useState(0);
  const stickRef = useRef(true);
  const prevMsgLenRef = useRef(0);
  const viewportSize = Math.max(MIN_VIEWPORT, rows - RESERVED_ROWS);

  // Refs used by the streaming loop — not React state, so they can be
  // mutated freely between throttled flushes without triggering renders.
  const mountedRef = useRef(true);
  const abortRef = useRef(null);
  const flushTimerRef = useRef(null);
  const fullTextRef = useRef('');
  // Mirror of conversationId so sendMessage always reads the latest session id
  // from a ref, not a possibly-stale useCallback closure — otherwise two sends
  // in quick succession (before React re-renders) can drop session continuity.
  const conversationIdRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  // ── Input-mode registry: claim 'input' mode while focused so global
  // single-char shortcuts (like '?' for help) don't steal keystrokes
  // out of the message box. Restore 'nav' when navigating away.
  useEffect(() => {
    setInputMode?.(isActive ? 'input' : 'nav');
  }, [isActive, setInputMode]);

  // Auto-stick the viewport to the newest messages unless the user has
  // manually scrolled up (PgUp) — mirrors terminal/IRC client behaviour.
  useEffect(() => {
    const len = messages.length;
    const grew = len - prevMsgLenRef.current;
    prevMsgLenRef.current = len;
    if (grew <= 0) return;
    if (stickRef.current) {
      setScrollOffset(0);
    } else {
      setScrollOffset((o) => o + grew);
    }
  }, [messages.length]);

  // Lazily fetch the org's agent roster the first time the picker opens.
  useEffect(() => {
    if (!pickerOpen || agentsLoaded) return;
    let cancelled = false;
    (async () => {
      if (!orgId) {
        if (!cancelled) { setAgents([]); setAgentsLoaded(true); }
        return;
      }
      try {
        const res = await client.get(resolveEndpoint('agents.list', { orgId }).path, { service: resolveEndpoint('agents.list', { orgId }).service });
        const list = res?.agents || res?.items || [];
        if (!cancelled) { setAgents(Array.isArray(list) ? list : []); setAgentsLoaded(true); }
      } catch {
        if (!cancelled) { setAgents([]); setAgentsLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, agentsLoaded, client, orgId]);

  const scrollUp = useCallback(() => {
    stickRef.current = false;
    setScrollOffset((o) => {
      const maxOffset = Math.max(0, messages.length - viewportSize);
      return Math.min(maxOffset, o + viewportSize);
    });
  }, [messages.length, viewportSize]);

  const scrollDown = useCallback(() => {
    setScrollOffset((o) => {
      const next = Math.max(0, o - viewportSize);
      if (next === 0) stickRef.current = true;
      return next;
    });
  }, [viewportSize]);

  // ── Handle keyboard input for the message box ────────────────────
  useInput((ch, key) => {
    if (!isActive) return;

    // Scrollback works even mid-stream so a long reply can be reviewed.
    if (key.pageUp) { scrollUp(); return; }
    if (key.pageDown) { scrollDown(); return; }
    if (key.ctrl && ch === 'u') { scrollUp(); return; }
    if (key.ctrl && ch === 'd') { scrollDown(); return; }

    if (isStreaming) return;

    // ── Agent picker owns the keyboard while open ────────────────────
    if (pickerOpen) {
      if (key.tab || key.downArrow) {
        setPickerIndex((i) => (agents.length ? (i + 1) % agents.length : 0));
        return;
      }
      if (key.upArrow) {
        setPickerIndex((i) => (agents.length ? (i - 1 + agents.length) % agents.length : 0));
        return;
      }
      if (key.return) {
        const chosen = agents[pickerIndex];
        if (chosen) setAgent(typeof chosen === 'string' ? chosen : (chosen.id || chosen.name));
        setPickerOpen(false);
        return;
      }
      if (key.escape) {
        setPickerOpen(false);
        return;
      }
      return;
    }

    if (key.return) {
      if (input.trim()) sendMessage();
      return;
    }

    // Tab (with an empty box) opens the agent picker. Free otherwise.
    if (key.tab) {
      if (input.trim() === '') {
        setPickerOpen(true);
        setPickerIndex(0);
      }
      return;
    }

    // ── History recall ─────────────────────────────────────────────
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndex === null) draftRef.current = input;
      const newIdx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIdx);
      setInput(history[newIdx]);
      setCursor(history[newIdx].length);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === null) return;
      const newIdx = historyIndex + 1;
      if (newIdx >= history.length) {
        setHistoryIndex(null);
        setInput(draftRef.current);
        setCursor(draftRef.current.length);
      } else {
        setHistoryIndex(newIdx);
        setInput(history[newIdx]);
        setCursor(history[newIdx].length);
      }
      return;
    }

    // ── Cursor movement ────────────────────────────────────────────
    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(input.length, c + 1)); return; }
    if (key.home || (key.ctrl && ch === 'a')) { setCursor(0); return; }
    if (key.end || (key.ctrl && ch === 'e')) { setCursor(input.length); return; }

    // ── Edit at cursor ─────────────────────────────────────────────
    if (key.backspace) {
      if (cursor === 0) return;
      setInput((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
      setCursor((c) => c - 1);
      setHistoryIndex(null);
      return;
    }
    if (key.delete) {
      setInput((prev) => (cursor >= prev.length ? prev : prev.slice(0, cursor) + prev.slice(cursor + 1)));
      setHistoryIndex(null);
      return;
    }

    // Don't capture escape (handled by parent for navigation)
    if (key.escape) return;

    if (ch && !key.ctrl && !key.meta && !key.tab && !key.return) {
      setInput((prev) => prev.slice(0, cursor) + ch + prev.slice(cursor));
      setCursor((c) => c + ch.length);
      setHistoryIndex(null);
    }
  }, { isActive });

  // ── Throttled flush of the token buffer into React state ──────────
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (!mountedRef.current) return;
      setStreamText(fullTextRef.current);
    }, FLUSH_INTERVAL_MS);
  }, []);

  const cancelFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // ── Send message ──────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const raw = input.trim();
    if (!raw) return;

    // `@name the rest of the message` routes just this send to `name`.
    const atMatch = raw.match(/^@(\S+)\s+([\s\S]+)$/);
    const routedAgent = atMatch ? atMatch[1] : null;
    const promptBody = atMatch ? atMatch[2] : raw;
    const effectiveAgent = routedAgent || agent || 'quox';

    setHistory((prev) => [...prev, raw]);
    setHistoryIndex(null);
    draftRef.current = '';

    setMessages((prev) => [...prev, { role: 'user', text: raw }]);
    setInput('');
    setCursor(0);

    fullTextRef.current = '';
    setIsStreaming(true);
    setStreamText('');
    setStreamStatus('');
    setStreamLabel('');

    const controller = new AbortController();
    abortRef.current = controller;

    const queryId = `CLI_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      query_id: queryId,
      prompt: promptBody,
      assistant: effectiveAgent,
    };
    if (conversationIdRef.current) body.session_id = conversationIdRef.current;

    let sawChunk = false;
    let resultSessionId = conversationIdRef.current;
    let agentUsed = null;

    try {
      for await (const event of client.stream(resolveEndpoint('chat.stream').path, {
        service: resolveEndpoint('chat.stream').service,
        body,
        signal: controller.signal,
      })) {
        if (!mountedRef.current || controller.signal.aborted) return;

        if (event.agent_used) {
          agentUsed = event.agent_used;
          setStreamLabel(agentUsed);
        }

        switch (event.type) {
          case 'connected':
            break;

          case 'thinking': {
            const stage = event.stage || '';
            if (stage === 'tool_call' || stage.includes('tool')) {
              setStreamStatus(`⚙ using tool: ${event.message || ''}`);
            } else if (event.message) {
              setStreamStatus(`… ${event.message}`);
            }
            break;
          }

          case 'chunk':
            sawChunk = true;
            fullTextRef.current += event.content || '';
            scheduleFlush();
            break;

          case 'done':
            if (!sawChunk && event.full_response) {
              fullTextRef.current = event.full_response;
            }
            if (event.session_id) resultSessionId = event.session_id;
            break;

          case 'error':
            throw new Error(event.error || 'Stream error');

          default:
            break;
        }
      }

      if (!mountedRef.current || controller.signal.aborted) return;

      cancelFlush();
      if (resultSessionId) {
        conversationIdRef.current = resultSessionId;
        setConversationId(resultSessionId);
      }
      setMessages((prev) => [...prev, { role: 'assistant', text: fullTextRef.current, label: agentUsed }]);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      cancelFlush();
      setMessages((prev) => [...prev, { role: 'error', text: err.message }]);
    } finally {
      if (mountedRef.current) {
        setIsStreaming(false);
        setStreamText('');
        setStreamStatus('');
        setStreamLabel('');
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [input, client, agent, scheduleFlush, cancelFlush]);

  // ── Viewport window over the message list ──────────────────────────
  const total = messages.length;
  const windowEnd = Math.max(0, total - scrollOffset);
  const windowStart = Math.max(0, windowEnd - viewportSize);
  const visibleMessages = messages.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  const activeAgent = agent || 'quox';
  const footer = `Enter: send  ↑/↓: history  PgUp/PgDn: scroll  Tab: agent  Esc: back  [agent: ${activeAgent}]`;

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <FullLayout title="Chat" subtitle="CommanderQ" footer={footer}>
      {/* Message history */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {messages.length === 0 && !isStreaming && (
          <Text color={colors.dim}>Type a message and press Enter to chat with CommanderQ</Text>
        )}
        {hiddenAbove > 0 && (
          <Text color={colors.dim}>{`↑ ${hiddenAbove} earlier message${hiddenAbove === 1 ? '' : 's'} (PgUp)`}</Text>
        )}
        {visibleMessages.map((msg, i) => (
          <Box key={windowStart + i} marginBottom={1}>
            <Text
              color={msg.role === 'user' ? colors.cyberBlue : msg.role === 'error' ? colors.error : colors.accent}
              bold
            >
              {msg.role === 'user' ? 'You: ' : msg.role === 'error' ? 'Error: ' : `${msg.label || 'CommanderQ'}: `}
            </Text>
            <Text color={msg.role === 'error' ? colors.error : colors.text} wrap="wrap">
              {msg.text}
            </Text>
          </Box>
        ))}
        {hiddenBelow > 0 && (
          <Text color={colors.dim}>{`↓ ${hiddenBelow} newer message${hiddenBelow === 1 ? '' : 's'} (PgDn)`}</Text>
        )}
        {isStreaming && (
          <Box marginBottom={streamStatus ? 0 : 1}>
            <Text color={colors.accent} bold>{`${streamLabel || 'CommanderQ'}: `}</Text>
            {streamText ? (
              <Text color={colors.text} wrap="wrap">{streamText}</Text>
            ) : (
              <Text color={colors.warning}>is thinking...</Text>
            )}
          </Box>
        )}
        {isStreaming && streamStatus && (
          <Box marginBottom={1}>
            <Text color={colors.dim}>{streamStatus}</Text>
          </Box>
        )}
      </Box>

      {/* Input + agent picker */}
      <ChatInput
        input={input}
        cursor={cursor}
        disabled={isStreaming}
        agents={agents}
        pickerOpen={pickerOpen}
        pickerIndex={pickerIndex}
      />
    </FullLayout>
  );
}
