/**
 * Getting started: the Ink view bare `quox` shows when no server is configured (FIRST_RUN_JOURNEY.md, C2a).
 * A labelled, scripted setup guide: no model, no account, no network beyond local checks. It is deliberately a
 * separate module from app.js; main.js picks one or the other.
 *
 * Steps: ask -> offer (Y/n) | declined -> preflight -> credential -> key -> install (installStop) ->
 *        ownerEmail -> ownerPassword -> finishing -> finale | notyet
 * With no finisher (the dry run) install goes straight to the finale, as in C2a.
 * Every line of copy comes from ./copy.js.
 */
import React from 'react';
import { Box, Static, Text, useStdin, useStdout } from 'ink';
import { HistoryItem, Row, introAnimates, clampCols } from '../render.js';
import { c, clip } from '../theme.js';
import { parseChunk, initialKeyState, PASTE_ON, PASTE_OFF } from '../keys.js';
import { packageVersion } from '../welcome.js';
import * as T from './copy.js';
import { matchIntent, yesNo, parseConnect } from './intent.js';
import { loadJourney, saveJourney, clearJourney, resumeStep } from './journey.js';
import { pendingRows, runPreflight, preflightPassed, detectOllama, defaultDeps } from './preflight.js';
import { credentialOptions, KEY_PROVIDERS, normaliseOllamaUrl } from './credential.js';
import { HelloIntro, helloIntroMs } from '../qmotion.js';
import { launchEgg } from '../egg.js';
import { passwordProblem, emailOk, generatePassword } from './finish.js';

const h = React.createElement;
const GLYPH = { ok: '✔', fail: '✖', warn: '⚠', running: '◐', pending: '·' };
const TONE = { ok: 'ok', fail: 'fail', warn: 'warn', running: 'sky', pending: 'dim' };
const fmtS = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** Word wrap to `width` columns; each line is its own <Text>, so every wrapped line keeps its colour. */
export function wrapWords(text, width) {
  const w = Math.max(8, width);
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      let wd = word;
      while ([...wd].length > w) { if (line) { out.push(line); line = ''; } out.push([...wd].slice(0, w).join('')); wd = [...wd].slice(w).join(''); }
      if (!line) line = wd;
      else if ([...line].length + 1 + [...wd].length <= w) line += ' ' + wd;
      else { out.push(line); line = wd; }
    }
    out.push(line);
  }
  return out;
}
const Para = ({ text, width, color, bold }) => h(Box, { flexDirection: 'column' }, ...wrapWords(text, width).map((l, i) => h(Text, { key: i, color, bold }, l)));

// ---- static items -----------------------------------------------------------------------------
function Item({ item, cols }) {
  switch (item.kind) {
    case 'intro': return h(HelloIntro, { item, cols, text: T.HELLO });
    case 'welcome': case 'user': return h(HistoryItem, { item, cols });
    case 'header': return h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, null, h(Text, { color: c('violet'), bold: true }, T.LABEL), h(Text, { color: c('dim') }, ' ' + '─'.repeat(Math.max(1, cols - T.LABEL.length - 1)))),
      h(Text, { color: c('dim') }, clip(T.LABEL_SUB, cols)));
    case 'guide': return h(Box, { marginTop: item.gap === false ? 0 : 1, paddingLeft: 2 }, h(Para, { width: cols - 2, color: c(item.tone || 'text'), bold: Boolean(item.bold), text: item.text }));
    case 'dim': return h(Box, { paddingLeft: 2 }, h(Para, { width: cols - 2, color: c(item.tone || 'dim'), text: item.text }));
    case 'cmd': return h(Box, { paddingLeft: 4 }, h(Para, { width: cols - 4, color: c('sky'), text: item.text }));
    case 'long': { // a URL or hash that must never be hard-wrapped (copy, click): one line if it fits, else its own line
      if ([...item.text].length <= cols - 2) return h(Box, { marginTop: item.gap === false ? 0 : 1, paddingLeft: 2 }, h(Text, { color: c(item.tone || 'text') }, item.text));
      return h(Box, { flexDirection: 'column', marginTop: item.gap === false ? 0 : 1, paddingLeft: 2 },
        h(Para, { width: cols - 2, color: c(item.tone || 'text'), text: item.lead }),
        h(Box, { width: [...item.value].length + 2 }, h(Text, { color: c('sky'), wrap: 'truncate-end' }, item.value)));
    }
    case 'list': return h(Box, { flexDirection: 'column', paddingLeft: 2 }, ...item.items.map((t, i) => h(Box, { key: i, flexDirection: 'row' },
      h(Text, { color: c('sky') }, item.numbered ? `${i + 1}  ` : '·  '), h(Para, { width: cols - 5, color: c('text'), text: t }))));
    case 'rows': return h(Box, { flexDirection: 'column', marginTop: 1 }, ...item.rows.map((r, i) => h(CheckRow, { key: i, r, cols })));
    default: return null;
  }
}

