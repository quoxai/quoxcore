/**
 * LucidDeck: the full-screen live LUCID situation deck (`quox lucid deck`).
 *
 * One vertical cursor. Up/Down (j/k) move through the focused pane's list,
 * Tab / Shift-Tab switch pane (Needs you, Since you looked, Areas), Enter
 * opens / acts, Esc backs out, ? is help, q quits. Every action echoes what it
 * did and why in a toast; keys that do nothing say so.
 *
 * Props are injected (api, intervalMs, intro) so the component is testable
 * without a network. api = { situation(), measure(ref, id), teach(body), ack(seq) }.
 * Never shows an empty all-quiet view on failure: errors render in the header
 * and the last good data stays on screen, marked STALE.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import {
  GLYPH, STATE_HEX, URGENCY, PALETTE, SPINNER, wrap, clip, ageOf, meter, clockLondonSec,
  whenText, changedWords, blindSpots,
} from '../../lucid/fmt.js';
import { LucidIntro } from '../../lucid/LucidIntro.jsx';

const PANES = ['needs', 'changed', 'areas'];
const PANE_TITLE = { needs: 'NEEDS YOU', changed: 'SINCE YOU LOOKED', areas: 'AREAS' };
const PANE_WORD = { needs: 'Needs you', changed: 'Since you looked', areas: 'Areas' };
const BAR_BG = '#1E3A8A';       // selected row bar
const BAR_BG_DIM = '#27272A';   // selected row in an unfocused pane
const NEW_MS = 4000;
const GHOST_MS = 4000;
const TOAST_MS = 3000;
const GRAD = ['#38BDF8', '#6366F1', '#8B5CF6', '#C084FC', '#8B5CF6'];

const pad = (s, w) => { const a = [...String(s)]; return a.length >= w ? a.join('') : s + ' '.repeat(w - a.length); };
const nm = (x) => (typeof x === 'string' ? x : (x && (x.label || x.name || x.L0 || x.id)) || '');

export function itemsLines(it, expanded, w, base = 1) {
  if (!expanded) return base;
  const a = it.L1 || {};
  let n = base;
  for (const v of [a.who, a.what, a.why, whenText(a.when)]) if (v) n += wrap(v, w - 8).length;
  if ((a.affected || []).length) n += 1;
  const ms = (it.L2 && it.L2.measures) || [];
  if (ms.length) n += 1 + ms.length + (ms.some((m) => m.command) ? 1 : 0);
  else n += 1;
  return n + 1;
}

/** Window of items to render so the selected one is visible within `rows` lines. */
export function windowItems(items, sel, expandedRef, rows, w, base) {
  const heights = items.map((it) => itemsLines(it, it.ref === expandedRef, w, base ? base(it) : 1));
  let start = 0;
  const fits = (s) => {
    let used = 0;
    for (let i = s; i <= sel; i++) used += heights[i];
    return used <= rows;
  };
  while (start < sel && !fits(start)) start++;
  let used = 0; let end = start;
  while (end < items.length && used + heights[end] <= rows) { used += heights[end]; end++; }
  if (end === start && items.length) end = start + 1;
  return { start, end };
}

/** Window by rendered line heights; when the list overflows, 2 lines are kept for the "N more" markers. */
export function fitWindow(items, sel, expandedRef, rows, w, base) {
  let win = windowItems(items, sel, expandedRef, rows, w, base);
  if (win.start > 0 || win.end < items.length) win = windowItems(items, sel, expandedRef, Math.max(1, rows - 2), w, base);
  return win;
}

/** Simple window for single-line lists. */
function winLines(n, sel, rows) {
  rows = Math.max(1, rows);
  if (n <= rows) return { start: 0, end: n };
  let start = Math.max(0, Math.min(sel - Math.floor(rows / 2), n - rows));
  return { start, end: start + rows };
}

export function signature(sit) {
  if (!sit) return '';
  return JSON.stringify([
    (sit.needs_you || []).map((i) => i.ref + i.urgency),
    (sit.changed || []).map((c) => c.ref + c.ts),
    (sit.areas || []).map((a) => a.state),
  ]);
}

function Pill({ urgency }) {
  const u = URGENCY[urgency] || URGENCY.whenever;
  const hot = urgency === 'now' || urgency === 'today' || urgency === 'this week';
  const label = ` ${u.label} `;
  return hot
    ? <Text backgroundColor={u.hex} color="#0B1220" bold>{pad(label, 11)}</Text>
    : <Text color={u.hex}>{pad(label, 11)}</Text>;
}

function Hints({ items, cols }) {
  return (
    <Text wrap="truncate" color={PALETTE.dim}>
      {items.map(([k, l], i) => (
        <Text key={k + l}>{i ? '   ' : ''}<Text bold color={PALETTE.brand}>{k}</Text><Text color={PALETTE.muted}> {l}</Text></Text>
      ))}
    </Text>
  );
}

