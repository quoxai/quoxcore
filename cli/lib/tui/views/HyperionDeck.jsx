/**
 * HyperionDeck: the full-screen live HYPERION activity view (`quox hyperion deck`), in the Quoxon look.
 * Refreshes every intervalMs; r refreshes now, q quits. A failed fetch never blanks the screen: the last
 * good data stays, marked STALE, with the error named in the header. Props are injected (api, intervalMs)
 * so the component is testable without a network. api = { activity() }.
 *
 * Refresh props live in refs so the fetch loop is created once (the LUCID deck ran out of memory when a
 * changing prop restarted its loop on every redraw).
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { statusLines, summaryText } from '../../core/hyperion.js';
import { c, gradient } from '../../quoxon/theme.js';

function roleFor(line) {
  if (/^(Node load|Pool|Recent ops)/.test(line)) return 'sky';
  if (/^VMID/.test(line)) return 'label';
  if (/unavailable|^⚠/.test(line)) return 'warn';
  return 'value';
}

export function HyperionDeck({ api, intervalMs = 10000 }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = (stdout && stdout.rows) || 30;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [at, setAt] = useState(null);
  const inflight = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setData(await apiRef.current.activity());
      setErr(null);
      setAt(Date.now());
    } catch (e) {
      setErr(e);
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  useInput((input) => {
    if (input === 'q') exit();
    else if (input === 'r') refresh();
  });

  const lines = data ? statusLines(data, { now: Date.now() }) : [];
  const shown = lines.slice(0, Math.max(5, rows - 4));
  const stale = err && data;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {gradient(' HYPERION ').map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
        <Text color={c('value')}> {data ? summaryText(data) : 'loading'}</Text>
        {stale ? <Text color={c('warn')}>  STALE: {String(err.message || err).slice(0, 60)}</Text> : null}
        {err && !data ? <Text color={c('error')}>  unreachable: {String(err.message || err).slice(0, 60)}</Text> : null}
      </Text>
      <Text> </Text>
      {shown.map((l, i) => <Text key={i} wrap="truncate" color={c(roleFor(l))}>{l}</Text>)}
      <Text> </Text>
      <Text wrap="truncate">
        <Text bold color={c('key')}>r</Text><Text color={c('value')}> refresh   </Text>
        <Text bold color={c('key')}>q</Text><Text color={c('value')}> quit   </Text>
        <Text color={c('value')}>{at ? `updated ${new Date(at).toISOString().slice(11, 19)} UTC, every ${Math.round(intervalMs / 1000)}s` : ''}</Text>
      </Text>
    </Box>
  );
}