function CheckRow({ r, cols }) {
  return h(Box, { flexDirection: 'column' },
    h(Row, { glyph: GLYPH[r.status] || '·', tone: TONE[r.status] || 'dim', name: r.name, body: r.body, tail: r.tail, cols }),
    r.status === 'fail' && r.fix ? h(Box, { paddingLeft: 6, flexDirection: 'column' },
      h(Para, { width: cols - 6, color: c('placeholder'), text: r.fix }),
      r.link ? h(Text, { color: c('sky') }, clip(r.link, cols - 6)) : null) : null);
}

function InputLine({ text, placeholder, cols, masked = false }) {
  const shown = masked ? '•'.repeat(Math.min([...text].length, Math.max(4, cols - 20))) : text;
  const room = cols - 4;
  const tail = [...shown].slice(-room).join('');
  return h(Box, { marginTop: 1 },
    h(Text, { color: c('sky'), bold: true }, '› '),
    tail ? h(Text, { color: c('input') }, tail) : null,
    h(Text, { inverse: true }, ' '),
    !tail && placeholder ? h(Text, { color: c('placeholder') }, ' ' + clip(placeholder, room - 2)) : null,
    masked && text ? h(Text, { color: c('dim') }, `  ${[...text].length} chars`) : null);
}

const Hint = ({ text, cols }) => h(Box, { paddingLeft: 2 }, h(Text, { color: c('dim') }, clip(text, cols - 2)));

