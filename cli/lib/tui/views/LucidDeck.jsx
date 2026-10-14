/**
 * LucidDeck: the full-screen live LUCID situation deck (`quox lucid deck`), in the Quoxon look.
 *
 * One vertical cursor. Up/Down (j/k) move through the focused pane's list,
 * Tab / Shift-Tab switch pane (Needs you, Since you looked, Areas), Enter
 * opens / acts, Esc backs out, ? is help, q quits. Every action echoes what it
 * did and why in a toast; keys that do nothing say so.
 *
 * Look (Quoxon design system): theme roles for every colour, headings in the sky to violet gradient, the
 * perpetual Q as the status glyph (needs you = waiting, fetching = working, unreachable = failing, quiet =
 * resting), areas and Needs-you items as inline object cards (lucid/cards.js) that drop in through katakana.
 * Motion: ONE shared clock (quoxon/motion/clock.js). Frames are demanded only while something moves; idle
 * the deck has no animation timer and writes nothing (the only recurring work is the fetch interval).
 *
 * Props are injected (api, intervalMs, intro) so the component is testable
 * without a network. api = { situation(), measure(ref, id), teach(body), ack(seq) }.
 * Never shows an empty all-quiet view on failure: errors render in the header
 * and the last good data stays on screen, marked STALE.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { wrap, clip, ageOf, meter, clockLondon, whenText, changedWords, blindSpots } from '../../lucid/fmt.js';
import { LucidIntro } from '../../lucid/LucidIntro.jsx';
import { LucidCard } from '../../lucid/LucidCard.jsx';
import { lucidArea, lucidNeed, cardHeight } from '../../lucid/cards.js';
import { glyphStateOf, glyphAnimating, revealT, deckDemands, nextMinuteAt, SETTLE_MS, REVEAL_MS, STAGGER_MS } from '../../lucid/motion.js';
import { QGlyph } from '../../quoxon/qmotion.js';
import { c, gradient, mono } from '../../quoxon/theme.js';
import { Clock, motionAllowed } from '../../quoxon/motion/clock.js';

const PANES = ['needs', 'changed', 'areas'];
const PANE_TITLE = { needs: 'NEEDS YOU', changed: 'SINCE YOU LOOKED', areas: 'AREAS' };
const PANE_WORD = { needs: 'Needs you', changed: 'Since you looked', areas: 'Areas' };
const BAR_BG = '#1E3A8A';       // selected row bar
const NEW_MS = 4000;
const GHOST_MS = 4000;
const TOAST_MS = 3000;

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

/** Window over items of known line heights so the selected one is visible within `rows` lines. */
export function windowHeights(heights, sel, rows) {
  let start = 0;
  const fits = (s) => {
    let used = 0;
    for (let i = s; i <= sel; i++) used += heights[i];
    return used <= rows;
  };
  while (start < sel && !fits(start)) start++;
  let used = 0; let end = start;
  while (end < heights.length && used + heights[end] <= rows) { used += heights[end]; end++; }
  if (end === start && heights.length) end = start + 1;
  return { start, end };
}

/** Window of items to render so the selected one is visible within `rows` lines. */
export function windowItems(items, sel, expandedRef, rows, w, base) {
  const heights = items.map((it) => itemsLines(it, it.ref === expandedRef, w, base ? base(it) : 1));
  return windowHeights(heights, sel, rows);
}

/** Window by rendered line heights; when the list overflows, 2 lines are kept for the "N more" markers. */
export function fitHeights(heights, sel, rows) {
  let win = windowHeights(heights, sel, rows);
  if (win.start > 0 || win.end < heights.length) win = windowHeights(heights, sel, Math.max(1, rows - 2));
  return win;
}
export function fitWindow(items, sel, expandedRef, rows, w, base) {
  let win = windowItems(items, sel, expandedRef, rows, w, base);
  if (win.start > 0 || win.end < items.length) win = windowItems(items, sel, expandedRef, Math.max(1, rows - 2), w, base);
  return win;
}