function Panel({ title, count, focused, width, height, note, children }) {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round"
      borderColor={focused ? PALETTE.brand : '#3F3F46'} paddingX={1}>
      <Box>
        {focused
          ? <Text backgroundColor={PALETTE.brand} color="#0B1220" bold> ▶ {title} </Text>
          : <Text color={PALETTE.dim} bold>  {title} </Text>}
        <Text color={focused ? PALETTE.text : PALETTE.dim}> {count}</Text>
        {note ? <Text color={PALETTE.dim}>  {note}</Text> : null}
      </Box>
      {children}
    </Box>
  );
}

export function LucidDeck({ api, intervalMs = 10000, now = () => Date.now(), onExit, intro = false }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, setSizeTick] = useState(0);
  const cols = (stdout && stdout.columns) || 100;
  const rows = (stdout && stdout.rows) || 30;

  const [phase, setPhase] = useState(intro ? 'intro' : 'deck');
  const [slide, setSlide] = useState(intro ? 3 : 0);
  const [data, setData] = useState(null);       // last good response
  const [err, setErr] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [tick, setTick] = useState(0);
  const [spin, setSpin] = useState(0);
  const [pane, setPane] = useState('needs');
  const [filter, setFilter] = useState(null);   // area key or null
  const [sel, setSel] = useState(0);
  const [chSel, setChSel] = useState(0);
  const [arSel, setArSel] = useState(0);        // 0 = All areas, 1.. = areas
  const [expanded, setExpanded] = useState(null);
  const [mSel, setMSel] = useState(0);
  const [confirm, setConfirm] = useState(null); // {text, extra, run}
  const [note, setNote] = useState(null);       // {text, tone, at}
  const [help, setHelp] = useState(false);
  const [hinted, setHinted] = useState(true);   // first-launch hint until first key
  const [arrived, setArrived] = useState(0);
  const sigRef = useRef('');
  const prevNeeds = useRef(null);
  const newAt = useRef(new Map());
  const ghosts = useRef([]);
  const inflight = useRef(false);

  const flash = useCallback((text, tone = 'ok') => {
    setNote({ text, tone, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!stdout || !stdout.on) return undefined;
    const f = () => setSizeTick((x) => x + 1);
    stdout.on('resize', f);
    return () => stdout.off && stdout.off('resize', f);
  }, [stdout]);

  // Props held in refs so `refresh` is created once: a default `now = () => Date.now()` is a new
  // function every render, and depending on it restarted the fetch loop on every redraw (the
  // deck fetched continuously and ran out of memory after 8.5h, 2026-10-11).
  const apiRef = useRef(api);
  const nowRef = useRef(now);
  apiRef.current = api;
  nowRef.current = now;

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setFetching(true);
    try {
      const res = await apiRef.current.situation();
      const sit = res && res.situation;
      const cur = (sit && sit.needs_you) || [];
      if (prevNeeds.current) {
        const have = new Set(prevNeeds.current.map((i) => i.ref));
        const nowRefs = new Set(cur.map((i) => i.ref));
        let fresh = 0;
        for (const i of cur) if (!have.has(i.ref)) { newAt.current.set(i.ref, Date.now()); fresh++; }
        for (const i of prevNeeds.current) if (!nowRefs.has(i.ref)) ghosts.current.push({ item: i, at: Date.now() });
        if (fresh) setArrived((n) => n + fresh);
      }
      prevNeeds.current = cur;
      sigRef.current = signature(sit);
      setData(res);
      setErr(null);
      setFetchedAt(nowRef.current());
    } catch (e) {
      setErr(e);
    } finally {
      inflight.current = false;
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    const h = setInterval(() => setTick((x) => x + 1), 500);
    return () => { clearInterval(t); clearInterval(h); };
  }, [refresh, intervalMs]);

  useEffect(() => {
    if (!fetching) return undefined;
    const s = setInterval(() => setSpin((x) => x + 1), 120);
    return () => clearInterval(s);
  }, [fetching]);

  useEffect(() => {
    if (phase !== 'deck' || slide <= 0) return undefined;
    const s = setTimeout(() => setSlide((x) => x - 1), 60);
    return () => clearTimeout(s);
  }, [phase, slide]);

  const introDone = useCallback(() => setPhase((p) => (p === 'intro' ? 'deck' : p)), []);

  const sit = (data && data.situation) || null;
  const areas = (sit && sit.areas) || [];
  const allNeeds = (sit && sit.needs_you) || [];
  const changed = (sit && sit.changed) || [];
  const needs = useMemo(() => (filter ? allNeeds.filter((i) => i.area === filter) : allNeeds), [allNeeds, filter]);
  const filterLabel = filter ? ((areas.find((a) => a.area === filter) || {}).label || filter) : null;
  const safeSel = Math.min(sel, Math.max(0, needs.length - 1));
  const safeCh = Math.min(chSel, Math.max(0, changed.length - 1));
  const safeAr = Math.min(arSel, areas.length);
  const cur = needs[safeSel];
  const curMeasures = (cur && cur.L2 && cur.L2.measures) || [];
  const isOpen = Boolean(cur && expanded === cur.ref);
  const expandedRef = isOpen ? expanded : null;

  // A resolved/vanished expanded item collapses itself.
  useEffect(() => {
    if (expanded && !allNeeds.some((i) => i.ref === expanded)) setExpanded(null);
  }, [allNeeds, expanded]);

  const runConfirmed = () => {
    const c = confirm; setConfirm(null);
    if (c) c.run();
  };

  const askMeasure = (item, m) => {
    setConfirm({
      text: `Do ${m.label}?`,
      extra: [m.risk && m.risk !== 'safe' ? m.risk : null, m.kind === 'run' ? 'This files an approval' : null].filter(Boolean).join(' · '),
      run: () => {
        flash(`Running "${m.label}"...`, 'busy');
        api.measure(item.ref, m.id).then((r) => {
          const bits = [r.say, r.command && `run: ${r.command}`, r.url && `open: ${r.url}`,
            r.status === 'filed' ? 'Filed for approval. Approve it in Approvals.' : null].filter(Boolean);
          flash(bits.join('  ') || `Done: ${m.label} (status ${r.status}).`, 'ok');
          refresh();
        }).catch((e) => flash(`"${m.label}" failed: ${e.status ? 'HTTP ' + e.status : e.message}`, 'bad'));
      },
    });
    flash('Asked first, nothing has run yet.', 'dim');
  };

  const askTeach = (text, body, okMsg) => {
    setConfirm({
      text,
      extra: '',
      run: () => {
        api.teach(body)
          .then(() => { flash(okMsg, 'ok'); refresh(); })
          .catch((e) => flash(`Teach failed: ${e.status ? 'HTTP ' + e.status : e.message}`, 'bad'));
      },
    });
  };

  const gotoPane = (delta) => {
    const i = PANES.indexOf(pane);
    const nxt = PANES[(i + delta + PANES.length) % PANES.length];
    setPane(nxt);
    flash(`Switched to ${PANE_WORD[nxt]}. Up/Down now moves through it.`, 'dim');
  };

  const move = (delta) => {
    if (pane === 'needs') {
      if (!needs.length) { flash(filter ? 'Nothing to move through: no needs in this area (Esc clears the filter).' : 'Nothing needs you, so there is nothing to select.', 'dim'); return; }
      if (isOpen && curMeasures.length) { setMSel((m) => Math.max(0, Math.min(curMeasures.length - 1, m + delta))); return; }
      if (isOpen) { flash('This item is open and has no actions. Esc closes it.', 'dim'); return; }
      setSel((x) => Math.max(0, Math.min(needs.length - 1, Math.min(x, needs.length - 1) + delta))); setMSel(0);
    } else if (pane === 'changed') {
      if (!changed.length) { flash('Nothing has changed since you last looked.', 'dim'); return; }
      setChSel((x) => Math.max(0, Math.min(changed.length - 1, Math.min(x, changed.length - 1) + delta)));
    } else {
      setArSel((x) => Math.max(0, Math.min(areas.length, Math.min(x, areas.length) + delta)));
    }
  };

  const activate = () => {
    if (pane === 'needs') {
      if (!cur) { flash('Nothing is selected, so Enter has nothing to open.', 'dim'); return; }
      if (!isOpen) { setExpanded(cur.ref); setMSel(0); return; }
      if (curMeasures[mSel]) { askMeasure(cur, curMeasures[mSel]); return; }
      setExpanded(null); flash('No actions on this item, closed it.', 'dim');
    } else if (pane === 'areas') {
      if (safeAr === 0 || (areas[safeAr - 1] && areas[safeAr - 1].area === filter)) {
        setFilter(null); flash('Showing all areas.', 'ok');
      } else {
        const a = areas[safeAr - 1];
        setFilter(a.area); flash(`Filtered Needs you to ${a.label}. Esc clears.`, 'ok');
      }
      setPane('needs'); setSel(0); setExpanded(null);
    } else {
      const c = changed[safeCh];
      if (!c) { flash('Nothing is selected.', 'dim'); return; }
      flash(`${c.L0 || 'Change'}${changedWords(c) ? ': ' + changedWords(c) : ''}`, 'ok');
    }
  };

  const onKey = (input, key) => {
    if (key.ctrl && input === 'c') { if (onExit) onExit(); exit(); return; }
    if (phase === 'intro') { introDone(); return; }
    setHinted(false);
    if (input === 'q' && !confirm) { if (onExit) onExit(); exit(); return; }
    if (help) { if (input === '?' || key.escape || input === 'q') setHelp(false); return; }
    if (confirm) {
      if (input === 'y' || input === 'Y') runConfirmed();
      else if (input === 'n' || input === 'N' || key.escape) { setConfirm(null); flash('Cancelled, nothing was changed.', 'dim'); }
      else flash('Answer y to do it or n to cancel.', 'dim');
      return;
    }
    if (input === '?') { setHelp(true); return; }
    if (input === 'r') { flash('Refreshing now...', 'busy'); refresh(); return; }
    if (key.tab) { gotoPane(key.shift ? -1 : 1); return; }
    if (key.upArrow || input === 'k') { move(-1); return; }
    if (key.downArrow || input === 'j') { move(1); return; }
    if (key.return) { activate(); return; }
    if (key.escape) {
      if (isOpen) { setExpanded(null); flash('Closed the item.', 'dim'); }
      else if (filter) { setFilter(null); setSel(0); flash('Filter cleared, showing all areas.', 'ok'); }
      else flash('Nothing to close. Press q to quit.', 'dim');
      return;
    }
    if (input === 'd') {
      if (pane !== 'needs') { flash('d acts on Needs you. Tab to that pane first.', 'dim'); return; }
      if (!cur) { flash('Nothing selected to act on.', 'dim'); return; }
      if (!isOpen) {
        if (!curMeasures.length) { flash('This item has no actions I can offer.', 'dim'); return; }
        setExpanded(cur.ref); setMSel(0); flash('Opened. Up/Down picks an action, Enter or d does it.', 'dim'); return;
      }
      if (!curMeasures[mSel]) { flash('This item has no actions I can offer.', 'dim'); return; }
      askMeasure(cur, curMeasures[mSel]); return;
    }
    if (input === 'u' || input === 'c') {
      if (pane !== 'needs' || !cur) { flash(`${input} acts on a Needs you item. Select one first.`, 'dim'); return; }
      if (input === 'u') {
        askTeach(`Treat all ${cur.kind} items as not urgent? y/n`,
          { scope: 'kind', target: cur.kind, field: 'urgency', value: 'whenever', reason: 'not useful (deck)' },
          `Noted: ${cur.kind} items are "whenever" from now on.`);
      } else {
        askTeach(`Mark "${clip(cur.L0 || '', 40)}" as something you care about? y/n`,
          { scope: 'subject', target: cur.ref, field: 'watched', value: true, reason: 'I care (deck)' },
          'Noted: you care about this one, LUCID will keep it in view.');
      }
      return;
    }
    if (input === 'm') {
      if (!sit || !sit.cursor) { flash('Nothing to mark: no cursor from LUCID yet.', 'dim'); return; }
      const n = changed.length;
      api.ack(sit.cursor.to)
        .then(() => { flash(`Marked ${n} change${n === 1 ? '' : 's'} as seen, so "since you looked" restarts from now.`, 'ok'); refresh(); })
        .catch((e) => flash(`Ack failed: ${e.status ? 'HTTP ' + e.status : e.message}`, 'bad'));
      return;
    }
    flash(`"${input || 'that key'}" does nothing here. Press ? for keys.`, 'dim');
  };
  // Always dispatch to the latest closure: Ink re-subscribes in a passive effect,
  // which can lag a render and would otherwise hand a key to stale state.
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useInput((input, key) => keyRef.current(input, key));


  if (phase === 'intro') {
    return (
      <Box flexDirection="column" height={Math.max(10, rows - 1)} width={cols}>
        <LucidIntro data={data} err={err} onDone={introDone} rows={rows} />
      </Box>
    );
  }

  const wall = Date.now();
  const t = now();
  const cov = (sit && sit.cannot_see && sit.cannot_see.coverage) || { live: 0, expected: 0 };
  const agoS = fetchedAt ? Math.max(0, Math.floor((t - fetchedAt) / 1000)) : null;
  const stale = Boolean(err && data);
  const noteLive = note && wall - note.at < (note.tone === 'bad' ? 6000 : TOAST_MS) ? note : null;
  const noteHex = noteLive ? ({ ok: STATE_HEX.ok, bad: STATE_HEX.blind, busy: PALETTE.brand, dim: PALETTE.muted }[noteLive.tone]) : null;
  const spots = blindSpots(sit && sit.cannot_see);
  const dau = (sit && sit.doesnt_add_up) || [];
  const flashOn = tick % 2 === 0;
  ghosts.current = ghosts.current.filter((g) => wall - g.at < GHOST_MS);
  const liveGhosts = ghosts.current.filter((g) => !filter || g.item.area === filter);

  // ── layout ──────────────────────────────────────────────────────────
  const wide = cols >= 80;
  const big = cols >= 110;
  const leftW = big ? 24 : 22;
  const avail = cols - 2 - leftW;
  const rightW = big ? avail - Math.round(avail * 0.55) : 0;   // below 110 cols Since-you-looked stacks under Needs-you
  const mainW = avail - rightW - (slide ? slide * 4 : 0);
  const bannerOn = Boolean(err) || hinted;
  const headerH = 3 + (err ? 1 : 0);
  const hintH = hinted && !err ? 1 : 0;
  const footerH = 3;
  const bodyH = Math.max(8, rows - headerH - hintH - footerH - 1);
  const listRows = bodyH - 3;
  const innerOf = (w) => Math.max(10, w - 4);

  // ── header ──────────────────────────────────────────────────────────
  const covHex = cov.expected && cov.live < cov.expected ? STATE_HEX.attention : STATE_HEX.ok;
  const badgeBg = allNeeds.length ? (arrived > 0 && !flashOn ? '#B45309' : STATE_HEX.attention) : null;
  const header = (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={err ? (stale ? STATE_HEX.attention : STATE_HEX.blind) : '#3F3F46'} paddingX={1}>
        <Text wrap="truncate">
          {[...'◉ LUCID'].map((ch, i) => <Text key={i} bold color={GRAD[i % GRAD.length]}>{ch}</Text>)}
          <Text color={PALETTE.dim}>  │  </Text>
          <Text bold>{clockLondonSec(t)}</Text><Text color={PALETTE.dim}> London</Text>
          <Text color={PALETTE.dim}>  │  </Text>
          {sit ? <Text color={covHex}>{meter(cov.live, cov.expected)} {cov.live}/{cov.expected}</Text> : <Text color={PALETTE.dim}>▱▱▱▱▱ -/-</Text>}
          <Text color={PALETTE.dim}>  │  </Text>
          {!sit ? <Text color={PALETTE.dim}>- need you</Text> : badgeBg
            ? <Text backgroundColor={badgeBg} color="#0B1220" bold> {allNeeds.length} need you </Text>
            : <Text bold color={STATE_HEX.ok}>0 need you</Text>}
          {filterLabel ? <Text bold color={PALETTE.accent}>  │  filter: {filterLabel}</Text> : null}
          {arrived > 0 ? <Text bold color={STATE_HEX.ok}> +{arrived} new</Text> : null}
          <Text color={PALETTE.dim}>  │  </Text>
          <Text color={PALETTE.muted}>
            {fetching ? <Text color={PALETTE.brand}>{SPINNER[spin % SPINNER.length]} </Text> : null}
            {agoS == null ? 'connecting' : `updated ${agoS}s ago`}
          </Text>
        </Text>
      </Box>
      {err ? (
        <Text bold wrap="truncate" color={stale ? STATE_HEX.attention : STATE_HEX.blind}>
          {stale ? `⚠ STALE ${agoS}s` : '✖ NO DATA'} · LUCID unreachable: {err.status || err.code || err.message} · retrying, {stale ? 'showing the last good data' : 'nothing is known yet (this is not "all quiet")'}
        </Text>
      ) : null}
      {hinted && !err ? (
        <Text wrap="truncate" backgroundColor={PALETTE.brand} color="#0B1220" bold>{pad(' ↑↓ move · Enter open · Tab switch panel · ? help ', cols - 2)}</Text>
      ) : null}
    </Box>
  );

  if (!sit) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box marginTop={1}>
          <Text color={err ? STATE_HEX.blind : PALETTE.dim}>
            {err ? 'No data yet. LUCID cannot be reached, so nothing is known (this is not "all quiet").' : 'Connecting to LUCID...'}
          </Text>
        </Box>
        <Box marginTop={1}><Text color={PALETTE.dim}>r refresh · q quit</Text></Box>
      </Box>
    );
  }

  // ── panes ───────────────────────────────────────────────────────────
  const focus = (p) => pane === p;

  const needsBody = (w, rowsAvail) => {
    const iw = innerOf(w);
    const f = focus('needs');
    if (needs.length === 0 && !liveGhosts.length) {
      return (
        <Text color={STATE_HEX.ok}>{filter ? 'Nothing needs you in this area.' : 'Nothing needs you right now.'}{spots.length ? <Text color={PALETTE.dim}> (check what I can't see)</Text> : null}</Text>
      );
    }
    const tw = iw - 14;
    const isNewOf = (it) => newAt.current.has(it.ref) && wall - newAt.current.get(it.ref) < NEW_MS;
    const textOf = (it) => (isNewOf(it) ? '● ' : '') + (it.L0 || '');
    const nGhost = Math.min(2, liveGhosts.length);
    const win = fitWindow(needs, safeSel, expandedRef, rowsAvail - nGhost, iw, (it) => wrap(textOf(it), tw).length);
    const above = win.start;
    const below = needs.length - win.end;
    return (
      <>
        {above > 0 ? <Text color={PALETTE.dim}>  ↑ {above} more</Text> : null}
        {needs.slice(win.start, win.end).map((it, k) => {
          const i = win.start + k;
          const on = i === safeSel;
          const open = expandedRef === it.ref;
          const a = it.L1 || {};
          const ms = (it.L2 && it.L2.measures) || [];
          const isNew = isNewOf(it);
          const bg = on ? (f ? BAR_BG : BAR_BG_DIM) : undefined;
          const lines = wrap(textOf(it), tw);
          const fg = isNew ? STATE_HEX.ok : on ? '#FFFFFF' : PALETTE.muted;
          return (
            <Box key={it.ref} flexDirection="column">
              {lines.map((ln, li) => (
                <Text key={li} wrap="truncate" backgroundColor={bg} bold={on && f} dimColor={!f && !on}>
                  <Text bold color={on ? (f ? '#FFFFFF' : PALETTE.muted) : PALETTE.dim}>{li === 0 ? (on ? '▶ ' : '  ') : '  '}</Text>
                  {li === 0 ? <Pill urgency={it.urgency} /> : <Text>{' '.repeat(11)}</Text>}
                  <Text color={fg}> {pad(ln, tw)}</Text>
                </Text>
              ))}
              {open ? (
                <Box flexDirection="column" marginLeft={3} marginBottom={1}>
                  {[['Who', a.who], ['What', a.what], ['Why', a.why], ['When', whenText(a.when, t)]].filter(([, v]) => v).map(([lbl, v]) => (
                    <Box key={lbl}><Box width={6}><Text color={PALETTE.dim}>{lbl}</Text></Box><Box width={iw - 9}><Text color={PALETTE.text}>{wrap(v, iw - 9).join('\n')}</Text></Box></Box>
                  ))}
                  {(a.affected || []).length ? (
                    <Text wrap="truncate" color={PALETTE.dim}>{pad('Affects', 6)} <Text color={PALETTE.muted}>{clip(a.affected.map(nm).filter(Boolean).join(', '), iw - 14)}</Text></Text>
                  ) : null}
                  {ms.length ? <Text bold color={PALETTE.accent}>What you can do</Text> : <Text color={PALETTE.dim}>No actions to offer here. Esc closes.</Text>}
                  {ms.map((m, mi) => {
                    const mOn = mi === mSel;
                    return (
                      <Text key={m.id} wrap="truncate" backgroundColor={mOn ? '#6D28D9' : undefined} bold={mOn}>
                        <Text color={mOn ? '#FFFFFF' : PALETTE.dim}>{mOn ? '❯ ' : '  '}</Text>
                        <Text color={mOn ? '#FFFFFF' : PALETTE.text}>{pad(clip(m.say || m.label, iw - 24), iw - 24)}</Text>
                        <Text color={m.risk === 'dangerous' ? STATE_HEX.blind : m.risk === 'gated' ? STATE_HEX.attention : mOn ? '#FFFFFF' : PALETTE.dim}> {m.risk}</Text>
                      </Text>
                    );
                  })}
                  {ms.some((m) => m.command) && ms[mSel] && ms[mSel].command
                    ? <Text wrap="truncate" color={PALETTE.code}>  $ {clip(ms[mSel].command, iw - 12)}</Text> : (ms.some((m) => m.command) ? <Text> </Text> : null)}
                </Box>
              ) : null}
            </Box>
          );
        })}
        {liveGhosts.slice(0, 2).map((g) => (
          <Text key={'g' + g.item.ref} wrap="truncate" color={PALETTE.dim} dimColor>  ✓ resolved  {clip(g.item.L0 || '', iw - 14)}</Text>
        ))}
        {below > 0 ? <Text color={PALETTE.dim}>  ↓ {below} more</Text> : null}
      </>
    );
  };

  const changedBody = (w, rowsAvail) => {
    const iw = innerOf(w);
    const f = focus('changed');
    if (!changed.length) return <Text color={PALETTE.dim}>Nothing has changed.</Text>;
    const tw = iw - 7;
    const textOf = (c) => {
      const words = changedWords(c);
      return (c.L0 || '') + (words ? ` · ${words}` : '');
    };
    const win = fitWindow(changed, safeCh, null, rowsAvail, iw, (c) => wrap(textOf(c), tw).length);
    const above = win.start;
    const below = changed.length - win.end;
    return (
      <>
        {above > 0 ? <Text color={PALETTE.dim}>  ↑ {above} more</Text> : null}
        {changed.slice(win.start, win.end).map((c, k) => {
          const i = win.start + k;
          const on = i === safeCh && f;
          return (
            <Box key={c.ref + c.ts} flexDirection="column">
              {wrap(textOf(c), tw).map((ln, li) => (
                <Text key={li} wrap="truncate" backgroundColor={on ? BAR_BG : undefined} bold={on} dimColor={!f}>
                  <Text color={on ? '#FFFFFF' : PALETTE.dim}>{li === 0 ? `${on ? '▶ ' : '  '}${pad(ageOf(c.ts, t), 3)} ` : ' '.repeat(7)}</Text>
                  <Text color={on ? '#FFFFFF' : PALETTE.text}>{pad(ln, tw)}</Text>
                </Text>
              ))}
            </Box>
          );
        })}
        {below > 0 ? <Text color={PALETTE.dim}>  ↓ {below} more</Text> : null}
      </>
    );
  };

  const areasBody = (w, rowsAvail) => {
    const iw = innerOf(w);
    const f = focus('areas');
    const list = [{ area: null, label: 'All areas', state: null }, ...areas];
    const win = winLines(list.length, safeAr, rowsAvail);
    return list.slice(win.start, win.end).map((a, k) => {
      const i = win.start + k;
      const on = i === safeAr && f;
      const active = (a.area || null) === filter;
      const n = a.area ? allNeeds.filter((x) => x.area === a.area).length : allNeeds.length;
      return (
        <Text key={a.area || 'all'} wrap="truncate" backgroundColor={on ? BAR_BG : undefined} bold={on} dimColor={!f && !active}>
          <Text color={on ? '#FFFFFF' : PALETTE.dim}>{on ? '▶ ' : '  '}</Text>
          <Text color={a.state ? (STATE_HEX[a.state] || PALETTE.muted) : PALETTE.muted}>{a.state ? (GLYPH[a.state] || '?') : '◉'} </Text>
          <Text color={on ? '#FFFFFF' : PALETTE.text}>{pad(clip(a.label || a.area, iw - 9), iw - 9)}</Text>
          <Text color={n ? STATE_HEX.attention : PALETTE.dim}> {n ? String(n).padStart(2) : ' ·'}</Text>
          <Text color={PALETTE.accent}>{active ? ' ●' : '  '}</Text>
        </Text>
      );
    });
  };

  const counts = {
    needs: needs.length + (filter ? `/${allNeeds.length}` : ''),
    changed: changed.length,
    areas: areas.length,
  };
  const bodies = { needs: needsBody, changed: changedBody, areas: areasBody };

  let body;
  if (help) {
    const K = (k, d) => (
      <Text key={k}><Text bold color={PALETTE.brand}>{pad(k, 14)}</Text><Text color={PALETTE.text}>{d}</Text></Text>
    );
    body = (
      <Panel title="KEYS" count="" focused width={cols - 2} height={bodyH}>
        {K('↑ ↓  j k', 'move the highlighted row (inside an open item: pick an action)')}
        {K('Tab / S-Tab', 'switch panel: Needs you, Since you looked, Areas')}
        {K('Enter', 'open an item / do the highlighted action / filter by area')}
        {K('d', 'do something about the selected item (asks y/n first)')}
        {K('Esc', 'close the item, cancel a question, clear the area filter')}
        {K('u', 'teach: treat this kind of item as not urgent (asks y/n)')}
        {K('c', 'teach: you care about this item (asks y/n)')}
        {K('m', 'mark everything since you looked as seen')}
        {K('r', 'refresh now (it also refreshes every 10s)')}
        {K('?', 'close this help')}
        {K('q  Ctrl-C', 'quit')}
        <Text color={PALETTE.dim}>Press ? or Esc to go back.</Text>
      </Panel>
    );
  } else if (wide) {
    const sl = slide ? slide * 4 : 0;
    const needsH = big ? bodyH : Math.ceil(bodyH * 0.6);
    const chH = bodyH - needsH;
    body = (
      <Box width={cols - 2 - sl} marginLeft={sl}>
        <Panel title={PANE_TITLE.areas} count={counts.areas} focused={focus('areas')} width={leftW} height={bodyH}>
          {areasBody(leftW, listRows)}
        </Panel>
        {big ? (
          <>
            <Panel title={PANE_TITLE.needs} count={counts.needs} focused={focus('needs')} width={mainW + sl} height={bodyH} note={filterLabel ? `· ${filterLabel}` : ''}>
              {needsBody(mainW, listRows)}
            </Panel>
            <Panel title={PANE_TITLE.changed} count={counts.changed} focused={focus('changed')} width={rightW} height={bodyH}>
              {changedBody(rightW, listRows)}
            </Panel>
          </>
        ) : (
          <Box flexDirection="column">
            <Panel title={PANE_TITLE.needs} count={counts.needs} focused={focus('needs')} width={mainW + sl} height={needsH} note={filterLabel ? `· ${filterLabel}` : ''}>
              {needsBody(mainW, needsH - 3)}
            </Panel>
            <Panel title={PANE_TITLE.changed} count={counts.changed} focused={focus('changed')} width={mainW + sl} height={chH}>
              {changedBody(mainW, chH - 3)}
            </Panel>
          </Box>
        )}
      </Box>
    );
  } else {
    const stackW = cols - 2;
    const others = PANES.filter((p) => p !== pane);
    const focH = Math.max(6, bodyH - others.length);
    body = (
      <Box flexDirection="column">
        <Panel title={PANE_TITLE[pane]} count={counts[pane]} focused width={stackW} height={focH} note={filterLabel && pane === 'needs' ? `· ${filterLabel}` : ''}>
          {bodies[pane](stackW, focH - 3)}
        </Panel>
        {others.map((p) => (
          <Text key={p} wrap="truncate" color={PALETTE.dim}> ▸ {PANE_TITLE[p]} {counts[p]}  (Tab)</Text>
        ))}
      </Box>
    );
  }

  // ── status line (always says what you are on and what Enter does) ───
  let where; let act;
  if (confirm) {
    where = 'Waiting for your answer'; act = [['y', 'yes, do it'], ['n', 'cancel']];
  } else if (help) {
    where = 'Help'; act = [['?', 'back'], ['q', 'quit']];
  } else if (pane === 'needs') {
    if (!cur) { where = `▶ Needs you · ${filter ? 'none in ' + filterLabel : 'nothing needs you'}`; act = [['Tab', 'switch panel'], ['?', 'help']]; }
    else if (isOpen) {
      const m = curMeasures[mSel];
      where = `▶ Needs you · ${safeSel + 1} of ${needs.length} · open: ${clip(cur.L0 || '', 50)}`;
      act = m ? [['↑↓', 'pick action'], ['Enter', `do "${clip(m.label, 18)}" (asks first)`], ['Esc', 'close']] : [['Esc', 'close']];
    } else {
      where = `▶ Needs you · ${safeSel + 1} of ${needs.length} · ${clip(cur.L0 || '', 60)}`;
      act = [['Enter', 'open'], ['d', 'do something'], ['u', 'not urgent'], ['c', 'I care'], ['m', 'mark all seen']];
    }
  } else if (pane === 'changed') {
    const c = changed[safeCh];
    where = c ? `▶ Since you looked · ${safeCh + 1} of ${changed.length} · ${clip(c.L0 || '', 60)}` : '▶ Since you looked · nothing changed';
    act = [['Enter', 'show detail'], ['m', 'mark all seen'], ['Tab', 'next panel']];
  } else {
    const a = areas[safeAr - 1];
    where = `▶ Areas · ${safeAr + 1} of ${areas.length + 1} · ${a ? a.label + ': ' + clip(a.L0 || '', 50) : 'all areas'}`;
    act = [['Enter', a ? `filter Needs you to ${a.label}` : 'show everything'], ['Tab', 'next panel']];
  }

  const hints = confirm ? [['y', 'yes'], ['n', 'no'], ['Esc', 'cancel']]
    : help ? [['?/Esc', 'close help'], ['q', 'quit']]
      : isOpen ? [['↑↓', 'pick action'], ['Enter/d', 'do it'], ['Esc', 'close'], ['?', 'help'], ['q', 'quit']]
        : [['↑↓', 'move'], ['Enter', pane === 'areas' ? 'filter' : 'open'], ['Tab', 'switch panel'], ['d', 'do'], ['m', 'mark seen'], ['?', 'help'], ['q', 'quit']];

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {body}
      {confirm ? (
        <Text wrap="truncate" backgroundColor={STATE_HEX.attention} color="#0B1220" bold> {confirm.text.endsWith('y/n') ? confirm.text : confirm.text + ' y/n'}{confirm.extra ? '  ·  ' + confirm.extra : ''} </Text>
      ) : noteLive ? (
        <Text wrap="truncate" bold color={noteHex}>{noteLive.tone === 'ok' ? '✔ ' : noteLive.tone === 'bad' ? '✖ ' : noteLive.tone === 'busy' ? '◐ ' : 'ℹ '}{noteLive.text}</Text>
      ) : (
        <Text wrap="truncate" color={spots.length || dau.length ? STATE_HEX.attention : PALETTE.dim}>
          {dau.length ? `doesn't add up (${dau.length}): ${clip(dau[0].L0 || '', 60)} · ` : ''}{spots.length ? `can't see: ${spots.map((s) => s.text).join(' · ')}` : 'Every expected source is speaking.'}
        </Text>
      )}
      <Text wrap="truncate">
        <Text bold color={PALETTE.accent}>{where}</Text>
        <Text color={PALETTE.dim}>  ·  </Text>
        {act.map(([k, l], i) => (
          <Text key={k}>{i ? '  ' : ''}<Text bold color={PALETTE.brand}>{k}:</Text><Text color={PALETTE.muted}> {l}</Text></Text>
        ))}
      </Text>
      <Hints items={hints} cols={cols} />
    </Box>
  );
}