// ---- the view ---------------------------------------------------------------------------------
export function GettingStarted({
  columns, version = '0.3.0', cwd = '', welcome = false, animateIntro, earlyInput = null,
  journeyPath, dryRun = false, runner = null, preflightDeps, runChecks = runPreflight, findOllama = detectOllama,
  requestCredential, broker = null, finisher = null, onExit = () => {}, now = () => Date.now()
}) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const cols = clampCols(columns ?? ((stdout?.columns || 80) - 1));
  const [, force] = React.useState(0);
  const rerender = () => force(n => n + 1);
  const seq = React.useRef(0);
  const nid = () => `g${seq.current++}`;

  const saved = React.useMemo(() => (journeyPath ? loadJourney(journeyPath) : null), []);
  const resumeAt = resumeStep(saved);
  const introItem = { id: 'intro', kind: 'intro', text: `${version} · Getting started · ${cwd}` };
  const opening = () => {
    const items = [introItem, ...(welcome ? [{ id: 'welcome', kind: 'welcome', version: packageVersion() }] : []), { id: 'hdr', kind: 'header' }];
    if (resumeAt) {
      items.push({ id: 'resume', kind: 'guide', text: T.RESUME });
      if (saved.request) items.push({ id: 'resumeReq', kind: 'dim', text: T.resumeRequest(saved.request) });
    } else {
      items.push({ id: 'greet', kind: 'guide', text: T.GREETING_REST }, { id: 'q', kind: 'guide', text: T.QUESTION }, { id: 'ex', kind: 'list', items: T.EXAMPLES, numbered: true });
    }
    return items;
  };

  const S = React.useRef({
    history: [], step: 'ask', input: '', intent: saved?.intent || null, request: saved?.request || null, provider: saved?.provider === 'skip' ? 'skip' : null,
    rows: [], fixNote: null, options: [], sel: 1, flash: null, install: null, logs: [], showLog: false, done: false, secret: null,
    installStage: saved?.installStage || null, installDir: saved?.installDir || null, dashboardUrl: saved?.dashboardUrl || null,
    ownerEmail: saved?.ownerEmail || null, finRows: [], stopping: false, vault: null
  });
  const set = (patch) => { S.current = { ...S.current, ...(typeof patch === 'function' ? patch(S.current) : patch) }; rerender(); };
  const push = (...items) => set(s => ({ history: [...s.history, ...items.map(it => ({ id: nid(), ...it }))] }));
  const persist = (extra = {}) => {
    if (!journeyPath) return;
    const c = S.current;
    saveJourney({ step: c.step, intent: c.intent, request: c.request, provider: c.provider, installStage: c.installStage, installDir: c.installDir, dashboardUrl: c.dashboardUrl, ownerEmail: c.ownerEmail, ...(c.ollamaUrl ? { ollamaUrl: c.ollamaUrl } : {}), ...extra }, journeyPath, () => new Date(now()).toISOString());
  };
  const live = React.useRef(true);
  React.useEffect(() => () => { live.current = false; }, []);

  // ---- intro (Orbit & Lock), then the opening lines move into <Static> --------------------------
  const animating = animateIntro ?? introAnimates(stdout?.isTTY);
  // Orbit & Lock, then the Q says hello (T.HELLO decodes in beside it); rarely the dragon's googly-eye greeting after that.
  const eye = React.useMemo(() => (animating && animateIntro === undefined ? launchEgg({ tty: Boolean(stdout?.isTTY) }) : false), []);
  const introMs = helloIntroMs({ eye, text: T.HELLO });
  const introStart = React.useRef(Date.now());
  const [, setFrame] = React.useState(0);
  const introDone = React.useRef(false);
  const finishIntro = () => {
    if (introDone.current) return;
    introDone.current = true;
    S.current = { ...S.current, history: [...opening(), ...S.current.history] };
    if (resumeAt === 'offer') offerLines();
    else if (resumeAt === 'preflight') startPreflight();
    else rerender();
  };
  React.useEffect(() => {
    if (!animating) { finishIntro(); return undefined; }
    introStart.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - introStart.current >= introMs) { clearInterval(id); setTimeout(finishIntro, 0); }
      setFrame(f => f + 1);
    }, 50);
    return () => clearInterval(id);
  }, []);

  // ---- steps ------------------------------------------------------------------------------------
  const exit = (result) => {
    if (S.current.done) return;
    S.current.secret?.drop?.();
    set({ done: true, secret: null });
    setTimeout(() => onExit(result), 0);
  };

  function offerLines() {
    const items = [{ kind: 'guide', text: T.OFFER }];
    items.push({ kind: 'guide', text: T.OFFER_ASK, bold: true, gap: false }, { kind: 'dim', text: T.ALREADY });
    push(...items);
    set({ step: 'offer' });
    persist();
  }

  function onRequest(text) {
    const m = matchIntent(text);
    if (m.intent === 'empty') return;
    push({ kind: 'user', text });
    if (m.intent === 'connect') { push({ kind: 'guide', text: T.CONNECT_INTENT_LINE }); set({ step: 'ask' }); return; }
    set({ intent: m.intent, request: text });
    push({ kind: 'guide', text: m.intent === 'offscript' ? T.DEFERRAL : T.INTENT_LINES[m.intent] });
    offerLines();
  }

  function onSlash(text) {
    const t = text.trim();
    if (/^\/(exit|quit|q)$/i.test(t)) { push({ kind: 'user', text: t }, { kind: 'dim', text: T.BYE }); persist(); exit({ action: 'exit' }); return true; }
    if (/^\/help$/i.test(t)) { push({ kind: 'user', text: t }, { kind: 'list', items: T.HELP.map(([k, v]) => `${k}   ${v}`) }); return true; }
    const conn = parseConnect(t);
    if (conn) {
      push({ kind: 'user', text: t });
      if (!conn.ok) { push({ kind: 'dim', tone: 'warn', text: conn.reason === 'url' ? T.connectBadUrl(conn.value) : T.CONNECT_USAGE }); return true; }
      push({ kind: 'guide', text: T.connectHandoff(conn.url) });
      exit({ action: 'connect', url: conn.url });
      return true;
    }
    push({ kind: 'user', text: t }, { kind: 'dim', tone: 'warn', text: T.SLASH_UNKNOWN });
    return true;
  }

  function submit() {
    const s = S.current;
    const text = s.input.trim();
    set({ input: '' });
    if (text.startsWith('/')) { onSlash(text); return; }
    if (s.step === 'ask') return onRequest(text);
    if (s.step === 'offer' || s.step === 'declined') {
      const yn = yesNo(text);
      if (yn === true) { push({ kind: 'user', text: text || 'yes' }); startPreflight(); return; }
      if (yn === false) { push({ kind: 'user', text }, { kind: 'guide', text: T.DECLINED }, { kind: 'dim', text: T.DECLINED_HINT }); set({ step: 'declined' }); persist(); return; }
      return onRequest(text); // a new request instead of an answer
    }
  }

  async function startPreflight() {
    set({ step: 'preflight', rows: pendingRows(), fixNote: null });
    persist();
    // resuming an install this guide started: its own ports being busy is expected
    const deps = S.current.installStage ? { ...(preflightDeps || defaultDeps()), ownInstall: true } : preflightDeps;
    const rows = await runChecks(deps, (r) => { if (live.current) set(s => ({ rows: s.rows.map(x => (x.id === r.id ? r : x)) })); });
    if (!live.current || S.current.done) return;
    if (!preflightPassed(rows)) { set({ step: 'preflightFail', rows, fixNote: T.PREFLIGHT_FAIL }); return; }
    push({ kind: 'guide', text: T.PREFLIGHT_TITLE, bold: true }, { kind: 'rows', rows }, { kind: 'guide', tone: 'ok', text: T.PREFLIGHT_OK });
    toCredential();
  }

  async function toCredential() {
    set({ rows: [] });
    if (S.current.provider === 'skip') { // Z2H-R2B: the owner already chose "Skip for now"; never re-ask on resume (/connect stays open)
      push({ kind: 'guide', tone: 'warn', text: T.CRED_SKIPPED });
      startInstall();
      return;
    }
    const ollama = await findOllama();
    if (!live.current || S.current.done) return;
    const options = credentialOptions({ ollama });
    push({ kind: 'guide', text: T.CRED_TITLE, bold: true });
    set({ step: 'credential', options, sel: Math.max(0, options.findIndex(o => !o.disabled)), flash: null });
    persist();
  }

  async function choose(opt) {
    if (!opt) return;
    if (opt.disabled) { set({ flash: T.CRED_CHATGPT_SOON }); return; }
    set({ flash: null, provider: opt.id });
    if (KEY_PROVIDERS.has(opt.id)) {
      set({ step: 'key', input: '' });
      const held = await requestCredential(opt.id); // THE hook: K1 secure card once it merges
      if (!live.current || S.current.done) { held?.drop?.(); return; }
      if (!held) { set({ step: 'credential', input: '' }); return; }
      push({ kind: 'user', text: opt.label }, { kind: 'guide', tone: 'ok', text: T.credHeld(opt.label, held.fingerprint) }, ...(opt.id === 'openai' ? [{ kind: 'guide', text: T.credConsent(opt.label) }] : []));
      set({ secret: held, input: '' });
    } else if (opt.id === 'ollama' && !opt.detected) {
      set({ step: 'ollamaUrl', input: '' }); // B3: nothing answered locally; ask for the LAN URL
      return;
    } else {
      push({ kind: 'user', text: opt.label }, { kind: 'guide', tone: opt.id === 'skip' ? 'warn' : 'ok', text: opt.id === 'skip' ? T.CRED_SKIPPED : T.CRED_OLLAMA });
    }
    startInstall();
  }

  function submitOllamaUrl() {
    const url = normaliseOllamaUrl(S.current.input);
    if (!url) { set({ flash: T.OLLAMA_URL_BAD }); return; }
    push({ kind: 'user', text: url }, { kind: 'guide', tone: 'ok', text: T.ollamaChosen(url) });
    set({ input: '', flash: null, ollamaUrl: url });
    startInstall();
  }

  async function startInstall() {
    if (!runner) { // no runner (should not happen outside tests): say so, and give the installer command
      push({ kind: 'guide', text: T.INSTALL_NOT_YET }, { kind: 'cmd', text: T.INSTALL_COMMAND }, { kind: 'dim', text: T.INSTALL_NOT_YET_AFTER });
      if (S.current.secret) { S.current.secret.drop(); push({ kind: 'dim', tone: 'warn', text: T.INSTALL_KEY_GONE }); }
      set({ step: 'notyet', secret: null });
      persist({ step: 'install' });
      return;
    }
    const dry = runner.kind === 'dry-run';
    const healthOnly = !dry && (S.current.installStage === 'start' || S.current.installStage === 'health');
    if (!dry && runner.installDir) set({ installDir: runner.installDir });
    if (!dry && S.current.install == null) {
      if (runner.installDir) push({ kind: 'dim', text: T.installWhere(runner.installDir) });
      if (healthOnly) push({ kind: 'dim', text: T.INSTALL_HEALTH_ONLY });
    }
    const stages = runner.stages.map(st => ({ id: st.id, name: st.id.toUpperCase(), body: st.label, status: 'pending', startedAt: null, ms: null, earlier: false }));
    set({ step: 'install', install: { stages, kind: runner.kind, failed: null, degraded: false }, logs: [], showLog: false, stopping: false });
    persist();
    const ac = new AbortController();
    S.current.abort = ac;
    const res = await runner.run({
      signal: ac.signal, request: S.current.request,
      resumeFrom: S.current.installStage, resumeDashboardUrl: S.current.dashboardUrl,
      onCheckpoint: (id, extra = {}) => { // the last COMPLETED stage, so the next quox resumes honestly
        set({ installStage: id, ...(extra.dashboardUrl ? { dashboardUrl: extra.dashboardUrl } : {}) });
        persist({ step: 'install' });
      },
      onEvent: (ev) => {
        if (!live.current) return;
        if (ev.type === 'log') set(s => ({ logs: [...s.logs, ev.line].slice(-8) }));
        if (ev.type === 'script') push({ kind: 'long', tone: 'dim', gap: false, text: T.installScript(ev.url, ev.sha256, ev.bytes), lead: T.installScriptLead(ev.url, ev.bytes), value: ev.sha256 });
        if (ev.type === 'stage-label') set(s => ({ install: { ...s.install, stages: s.install.stages.map(x => (x.id === ev.id ? { ...x, body: ev.label } : x)) } }));
        if (ev.type === 'stage') set(s => ({ install: { ...s.install, stages: s.install.stages.map(x => (x.id === ev.id ? { ...x, status: ev.status, startedAt: ev.status === 'running' ? ev.at : x.startedAt, ms: ev.ms ?? x.ms, earlier: Boolean(ev.earlier) } : x)) } }));
      }
    });
    S.current.abort = null;
    if (!live.current || S.current.done) return;
    if (res.interrupted || S.current.stopping) {
      push({ kind: 'dim', text: T.INSTALL_STOPPED }); persist({ step: 'install' }); exit({ action: 'exit' }); return;
    }
    if (res.logPath) set({ installLogPath: res.logPath });
    if (res.dashboardUrl) set({ dashboardUrl: res.dashboardUrl });
    const rows = S.current.install.stages.map(st => ({ ...st, tail: st.earlier ? T.INSTALL_EARLIER : st.ms != null ? fmtS(st.ms) : '' }));
    if (!res.ok) { set(s => ({ step: 'installFail', install: { ...s.install, failed: res.failedStage || '?', degraded: Boolean(res.degraded), error: res.error || null, logPath: res.logPath || null } })); persist({ step: 'install' }); return; }
    push({ kind: 'guide', text: T.INSTALL_TITLE + (dry ? ` (${T.INSTALL_DRY})` : ''), bold: true }, { kind: 'rows', rows });
    if (dry || !finisher) { finale({ dashboardUrl: res.dashboardUrl, dry }); return; }
    toOwner();
  }

  // ---- owner account (C2c) ----------------------------------------------------------------------
  function toOwner(note = null) {
    if (note) push({ kind: 'guide', tone: 'warn', text: note });
    else push({ kind: 'guide', text: T.OWNER_TITLE, bold: true }, { kind: 'dim', text: T.OWNER_WHY });
    set({ step: 'ownerEmail', input: S.current.ownerEmail || '', flash: null });
    persist({ step: 'owner' });
  }
  function onOwnerEmail() {
    const email = S.current.input.trim();
    if (!emailOk(email)) { set({ flash: T.OWNER_EMAIL_BAD }); return; }
    push({ kind: 'user', text: email });
    set({ ownerEmail: email, step: 'ownerPassword', input: '', flash: null });
    persist({ step: 'owner' });
  }
  function onOwnerPassword() {
    let pw = S.current.input;
    set({ input: '' });
    if (!pw) {
      pw = generatePassword(); // shown once, here, then only the token is kept
      push({ kind: 'guide', tone: 'ok', text: T.ownerPwShownOnce(pw) }, { kind: 'dim', text: T.OWNER_PW_SAVE });
    } else {
      const bad = passwordProblem(pw);
      if (bad) { set({ flash: bad }); return; }
    }
    set({ flash: null });
    runFinish(S.current.ownerEmail, pw);
  }

  async function runFinish(email, password) {
    const F = T.FIN;
    const opt = credentialOptions({ ollama: true }).find(o => o.id === S.current.provider);
    const rows = [
      { id: 'account', name: F.account.name, status: 'running', body: F.account.running },
      { id: 'signin', name: F.signin.name, status: 'pending', body: F.signin.running },
      { id: 'vault', name: F.vault.name, status: 'pending', body: S.current.secret ? F.vault.running(opt?.label || 'key') : F.vault.skipped },
      { id: 'link', name: F.link.name, status: 'pending', body: F.link.running }
    ];
    const row = (id, patch) => set(s => ({ finRows: s.finRows.map(r => (r.id === id ? { ...r, ...patch } : r)) }));
    set({ step: 'finishing', finRows: rows });
    persist({ step: 'finishing' });

    const made = await finisher.createOwner({ email, password });
    if (!live.current || S.current.done) return;
    if (!made.ok && !made.existed) { set({ finRows: [] }); toOwner(made.error); set({ step: 'ownerPassword', input: '' }); return; }
    row('account', { status: 'ok', body: made.existed ? F.account.existing(email) : F.account.ok(email) });

    row('signin', { status: 'running' });
    const signed = await finisher.signIn({ email, password });
    password = null; // the password is not needed again; only the token is kept (in the profile)
    if (!live.current || S.current.done) return;
    if (!signed.ok) {
      set({ finRows: [] });
      toOwner(made.existed ? T.OWNER_EXISTS : signed.error);
      return;
    }
    row('signin', { status: 'ok', body: F.signin.ok(signed.org) });

    let vault = null;
    if (S.current.secret) {
      row('vault', { status: 'running' });
      vault = await finisher.storeCredential(S.current.secret); // drops the key, stored or not
      set({ secret: null });
      if (!live.current || S.current.done) return;
      row('vault', { status: vault.ok ? 'ok' : 'warn', body: String(vault.text || '').replace(/^[✔✖]\s*/, '') }); // the row glyph already says it
    } else {
      row('vault', { status: 'warn', body: S.current.provider === 'ollama' ? F.vault.ollama : F.vault.skipped });
    }
    set({ vault });

    row('link', { status: 'running' });
    const link = await finisher.loginLink(S.current.dashboardUrl);
    if (!live.current || S.current.done) return;
    row('link', link.ok ? { status: 'ok', body: F.link.ok } : { status: 'warn', body: F.link.fail(link.error) });

    push({ kind: 'guide', text: T.FINISH_TITLE, bold: true }, { kind: 'rows', rows: S.current.finRows });
    if (vault) push({ kind: 'dim', text: vault.ok ? T.KEY_GONE_AFTER : `${T.KEY_GONE_AFTER} ${T.keyNotStored(vault.provider || S.current.provider)}` });
    set({ finRows: [] });
    finale({ dashboardUrl: S.current.dashboardUrl, link: link.ok ? link.url : null, dry: false });
  }

  function replayText() {
    const { request, intent } = S.current;
    if (!request || intent === 'explore') return T.REPLAY_TOUR;
    return request;
  }

  function finale({ dashboardUrl, link = null, dry }) {
    const items = [];
    const intent = S.current.intent && T.TIPS[S.current.intent] ? S.current.intent : 'explore';
    if (dry) items.push({ kind: 'guide', tone: 'warn', text: T.FINALE_DRY_BANNER });
    items.push({ kind: 'guide', tone: 'ok', bold: true, text: T.FINALE_RUNNING },
      { kind: 'guide', text: T.finaleReplay(S.current.request && S.current.intent !== 'explore' ? S.current.request : null) });
    if (dry) items.push({ kind: 'dim', text: T.FINALE_REPLAY_DRY });
    const url = dashboardUrl || 'https://localhost:3000';
    if (dry || link) items.push({ kind: 'long', text: T.finaleDashboard(link || url), lead: T.FINALE_DASHBOARD_LEAD, value: link || url });
    else items.push({ kind: 'long', text: T.finaleDashboardPlain(url), lead: T.FINALE_DASHBOARD_LEAD_PLAIN, value: url });
    items.push({ kind: 'guide', gap: false, text: T.FINALE_PROOF });
    if (!dry) items.push({ kind: 'dim', text: T.FINALE_CERT });
    if (!dry && S.current.installLogPath) items.push({ kind: 'dim', text: T.INSTALL_LOG_PATH(S.current.installLogPath) });
    items.push({ kind: 'guide', text: T.FINALE_TIPS_TITLE }, { kind: 'list', items: dry ? T.FINALE_TIPS : T.TIPS[intent] });
    const noAi = !dry && (S.current.provider === 'skip' || (S.current.vault && !S.current.vault.ok));
    if (noAi) items.push({ kind: 'guide', text: T.FINALE_HOSTS_NO_AI });
    if (!dry) items.push({ kind: 'guide', text: noAi ? T.k2NoAi(S.current.provider === 'anthropic' ? 'anthropic' : 'openai') : T.K2[intent] });
    push(...items);
    S.current.secret?.drop?.();
    set({ step: 'finale', secret: null, finaleDry: dry });
    if (!dry && journeyPath) clearJourney(journeyPath);
  }

  // ---- keys -------------------------------------------------------------------------------------
  const K = React.useRef({ keys: initialKeyState() });
  const onKey = (ev) => {
    const s = S.current;
    if (s.done) return;
    if (ev.type === 'key' && (ev.name === 'ctrl-c' || ev.name === 'ctrl-d') && s.step === 'install') {
      set({ step: 'installStop' }); // never abort a running install on one keypress: ask first
      return;
    }
    if (ev.type === 'key' && (ev.name === 'ctrl-c' || ev.name === 'ctrl-d') && s.step === 'installStop') { stopInstall(); return; }
    if (ev.type === 'key' && (ev.name === 'ctrl-c' || ev.name === 'ctrl-d')) {
      if (s.step === 'key') broker?.cancel?.();
      S.current.abort?.abort?.();
      push({ kind: 'dim', text: T.BYE }); persist(); exit({ action: 'exit' }); return;
    }
    if (!introDone.current) { if (ev.type !== 'key') set({ input: s.input + ev.text.replace(/[\r\n]+/g, ' ') }); return; }
    switch (s.step) {
      case 'ask': case 'offer': case 'declined': return textKey(ev, submit);
      case 'key': return textKey(ev, () => {
        const v = S.current.input;
        if (!v.trim()) { set({ flash: T.CRED_EMPTY }); return; }
        set({ input: '', flash: null });
        broker?.submit?.(v.trim());
      }, () => { set({ input: '', flash: null }); broker?.cancel?.(); });
      case 'ollamaUrl': return textKey(ev, submitOllamaUrl, () => set({ step: 'credential', input: '', flash: null }));
      case 'preflightFail':
        if (ev.type === 'text' && /^r$/i.test(ev.text)) startPreflight();
        else if (ev.type === 'text' && /^c$/i.test(ev.text) && dryRun) {
          push({ kind: 'guide', text: T.PREFLIGHT_TITLE, bold: true }, { kind: 'rows', rows: s.rows }, { kind: 'guide', tone: 'warn', text: T.PREFLIGHT_CONTINUED });
          toCredential();
        }
        else if (ev.type === 'text' && /^q$/i.test(ev.text)) { push({ kind: 'dim', text: T.BYE }); persist({ step: 'preflight' }); exit({ action: 'exit' }); }
        return;
      case 'credential': {
        const n = s.options.length;
        if (ev.type === 'key' && ev.name === 'up') set({ sel: (s.sel - 1 + n) % n, flash: null });
        else if (ev.type === 'key' && (ev.name === 'down' || ev.name === 'tab')) set({ sel: (s.sel + 1) % n, flash: null });
        else if (ev.type === 'key' && ev.name === 'enter') choose(s.options[s.sel]);
        else if (ev.type === 'text' && /^[1-9]$/.test(ev.text) && Number(ev.text) <= n) { set({ sel: Number(ev.text) - 1 }); choose(s.options[Number(ev.text) - 1]); }
        return;
      }
      case 'install': if (ev.type === 'text' && /^v$/i.test(ev.text)) set({ showLog: !s.showLog }); return;
      case 'installStop':
        if (ev.type === 'text' && /^y/i.test(ev.text)) stopInstall();
        else if ((ev.type === 'text' && /^n/i.test(ev.text)) || (ev.type === 'key' && (ev.name === 'enter' || ev.name === 'escape'))) set({ step: 'install' });
        return;
      case 'ownerEmail': return textKey(ev, onOwnerEmail);
      case 'ownerPassword': return textKey(ev, onOwnerPassword, () => set({ step: 'ownerEmail', input: S.current.ownerEmail || '', flash: null }));
      case 'finishing': return;
      case 'installFail':
        if (ev.type === 'text' && /^v$/i.test(ev.text)) set({ showLog: !s.showLog });
        else if (ev.type === 'text' && /^r$/i.test(ev.text)) startInstall();
        return;
      case 'notyet': if (ev.type === 'key' && ev.name === 'enter') exit({ action: 'exit' }); return;
      case 'finale':
        if (ev.type === 'key' && ev.name === 'enter') exit(s.finaleDry || !finisher ? { action: 'exit' } : { action: 'connected', replay: replayText() });
        return;
      default:
    }
  };
  function stopInstall() {
    push({ kind: 'dim', text: T.INSTALL_STOP_ASK }, { kind: 'user', text: 'yes' });
    set({ stopping: true, step: 'install' });
    S.current.abort?.abort?.(); // the runner stops the installer's process group; startInstall then exits
  }

  function textKey(ev, onEnter, onEscape) {
    const s = S.current;
    const masked = s.step === 'key' || s.step === 'ownerPassword';
    if (ev.type === 'text' || ev.type === 'paste') set({ input: s.input + ev.text.replace(/[\r\n]+/g, masked ? '' : ' '), flash: null });
    else if (ev.name === 'backspace') set({ input: [...s.input].slice(0, -1).join('') });
    else if (ev.name === 'kill-line') set({ input: '' });
    else if (ev.name === 'enter') onEnter();
    else if (ev.name === 'escape' && onEscape) onEscape();
  }

  React.useEffect(() => {
    if (!stdin) return undefined;
    if (isRawModeSupported) setRawMode(true);
    if (stdout?.isTTY) stdout.write(PASTE_ON);
    const handle = (chunk) => {
      const parsed = parseChunk(chunk, K.current.keys);
      K.current.keys = parsed.state;
      for (const ev of parsed.events) onKey(ev);
    };
    if (earlyInput) { // typed before mount: into the input, never submitted
      earlyInput.detach();
      for (const chunk of earlyInput.chunks.splice(0)) {
        const parsed = parseChunk(chunk, K.current.keys);
        K.current.keys = parsed.state;
        for (const ev of parsed.events) if (ev.type === 'text' || ev.type === 'paste') S.current.input += ev.text.replace(/[\r\n]+/g, ' ');
      }
    }
    stdin.on('data', handle);
    return () => {
      stdin.off('data', handle);
      if (stdout?.isTTY) stdout.write(PASTE_OFF);
      if (isRawModeSupported) setRawMode(false);
    };
  }, [stdin]);

  // a ticking clock while a stage runs (elapsed time, never a fake percentage)
  React.useEffect(() => {
    if (S.current.step !== 'install' && S.current.step !== 'installStop') return undefined;
    const id = setInterval(rerender, 250);
    return () => clearInterval(id);
  }, [S.current.step]);

  // the broker drives the masked card (the K1 secure card replaces it)
  React.useEffect(() => broker?.subscribe?.(() => rerender()), [broker]);

  // ---- render -----------------------------------------------------------------------------------
  const s = S.current;
  const liveParts = [];
  if (!introDone.current) liveParts.push(h(HelloIntro, { key: 'intro', item: introItem, cols, text: T.HELLO, eye, t: Date.now() - introStart.current }));
  else if (!s.done) {
    switch (s.step) {
      case 'ask':
        liveParts.push(h(InputLine, { key: 'in', text: s.input, placeholder: T.INPUT_PLACEHOLDER, cols }), h(Hint, { key: 'hint', text: 'Enter to send · /help · /exit', cols }));
        break;
      case 'offer': case 'declined':
        liveParts.push(h(InputLine, { key: 'in', text: s.input, placeholder: s.step === 'offer' ? 'Enter for yes, or n' : 'yes, /connect server <url>, or /exit', cols }), h(Hint, { key: 'hint', text: 'Enter to send · /exit', cols }));
        break;
      case 'preflight': case 'preflightFail':
        liveParts.push(h(Box, { key: 'pf', marginTop: 1, paddingLeft: 2 }, h(Text, { bold: true, color: c('text') }, T.PREFLIGHT_TITLE)),
          ...s.rows.map((r) => h(CheckRow, { key: r.id, r, cols })));
        if (s.step === 'preflightFail') liveParts.push(h(Box, { key: 'pfn', marginTop: 1, paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('warn'), text: s.fixNote })), h(Hint, { key: 'h', text: dryRun ? T.PREFLIGHT_RETRY_DRY : T.PREFLIGHT_RETRY, cols }));
        break;
      case 'credential':
        liveParts.push(h(Box, { key: 'opts', flexDirection: 'column', marginTop: 1 }, ...s.options.map((o, i) => {
          const on = i === s.sel;
          return h(Text, { key: o.id },
            h(Text, { color: c(on ? 'sky' : 'dim') }, on ? '  › ' : '    '),
            h(Text, { color: c(o.disabled ? 'dim' : on ? 'input' : 'text'), bold: on && !o.disabled }, `${i + 1}  ${o.label}`),
            o.note ? h(Text, { color: c(o.id === 'skip' ? 'warn' : 'dim') }, clip(`  ${o.note}`, Math.max(4, cols - o.label.length - 9))) : null);
        })));
        if (s.flash) liveParts.push(h(Box, { key: 'fl', paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('warn'), text: s.flash })));
        liveParts.push(h(Hint, { key: 'h', text: T.CRED_HINT, cols }));
        break;
      case 'key': {
        const opt = s.options.find(o => o.id === s.provider);
        liveParts.push(h(Box, { key: 'card', flexDirection: 'column', marginTop: 1 },
          h(Text, { color: c('violet') }, '─'.repeat(cols)),
          h(Box, { paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('text'), text: T.credPrompt(opt?.label || 'API key') })),
          h(InputLine, { text: s.input, cols, masked: true }),
          s.flash ? h(Box, { paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('warn'), text: s.flash })) : null,
          h(Hint, { text: T.CRED_INPUT_HINT, cols }),
          h(Text, { color: c('violet') }, '─'.repeat(cols))));
        break;
      }
      case 'ollamaUrl':
        liveParts.push(h(Box, { key: 'card', flexDirection: 'column', marginTop: 1 },
          h(Text, { color: c('violet') }, '─'.repeat(cols)),
          h(Box, { paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('text'), text: T.OLLAMA_URL_PROMPT })),
          h(InputLine, { text: s.input, cols }),
          s.flash ? h(Box, { paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('warn'), text: s.flash })) : null,
          h(Hint, { text: T.OLLAMA_URL_HINT, cols }),
          h(Text, { color: c('violet') }, '─'.repeat(cols))));
        break;
      case 'ownerEmail': case 'ownerPassword': {
        const pw = s.step === 'ownerPassword';
        if (pw) liveParts.push(h(Box, { key: 'pwp', paddingLeft: 2, width: cols, marginTop: 1 }, h(Para, { width: cols - 2, color: c('text'), text: T.OWNER_PW_PROMPT })));
        liveParts.push(h(InputLine, { key: 'in', text: s.input, placeholder: pw ? '' : T.OWNER_EMAIL_PLACEHOLDER, cols, masked: pw }));
        if (s.flash) liveParts.push(h(Box, { key: 'fl', paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, color: c('warn'), text: s.flash })));
        liveParts.push(h(Hint, { key: 'h', text: pw ? T.OWNER_PW_HINT : 'Enter to continue', cols }));
        break;
      }
      case 'finishing':
        liveParts.push(h(Box, { key: 'ft', marginTop: 1, paddingLeft: 2 }, h(Text, { bold: true, color: c('text') }, T.FINISH_TITLE)),
          ...s.finRows.map((r) => h(CheckRow, { key: r.id, r, cols })));
        break;
      case 'install': case 'installFail': case 'installStop': {
        const t = now();
        const dry = s.install.kind === 'dry-run';
        liveParts.push(h(Box, { key: 'it', marginTop: 1, paddingLeft: 2, width: cols }, h(Para, { width: cols - 2, bold: true, color: c('text'), text: T.INSTALL_TITLE + (dry ? ` (${T.INSTALL_DRY})` : '') })));
        for (const st of s.install.stages) {
          const tail = st.earlier ? T.INSTALL_EARLIER : st.status === 'running' && st.startedAt ? fmtS(t - st.startedAt) : st.ms != null ? fmtS(st.ms) : '';
          liveParts.push(h(CheckRow, { key: st.id, r: { ...st, tail }, cols }));
        }
        if (s.showLog) liveParts.push(h(Box, { key: 'log', flexDirection: 'column', paddingLeft: 4, marginTop: 1 }, ...s.logs.map((l, i) => h(Text, { key: i, color: c('dim') }, clip(l, cols - 4)))));
        if (s.step === 'installFail') {
          liveParts.push(h(Box, { key: 'if', paddingLeft: 2, width: cols, marginTop: 1, flexDirection: 'column' },
            h(Para, { width: cols - 2, color: c('fail'), text: T.INSTALL_FAILED(T.STAGES[s.install.failed] || s.install.failed) }),
            s.install.error ? h(Para, { width: cols - 2, color: c('dim'), text: s.install.error }) : null,
            s.install.logPath ? h(Para, { width: cols - 2, color: c('dim'), text: T.INSTALL_LOG_PATH(s.install.logPath) }) : null,
            s.install.logPath ? h(Para, { width: cols - 2, color: c('dim'), text: T.INSTALL_RERUN_HINT }) : null,
            s.install.degraded ? h(Para, { width: cols - 2, color: c('warn'), text: T.INSTALL_DEGRADED }) : null));
        }
        if (s.step === 'installStop') liveParts.push(h(Box, { key: 'stop', paddingLeft: 2, width: cols, marginTop: 1 }, h(Para, { width: cols - 2, color: c('warn'), bold: true, text: T.INSTALL_STOP_ASK })));
        liveParts.push(h(Hint, { key: 'h', text: s.step === 'installFail' ? T.INSTALL_FAIL_HINT : s.step === 'installStop' ? 'y to stop · n or Enter to carry on' : T.INSTALL_HINT, cols }));
        break;
      }
      case 'notyet': case 'finale':
        liveParts.push(h(Box, { key: 'h', marginTop: 1 }, h(Hint, { text: s.step === 'finale' && !s.finaleDry && finisher ? T.FINALE_EXIT : T.FINALE_EXIT_DRY, cols })));
        break;
      default:
    }
  }
  return h(Box, { flexDirection: 'column' },
    h(Static, { items: introDone.current ? s.history : [] }, (it) => h(Box, { key: it.id, flexDirection: 'column' }, h(Item, { item: it, cols }))),
    ...liveParts);
}