export function signature(sit) {
  if (!sit) return '';
  return JSON.stringify([
    (sit.needs_you || []).map((i) => i.ref + i.urgency),
    (sit.changed || []).map((c) => c.ref + c.ts),
    (sit.areas || []).map((a) => a.state),
  ]);
}

/** A heading in the Quoxon gradient (plain muted under NO_COLOR). */
function Grad({ text, bold = true }) {
  return <>{gradient(text).map((g, i) => <Text key={i} bold={bold} color={g.color}>{g.ch}</Text>)}</>;
}

function Hints({ items }) {
  return (
    <Text wrap="truncate" color={c('muted')}>
      {items.map(([k, l], i) => (
        <Text key={k + l}>{i ? '   ' : ''}<Text bold color={c('key')}>{k}</Text><Text color={c('muted')}> {l}</Text></Text>
      ))}
    </Text>
  );
}

/** A pane title rule: gradient heading when focused, quiet when not, a rule running to the pane's edge. */
function PaneTitle({ title, count, focused, width, note }) {
  const head = ` ${title} `;
  const tail = `${count === '' ? '' : ` ${count}`}${note ? `  ${note}` : ''} `;
  const fill = Math.max(0, width - 3 - [...head].length - [...tail].length);
  return (
    <Text wrap="truncate">
      <Text color={focused ? c('sky') : c('faint')}>{focused ? '▶' : '─'}</Text>
      <Text color={focused ? c('sky') : c('faint')}>─</Text>
      {focused ? <Grad text={head} /> : <Text color={c('muted')} bold>{head}</Text>}
      <Text color={focused ? c('value') : c('muted')}>{tail}</Text>
      <Text color={focused ? c('sky') : c('faint')}>{'─'.repeat(fill)}</Text>
    </Text>
  );
}

export function LucidDeck({ api, intervalMs = 10000, now = () => Date.now(), onExit, intro = false, motion }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, setSizeTick] = useState(0);
  const cols = (stdout && stdout.columns) || 100;
  const rows = (stdout && stdout.rows) || 30;
  const motionOn = useMemo(() => (motion != null ? Boolean(motion) : motionAllowed(stdout && stdout.isTTY)), [motion, stdout]);

  const [phase, setPhase] = useState(intro ? 'intro' : 'deck');
  const [data, setData] = useState(null);       // last good response
  const [err, setErr] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [, setFrame] = useState(0);             // bumped by the shared clock
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
  const startAt = useRef(new Map());            // card key -> when its drop-in starts (may be a few ms ahead)
  const revealUntil = useRef(0);
  const errAt = useRef(null);
  const glyph = useRef({ state: null, since: null });

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

  const startCard = (key, at) => {
    startAt.current.set(key, at);
    revealUntil.current = Math.max(revealUntil.current, at + REVEAL_MS);
    if (startAt.current.size > 400) for (const [k, v] of startAt.current) if (Date.now() - v > 60000) startAt.current.delete(k);
  };

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setFetching(true);
    try {
      const res = await apiRef.current.situation();
      const sit = res && res.situation;
      const cur = (sit && sit.needs_you) || [];
      const at = Date.now();
      if (prevNeeds.current) {
        const have = new Set(prevNeeds.current.map((i) => i.ref));
        const nowRefs = new Set(cur.map((i) => i.ref));
        let fresh = 0;
        for (const i of cur) if (!have.has(i.ref)) { newAt.current.set(i.ref, at); startCard('n:' + i.ref, at); fresh++; }
        for (const i of prevNeeds.current) if (!nowRefs.has(i.ref)) ghosts.current.push({ item: i, at });
        if (fresh) setArrived((n) => n + fresh);
      } else {
        // the first board: cards drop in top to bottom
        cur.forEach((i, k) => startCard('n:' + i.ref, at + k * STAGGER_MS));
        ((sit && sit.areas) || []).forEach((a, k) => startCard('a:' + a.area, at + (k + 1) * STAGGER_MS));
        startCard('a:', at);
      }
      prevNeeds.current = cur;
      sigRef.current = signature(sit);
      setData(res);
      setErr(null);
      errAt.current = null;
      setFetchedAt(nowRef.current());
    } catch (e) {
      if (errAt.current == null) errAt.current = Date.now();
      setErr(e);
    } finally {
      inflight.current = false;
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  // ---- the one clock -------------------------------------------------------------------------------
  // Each render declares what it still needs (see lucid/motion.js); with nothing declared there is no timer.
  const clockRef = useRef(null);
  if (!clockRef.current) clockRef.current = new Clock(() => setFrame((x) => x + 1));
  const demandRef = useRef(null);
  useEffect(() => { if (demandRef.current) clockRef.current.schedule(demandRef.current()); });
  useEffect(() => () => clockRef.current.stop(), []);

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
    const c0 = confirm; setConfirm(null);
    if (c0) c0.run();
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
      const c1 = changed[safeCh];
      if (!c1) { flash('Nothing is selected.', 'dim'); return; }
      flash(`${c1.L0 || 'Change'}${changedWords(c1) ? ': ' + changedWords(c1) : ''}`, 'ok');
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
        <LucidIntro data={data} err={err} onDone={introDone} rows={rows} cols={cols} motion={motionOn} />
      </Box>
    );
  }

  const wall = Date.now();
  const t = now();
  const cov = (sit && sit.cannot_see && sit.cannot_see.coverage) || { live: 0, expected: 0 };
  const stale = Boolean(err && data);
  const ageText = fetchedAt ? ageOf(fetchedAt, t) : null;
  const noteLive = note && wall - note.at < (note.tone === 'bad' ? 6000 : TOAST_MS) ? note : null;
  const noteRole = noteLive ? ({ ok: 'ok', bad: 'error', busy: 'sky', dim: 'muted' }[noteLive.tone]) : null;
  const spots = blindSpots(sit && sit.cannot_see);
  const dau = (sit && sit.doesnt_add_up) || [];
  ghosts.current = ghosts.current.filter((g) => wall - g.at < GHOST_MS);
  const liveGhosts = ghosts.current.filter((g) => !filter || g.item.area === filter);

  // ---- the Q: LUCID state -> glyph state, animated only for a short window after a change ----------------
  const gState = glyphStateOf({ err, fetching, needs: allNeeds.length });
  if (glyph.current.state !== gState) glyph.current = { state: gState, since: wall };
  const gAnimating = glyphAnimating({ state: gState, since: glyph.current.since, now: wall, motion: motionOn });
  const headGlyph = <QGlyph state={gState} ms={wall} since={gState === 'failing' ? glyph.current.since : null} quiet={!gAnimating} />;

  // ---- what this render still needs from the clock --------------------------------------------------------
  const newExpiries = [...newAt.current.values()].map((v) => v + NEW_MS);
  demandRef.current = () => {
    const w = Date.now();
    return deckDemands({
      motion: motionOn,
      frames: gAnimating || w < revealUntil.current,
      now: w,
      at: [
        noteLive ? noteLive.at + (noteLive.tone === 'bad' ? 6000 : TOAST_MS) : null,
        ...ghosts.current.map((g) => g.at + GHOST_MS),
        ...newExpiries,
        motionOn && glyph.current.since != null ? glyph.current.since + SETTLE_MS : null,
        nextMinuteAt(w, t),
      ],
    });
  };
  const revealOf = (key) => revealT(startAt.current.get(key), wall, motionOn);

  // ── layout ──────────────────────────────────────────────────────────
  const wide = cols >= 80;
  const big = cols >= 110;
  const leftW = big ? 24 : 22;
  const avail = cols - 2 - leftW;
  const rightW = big ? avail - Math.round(avail * 0.55) : 0;   // below 110 cols Since-you-looked stacks under Needs-you
  const mainW = avail - rightW;
  const headerH = 3 + (err ? 1 : 0);
  const hintH = hinted && !err ? 1 : 0;
  const footerH = 3;
  const bodyH = Math.max(8, rows - headerH - hintH - footerH - 1);
  const listRows = bodyH - 1;                                  // one line for the pane title rule

  // ── header ──────────────────────────────────────────────────────────
  const covRole = cov.expected && cov.live < cov.expected ? 'warn' : 'ok';
  const hot = arrived > 0 && gState === 'waiting' && gAnimating;
  const header = (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={err ? (stale ? c('warn') : c('error')) : c('faint')} paddingX={1}>
        <Text wrap="truncate">
          {headGlyph}<Text> </Text><Grad text="LUCID" />
          <Text color={c('muted')}>  │  </Text>
          <Text bold color={c('value')}>{clockLondon(t)}</Text><Text color={c('muted')}> London</Text>
          <Text color={c('muted')}>  │  </Text>
          {sit ? <Text color={c(covRole)}>{meter(cov.live, cov.expected)} {cov.live}/{cov.expected}</Text> : <Text color={c('muted')}>▱▱▱▱▱ -/-</Text>}
          <Text color={c('muted')}>  │  </Text>
          {!sit ? <Text color={c('muted')}>- need you</Text> : allNeeds.length
            ? <Text bold color={c('warn')}>{allNeeds.length} need you</Text>
            : <Text bold color={c('ok')}>0 need you</Text>}
          {filterLabel ? <Text bold color={c('key')}>  │  filter: {filterLabel}</Text> : null}
          {arrived > 0 ? <Text bold color={hot ? c('warn') : c('ok')}> +{arrived} new</Text> : null}
          <Text color={c('muted')}>  │  </Text>
          <Text color={c('muted')}>{ageText == null ? 'connecting' : `updated ${ageText} ago`}</Text>
        </Text>
      </Box>
      {err ? (
        <Text bold wrap="truncate" color={stale ? c('warn') : c('error')}>
          {stale ? `⚠ STALE ${ageText}` : '✖ NO DATA'} · LUCID unreachable: {err.status || err.code || err.message} · retrying, {stale ? 'showing the last good data' : 'nothing is known yet (this is not "all quiet")'}
        </Text>
      ) : null}
      {hinted && !err ? (
        <Text wrap="truncate" backgroundColor={mono() ? undefined : BAR_BG} color={mono() ? undefined : '#FFFFFF'} inverse={mono()} bold>{pad(' ↑↓ move · Enter open · Tab switch panel · ? help ', cols - 2)}</Text>
      ) : null}
    </Box>
  );

  if (!sit) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box marginTop={1}>
          <Text color={err ? c('error') : c('muted')}>
            {err ? 'No data yet. LUCID cannot be reached, so nothing is known (this is not "all quiet").' : 'Connecting to LUCID...'}
          </Text>
        </Box>
        <Box marginTop={1}><Text color={c('muted')}>r refresh · q quit</Text></Box>
      </Box>
    );
  }

  // ── panes ───────────────────────────────────────────────────────────
  const focus = (p) => pane === p;
  const isNewOf = (it) => newAt.current.has(it.ref) && wall - newAt.current.get(it.ref) < NEW_MS;
  const areaLabelOf = (k) => ((areas.find((a) => a.area === k) || {}).label || '');

  const needsBody = (w, rowsAvail) => {
    const cw = Math.max(24, w - 1);
    const f = focus('needs');
    if (needs.length === 0 && !liveGhosts.length) {
      return (
        <Text color={c('ok')}>{filter ? 'Nothing needs you in this area.' : 'Nothing needs you right now.'}{spots.length ? <Text color={c('muted')}> (check what I can't see)</Text> : null}</Text>
      );
    }
    const views = needs.map((it, i) => lucidNeed({
      item: it, areaLabel: filter ? '' : areaLabelOf(it.area), isNew: isNewOf(it), selected: i === safeSel, focused: f,
      open: expandedRef === it.ref, mSel, now: t,
    }, cw));
    const nGhost = Math.min(2, liveGhosts.length);
    const win = fitHeights(views.map(cardHeight), safeSel, rowsAvail - nGhost);
    const above = win.start;
    const below = needs.length - win.end;
    return (
      <>
        {above > 0 ? <Text color={c('muted')}>  ↑ {above} more</Text> : null}
        {needs.slice(win.start, win.end).map((it, k) => (
          <LucidCard key={it.ref} view={views[win.start + k]} t={revealOf('n:' + it.ref)} />
        ))}
        {liveGhosts.slice(0, 2).map((g) => (
          <Text key={'g' + g.item.ref} wrap="truncate" color={c('muted')} dimColor>  ✓ resolved  {clip(g.item.L0 || '', Math.max(10, w - 16))}</Text>
        ))}
        {below > 0 ? <Text color={c('muted')}>  ↓ {below} more</Text> : null}
      </>
    );
  };

  const changedBody = (w, rowsAvail) => {
    const iw = Math.max(10, w - 2);
    const f = focus('changed');
    if (!changed.length) return <Text color={c('muted')}>Nothing has changed.</Text>;
    const tw = iw - 7;
    const textOf = (c0) => {
      const words = changedWords(c0);
      return (c0.L0 || '') + (words ? ` · ${words}` : '');
    };
    const win = fitHeights(changed.map((c0) => wrap(textOf(c0), tw).length), safeCh, rowsAvail);
    const above = win.start;
    const below = changed.length - win.end;
    return (
      <>
        {above > 0 ? <Text color={c('muted')}>  ↑ {above} more</Text> : null}
        {changed.slice(win.start, win.end).map((c0, k) => {
          const i = win.start + k;
          const on = i === safeCh && f;
          return (
            <Box key={c0.ref + c0.ts} flexDirection="column">
              {wrap(textOf(c0), tw).map((ln, li) => (
                <Text key={li} wrap="truncate" backgroundColor={on && !mono() ? BAR_BG : undefined} inverse={on && mono()} bold={on}>
                  <Text color={on ? '#FFFFFF' : c('muted')}>{li === 0 ? `${on ? '▶ ' : '  '}${pad(ageOf(c0.ts, t), 3)} ` : ' '.repeat(7)}</Text>
                  <Text color={on ? '#FFFFFF' : (li === 0 ? c('text') : c('muted'))}>{pad(ln, tw)}</Text>
                </Text>
              ))}
            </Box>
          );
        })}
        {below > 0 ? <Text color={c('muted')}>  ↓ {below} more</Text> : null}
      </>
    );
  };

  const areasBody = (w, rowsAvail) => {
    const cw = Math.max(18, w - 1);
    const f = focus('areas');
    const list = [{ area: null, label: 'All areas', state: null }, ...areas];
    const views = list.map((a, i) => {
      const n = a.area ? allNeeds.filter((x) => x.area === a.area).length : allNeeds.length;
      return lucidArea({
        area: a.area, label: a.label, state: a.state, L0: a.L0, last: a.last, n, active: (a.area || null) === filter && filter != null,
        selected: i === safeAr && f, focused: f, expanded: i === safeAr && f, now: t,
      }, cw);
    });
    const win = fitHeights(views.map(cardHeight), safeAr, rowsAvail);
    return (
      <>
        {win.start > 0 ? <Text color={c('muted')}>  ↑ {win.start} more</Text> : null}
        {list.slice(win.start, win.end).map((a, k) => (
          <LucidCard key={a.area || 'all'} view={views[win.start + k]} t={revealOf('a:' + (a.area || ''))} />
        ))}
        {win.end < list.length ? <Text color={c('muted')}>  ↓ {list.length - win.end} more</Text> : null}
      </>
    );
  };

  const counts = {
    needs: needs.length + (filter ? `/${allNeeds.length}` : ''),
    changed: changed.length,
    areas: areas.length,
  };
  const bodies = { needs: needsBody, changed: changedBody, areas: areasBody };
  const col = (p, w, h0, children, note0) => (
    <Box flexDirection="column" width={w} height={h0}>
      <PaneTitle title={PANE_TITLE[p]} count={counts[p]} focused={focus(p)} width={w - 1} note={note0} />
      {children}
    </Box>
  );

  let body;
  if (help) {
    const K = (k, d) => (
      <Text key={k}><Text bold color={c('key')}>{pad(k, 14)}</Text><Text color={c('text')}>{d}</Text></Text>
    );
    body = (
      <Box flexDirection="column" height={bodyH}>
        <PaneTitle title="KEYS" count="" focused width={cols - 2} />
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
        <Text color={c('muted')}>Press ? or Esc to go back.</Text>
      </Box>
    );
  } else if (wide) {
    const needsH = big ? bodyH : Math.ceil(bodyH * 0.6);
    const chH = bodyH - needsH;
    const nNote = filterLabel ? `· ${filterLabel}` : '';
    body = (
      <Box width={cols - 2}>
        {col('areas', leftW, bodyH, areasBody(leftW, listRows))}
        {big ? (
          <>
            {col('needs', mainW, bodyH, needsBody(mainW, listRows), nNote)}
            {col('changed', rightW, bodyH, changedBody(rightW, listRows))}
          </>
        ) : (
          <Box flexDirection="column" width={mainW}>
            {col('needs', mainW, needsH, needsBody(mainW, needsH - 1), nNote)}
            {col('changed', mainW, chH, changedBody(mainW, chH - 1))}
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
        {col(pane, stackW, focH, bodies[pane](stackW, focH - 1), filterLabel && pane === 'needs' ? `· ${filterLabel}` : '')}
        {others.map((p) => (
          <Text key={p} wrap="truncate" color={c('muted')}> ▸ {PANE_TITLE[p]} {counts[p]}  (Tab)</Text>
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
    const c1 = changed[safeCh];
    where = c1 ? `▶ Since you looked · ${safeCh + 1} of ${changed.length} · ${clip(c1.L0 || '', 60)}` : '▶ Since you looked · nothing changed';
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
        <Text wrap="truncate" backgroundColor={mono() ? undefined : c('warn')} inverse={mono()} color={mono() ? undefined : '#0B1220'} bold> {confirm.text.endsWith('y/n') ? confirm.text : confirm.text + ' y/n'}{confirm.extra ? '  ·  ' + confirm.extra : ''} </Text>
      ) : noteLive ? (
        <Text wrap="truncate" bold color={c(noteRole)}>{noteLive.tone === 'ok' ? '✔ ' : noteLive.tone === 'bad' ? '✖ ' : noteLive.tone === 'busy' ? '◐ ' : 'ℹ '}{noteLive.text}</Text>
      ) : (
        <Text wrap="truncate" color={spots.length || dau.length ? c('warn') : c('muted')}>
          {dau.length ? `doesn't add up (${dau.length}): ${clip(dau[0].L0 || '', 60)} · ` : ''}{spots.length ? `can't see: ${spots.map((s) => s.text).join(' · ')}` : 'Every expected source is speaking.'}
        </Text>
      )}
      <Text wrap="truncate">
        <Text bold color={c('key')}>{where}</Text>
        <Text color={c('muted')}>  ·  </Text>
        {act.map(([k, l], i) => (
          <Text key={k}>{i ? '  ' : ''}<Text bold color={c('sky')}>{k}:</Text><Text color={c('muted')}> {l}</Text></Text>
        ))}
      </Text>
      <Hints items={hints} />
    </Box>
  );
}
