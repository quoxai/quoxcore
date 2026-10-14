/**
 * QUOXON app: composer + live turn. State lives in refs updated synchronously
 * (so a stdin chunk carrying several keys applies in order) and mirrored into
 * React state for rendering.
 */
import React from 'react';
import { Box, Static, Text, measureElement, useApp, useStdin, useStdout } from 'ink';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { bufferReducer, initialBuffer, sanitizeForSend } from './textBuffer.js';
import { parseChunk, initialKeyState, flushDangling, hasDangling, PASTE_ON, PASTE_OFF, PASTE_DANGLING_MS } from './keys.js';
import { reduce, initialState, approvalKeyAllowed, groupApprovals, isPrivileged, approvalSourceLabel } from './events.js';
import { turnTokens } from './indicator.js';
import {
  Composer, RingComposer, Pending, ApprovalCard, StatusLine, NotifyBar, Working, HistoryItem, liveRows, Intro, Roster, WaitingNotice, historyGap, INTRO_FRAMES, introAnimates, describeActivity, clampCols, clip, COLORS, revealTimingFor
} from './render.js';
import { c, mono } from './theme.js';
import { findEntry, helpModel, suggestCommands } from './commands.js';
import { osc52, pickCopy } from './copy.js';
import { detectSlotAgent } from './context.js';
import { rulesContext, rulesLabel, rulesLines } from './rules.js';
import { parseBang, quoxArgv, runBang, footer as bangFooter, truncNote as bangTruncNote, shareText, withShared, cleanOutput, DEFAULT_TIMEOUT_MS } from './bang.js';
import { nextTip, normaliseMode, tipSettingsReply, tipsReply, DEFAULT_MODE, TIPS, tryCommand, tipText } from './tips.js';
import { findSkill, skillRows, skillDetail, skillPrompt } from './skills.js';
import { rosterView, peekLines, selectRows, backgroundAlerts, isExpired } from './roster.js';
import { runObjectCommand } from './objects/index.js';
const OBJECT_CMDS = new Set(['/skills', '/agents', '/workflow', '/crystal', '/memory', '/rules', '/proof', '/reconcile']);
import { intentHint } from './intent.js';
import { observerLines } from './observers.js';
import { packageVersion } from './welcome.js';
import { INVITE, cleanName, loadNames, saveName, matchAgent, parseTarget, nearest, listFailure } from './session.js';
import { termRows } from './term.js';
import { createConnectController, connectionLines, connectOfferFor, looksLikeKey, keyWarning, providerFor, parseOllamaArg, connectOllamaFlow, ollamaModelRows, connectCompatFlow, compatModelRows, confirmLanAllow } from './connect.js';
import { ConnectCard } from './connectCard.js';
import { cmd as mark } from './palette.js';
import { createLoginController, LoginCard, SIGNED_OUT_LINE, signedOutCard, isSessionDead } from './signin.js';
import { isConsentError, consentHintLines, consentStatusLines } from './consent.js';
import { CHOICES, modelLines, selectModel, selectOllamaModel, selectCompatModel, adoptAfterConnect, selectDiscoveredModel, selectSubscriptionModel, modelLabel, fallbackNote, streamFields, normChoice } from './model.js';
import { overviewLines } from '../core/sessionsOverview.js';
import { capabilityLines, offerFor, findCapability } from './capabilities.js';
import { anyProviderConnected, NO_AI_CARD, NO_AI_STATUS, asksAddHost, asksWatchHosts, addHostLines } from './noai.js';
import { DragonLive, playDragon, dragonActive, resetDragon } from './qmotion.js';
import { AUTOPLAY, AUTOPLAY_REQUEST, AUTOPLAY_PROOF, typingPlan } from './demo.autoplay.js';
import { motionLevel, levelFeatures, moodForEvent, ignitionGlow, normaliseLevel } from './motion/level.js';
import { CLIPS as DRAGON_CLIPS } from './qdragonScenes.js';
import { DRAGON_USAGE, DRAGON_EXPLAINS, DRAGON_ANSWERS, NOTHING_TO_EXPLAIN, ASK_PROMPT, WAKE_MS, explainPrompt, askPrompt, lastOutput, parseDragonArg, sourceLines } from './dragonModes.js';
import { SleepScreen, DragonTalk, FlyLive } from './dragonView.js';
import { FLY_PASS_MS, FLY_STILL_MS } from './qdragonFly.js';
import { createSound } from './sound/index.js';
import { createPalette } from './slash/paletteController.js';
import { capabilityMap } from './slash/palette.js';
import { createArgSources } from './slash/argSources.js';
import { createModelCmd } from './slash/modelCmd.js';
import { normPrefs, parseModelSub, label as favLabel } from './modelPrefs.js';
import { ListView } from './slash/listView.js';
import { createLedger, costModel } from './slash/ledger.js';
import { statusModel, contextModel, doctorModel, chatChecks } from './slash/panels.js';
import { createPicker } from './slash/picker.js';
import { resumeRows, pickerRow, matchConversation, turnsToHistory } from './slash/resume.js';
import { settingsList, applySettings, configRows, cycle } from './slash/settings.js';
import { startBuildWatch } from './slash/restart.js';
import { dashboardLines } from './slash/dashboard.js';
import { supportsHyperlinks } from './markdown.js';
import { compactResult, compactError, contextFacts, compactShowLines } from './slash/compact.js';
import { intentPanel } from './intent.js';
import { awayDue, parseSince } from './away.js';
import { sitrepData } from './objects/sitrep.js';
import { launchEgg } from './egg.js';
import { INTRO_MS } from './qart.js';
import { Clock, FRAME_MS, SECOND_MS, motionAllowed, createFrames } from './motion/clock.js';
import { FrameContext, useFrame } from './motion/frame.js';
import { ringMode, ringAnimating } from './motion/ring.js';
import { TIMING, revealSpan } from './motion/reveal.js';
import { matchOrg, orgLines } from './orgSwitch.js';
import { isServerDown, waitForServer, SERVER_RESTARTING, explainTermination, RETRY_HINT } from './resend.js';

const h = React.createElement;
const PASTE_GUARD_MS = 40;
const MAX_ROSTER = 4;
const ESC_ESC_MS = 500;
const INTERRUPT_FALLBACK_MS = 8000;
const INTRO_FRAME_MS = 50; // intro frame period on the shared clock (the plan's length is INTRO_MS)
const HELD_WINDOW_MS = 1000; // a key seen this close before a card appears is treated as still held
const APPROVE_WORD = 'approve';
const CARD_GONE_MS = 400;
const FRESH_CARD_MS = 120000; // past this a card is stale even in its own turn: it needs explicit Tab focus
const CARD_EDIT_KEYS = ['backspace', 'delete', 'delete-word', 'kill-line', 'left', 'right', 'home', 'end', 'word-left', 'word-right', 'undo', 'redo'];


const STEER_OFF_NOTE = "This model can't take steering mid-turn; queued for next turn.";
const newTurnId = () => `QXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function openEditor(text) {
  const dir = mkdtempSync(join(tmpdir(), 'quoxon-'));
  const file = join(dir, 'prompt.md');
  writeFileSync(file, text, 'utf8');
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const r = spawnSync(editor, [file], { stdio: 'inherit' });
  let out = null;
  if (!r.error) out = readFileSync(file, 'utf8').replace(/\n+$/, '');
  try { unlinkSync(file); } catch { /* best-effort */ }
  return out;
}

export const friendlyError = (e, profile) =>
  (e?.status === 401 || /valid jwt|service key|unauthor/i.test(e?.message || ''))
    ? `Not signed in for chat on profile ${profile}. Run: quox login -p ${profile}` : (e?.message || String(e));

const byId = (id) => CHOICES.find(x => x.id === id) || null;
// the status line shows the new ask until the server answers
const NO_RAN = { provider: null, model: null, endpoint: null };

export function App({ slotAgent, notifyMs = 4000, resultPollMs = 3000, resultTimeoutMs = 120000, rosterMs = 15000, api, profile = 'default', org = null, version = '0.1.0', cwd = '', columns, demoLabel = null, verbose = 'on', mode = 'ask', editor = openEditor, introNote = null, animateIntro, earlyInput = null, startup = null, blocked: blockedProp = null, signedOut: signedOutProp = null, autoplay = null, rules = null, welcome = false, sessionName = null, invite = false, namesPath, transcript = null, modelChoice = null, resumeConversation = null, resume = null, onRestart = null, onDemo = null, restartCheck = null, startSha = null, buildWatch = startBuildWatch, env = process.env, motion, motionStats = null, away = null, tipStartup = false , interactive, resendDelays = null, demoAuto = null, agentLogin = false, humanProfiles = [] }) {
  // Z2H: signed-out is ONE state (card at the top + /login), not scattered errors. While it holds, `blocked` is the
  // one-line answer, so chat, /connect and the digest/approvals pollers stay quiet instead of printing raw 401s.
  const [signedOut, setSignedOut] = React.useState(signedOutProp);
  const blocked = blockedProp || (signedOut ? SIGNED_OUT_LINE : null);
  const BL = React.useRef(null); BL.current = blocked; // effects/timers created at mount read the live value
  const { exit: inkExit } = useApp();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [cols, setCols] = React.useState(clampCols(columns ?? ((stdout?.columns || 80) - 1)));
  const [, bump] = React.useState(0);
  // Every exit path goes through here: settle all in-flight katakana (Working word, drop-in reveals, sleep screen)
  // to plain text, let that frame paint, then unmount. Ink leaves its last frame in scrollback, so it must be plain.
  const exit = (afterMs = 0) => {
    const R0 = R.current;
    if (R0.exiting) return undefined;
    R0.exiting = true; R0.sleep = null; R0.fly = null;
    R0.bang?.run.kill(); // QUOXON-FW8: a running ! command is killed with us, never left behind
    resetDragon();
    bump(n => n + 1);
    return setTimeout(() => inkExit(), 60 + afterMs);
  };
  const [epoch, setEpoch] = React.useState(0);

  const introItem = { id: 'intro', kind: 'intro', text: `${version} · ${profile} · ${cwd}`, cols: clampCols(columns ?? ((process.stdout.columns || 80) - 1)) };
  const introHistory = () => [introItem,
    ...(welcome ? [{ id: 'welcome', kind: 'welcome', version: packageVersion() }] : []),
    ...(demoLabel ? [{ id: 'demo', kind: 'note', text: demoLabel, tone: 'warn' }] : []),
    ...(signedOutProp ? [{ id: 'signedOut', kind: 'note', text: signedOutCard(profile, signedOutProp.reason), tone: 'error' }] : []),
    ...(introNote ? [{ id: 'introNote', kind: 'note', text: introNote, tone: 'warn' }] : []),
    ...(invite ? [{ id: 'invite', kind: 'note', text: INVITE }] : [])];
  // The animated intro lives in the live region (no flicker, nothing printed twice) and moves into
  // <Static> history once settled. Any keypress skips it; the composer is usable throughout.
  const introAnimating = animateIntro ?? introAnimates(stdout?.isTTY);
  // Motion (decorative animation) is decided once: a real terminal and no QUOX_REDUCED_MOTION / LITE. Colour
  // is a separate setting (NO_COLOR); one never implies the other.
  const motionOn = motion ?? motionAllowed(stdout?.isTTY);
  const isInteractive = interactive ?? Boolean(stdout?.isTTY); // /dragon sleep takes over the screen: a real terminal only, never piped or headless
  // Motion level (motion/level.js): read live, so a /config change applies at once. calm = everything above.
  const feats = () => levelFeatures(motionLevel(env));
  const introStart = React.useRef(Date.now());
  // Cinematic: Orbit & Lock on every launch, then the dragon greets you (open, look, wink). Launch egg: rarely the same
  // dragon greeting on other levels (egg.js decides once per launch; never reduced motion).
  const introDragon = React.useMemo(() => introAnimating && !mono() && (feats().introDragon || (animateIntro === undefined && feats().launchEgg && launchEgg({ tty: Boolean(stdout?.isTTY) }))), []);
  const introMs = INTRO_MS + (introDragon ? DRAGON_CLIPS.greeting.dur + 300 : 0);
  const introDone = React.useRef(!introAnimating);
  const finishIntro = () => {
    if (introDone.current) return;
    introDone.current = true;
    const intro = introHistory();
    S.current = { ...S.current, history: [...intro, ...S.current.history] };
    committedRef.current = intro.length; // the intro itself is already on screen; later items may still reveal
    bump(n => n + 1);
  };
  const finishIntroRef = React.useRef(finishIntro);
  finishIntroRef.current = finishIntro;

  const S = React.useRef(initialState({
    verbose,
    history: introAnimating ? [] : introHistory()
  }));
  const B = React.useRef(initialBuffer());
  // Drop-in reveals: history items enter <Static> only once their reveal has ended (at most ~1 s); until then
  // they render in the live region. committedRef = how many history items <Static> has been given.
  const committedRef = React.useRef(introAnimating ? 0 : S.current.history.length);
  const fxRef = React.useRef(new Map()); // item id -> { at, timing, running, settleAt }
  const rosterSeen = React.useRef(new Map()); // roster row key -> first seen (ms)
  const K = React.useRef({ keys: initialKeyState(), lastKeyAt: null, lastKeyCh: null, lastDataAt: 0, lastPasteAt: 0, lastEscAt: 0, ctrlC: 0, guard: null, cardFocus: false, confirm: false, cardGoneAt: 0, typed: '', danglingTimer: null });
  const chromeRef = React.useRef(null);
  const chromeH = React.useRef(null);
  const R = React.useRef({ abort: null, histIdx: -1, history: [], stash: [], reviewing: false, fallbackTimer: null, ctrlCTimer: null, banner: null, closed: false, pollTimers: new Set(), caps: { steer: true, interrupt: true }, confirmMulti: null, roster: { rows: [], all: false, allRows: [], alerts: [], sources: null, on: true, focus: false, sel: 0, peek: false, confirm: null, stopping: false } });
  // E5: when this profile was last seen (read once at launch, before it is refreshed), and a throttled touch.
  const AWAY = React.useRef({ last: null, touched: 0 });
  const touchSeen = (force = false) => {
    const now = Date.now();
    if (!away || (!force && now - AWAY.current.touched < 60000)) return;
    AWAY.current.touched = now;
    try { away.write(profile, now); } catch { /* best effort */ }
  };

  const SND = React.useRef(null); SND.current ??= createSound({ api, stdout }); // QuoxSound: one subscription point (dispatch)
  const dispatch = (a) => {
    transcript?.action(a.redact !== undefined ? { ...a, text: a.redact } : a); // dev transcript capture (off by default; see transcript.js); `redact` is what the capture sees instead of a secret-bearing text
    const prevS = S.current; S.current = reduce(prevS, { now: Date.now(), ...a }); SND.current.observe(prevS, S.current, a);
    if (motionOn && !mono() && feats().moods) { const m = moodForEvent(prevS, a, S.current); if (m) playDragon(m); } // cinematic: the dragon reacts
    // Per shown card: remember the key that was already down when it appeared, and restart the typed word.
    const c0 = S.current.approvals[0];
    if (!c0 && K.current.guard) K.current.cardGoneAt = Date.now();
    const gid = c0 ? `${c0.callId}:${c0.displayedAt}` : null;
    if (gid !== K.current.guard?.id) {
      const k = K.current;
      const held = c0 && k.lastKeyAt != null && Date.now() - k.lastKeyAt < HELD_WINDOW_MS ? k.lastKeyCh : null;
      k.guard = gid ? { id: gid, heldKey: held } : null;
      k.typed = '';
      k.cardFocus = false; k.confirm = false;
    }
    if (!R.current.closed) bump(n => n + 1);
  };
  const edit = (a) => { B.current = bufferReducer(B.current, a); if (!B.current.text) { R.current.multiWarned = false; R.current.confirmMulti = null; } bump(n => n + 1); };
  const say = (text, tone) => dispatch({ type: 'note', text, tone });
  /** Z2H-3c: add-a-host lines, after probing that the server can actually serve its installer (null = unknown). */
  const hostLines = async () => {
    const base = await (api.hostsBaseUrl?.() ?? api.serverUrl?.());
    let check = null; try { check = base && api.hostInstallCheck ? await api.hostInstallCheck(base) : null; } catch { check = null; }
    return addHostLines(base, check);
  };
  // /model: the --provider flag wins for this run ('auto' = ignore the saved choice), else the profile's saved choice.
  const MC = React.useRef(modelChoice === 'auto' ? null : normChoice(modelChoice) || (api.modelChoice?.() ?? null));
  // /connect card: owns its own secret box; the key never enters dispatch, the buffer or history.
  const CN = React.useRef(null);
  CN.current ??= createConnectController({ api, note: (t, tone) => say(t, tone), emit: (a) => dispatch(a), refresh: () => bump(n => n + 1) });
  // /login card: email (prefilled), masked password, MFA code if asked. Same login path as `quox login`.
  const markSignedOut = (reason = null) => { if (BL.current) return; setSignedOut({ reason }); say(signedOutCard(profile, reason), 'error'); };
  const LI = React.useRef(null);
  LI.current ??= createLoginController({ api, note: (t, tone) => say(t, tone), refresh: () => bump(n => n + 1), onSignedIn: () => {
    setSignedOut(null); BL.current = blockedProp || null;
    R.current.notify = { fails: 0, authLost: false };
    dispatch({ type: 'notify', patch: { error: null } });
    refreshNotify(); refreshRoster();
    if (away && api.away) { const last = AWAY.current.last; if (awayDue(last)) api.away(new Date(last).toISOString()).then((d) => dispatch({ type: 'object', obj: { type: 'away', data: { ...d, compact: true } } }), () => {}); }
  } });
  // L0 palette: opens under the composer while the draft is a bare /word (slash/paletteController.js).
  const PL = React.useRef(null);
  // QUOXON-FW6: model favourites + default (server-side user preferences; profile = cache).
  const MP = React.useRef(null);
  MP.current ??= { prefs: normPrefs(api.localModelPrefs?.()), touched: false, warned: false };
  const PK = React.useRef(null); // /resume, /config, /model
  PK.current ??= createPicker({ refresh: () => bump(n => n + 1) });
  const MM = React.useRef(null);
  MM.current ??= createModelCmd({
    api, say: (t, tone) => say(t, tone), command: (l) => command(l), mc: MC, mp: MP,
    picker: PK.current, state: S, bump: () => bump(n => n + 1), cols: () => cols
  });
  PL.current ??= createPalette({
    getDraft: () => B.current.text, setDraft: (t) => edit({ type: 'set', text: t }),
    run: (t) => { R.current.history.push(t); command(t); }, say: (t, tone) => say(t, tone),
    ctx: () => ({ api, caps: R.current.contract, blocked }),
    source: createArgSources({ api, getPrefs: () => MP.current.prefs }),
    refresh: () => bump(n => n + 1)
  });
  React.useEffect(() => MM.current.startOnDefault({
    flagged: modelChoice != null, off: Boolean(blocked || demoLabel),
    dispatchCtx: () => dispatch({ type: 'ctx', ctx: NO_RAN })
  }), []);
  const LG = React.useRef(null); LG.current ??= createLedger(); // /cost, /context: real usage only
  React.useEffect(() => (startSha ? buildWatch({ startSha, onNotice: (t) => say(t, 'dim') }) : undefined), []);
  React.useEffect(() => { if (resume && !blocked) resumeCmd(resume === true ? '' : String(resume)); }, []);
  React.useEffect(() => { if (!blocked && !demoLabel) aiConnected().then((st) => { R.current.noAi = st === false ? true : st === true ? false : undefined; bump(n => n + 1); }); }, []);
  // Tips (tips.js): mode, rotation and "already used" persist on the profile (quoxon.tips / tipsSeen / tipsUsed).
  const TP = React.useRef(null);
  TP.current ??= (() => { const q = api.settings?.() || {}; const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []); return { mode: normaliseMode(q.tips) || DEFAULT_MODE, seen: arr(q.tipsSeen), used: arr(q.tipsUsed) }; })();
  const showTip = async ({ startup: atLaunch = false } = {}) => {
    const t = TP.current;
    if (t.mode === 'off') return atLaunch ? undefined : say('Tips are off. /tip-settings all turns them back on.');
    let hosts; try { hosts = await api.hostCount?.(); } catch { hosts = undefined; } // unknown never skips a tip
    if (atLaunch && S.current.approvals.length) return undefined; // never over an approval
    let plugins; try { plugins = await api.installedPlugins?.(); } catch { plugins = undefined; } // unreadable = plugin tips hidden
    const signals = { hosts, modelFavs: MP.current.prefs.favourites.length };
    const contract = R.current.contract || null;
    const r = nextTip({ mode: t.mode, contract, plugins, signals, used: t.used, seen: t.seen });
    if (!r.tip) return atLaunch ? undefined : say('No tips to show right now for this install.');
    t.seen = r.seen; api.saveSetting?.('tipsSeen', t.seen);
    if (R.current.sleep) return undefined; // no tip over the sleep screen
    return dispatch({ type: 'tip', text: tipText(r.tip), cmd: r.tip.try });
  };
  const tipStarted = React.useRef(false);
  const startupTip = () => { if (tipStartup && !welcome && !blocked && !tipStarted.current) { tipStarted.current = true; showTip({ startup: true }); } };
  React.useEffect(() => {
    if (!blocked && api.capabilities) api.capabilities().then((res) => { R.current.contract = capabilityMap(res); startupTip(); }, () => startupTip());
    else startupTip();
  }, []);

  React.useEffect(() => {
    if (columns != null) { setCols(clampCols(columns)); return undefined; }
    // Only the live region repaints at the new width (R3 D2): the stdout proxy (term.js) erases the old frame
    // by its reflowed height, so no ghost composers, and history is never reprinted into scrollback.
    const onResize = () => setCols(clampCols((stdout.columns || 80) - 1));
    stdout?.on?.('resize', onResize);
    return () => stdout?.off?.('resize', onResize);
  }, [stdout, columns]);

  R.current.startedAt ??= Date.now();
  const where = React.useRef(slotAgent || detectSlotAgent());
  // Session name (top rule) and the attached agent. The name is saved locally once a conversation id exists.
  const SN = React.useRef({ name: cleanName(sessionName), saved: null, agent: null, baseAgent: where.current.agent ?? null });
  React.useEffect(() => {
    const id = S.current.ctx.conversationId; const key = `${id}|${SN.current.name}`;
    if (SN.current.name && id && SN.current.saved !== key) { SN.current.saved = key; saveName(id, SN.current.name, namesPath); }
  });

  // Live approvals count: refreshed from the inbox every 30 s. A failed refresh keeps the last
  // known count and records the error; it never reads as "0 waiting".
  const refreshNotify = async () => {
    if (BL.current) return;
    const N = R.current.notify || (R.current.notify = { fails: 0, authLost: false });
    try {
      const items = await api.approvals();
      if (N.authLost) say('Signed in again: approvals are back.', 'ok');
      N.fails = 0; N.authLost = false;
      dispatch({ type: 'notify', patch: { approvals: items.length, error: null } });
      dispatch({ type: 'inbox.sync', ids: items.map(i => i.id) });
      // Provider paths that emit no approval.requested still surface here, as the same card.
      for (const item of items) dispatch({ type: 'approval.found', item, since: R.current.startedAt, userId: api.userId?.() || null });
    } catch (e) {
      N.fails++; // counted apart from an empty inbox
      const msg = e?.message || 'failed';
      if (e?.status === 401 || isSessionDead(e) || /No authentication token|service key|unauthori[sz]ed/i.test(msg)) {
        N.authLost = true;
        markSignedOut(e?.reason || null); // one card, then the pollers go quiet until /login
        dispatch({ type: 'notify', patch: { error: null } });
        return;
      }
      dispatch({ type: 'notify', patch: { error: msg } });
    }
  };
  React.useEffect(() => {
    // Back off on repeated failure (x2 per miss, capped at 60 s); the normal cadence returns after one success.
    let timer = null, stopped = false;
    const tick = async () => {
      await refreshNotify();
      if (stopped) return;
      const f = R.current.notify?.fails || 0;
      timer = setTimeout(tick, f ? Math.min(60000, notifyMs * 2 ** Math.min(f, 12)) : notifyMs);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  // Roster: refreshed from real list endpoints. A failing source adds no rows and is named in /roster.
  const refreshRoster = async () => {
    if (BL.current || !api.roster) return;
    try {
      let r = await api.roster(Date.now());
      const R0 = R.current.roster;
      const prevKey = R0.rows[R0.sel]?.key;
      R0.allRows = r.rows; R0.alerts = backgroundAlerts(r.rows); R0.sources = r.sources;
      r = { ...r, rows: selectRows(r.rows, { all: R0.all }) };
      R0.rows = r.rows;
      const at = r.rows.findIndex(x => x.key === prevKey);
      R0.sel = at >= 0 ? at : Math.min(R0.sel, Math.max(0, r.rows.length - 1));
      if (!r.rows.length) { R0.focus = false; R0.peek = false; R0.confirm = null; }
      if (!R.current.closed) bump(n => n + 1);
    } catch { /* api.roster handles per-source failures; nothing to show */ }
  };
  React.useEffect(() => {
    refreshRoster();
    const id = setInterval(refreshRoster, rosterMs);
    return () => clearInterval(id);
  }, []);

  // Roster clock: finished rows fade out and drop locally at their expiry (runs on the motion clock's ticks).
  const expireRoster = () => {
    const ro = R.current.roster;
    if (!ro.rows.length) return false;
    const now = Date.now();
    if (ro.rows.some(r => isExpired(r, now))) {
      const selKey = ro.rows[ro.sel]?.key;
      ro.rows = ro.rows.filter(r => !isExpired(r, now)); ro.allRows = ro.allRows.filter(r => !isExpired(r, now));
      const at = ro.rows.findIndex(r => r.key === selKey);
      ro.sel = at >= 0 ? at : Math.min(ro.sel, Math.max(0, ro.rows.length - 1));
      if (!ro.rows.length) { ro.focus = false; ro.peek = false; ro.confirm = null; }
      return true;
    }
    return false;
  };

  // ---- motion: ONE clock for every animation and visible tick (motion/clock.js). Each render declares what it
  // still needs (frames, a second tick, a one-shot wake); with nothing declared there is no timer at all.
  const clockRef = React.useRef(null);
  const framesRef = React.useRef(null);
  if (!framesRef.current) framesRef.current = createFrames();
  const lastAppRender = React.useRef(0);
  const ringRef = React.useRef(null);
  const onClockTick = React.useRef(null);
  onClockTick.current = () => {
    if (R.current.closed) return;
    R.current.tickPerf = performance.now();
    const now = Date.now();
    if (!introDone.current && now - introStart.current >= introMs) { finishIntro(); return; }
    framesRef.current.emit(now); // animated leaves re-render themselves
    if (expireRoster() || appDue(now)) bump(n => n + 1); // structural change: the whole view
    else clockRef.current.schedule(demands(), now);
  };
  // The newest protocol stage stays live (its icon pulses) while it is the last thing that happened in the turn.
  const isActiveStage = (st, i) => i === st.history.length - 1 && Boolean(st.turn) && !st.blocks.length && st.history[i].kind === 'trace';
  // The app itself re-renders on a tick only when something it lays out is due (not for every frame).
  function appDue(now) {
    const s0 = S.current;
    if (!introDone.current) return true;
    const sec = (t) => Math.floor(t / 1000);
    if (R.current.roster.rows.length && sec(now) !== sec(lastAppRender.current)) return true; // roster ages
    if (motionOn) {
      if (s0.history.length > committedRef.current && !fxActive(s0.history[committedRef.current], now) && !isActiveStage(s0, committedRef.current)) return true; // commit to Static
      for (const r of R.current.roster.rows) if (rosterFx(r.key, now) != null || !rosterSeen.current.has(r.key)) return true;
    }
    const card0 = s0.approvals[0];
    if (card0) {
      const age = now - (card0.displayedAt ?? card0.shownAt);
      if (motionOn && age < 1000) return true; // arrival animation
      if (!R.current.armedShown && age >= 300) return true; // the card arms
    }
    return false;
  }
  if (!clockRef.current) clockRef.current = new Clock(() => onClockTick.current());
  if (motionStats) motionStats.clock = clockRef.current;
  React.useEffect(() => () => clockRef.current.stop(), []);
  const demands = () => {
    const s0 = S.current, now = Date.now(), d = [];
    if (!introDone.current) d.push({ every: INTRO_FRAME_MS });
    if (s0.turn) d.push(motionOn ? { every: FRAME_MS } : { every: SECOND_MS, since: s0.turn.startedAt });
    const card0 = s0.approvals[0];
    if (card0) { const at = (card0.displayedAt ?? card0.shownAt) + 320; if (now < at) d.push(motionOn ? { every: FRAME_MS } : { at }); }
    if (R.current.roster.rows.length) d.push({ every: SECOND_MS });
    if (ringAnimating(ringRef.current)) d.push({ every: FRAME_MS }); // the ring settling after the turn
    if (dragonActive(now, !motionOn || mono())) d.push({ every: motionOn && !mono() ? 40 : 500 }); // /dragon and the cinematic moods (qmotion DragonLive)
    if (motionOn && fxBusy(now)) d.push({ every: FRAME_MS }); // reveals in flight
    const sl = R.current.sleep;
    if (sl) d.push({ every: sl.wakeAt != null ? 50 : sl.still ? 1000 : 120 }); // sleep screen: low frame rate (shimmer, slow sway)
    if (dragonTalkVisible(now)) d.push({ every: motionOn && !mono() ? 60 : 500 }); // /dragon explain|ask
    if (flyActive(now)) d.push({ every: R.current.fly.still ? 500 : 60 }); // /dragon-fly
    return d;
  };
  React.useEffect(() => { if (!R.current.closed) clockRef.current.schedule(demands()); });

  const fxEnd = (e) => Math.max(e.at + revealSpan(e.timing) * 1000, e.settleAt != null ? e.settleAt + revealSpan(TIMING.settle) * 1000 : 0);
  const fxActive = (item, now) => { const e = fxRef.current.get(item.id); return Boolean(e) && now < fxEnd(e); };
  const fxFor = (item, now) => {
    const e = fxRef.current.get(item.id);
    if (!e || now >= fxEnd(e) || R.current.exiting) return null;
    return { e: (now - e.at) / 1000, timing: e.timing, settle: e.settleAt != null ? (now - e.settleAt) / 1000 : null };
  };
  const registerFx = (item, now) => {
    const t = revealTimingFor(item);
    if (!t) return;
    const e = fxRef.current.get(item.id);
    if (!e) fxRef.current.set(item.id, { at: now, timing: t, running: item.kind === 'tool' && item.status === 'running', settleAt: null });
    else if (e.running && item.status !== 'running' && e.settleAt == null) e.settleAt = now;
  };
  const rosterFx = (key, now) => { const at = rosterSeen.current.get(key); const e = at == null ? null : (now - at) / 1000; return e != null && e < revealSpan(TIMING.roster) ? e : null; };
  function fxBusy(now) {
    const s0 = S.current;
    if (s0.history.length > committedRef.current) return true;
    if (s0.blocks.some(b => fxActive(b, now))) return true;
    const card0 = s0.approvals[0];
    if (card0 && now - (card0.displayedAt ?? card0.shownAt) < 1000) return true;
    for (const r of R.current.roster.rows) if (rosterFx(r.key, now) != null) return true;
    return false;
  }

  // After approving from the terminal the tool runs asynchronously: poll its stored result.
  const pollResult = async (run) => {
    if (!run.approvalId || !api.approvalResult) return dispatch({ type: 'approval.result', callId: run.callId, outcome: 'timeout' });
    const t0 = Date.now();
    while (Date.now() - t0 < resultTimeoutMs) {
      await new Promise(r => { const t = setTimeout(() => { R.current.pollTimers.delete(t); r(); }, resultPollMs); R.current.pollTimers.add(t); R.current.pollWake = r; });
      if (R.current.closed) return undefined;
      if (!S.current.running.some(x => x.callId === run.callId)) return undefined; // resolved elsewhere
      try {
        const r = await api.approvalResult(run.approvalId);
        if (r?.status === 'denied') return dispatch({ type: 'approval.result', callId: run.callId, outcome: 'denied' });
        if (r && (r.status === 'approved' || r.status === 'error') && r.executed_at) {
          const text = r.result == null ? null : clip(typeof r.result === 'string' ? r.result : JSON.stringify(r.result), cols - 20);
          return dispatch({ type: 'approval.result', callId: run.callId, outcome: r.status === 'error' ? 'failed' : 'done', text });
        }
      } catch { /* keep polling until the deadline */ }
    }
    return dispatch({ type: 'approval.result', callId: run.callId, outcome: 'timeout' });
  };
  /** Where an answer came from, for the approve comment: the session name, else the conversation id, else a marker. */
  const sessionLabel = () => String(SN.current.name || (S.current.ctx.conversationId ? String(S.current.ctx.conversationId).slice(0, 12) : 'new session')).replace(/\s+/g, ' ').slice(0, 40);
  /** A card is fresh only while the turn that raised it is the live turn; anything older is stale and needs explicit Tab focus. */
  const cardFresh = (c) => Boolean(c && c.turnId != null && c.turnId === S.current.lastTurnId && Date.now() - (c.shownAt || 0) < FRESH_CARD_MS);
  /** The card takes the keyboard only when explicitly focused (Tab), or it is fresh in this turn, unprivileged, and the composer is empty. */
  const cardCaptures = () => { const c = S.current.approvals[0]; return Boolean(c && (K.current.cardFocus || (!c.privileged && !B.current.text && cardFresh(c)))); };
  const answer = async (card, action) => {
    if (R.current.answering?.has(card.callId)) return;
    (R.current.answering ||= new Set()).add(card.callId);
    try {
      await api.respond(card.inboxItemId, action, { via: `tty ${sessionLabel()}` });
      // The demo's stream carries on to its own tool result, so no "running, result later" note, no poll, no stale count.
      dispatch({ type: 'approval.sent', callId: card.callId, action, tool: card.tool, target: card.target, approvalId: card.approvalId, quiet: Boolean(demoLabel) });
      if (demoLabel) { B.current = initialBuffer(); dispatch({ type: 'notify', patch: { approvals: 0, error: null } }); } // (a stray early keystroke is not left in the composer)
      if (action === 'approve' && card.tool !== 'hat.switch' && !demoLabel) pollResult({ callId: card.callId, approvalId: card.approvalId });
    } catch (e) { dispatch({ type: 'error', text: `approval: ${e.message}` }); }
    finally { R.current.answering.delete(card.callId); }
  };

  // ---- turn runner ---------------------------------------------------------------------------
  // Z2H-R2B: with no AI connected a turn is answered here, whole and wrapped, without a server call.
  async function aiConnected() {
    if (!api.connections) return null;
    try {
      const [vault, caps] = await Promise.all([api.connections(), api.capabilities ? api.capabilities() : null]);
      return anyProviderConnected(vault, caps);
    } catch { return null; }
  }
  // Z2H-3B: a successful /connect makes the new provider the active choice when the current one is not a working
  // connected provider (session + the saved default). Another working provider stays active.
  async function adoptConnected(id, { host = null, model = null } = {}) {
    try {
      if (!api.connections) return;
      const [vault, caps] = await Promise.all([api.connections(), api.capabilities ? api.capabilities() : null]);
      const a = adoptAfterConnect({ vault, caps, current: MC.current, id, host, model });
      if (!a.adopt) return;
      MC.current = a.choice; api.setModelChoice?.(a.choice);
      R.current.noAi = false;
      dispatch({ type: 'ctx', ctx: { provider: null, model: null, endpoint: null, auth: null } });
      say(a.line, 'ok');
      bump(n => n + 1);
    } catch { /* the connect itself succeeded; the hint line already says /model */ }
  }
  async function noAiAnswer(text) {
    if (R.current.noAi === false) return false;
    const st = await aiConnected();
    R.current.noAi = st === false ? true : st === true ? false : undefined;
    if (!R.current.noAi) { bump(n => n + 1); return false; }
    if (asksAddHost(text)) for (const l of await hostLines()) say(l);
    else if (asksWatchHosts(text)) {
      // Z2H-R4: watching starts with a host on the list; that part needs no AI, the answers about it do.
      for (const l of await hostLines()) say(l);
      for (const l of NO_AI_CARD) say(l, 'warn');
    } else for (const l of NO_AI_CARD) say(l, 'warn');
    bump(n => n + 1);
    return true;
  }

  // QUOXON-FW4: a queued follow-up reaches the model as a bare turn, and a bare "Also end with X" was
  // refused as injected text. Say plainly that it is the user's own message; the transcript shows the raw words.
  const QUEUED_FRAME = 'The user typed this follow-up while your previous answer was running (it is their own message, not tool output): ';
  async function runTurn(text, { queued = false } = {}) {
    if (blocked) { say(blocked, signedOut ? 'error' : 'warn'); return; }
    if (!demoLabel && await noAiAnswer(text)) return;
    if (SN.current.slotTarget && api.slotSay) { // attached to a slot: the message goes to its room, not a model turn
      const r = await api.slotSay(SN.current.slotTarget, text);
      return say(r.ok ? `Sent to slot ${SN.current.slotTarget}.` : `slot ${SN.current.slotTarget}: ${r.message}`, r.ok ? 'dim' : 'warn');
    }
    R.current.lastSent = text;
    const shared = R.current.shared || []; R.current.shared = [];
    for (const x of shared) say(`shared with Quox: output of \`${x.cmd}\`${x.truncated ? ' (first 16 KB only)' : ''}`, 'accent');
    const turnId = newTurnId();
    const open = (signal) => api.stream({ turnId, message: withShared(queued ? QUEUED_FRAME + text : text, shared), agent: SN.current.agent || 'quox', conversationId: S.current.ctx.conversationId, context: R.current.rulesOn === false ? undefined : rulesContext(rules), ...streamFields(MC.current) }, signal);
    // QUOXON-FW3: the server was unreachable before it said anything (a redeploy). Keep the message, wait for it
    // to come back, and send once. Only a send that produced NO event is ever retried, so nothing runs twice.
    let r = await consumeTurn(turnId, open, { keepOnDown: true });
    if (!r?.down) return r;
    say(SERVER_RESTARTING, 'warn');
    for (let round = 0; r?.down && round < 3; round++) {
      const ctrl = new AbortController();
      R.current.abort = ctrl; R.current.waitingServer = { text };
      const res = await waitForServer({ health: (ms) => api.health(ms), signal: ctrl.signal, delays: resendDelays });
      R.current.waitingServer = null; R.current.abort = null;
      if (res !== 'up') {
        dispatch({ type: 'turn.deferred' });
        edit({ type: 'set', text: B.current.text ? `${text}\n${B.current.text}` : text });
        return say(res === 'cancelled' ? 'Cancelled. Your message is back in the composer; it was not sent.' : 'The Quox server did not come back in time. Your message is back in the composer; it was not sent.', 'warn');
      }
      r = await consumeTurn(turnId, open, { keepOnDown: true });
    }
    if (r?.down) { dispatch({ type: 'turn.deferred' }); edit({ type: 'set', text: B.current.text ? `${text}\n${B.current.text}` : text }); say('The server keeps dropping the connection. Your message is back in the composer; it was not sent.', 'warn'); }
    return r;
  }

  // QUOXON C5: render a turn that is already running on the server (after /resume, --conversation or a
  // restart). Replays it from the start, then follows it live; exactly once by seq.
  async function followTurn(conversationId, turnId) {
    if (S.current.turn || !api.reattach) return;
    say('A turn is still running in this conversation; reattaching to it.', 'dim');
    return consumeTurn(turnId, (signal) => api.reattach({ conversationId, turnId, after: 0 }, signal));
  }
  async function reattachIfRunning(conversationId) {
    if (!conversationId || !api.runningTurn || S.current.turn) return;
    const r = await api.runningTurn(conversationId);
    if (r?.running && r.turnId && !S.current.turn && S.current.ctx.conversationId === conversationId) followTurn(conversationId, r.turnId);
  }

  async function consumeTurn(turnId, open, { keepOnDown = false } = {}) {
    R.current.caps.steer = true; R.current.steerNoted = false; // steer support is learned per turn (provider paths differ)
    R.current.durable = false; // learned from the server: v1.1 events carry a seq
    dispatch({ type: 'turn.begin', turnId });
    const ctrl = new AbortController();
    R.current.abort = ctrl;
    let offered = false, sawEvent = false, down = false;
    try {
      for await (const ev of open(ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        sawEvent = true;
        if (typeof ev?.seq === 'number') R.current.durable = true;
        LG.current.observe(ev);
        dispatch({ type: 'event', ev });
        // Z2H-3B: a server default that is not connected must not linger in the status bar.
        if (ev.type === 'error' && /No AI is connected/i.test(String(ev.error || ev.message || ''))) {
          R.current.noAi = true;
          dispatch({ type: 'ctx', ctx: { provider: null, model: null, endpoint: null, auth: null } });
        }
        const fb = fallbackNote(MC.current, ev);
        if (fb) say(fb, 'warn');
        const offer = connectOfferFor(ev);
        if (offer && !offered) { offered = true; say(offer); }
        if (isConsentError(ev)) { // the words are in the error block; here the link and the way back
          R.current.consent = ev.retryable ? null : { provider: ev.provider || null, text: R.current.lastSent || null };
          let base = null; try { base = await api.dashboardBase?.(); } catch { base = null; }
          for (const l of consentHintLines(ev, base)) say(l, 'dim');
        }
      }
      if (S.current.turn?.id === turnId) {
        // stream closed without a terminal event
        // never claim completion the server did not confirm
        dispatch({ type: 'event', ev: { type: 'turn.finished', status: ctrl.signal.aborted ? 'interrupted' : 'unconfirmed' } });
      }
    } catch (e) {
      if (keepOnDown && !sawEvent && !ctrl.signal.aborted && isServerDown(e)) { down = true; }
      else if (!ctrl.signal.aborted) {
        // FW4: settle in-flight tools explicitly (never leave a row "running"), then explain the cut with a way forward.
        const why = sawEvent ? explainTermination(e) : null;
        if (why) for (const b of S.current.blocks) if (b.kind === 'tool' && b.status === 'running') dispatch({ type: 'event', ev: { type: 'tool.finished', call_id: b.callId, tool: b.tool, status: 'interrupted', result_summary: 'connection lost before a result; verify before retrying' } });
        const dead = !why && (e?.status === 401 || isSessionDead(e));
        dispatch({ type: 'event', ev: { type: 'error', error: why || (dead ? SIGNED_OUT_LINE : friendlyError(e, profile)) } });
        if (dead) markSignedOut(e?.reason || null);
        if (why) say(RETRY_HINT, 'warn');
        // A lost reattach is not a failed turn: the server may still be finishing it (C5).
        if (S.current.turn?.id === turnId) dispatch({ type: 'event', ev: { type: 'turn.finished', status: e?.code === 'reattach_failed' ? 'unconfirmed' : 'failed' } });
      }
    } finally {
      clearTimeout(R.current.fallbackTimer);
      LG.current.end();
      if (!down) R.current.abort = null;
      if (!down && S.current.turn?.id === turnId) dispatch({ type: 'stopped.local' });
    }
    return down ? { down: true } : undefined;
  }

  React.useEffect(() => {
    if (R.current.sleep && R.current.sleep.wakeAt == null && S.current.approvals.length) wakeDragon(); // an approval always wakes it
    const s = S.current;
    if (!s.turn && s.autoDrain && s.pending.length) {
      const next = s.pending[0];
      dispatch({ type: 'queue.shift' });
      dispatch({ type: 'user', text: next.text, queued: true });
      runTurn(next.text, { queued: true });
    }
  });

  function submit(text) {
    touchSeen();
    dispatch({ type: 'user', text });
    const tip = intentHint(text); // a hint only: the turn still goes to the model
    if (tip) say(tip);
    const panel = intentPanel(text); // the same panel as the command, from local facts, above the answer
    if (panel) showPanel(panel, { local: true });
    R.current.history.push(text);
    R.current.histIdx = -1;
    runTurn(text);
  }

  async function steer(text) {
    const id = `steer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const s = S.current;
    dispatch({ type: 'steer.add', id, text });
    const r = await api.steer(s.ctx.conversationId, s.turn.id, text, id);
    if (r.ok) return;
    // Put the text back in the draft (in front of anything typed since) instead of losing or replaying it.
    const restore = () => { const cur = B.current.text; edit({ type: 'set', text: cur ? `${text}\n${cur}` : text }); };
    if (r.reason === 'ambiguous') {
      dispatch({ type: 'steer.failed', id, reason: 'Steer may not have been applied; resend? Your text is back in the draft.' });
      restore();
    } else if (r.reason === 'denied') {
      dispatch({ type: 'steer.failed', id, reason: `Steering was denied by policy (${r.message || 'steer_denied_by_policy'}). Your text is back in the draft; it was not run.` });
      restore();
    } else {
      if (r.reason === 'unsupported') { R.current.caps.steer = false; R.current.steerNoted = true; bump(n => n + 1); }
      dispatch({ type: 'steer.converted', id, reason: r.reason === 'turn_finished'
        ? 'That turn already finished; queued your message as the next turn.'
        : STEER_OFF_NOTE });
    }
  }

  async function interrupt() {
    if (R.current.waitingServer) { R.current.abort?.abort(); return; } // QUOXON-FW3: Esc cancels the wait; runTurn restores the text
    const s = S.current;
    if (!s.turn || s.turn.status === 'interrupting') return;
    dispatch({ type: 'interrupt.requested' });
    const r = await api.interrupt(s.ctx.conversationId, s.turn.id);
    const turnId = s.turn.id;
    const local = () => { if (S.current.turn?.id === turnId) { R.current.abort?.abort(); dispatch({ type: 'stopped.local' }); } };
    if (!r.ok) { R.current.caps.interrupt = false; return local(); }
    R.current.fallbackTimer = setTimeout(local, INTERRUPT_FALLBACK_MS);
  }

  // ---- L1 slash commands (models in slash/*.js) ------------------------------------------------
  const help = (model) => dispatch({ type: 'help', model });
  const leaveArmed = (kind) => { // a running turn would be disconnected: ask once, a second ask within 5 s goes ahead
    if (!S.current.turn) return true;
    // C5: a durable turn (the server sends seq) keeps running when we leave; /resume reattaches.
    if (R.current.durable) { say('Quox keeps working; it will be here when you come back. /resume reattaches to the turn.', 'ok'); return true; }
    const t = R.current.leaveAsk;
    if (t && t.kind === kind && Date.now() - t.at < 5000) return true;
    R.current.leaveAsk = { kind, at: Date.now() };
    say(`A turn is running. ${kind === 'restart' ? 'Restarting' : 'Leaving'} disconnects it, and the server stops it before its next step (a tool already running finishes and is recorded). /${kind === 'restart' ? 'restart' : 'quit'} again within 5 s to go ahead, or wait for the turn.`, 'warn');
    return false;
  };
  async function showPanel(cmd, { local = false } = {}) {
    const base = { ctx: S.current.ctx, choice: MC.current, agent: SN.current.agent || where.current.agent, conversationId: S.current.ctx.conversationId };
    if (cmd === '/cost') return help(costModel(LG.current));
    if (cmd === '/status') {
      let hl = R.current.lastHealth || null;
      if (!local && api.health) { hl = await api.health(8000); R.current.lastHealth = hl; }
      return help(statusModel({ ...base, profile, org: R.current.orgName ?? org ?? null, serverUrl: api.serverUrl?.() || hl?.url || null, health: hl, slot: where.current.slot, sessionName: SN.current.name, version, local: local && !hl }));
    }
    if (cmd === '/context') {
      let skills = R.current.skillsInfo || null; let memory = R.current.memoryInfo || null;
      if (!local) {
        [skills, memory] = await Promise.all([
          api.skills ? api.skills().then(l => ({ ok: true, count: l.length }), e => ({ ok: false, error: e?.status ? `HTTP ${e.status}` : (e?.message || 'failed') })) : { ok: false, error: 'not available in this mode' },
          api.memoryStatus ? api.memoryStatus() : { ok: false, error: 'not available in this mode' }
        ]);
        R.current.skillsInfo = skills; R.current.memoryInfo = memory;
      }
      let server = null; let serverError = null;
      if (!local && base.conversationId && api.conversationContext) {
        try { server = contextFacts(await api.conversationContext(base.conversationId)); }
        catch (e) { serverError = e?.status === 404 ? 'no stored turns yet' : e?.status ? `HTTP ${e.status}` : (e?.message || 'failed'); }
      }
      return help(contextModel({ ...base, server, serverError, tokens: LG.current.conversationTokens(S.current.ctx.conversationId), rules, rulesOn: R.current.rulesOn !== false, skills, memory }));
    }
    return undefined;
  }
  async function resumeTo(row) {
    if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
    let turns;
    try { turns = await api.conversationTurns(row.id); } catch (e) { return dispatch({ type: 'error', text: `resume: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); }
    const t = turnsToHistory(turns);
    dispatch({ type: 'ctx', ctx: { conversationId: row.id } });
    SN.current.name = loadNames(namesPath)[row.id]?.name || null; SN.current.saved = null;
    say(`Resumed "${clip(row.title, cols - 20)}"${row.agent ? ` with ${row.agent}` : ''}.`, 'ok');
    dispatch({ type: 'history.add', items: t.items, answers: t.answers });
    say(t.total ? `Showing the last ${t.shown} of ${t.total} stored messages. Your next message continues this conversation.` : 'The server has no stored messages for it (it keeps them 7 days). Your next message continues it anyway.', 'dim');
    return reattachIfRunning(row.id);
  }
  async function resumeCmd(q) {
    if (!api.conversations || !api.conversationTurns) return say('Resume is not available in this mode.', 'warn');
    let rows;
    try {
      const [list, index] = await Promise.all([api.conversations(30), api.sessionsIndex ? api.sessionsIndex().catch(() => null) : null]);
      rows = resumeRows(list, index, loadNames(namesPath));
    } catch (e) { return dispatch({ type: 'error', text: `resume: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); }
    if (q) {
      const m = matchConversation(rows, q);
      if (m.row) return resumeTo(m.row);
      return say(m.ambiguous ? `"${q}" matches ${m.ambiguous.length} conversations: ${m.ambiguous.map(x => x.slice(0, 12)).join(', ')}. Use more of the id.` : `No recent conversation matches "${q}". /resume lists them.`, 'warn');
    }
    if (!rows.length) return say('No recent conversations to resume.');
    const now = Date.now();
    PK.current.open({ title: 'Resume a conversation', rows: rows.map(r => pickerRow(r, now)), hint: '↑↓ select · Enter resume · Esc cancel', onPick: (_, i) => resumeTo(rows[i]) });
    return undefined;
  }
  // ---- /dragon explain | ask | sleep (dragonModes.js) -----------------------------------------------
  const dragonTalkVisible = (now = Date.now()) => {
    const d = R.current.dragonTalk;
    return Boolean(d) && (d.armed || !d.endedAt || now - d.endedAt < 4000);
  };
  /** One governed turn on whichever provider is selected, framed for the simplest possible answer. */
  function dragonTurn(label, prompt) {
    const d = R.current.dragonTalk = { since: Date.now(), endedAt: null, armed: false, label };
    say(label, 'ok');
    Promise.resolve(runTurn(prompt)).catch(() => {}).finally(() => { d.endedAt = Date.now(); bump(n => n + 1); });
    bump(n => n + 1);
    return true;
  }
  function dragonExplain() {
    if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
    const o = lastOutput(S.current);
    if (!o) return say(NOTHING_TO_EXPLAIN);
    return dragonTurn(DRAGON_EXPLAINS, explainPrompt(o.text));
  }
  function dragonAsk(question) {
    if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
    if (!question) { R.current.askArmed = true; R.current.dragonTalk = { since: Date.now(), endedAt: Date.now(), armed: true, label: ASK_PROMPT }; bump(n => n + 1); return true; }
    dispatch({ type: 'user', text: question });
    return dragonTurn(DRAGON_ANSWERS, askPrompt(question));
  }
  function dragonSleep() {
    if (!isInteractive) return say('/dragon sleep needs an interactive terminal.', 'warn');
    if (S.current.approvals.length) return say('An approval is waiting. Answer it first; the dragon will not sleep over it.', 'warn');
    R.current.sleep = { startedAt: Date.now(), wakeAt: null, still: !motionOn || mono() };
    bump(n => n + 1); return true;
  }
  function dragonFly() { // one pass of the dragon in flight in the live region; Esc stops it, a new call restarts it
    R.current.fly = { startedAt: Date.now(), still: !motionOn || mono() };
    bump(n => n + 1); return true;
  }
  const flyActive = (now = Date.now()) => { const f = R.current.fly; return Boolean(f) && now - f.startedAt < (f.still ? FLY_STILL_MS : FLY_PASS_MS + 400); };
  function wakeDragon() {
    const sl = R.current.sleep;
    if (!sl || sl.wakeAt != null) return;
    sl.wakeAt = Date.now();
    const end = () => { R.current.sleep = null; bump(n => n + 1); };
    if (sl.still) end(); else R.current.wakeTimer = setTimeout(end, WAKE_MS + 60);
    bump(n => n + 1);
  }

  function openConfig() {
    const list = settingsList();
    const saved = api.settings ? api.settings() : (R.current.sessionSettings ||= {});
    const vals = { verbose: S.current.verbose, ...saved, sound: SND.current.settings?.().profile };
    // R3 D2: changes are staged in the card; Enter saves them, Esc (or typing) discards them.
    let staged = {};
    const apply = (it, v) => {
      vals[it.id] = v;
      if (it.id === 'sound') { SND.current.command(v, say); return; } // the sound controller saves its own profile
      const ok = api.saveSetting ? api.saveSetting(it.id, v) : ((R.current.sessionSettings ||= {})[it.id] = v, false);
      if (it.id === 'verbose') dispatch({ type: 'verbose', mode: v });
      // Theme and motion apply to what is drawn from now on; history already in scrollback keeps its look
      // (repainting it would print the whole transcript again).
      if (it.id === 'theme' || it.id === 'motion') applySettings(vals, env);
      R.current.configSaved = ok;
    };
    const commit = () => {
      const ids = Object.keys(staged);
      if (!ids.length) return;
      for (const id of ids) apply(list.find(x => x.id === id), staged[id]);
      const what = ids.map(id => `${id} ${staged[id]}`).join(', ');
      staged = {};
      say(`${api.saveSetting ? `Saved to profile ${profile}` : 'Applied for this session'}: ${what}.${ids.includes('theme') ? ' The theme applies to new output; earlier lines keep their colours.' : ''}`, 'ok');
    };
    PK.current.open({
      title: api.saveSetting ? `Settings · Enter saves to profile ${profile} · Esc cancels` : 'Settings · Enter applies for this session · Esc cancels',
      rowsFn: () => configRows(list, { ...vals, ...staged }, { model: modelLabel(S.current.ctx, MC.current) || 'auto' }).map((r, i) => (list[i].id in staged ? { ...r, note: 'unsaved · Enter saves' } : r)),
      hint: '↑↓ select · ←→ or Space change · Enter save · Esc cancel · typing goes to the composer',
      onAdjust: (i, dir) => {
        const it = list[i]; if (it.action) return;
        const now = it.id === 'motion' ? (normaliseLevel(vals.motion) || it.def) : (vals[it.id] ?? it.def); // F3: a pre-levels full/reduced profile
        const v = cycle(it, staged[it.id] ?? now, dir);
        if (v === now) delete staged[it.id]; else staged[it.id] = v;
      },
      onClose: () => { if (Object.keys(staged).length) say('Settings closed; nothing saved.', 'dim'); staged = {}; },
      onPick: (_, i) => { commit(); if (list[i].action === 'model') command('/model'); }
    });
  }

  // ---- QUOXON-FW8: ! commands ---------------------------------------------------------------------
  function bangCommand(bang) {
    if (bang.kind === 'reserved') return say('!! is reserved. Use ! followed by a command, e.g. !ls or !quox inbox list.', 'warn');
    if (bang.kind === 'empty') return say('Usage: !<command> runs it here, !quox <args> runs this quox as you. Output stays on your screen; /share sends it to Quox.', 'warn');
    let plan = { cmd: bang.cmd };
    if (bang.kind === 'quox') {
      plan = quoxArgv(bang.args, { profile });
      if (plan.refuse) return say(plan.refuse, 'warn');
    }
    const cmd = bang.cmd;
    const timeoutMs = Number(env.QUOX_BANG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    say(`$ ${cmd}`, 'accent');
    let pending = ''; let timer = null;
    const flush = (all) => {
      if (R.current.exiting) { pending = ''; return; }
      let out = pending;
      if (!all) { const i = out.lastIndexOf('\n'); if (i < 0) return; out = out.slice(0, i + 1); }
      pending = pending.slice(out.length);
      out = cleanOutput(out).replace(/\n+$/, '');
      if (out) dispatch({ type: 'bang.out', text: out });
    };
    const run = runBang(plan, { cwd: process.cwd(), env, timeoutMs, onData: (t) => { pending += t; if (!timer) timer = setTimeout(() => { timer = null; flush(false); }, 80); } });
    const slow = setTimeout(() => { if (R.current.bang?.run === run && !R.current.exiting) say('still running (Ctrl+C stops it)', 'accent'); }, 5000);
    R.current.bang = { run, cmd };
    run.done.then((r) => {
      clearTimeout(timer); clearTimeout(slow); timer = null; flush(true);
      R.current.bang = null;
      const results = R.current.bangResults ??= [];
      results.push({ cmd, text: r.text, truncated: r.truncated });
      if (results.length > 10) results.shift();
      transcript?.bang?.(cmd, r.timedOut ? 'timeout' : r.killed ? 'killed' : r.code);
      if (R.current.exiting) return;
      if (r.truncated) say(bangTruncNote(r), 'warn');
      if (r.stdinNote) say(r.stdinNote, 'warn');
      say(bangFooter(r, { timeoutMs }), r.code === 0 && !r.timedOut && !r.killed ? 'ok' : 'warn');
      bump(n => n + 1);
    });
  }

  function shareCommand(arg) {
    const res = R.current.bangResults || [];
    if (!res.length) return say('Nothing to share yet. Run a command with ! first, e.g. !quox inbox list, then /share.', 'warn');
    const n = arg ? Number(arg) : 1;
    if (!Number.isInteger(n) || n < 1 || n > res.length) return say(`Usage: /share [N] where N is 1 (latest) to ${res.length}.`, 'warn');
    const r = res[res.length - n];
    const sh = shareText(r.text);
    R.current.shared = [...(R.current.shared || []).filter(x => x.cmd !== r.cmd), { cmd: r.cmd, text: sh.text, truncated: sh.truncated }];
    say(`Output of \`${r.cmd}\` will be shared with Quox with your next message${sh.truncated ? ' (first 16 KB only, it was longer)' : ''}.`, 'accent');
  }

  async function command(line) {
    if (/^\/\/(\s|$)/.test(line.trim())) line = line.trim().replace(/^\/\//, '/note');
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd !== '/note') transcript?.command(line);
    const restArg = line.trim().replace(/^\S+\s*/, '');
    touchSeen();
    if (TIPS.some(x => tryCommand(x) === cmd) && !TP.current.used.includes(cmd)) { TP.current.used = [...TP.current.used, cmd]; api.saveSetting?.('tipsUsed', TP.current.used); } // using a thing retires its tip
    if (OBJECT_CMDS.has(cmd) && !(cmd === '/rules' && arg)) { // inline object views (objects/): a card into history, or an honest note
      const r = await runObjectCommand(cmd, restArg, { objects: api.objects, rules, rulesOn: R.current.rulesOn, items: [...S.current.history, ...S.current.blocks] });
      if (r) return r.object ? dispatch({ type: 'object', obj: r.object }) : say(clip(r.note, cols - 4), r.tone);
    }
    switch (cmd) {
      case '/copy': {
        const r = pickCopy(S.current.answers, arg || '');
        if (r.error) return say(r.error, 'warn');
        if (stdout?.isTTY) stdout.write(osc52(r.text));
        return say(`copied ${r.text.length.toLocaleString('en-US')} chars to the clipboard (needs a terminal that allows OSC 52)`, 'dim');
      }
      case '/share': return shareCommand(arg);
      case '/note': {
        if (!restArg) return say('Usage: /note <text>  (or // text). Nothing to note.', 'warn');
        if (!transcript?.note) return say('notes need dev transcripts on (touch ~/.config/quox/dev-transcripts)', 'warn');
        transcript.note(restArg.slice(0, 2000));
        return say('noted for the observer', 'dim');
      }
      case '/rename': {
        if (!restArg) return say(SN.current.name ? `Session name: ${SN.current.name}` : 'This session has no name. Use /rename <name>.');
        const n = cleanName(restArg);
        SN.current.name = n; SN.current.saved = null; bump(x => x + 1);
        return say(`Session named "${n}".`, 'ok');
      }
      case '/slot': {
        if (!restArg) return say(where.current.slot ? `Slot: ${where.current.slot}` : 'No slot. Use /slot <name> to give this session an address.');
        if (!api.checkoutSlot) return say('Slots are not available in this mode.', 'warn');
        const toks = restArg.split(/\s+/);
        const forceCreate = toks.includes('--create');
        const nm = toks.find(t => t !== '--create') || '';
        if (!nm) return say('Usage: /slot <name> [--create]', 'warn');
        if (!forceCreate && api.slots) { // a name that is not a real slot but is close to one is a typo, not a request to create
          let slots = null;
          try { slots = await api.slots(); } catch { slots = null; }
          if (Array.isArray(slots) && !slots.some(x => String(x.name) === nm)) {
            const near = await nearbyTargets(nm, slots);
            if (near.length) return say(`Slot "${nm}" not found. Did you mean: ${near.join(', ')}? (/slot ${nm} --create makes a new slot)`, 'warn');
          }
        }
        const r = await api.checkoutSlot(nm, SN.current.name || S.current.ctx.conversationId || 'quox');
        if (!r.ok) return say(`slot ${nm}: ${r.message}`, 'warn');
        where.current = { ...where.current, slot: nm }; bump(x => x + 1);
        return say(`Slot ${nm} checked out. Discord replies are not relayed into this window yet.`, 'ok');
      }
      case '/attach': {
        if (!restArg) return say(SN.current.agent ? `Attached to ${SN.current.agent}. /detach returns to CommanderQ.` : 'Talking to CommanderQ. Use /attach <agent> to pick one.');
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        if (!api.agents) return say('Agents are not available in this mode.', 'warn');
        const pt = parseTarget(restArg);
        let list;
        try { list = await api.agents(); } catch (e) { return say(`Couldn't check agents: ${listFailure(e, profile)}`, 'warn'); }
        let slots = null;
        if (pt.kind !== 'agent' && api.slots) {
          try { slots = await api.slots(); } catch (e) { if (pt.kind === 'slot') return say(`Couldn't check slots: ${listFailure(e, profile)}`, 'warn'); slots = null; }
        }
        const lc = pt.name.toLowerCase();
        const slotRow = pt.kind === 'agent' ? null : (Array.isArray(slots) ? slots : []).find(x => String(x.name).toLowerCase() === lc);
        const m = pt.kind === 'slot' ? { matches: [] } : matchAgent(pt.name, list);
        const slotLive = !!(slotRow && slotRow.holder_session);
        let choice = null; // 'slot' | 'agent'
        if (slotRow && m.agent) choice = pt.kind === 'slot' || slotLive ? 'slot' : 'agent';
        else if (slotRow) choice = 'slot';
        else if (m.agent) choice = 'agent';
        if (!choice) {
          // A miss is only "no such agent" when the lists answered; a failed list is the failure, not a not-found.
          if (list?.listError) return say(`Couldn't check agents: ${listFailure(list.listError, profile)}`, 'warn');
          if (api.slots && slots === null && pt.kind !== 'agent') { try { slots = await api.slots(); } catch (e) { return say(`Couldn't check slots: ${listFailure(e, profile)}`, 'warn'); } }
          const near = await nearbyTargets(pt.name, slots, list);
          return say(`No ${pt.kind || 'agent or slot'} called "${pt.name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Try quox agent list.'}`, 'warn');
        }
        const both = !!(slotRow && m.agent);
        if (choice === 'slot') {
          if (!api.slotSay) return say('Talking to a slot is not available in this mode.', 'warn');
          SN.current.agent = null; SN.current.slotTarget = slotRow.name;
          where.current = { ...where.current, agent: SN.current.baseAgent }; bump(x => x + 1);
          const host = slotRow.holder_identity ? String(slotRow.holder_identity).replace(/^resident:/, '') : null;
          const lbl = `slot ${slotRow.name}${host ? ` (${host})` : ''}`;
          const alt = both ? ` To pick the agent instead: /attach agent:${pt.name}` : '';
          if (!pt.rest) return say(`Attached to ${lbl}. Your next messages go to it. /detach returns to CommanderQ.${alt}`, 'ok');
          const r = await api.slotSay(slotRow.name, pt.rest);
          if (!r.ok) return say(`Attached to ${lbl}, but the message was not sent: ${r.message}`, 'warn');
          return say(`Attached to ${lbl}. Sent: ${pt.rest}${alt}`, 'ok');
        }
        SN.current.slotTarget = null;
        SN.current.agent = m.agent.id; where.current = { ...where.current, agent: m.agent.id }; bump(x => x + 1);
        const alt = both ? ` To pick the slot instead: /attach slot:${pt.name}` : '';
        say(`Attached to ${m.agent.id}. Your next turns go to it. /detach returns to CommanderQ.${alt}`, 'ok');
        if (pt.rest) { dispatch({ type: 'user', text: pt.rest }); R.current.history.push(pt.rest); runTurn(pt.rest); }
        return undefined;
      }
      case '/hosts': {
        if (/^add\b/i.test(restArg || '')) { for (const l of await hostLines()) say(l); return undefined; }
        say('To see the hosts your Quox knows: quox fleet hosts (in a terminal).');
        return say('To add one, no AI needed: /hosts add');
      }
      case '/login': { LI.current.open(); return undefined; }
      case '/connect': {
        if (BL.current) return say(BL.current, 'warn');
        if (!restArg) {
          if (!api.connections) return say('Connections are not available in this mode.', 'warn');
          const [vault, caps] = await Promise.all([api.connections(), api.capabilities ? api.capabilities() : null]);
          for (const [t, tone] of connectionLines(vault, caps)) say(clip(t, cols - 4), tone);
          return undefined;
        }
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        if (/^(yes|no)$/i.test(restArg.trim())) { // answers the private-network card
          const offer = R.current.lanOffer; R.current.lanOffer = null;
          if (!offer) return say('Nothing to confirm. Run /connect again.', 'warn');
          if (/^no$/i.test(restArg.trim())) return say('Left blocked. Nothing was changed.');
          const c = await confirmLanAllow(api, offer);
          for (const [t, tone] of c.lines) say(t, tone);
          // Z2H-R4: a LAN provider always arrives here; adopt it like the direct path does.
          if (c.ok && offer.providerId) await adoptConnected(offer.providerId, { host: c.host, model: c.model });
          return undefined;
        }
        const pv = providerFor(arg);
        if (pv?.url && pv.id !== 'ollama') { // B5: LM Studio / vLLM / custom: probed server side, then saved (custom may need a key)
          const rest = restArg.replace(/^\S+\s*/, '');
          say(`Checking the URL from the server…`);
          const r = await connectCompatFlow(api, pv.id, rest);
          for (const [t, tone] of r.lines) say(clip(t, cols - 4), tone);
          R.current.lanOffer = r.lanOffer ? { ...r.lanOffer, providerId: pv.id } : null;
          if (r.needsKey) CN.current.openCustom(r.extra);
          else if (r.ok) await adoptConnected(pv.id, { host: r.host, model: r.model });
          return undefined;
        }
        if (pv?.url) { // B3: Ollama takes a URL, probed and saved server side
          { const u = parseOllamaArg(restArg.replace(/^\S+\s*/, '')).url; if (u) say(`Checking ${u} from the server…`); }
          const r = await connectOllamaFlow(api, restArg.replace(/^\S+\s*/, ''));
          for (const [t, tone] of r.lines) say(t, tone)  /* Z2H-R3: notes wrap; clipping cut the egress message at "localho…" */;
          R.current.lanOffer = r.lanOffer ? { ...r.lanOffer, providerId: 'ollama' } : null;
          if (r.ok) await adoptConnected('ollama', { host: r.host, model: r.model });
          return undefined;
        }
        CN.current.open(arg);
        return undefined;
      }
      case '/model': {
        const sub = parseModelSub(restArg);
        const handled = MM.current.handle(sub);
        if (handled) return handled;
        if (sub.kind === 'pass') MP.current.touched = true;
        if (!api.connections) return say('Model choice is not available in this mode.', 'warn');
        // One provider status for /model, /connect, /doctor, /capabilities: the server's capabilities, vault for detail.
        const [res, caps] = await Promise.all([api.connections(), api.capabilities ? api.capabilities() : null]);
        if (sub.kind === 'list' || !restArg) {
          for (const [t, tone] of modelLines(res, MC.current, caps)) say(clip(t, cols - 4), tone);
          return undefined;
        }
        let r = selectModel(res, restArg, caps);
        let installed = null;
        if (r.ok && r.choice?.provider === 'ollama' && api.ollamaModels) { // B3: check against what that Ollama has installed
          r = selectOllamaModel(await api.ollamaModels(), r.choice.model || null);
          if (r.models) installed = ollamaModelRows(r.models, r.current || r.choice?.model);
        }
        if (r.ok && r.choice?.via === 'subscription') { // QUOXON-MODEL: Claude CLI family aliases, no list to fetch
          if (r.choice.model) r = selectSubscriptionModel(r.choice);
        } else if (r.ok && (r.choice?.provider === 'openai' || r.choice?.provider === 'anthropic') && api.providerModels) {
          // QUOXON-MODEL: live model list (server cached 1 h, refreshed now); no hardcoded lists to go stale
          const row = CHOICES.find(x => x.provider === r.choice.provider && !x.via);
          const d = selectDiscoveredModel(await api.providerModels(r.choice.provider, { refresh: true }), r.choice, row);
          r = d.ok && r.tone === 'warn' && !d.models ? { ...d, text: `${d.text} ${r.text}`, tone: 'warn' } : d;
          if (r.models) installed = compatModelRows(r.models, r.current || r.choice?.model);
        }
        if (r.ok && byId(r.choice?.provider)?.compat && api.compatModels) { // B5: check against the provider's own /models
          r = selectCompatModel(await api.compatModels(r.choice.provider), r.choice.provider, r.choice.model || null);
          if (r.models) installed = compatModelRows(r.models, r.current || r.choice?.model);
        }
        if (r.ok) {
          MC.current = r.choice; api.setModelChoice?.(r.choice);
          dispatch({ type: 'ctx', ctx: { provider: null, model: null, endpoint: null } }); // the status line shows the new ask until the server answers
        }
        say(r.text, r.tone);
        if (installed) for (const [t, tone] of installed) say(clip(t, cols - 4), tone);
        return undefined;
      }
      case '/capabilities': {
        if (!api.capabilities) return say('Capabilities are not available in this mode.', 'warn');
        const res = await api.capabilities();
        if (restArg && res.ok) {
          const c = findCapability(restArg, res);
          if (!c) return say(`Nothing called "${restArg}". /capabilities lists them.`, 'warn');
          say(clip(`${c.name}: ${c.intent}`, cols - 4));
          say(clip(`Proof: ${c.evidence || 'not stated'}`, cols - 4));
          return say(clip(offerFor(c.id, res) || `✔ ${c.name} is ready here.`, cols - 4), c.availability === 'installed' ? 'ok' : 'warn');
        }
        for (const [t, tone] of capabilityLines(res)) say(clip(t, cols - 4), tone);
        return undefined;
      }
      case '/workflow': case '/crystal': case '/memory': case '/proof': case '/reconcile': return undefined; // answered above (runObjectCommand)
      case '/agents': return say('Usage: /agents <name> shows an agent card.'); // the bare list belongs to the slash-commands work
      case '/detach':
        SN.current.agent = null; SN.current.slotTarget = null; where.current = { ...where.current, agent: SN.current.baseAgent }; bump(x => x + 1);
        return say('Back to CommanderQ.');
      case '/sessions': {
        if (arg === 'all') {
          if (!api.sessionsIndex) return say('The session index is not available in this mode.', 'warn');
          try {
            for (const l of overviewLines(await api.sessionsIndex(), { localHost: osHostname(), names: loadNames(namesPath) })) say(clip(l.text, cols - 4), l.tone);
          } catch (e) { dispatch({ type: 'error', text: `sessions all: ${e.status ? `HTTP ${e.status}: ` : ''}${e.message}` }); }
          return undefined;
        }
        if (!api.conversations) return say('Sessions are not available in this mode.', 'warn');
        try {
          const rows = await api.conversations(); const names = loadNames(namesPath);
          if (!rows.length) return say('No recent conversations.');
          for (const r of rows) say(`${r.id.slice(0, 12)}  ${clip(names[r.id]?.name || r.title || '(untitled)', Math.max(10, cols - 30))}  ${r.updated_at ? String(r.updated_at).slice(0, 16).replace('T', ' ') : ''}`);
        } catch (e) { dispatch({ type: 'error', text: `sessions: ${e.message}` }); }
        return undefined;
      }
      case '/quit': case '/exit': {
        const midTurn = Boolean(S.current.turn);
        if (!leaveArmed('quit')) return undefined;
        R.current.leaveAsk = null;
        return exit(midTurn ? 30 : 0); // mid-turn: let the "keeps working" line paint first
      }
      case '/restart': {
        if (!onRestart) return say('Restart is not available in this mode.', 'warn');
        if (!leaveArmed('restart')) return undefined;
        R.current.leaveAsk = null;
        if (R.current.restarting) return say('Already restarting…', 'dim');
        R.current.restarting = true;
        let target;
        if (restartCheck) { // never let go of the terminal for a quox that cannot start: say so and stay
          say('Checking the installed quox…', 'dim');
          const c = await restartCheck();
          if (!c.ok) { R.current.restarting = false; return say(`Could not restart: ${c.bin} did not start (${c.error}). Still in this client.`, 'warn'); }
          target = c.onPath || undefined;
        }
        say(`Restarting${S.current.ctx.conversationId ? ' into this conversation' : ''}…`, 'dim');
        onRestart({ conversationId: S.current.ctx.conversationId || null, name: SN.current.name || null, bin: target });
        return exit(30);
      }
      case '/demo': {
        if (!leaveArmed('demo')) return undefined;
        R.current.leaveAsk = null;
        if (!onDemo) return say('/demo needs the terminal client.', 'warn');
        say('Starting the demo (autoplay, nothing real runs). Quit it to come back.', 'dim');
        onDemo();
        return exit(30);
      }
      case '/gripe': case '/gripe!': {
        if (!api.gripe) return say('/gripe is not available in this mode.', 'warn');
        const pending = R.current.pendingGripe && Date.now() - R.current.pendingGripe.at < 120000 ? R.current.pendingGripe.text : null;
        const text = restArg || (cmd === '/gripe!' ? pending : null);
        if (!text) return say(cmd === '/gripe!' ? 'Nothing to file. /gripe <text> first, or /gripe! <text>.' : 'Usage: /gripe <what is wrong>  (/gripe! <text> files without asking)', 'warn');
        if (cmd === '/gripe') { // ask first: filing makes a public-ish issue
          R.current.pendingGripe = { text, at: Date.now() };
          say(`File this as a GitHub issue via GRIPE? "${clip(text, Math.max(20, cols - 50))}"`);
          return say('/gripe! files it · /gripe <new text> replaces it · anything else leaves it unfiled', 'dim');
        }
        R.current.pendingGripe = null;
        say('Filing via GRIPE…', 'dim');
        const g = await api.gripe(text.slice(0, 4000), { yes: true });
        if (!g.ok) return say(`Gripe not filed: ${g.message}`, 'warn');
        if (!g.superseded && g.response && !g.url) for (const l of String(g.response).split('\n').filter(Boolean).slice(0, 6)) say(clip(l, cols - 4), 'dim');
        for (const n of g.notes || []) {
          if (n.kind === 'created') say(`✔ GRIPE │ issue filed │ ${n.url}`, 'ok');
          else say(clip(n.text, cols * 3), n.kind === 'warn' ? 'warn' : 'dim');
        }
        return undefined;
      }
      case '/status': case '/context': case '/cost': case '/usage':
        return showPanel(cmd === '/usage' ? '/cost' : cmd);
      case '/doctor': {
        if (!api.doctorChecks) return say('/doctor is not available in this mode.', 'warn');
        say('Running the quox doctor checks…', 'dim');
        const [plat, chat] = await Promise.all([api.doctorChecks().then(c => ({ c }), e => ({ e })), chatChecks(api)]);
        const empty = !plat.e && (!Array.isArray(plat.c) || !plat.c.length); // a run that produced no rows is a failure to say, not a blank panel
        return help(doctorModel(Array.isArray(plat.c) ? plat.c : [], chat, plat.e ? (plat.e.message || 'failed') : empty ? 'the doctor checks returned no results' : null));
      }
      case '/server': {
        if (!api.serverStatus) return say('/server is not available in this mode.', 'warn');
        say('Reading the server status…', 'dim');
        const st = await api.serverStatus().then(r => r, e => ({ ok: false, error: e?.message || 'failed' }));
        if (!st.ok) return say(`No server status: ${st.error}`, 'warn');
        help(st.rows);
        return say('Change it from a terminal: quox server update --dry-run shows the plan first (also rollback, uninstall, doctor, diag).', 'dim');
      }
      case '/dashboard': {
        if (!api.dashboardLink) return say('/dashboard is not available in this mode.', 'warn');
        const r = await api.dashboardLink(arg || '').catch(e => ({ kind: 'error', error: e?.message || 'failed' }));
        // The link is a credential: the lines go to the screen only; the dev transcript records that one was minted.
        for (const l of dashboardLines(r, { hyperlinks: supportsHyperlinks(env, Boolean(stdout?.isTTY)) })) {
          const sensitive = r.kind === 'link' && l.text.includes(r.url);
          dispatch({ type: 'note', text: l.text, tone: l.tone, ...(sensitive ? { redact: 'dashboard link minted' } : {}) });
        }
        return undefined;
      }
      case '/config': case '/settings':
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        return openConfig();
      case '/consent': {
        if (!api.consentStatus) return say('/consent is not available in this mode.', 'warn');
        const pending = R.current.consent || null;
        if (arg === 'grant') {
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          const prov = String(restArg.replace(/^\S+\s*/, '') || pending?.provider || '').toLowerCase();
          if (!prov) return say('Which provider? /consent grant openai', 'warn');
          try { await api.grantConsent(prov); } catch (e) { return say(`Could not record your consent (${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}). Settings > Privacy in the dashboard does the same.`, 'warn'); }
          say(`✔ Consent recorded: ${prov} may receive your messages and tool results. Change it any time in Settings > Privacy.`, 'ok');
          R.current.consent = null;
          if (pending?.text) { say('Sending your message again.', 'dim'); return runTurn(pending.text); }
          return undefined;
        }
        let rec = null;
        try { rec = await api.consentStatus(); } catch (e) { return say(`Could not read your consent (${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}).`, 'warn'); }
        for (const [t, tone] of consentStatusLines(rec, { provider: pending?.provider })) say(t, tone);
        return undefined;
      }
      case '/compact': {
        if (arg === 'show') {
          const last = R.current.lastCompact;
          if (!last) return say('Nothing compacted in this session yet. /compact runs it.', 'warn');
          return help(compactShowLines(last));
        }
        if (!api.compactConversation) return say('/compact is not available in this mode.', 'warn');
        const id = S.current.ctx.conversationId;
        if (!id) return say('Nothing to compact yet: this conversation starts with your next message.', 'warn');
        if (S.current.turn) return say('A turn is still running in this conversation. Compact after it finishes.', 'warn');
        say('Compacting on the server (one model call)…', 'dim');
        let r;
        try { r = await api.compactConversation(id); } catch (e) { return say(compactError(e), 'warn'); }
        const v = compactResult(r);
        R.current.lastCompact = v;
        return help([
          { kind: 'plain', text: v.head },
          ...v.summaryLines.map(t => ({ kind: 'dim', text: `│ ${t}` })),
          ...(v.more ? [{ kind: 'dim', text: `│ … ${v.more} more line${v.more === 1 ? '' : 's'}. /compact show for all` }] : []),
          ...v.notes.map(t => ({ kind: 'dim', text: t }))
        ]);
      }
      case '/resume':
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        return resumeCmd(restArg);
      case '/dragon': { // the living dragon (qmotion DragonLive): /dragon, classic and hero = the one dragon show, fire = its last act; explain / ask / sleep are dragonModes.js
        const m = parseDragonArg(restArg);
        if (!m) return say(DRAGON_USAGE);
        if (m.mode === 'explain') return dragonExplain();
        if (m.mode === 'ask') return dragonAsk(m.question);
        if (m.mode === 'sleep') return dragonSleep();
        if (m.mode === 'fly') return dragonFly();
        playDragon(m.mode, undefined); bump(n => n + 1); return true;
      }
      case '/dragon-fly': return arg ? say('Usage: /dragon-fly', 'warn') : dragonFly();
      case '/sound': return SND.current.command(arg, say);
      case '/tip': return showTip();
      case '/tips': { let plugins = []; try { plugins = (await api.installedPlugins?.()) || []; } catch { /* unreadable: plugin tips hidden */ }
        const r = tipsReply(arg, { mode: TP.current.mode, plugins }); r.lines.forEach((l, i) => say(l, i ? undefined : r.tone === 'plain' ? undefined : r.tone)); return true; }
      case '/tip-settings': {
        const r = tipSettingsReply(arg, TP.current.mode);
        if (r.mode) { TP.current.mode = r.mode; api.saveSetting?.('tips', r.mode); }
        return say(r.text, r.tone === 'plain' ? undefined : r.tone);
      }
      case '/about': return dispatch({ type: 'welcome', version: packageVersion() });
      case '/help': return dispatch({ type: 'help', model: helpModel(arg, R.current.caps) });
      case '/clear': case '/new': case '/reset': {
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        const prev = S.current.ctx.conversationId;
        dispatch({ type: 'ctx', ctx: { conversationId: null } });
        SN.current.name = null; SN.current.saved = null;
        dispatch({ type: 'history.reset' });
        if (stdout?.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H');
        setEpoch(e => e + 1);
        return say(prev ? 'Previous conversation saved. /resume to go back.' : 'New conversation.');
      }
      case '/aocl': return dispatch({ type: 'aocl.table' });
      case '/verbose':
        if (!['off', 'on', 'full'].includes(arg)) return say(`verbose is ${S.current.verbose}. Use /verbose off|on|full`);
        dispatch({ type: 'verbose', mode: arg });
        if (api.saveSetting) api.saveSetting('verbose', arg); // persisted per user (profile settings)
        return say(`verbose ${arg}${api.saveSetting ? ' (saved)' : ''}`);
      case '/rules': {
        if (arg === 'off' || arg === 'on') {
          R.current.rulesOn = arg === 'on';
          bump(n => n + 1);
          return say(arg === 'on' ? (rules?.files?.length ? 'Rules on.' : 'No QUOX.md loaded, nothing to turn on.') : 'Rules off for this session (nothing from QUOX.md is sent).');
        }
        const lines = rulesLines(rules, { enabled: R.current.rulesOn !== false, cols });
        const per = 20, pages = Math.max(1, Math.ceil(lines.length / per));
        const pg = Math.min(pages, Math.max(1, Number(arg) || 1));
        lines.slice((pg - 1) * per, pg * per).forEach(l => say(clip(l, cols - 4)));
        if (pages > 1) say(`page ${pg}/${pages}${pg < pages ? ` · /rules ${pg + 1} for more` : ''}`);
        return undefined;
      }
      case '/org': {
        if (!api.orgs) return say('Org switching is not available in this mode.', 'warn');
        const R0 = R.current, curId = R0.orgId ?? api.orgId?.() ?? null;
        const sub = (restArg.match(/^(\S+)\s*(.*)$/) || [])[1] || '';
        const query = (restArg.match(/^\S+\s+(.*)$/) || [])[1]?.trim() || '';
        let list;
        try { list = await api.orgs(); } catch (e) { return say(`Couldn't list your orgs: ${listFailure(e, profile)}`, 'warn'); }
        if (!sub || sub === 'list') {
          if (!list.length) return say('No orgs returned for this login.', 'warn');
          orgLines(list, curId).forEach(l => say(l));
          return say('/org switch <name> to move this session to another one.');
        }
        if (sub === 'yes') {
          const t = R0.orgPending; R0.orgPending = null;
          if (!t) return say('Nothing to confirm. /org switch <name> first.', 'warn');
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          if (!api.switchOrg) return say('Org switching is not available in this mode.', 'warn');
          let done;
          try { done = await api.switchOrg(t.id); } catch (e) { return say(`Not switched. ${e?.message || 'The server refused.'} You are still in ${R0.orgName ?? org ?? 'the same org'}.`, 'warn'); }
          R0.orgId = done.id; R0.orgName = done.name;
          dispatch({ type: 'ctx', ctx: { conversationId: null } });
          SN.current.name = null; SN.current.saved = null;
          dispatch({ type: 'history.reset' });
          if (stdout?.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H');
          setEpoch(e => e + 1); bump(n => n + 1);
          return say(`Switched to ${done.name}. New conversation in that org.`, 'ok');
        }
        if (sub !== 'switch') return say('Usage: /org  or  /org switch <name or id>', 'warn');
        if (!query) return say('Usage: /org switch <name or id>. /org lists them.', 'warn');
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        const m = matchOrg(query, list);
        if (m.ambiguous) return say(`"${query}" matches more than one: ${m.ambiguous.map(o => o.name).join(', ')}. Be more specific.`, 'warn');
        if (!m.org) return say(`No org of yours matches "${query}". /org lists them.`, 'warn');
        if (m.org.id === curId) return say(`Already in ${m.org.name}.`);
        R0.orgPending = { id: m.org.id, name: m.org.name };
        return say(`Switch to ${m.org.name}? This starts a new conversation in that org. /org yes to confirm.`, 'warn');
      }
      case '/skills': {
        if (!api.skills) return say('This server has no skills list.', 'warn');
        try {
          const all = await api.skills();
          if (arg) {
            const sk = findSkill(all, arg);
            if (!sk) return say(`No skill named "${arg}". /skills lists them.`, 'warn');
            const full = (api.skill && sk.id ? await api.skill(sk.id) : null) || sk;
            skillDetail(full).forEach(l => say(clip(l, cols - 4)));
            return undefined;
          }
          if (!all.length) return say('No skills in this org yet.');
          say(`${all.length} skill${all.length === 1 ? '' : 's'}. /skills <name> for detail, /skill <name> [args] to run:`);
          skillRows(all.slice(0, 25), cols - 4).forEach(l => say(l));
          if (all.length > 25) say(`... and ${all.length - 25} more. /skills <name> shows any one.`);
        } catch (e) { dispatch({ type: 'error', text: `skills: ${e.message}` }); }
        return undefined;
      }
      case '/skill': {
        const argRest = line.trim().split(/\s+/).slice(2).join(' ');
        if (!arg) return say('Usage: /skill <name> [args]. /skills lists them.', 'warn');
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        if (blocked) return say(blocked, 'warn');
        if (api.skills) {
          try {
            const sk = findSkill(await api.skills(), arg);
            if (!sk) return say(`No skill named "${arg}". /skills lists them.`, 'warn');
            return submit(skillPrompt(sk.name || arg, argRest));
          } catch (e) { return dispatch({ type: 'error', text: `skills: ${e.message}` }); }
        }
        return submit(skillPrompt(arg, argRest));
      }
      case '/roster': {
        const ro = R.current.roster;
        if (arg === 'all') {
          ro.all = !ro.all; ro.on = true;
          ro.rows = selectRows(ro.allRows, { all: ro.all }); ro.sel = 0;
          return say(ro.all ? 'Roster shows everything, background work included. /roster all again to hide it.' : 'Roster shows only what needs you. Background work is hidden.');
        }
        ro.on = !ro.on; if (!ro.on) { ro.focus = false; ro.peek = false; ro.confirm = null; }
        say(`Roster ${ro.on ? 'on' : 'off'}.${ro.sources ? '' : ' Not loaded yet.'}`);
        for (const src of ro.sources || []) {
          say(`${src.state === 'connected' ? '✔' : src.state === 'error' ? '✖' : '·'} ${src.label}: ${src.state === 'connected' ? `${src.count} shown` : `${src.state}${src.note ? ` (${src.note})` : ''}`}`, src.state === 'error' ? 'warn' : undefined);
        }
        if (ro.sources) say('Down on an empty composer focuses the roster. Enter peeks, s stops (y confirms), Esc returns.');
        return undefined;
      }
      case '/sitrep': {
        if (!api.sitrep) return say('/sitrep is not available in this mode.', 'warn');
        const r = await api.sitrep();
        return dispatch({ type: 'object', obj: { type: 'sitrep', data: sitrepData(r.situation, r.approvals) } });
      }
      case '/away': {
        if (!api.away) return say('/away is not available in this mode.', 'warn');
        const p = parseSince(restArg, { lastSeen: AWAY.current.last });
        if (!p.ok) return say(p.error, 'warn');
        try { dispatch({ type: 'object', obj: { type: 'away', data: await api.away(p.since) } }); }
        catch (e) { say(`away: could not read the digest (${e?.status ? `HTTP ${e.status}` : e?.message || 'failed'}). Nothing is assumed.`, 'warn'); }
        return undefined;
      }
      case '/observers': {
        if (!api.observers) return say('Observers are not available in this mode.', 'warn');
        try { for (const [text, tone] of observerLines(await api.observers(), cols)) say(text, tone); }
        catch (e) { dispatch({ type: 'error', text: `observers: ${e.message}` }); }
        return undefined;
      }
      case '/approvals': {
        let items;
        try { items = await api.approvals(); }
        catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}). That does not mean nothing is waiting; try again or run: quox inbox list` }); }
        let stats = null; let statsErr = null;
        if (api.approvalStats) { try { stats = await api.approvalStats(); } catch (e) { statsErr = e.message; } }
        const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
        const groups = groupApprovals(items, { conversationId: S.current.ctx.conversationId, cardIds });
        const flat = groups.flatMap(g => g.items.map(x => x.item));
        dispatch({ type: 'inbox', items: flat });
        dispatch({ type: 'notify', patch: { approvals: flat.length, error: null } });
        const hidden = stats ? Math.max(0, stats.awaiting - flat.length) : 0;
        if (!flat.length && !hidden && !statsErr) return say('Nothing is waiting for your approval.');
        if (flat.length) say(`${flat.length} waiting. ${mark('/approve N')} or ${mark('/deny N')} (privileged ones: ${mark('/approve N confirm')}):`, 'warn');
        let n = 0;
        for (const g of groups) {
          say(`${g.group}:`, 'warn');
          for (const x of g.items) say(`  [${++n}] ${clip(x.item.title || x.item.summary || x.item.id, cols - 12 - x.label.length)} (${x.label})${isPrivileged({ tool: x.item.payload?.approval_context?.method?.tool, risk: x.item.payload?.approval_context?.risk, flag: x.item.payload?.privileged === true || x.item.payload?.approval_context?.privileged === true, title: x.item.title }) ? ' [privileged]' : ''}`);
        }
        if (hidden) {
          const others = humanProfiles.filter(h => h !== profile);
          const who = agentLogin ? `${profile} (an agent login), so it can't approve these` : `${profile}, which cannot act on these`;
          say(`${hidden} more approval${hidden === 1 ? ' is' : 's are'} waiting org-wide. This window is signed in as ${who}.${others.length ? ` Quit and run: quox -p ${others[0]}${others.length > 1 ? ` (human profiles found: ${others.join(', ')})` : ''}. Or approve in the dashboard Approvals page, or: quox inbox -p ${others[0]} respond <id> --action approve|reject` : ' Approve in the dashboard Approvals page.'}`, 'warn');
        }
        if (statsErr) say(`Could not check the org-wide approval count (${statsErr}); the list above is what the inbox returned.`, 'warn');
        return undefined;
      }
      case '/approve': case '/deny': {
        const verb = cmd === '/approve' ? 'approve' : 'reject';
        const words = line.trim().split(/\s+/).slice(1);
        const confirm = words.includes('confirm');
        const spec = words.filter(w => w !== 'confirm');
        const usage = `Usage: ${mark(`${cmd} N [N...]`)} | ${mark(`${cmd} 1,2`)} | ${mark(`${cmd} 1-3`)} | ${mark(`${cmd} all`)}   (privileged ones need: ${mark(`${cmd} N confirm`)}). List them with ${mark('/approvals')}.`;
        const nums = []; let bad = false; let all = false;
        for (const w of spec) for (const part of w.split(',').filter(Boolean)) {
          const m = /^(\d+)(?:-(\d+))?$/.exec(part);
          if (part.toLowerCase() === 'all') all = true;
          else if (m && Number(m[1]) >= 1 && Number(m[2] ?? m[1]) >= Number(m[1]) && Number(m[2] ?? m[1]) - Number(m[1]) < 200) { for (let k = Number(m[1]); k <= Number(m[2] ?? m[1]); k++) nums.push(k); }
          else bad = true;
        }
        if (bad || (!all && !nums.length)) return say(`${spec.length ? `Could not read "${spec.join(' ')}". ` : ''}${usage}`, 'warn');
        let list = S.current.inbox;
        if (!list.length || (!all && nums.some(k => !list[k - 1]))) { // never send the user back to /approvals: fetch the same list, in the same order, ourselves
          try {
            const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
            list = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds }).flatMap(g => g.items.map(x => x.item));
            dispatch({ type: 'inbox', items: list });
          } catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); }
        }
        if (!list.length) return say('Nothing is waiting for your approval.', 'warn');
        const targets = all ? list.map((_, k) => k + 1) : [...new Set(nums)];
        const privOf = (it) => isPrivileged({ tool: it.payload?.approval_context?.method?.tool, risk: it.payload?.approval_context?.risk, flag: it.payload?.privileged === true || it.payload?.approval_context?.privileged === true, title: it.title });
        const done = []; const heldPriv = []; const failed = []; const missing = [];
        const describe = (k) => { const it = list[k - 1]; return `[${k}] ${clip(it.title || it.id, Math.max(20, cols - 40))} (${approvalSourceLabel(it)})`; };
        for (const k of targets) {
          const it = list[k - 1];
          if (!it) { missing.push(k); continue; }
          if (verb === 'approve' && privOf(it) && !(confirm && !all)) { heldPriv.push(k); continue; }
          try { await answer({ callId: it.id, inboxItemId: it.id, approvalId: it.approval_id || it.approvalId || null, tool: clip(it.title || it.id, cols - 40), target: null }, verb); done.push(k); }
          catch (e) { failed.push(`[${k}] ${e.message}`); }
        }
        for (const k of done) say(`✔ ${verb === 'approve' ? 'Approved' : 'Denied'} ${describe(k)}${verb === 'approve' ? '; the plugin or agent will act on it (its outcome is not tracked here)' : ''}`, 'ok');
        if (done.length > 1) say(`${verb === 'approve' ? 'Approved' : 'Denied'}: ${done.map(k => `[${k}]`).join(' ')}`);
        if (missing.length) say(`No such item: ${missing.map(k => `[${k}]`).join(' ')} (${list.length} listed; /approvals shows them).`, 'warn');
        for (const f of failed) dispatch({ type: 'error', text: `approval: ${f}` });
        if (heldPriv.length && all) say(`${heldPriv.length} privileged left: ${heldPriv.map(k => `${cmd} ${k} confirm`).join(', ')}`, 'warn');
        else if (heldPriv.length) { // ask inline instead of sending the user to a second command
          R.current.pendingGrant = { cmd, verb, items: heldPriv.map(k => list[k - 1]), at: Date.now() };
          for (const k of heldPriv) {
            const it = list[k - 1]; const c = it.payload?.approval_context || {};
            const tools = [].concat(c.elevated_tools || c.tools || it.payload?.tools || c.method?.target || []).filter(Boolean).join(', ');
            say(`Grant ${clip(it.title || it.id, cols - 30)} (privileged)${tools ? `: elevated tools ${tools}` : ''}${c.on_behalf_of?.conversation_id ? ' for that conversation' : ''}?`, 'warn');
          }
          say('Type y to grant, anything else cancels. (One-shot form: ' + `${cmd} ${heldPriv.join(' ')} confirm)`, 'warn');
        }
        return undefined;
      }
      default: {
        const e = findEntry(cmd);
        if (e && e.status === 'planned') return say(`${e.usage} is planned, not built yet. /help shows what works today.`, 'warn');
        const sug = suggestCommands(cmd);
        return say(sug.length ? `Unknown command ${cmd}. Did you mean ${sug.join(' or ')}? (/help lists them)` : `Unknown command ${cmd}. Try /help`, 'warn');
      }
    }
  }

  // Closest slots (with host) and agents for a mistyped name, each labelled which is which.
  async function nearbyTargets(name, slots, agents = null) {
    let ag = agents;
    if (!ag && api.agents) { try { ag = await api.agents(); } catch { ag = null; } }
    const out = [];
    const sl = Array.isArray(slots) ? slots : [];
    for (const n of nearest(name, sl.map(x => x.name))) {
      const row = sl.find(x => x.name === n);
      const host = row?.holder_identity ? String(row.holder_identity).replace(/^resident:/, '') : null; // never host_id: an internal id
      out.push(`slot ${n}${host ? ` (${host})` : ''}`);
    }
    const ids = (Array.isArray(ag) ? ag : []).map(a => String(a?.agent_id ?? a?.id ?? a?.name ?? ''));
    for (const n of nearest(name, ids)) out.push(`agent ${n}`);
    return out;
  }

  function onEnter(now) {
    if (now - K.current.lastPasteAt < PASTE_GUARD_MS) return; // post-paste guard
    if (now - K.current.cardGoneAt < CARD_GONE_MS) return; // keys meant for the card must not send a turn
    const buf = B.current;
    if (buf.text.endsWith('\\')) { edit({ type: 'set', text: buf.text.slice(0, -1) + '\n', keepPastes: true }); return; }
    if (!buf.text.trim()) {
      const s = S.current;
      if (!s.turn && s.pending.length) { dispatch({ type: 'queue.shift' }); const n = s.pending[0]; dispatch({ type: 'user', text: n.text, queued: true }); runTurn(n.text, { queued: true }); }
      return;
    }
    const chk = sanitizeForSend(buf);
    if (!chk.ok) { B.current = { ...chk.buffer, undo: buf.undo, redo: buf.redo }; say(chk.note, 'warn'); bump(n => n + 1); return; }
    const text = chk.text.trim();
    const keyHit = looksLikeKey(text);
    if (keyHit) { B.current = initialBuffer(); R.current.confirmMulti = null; say(keyWarning(keyHit), 'warn'); return; } // never sent, never in history
    const bang = parseBang(text);
    if (bang) { // QUOXON-FW8: the user's own command on their own machine; never a turn, never the server
      if (bang.kind !== 'reserved' && bang.kind !== 'empty' && R.current.bang) { say('A command is still running. Ctrl+C stops it; your draft is kept.', 'warn'); return; }
      B.current = initialBuffer(); R.current.confirmMulti = null; R.current.history.push(text); R.current.histIdx = -1;
      bangCommand(bang); bump(n => n + 1); return;
    }
    const s = S.current;
    const isCommand = text.startsWith('/') && !text.includes('\n');
    if (blocked && !isCommand) { // Z2H-R4: clear the box (else the next /login is appended and refused); Up recalls the message
      R.current.history.push(text); R.current.histIdx = -1; B.current = initialBuffer(); say(blocked, 'warn'); bump(n => n + 1); return;
    }
    if (text.startsWith('/') && text.includes('\n') && !R.current.confirmMulti) {
      // commands are one line: never ship a multi-line "/..." draft to the model without an explicit second Enter.
      // The second Enter sends it even after edits (R3 D3: requiring a byte-identical draft swallowed every later Enter).
      R.current.confirmMulti = true;
      if (!R.current.multiWarned) {
        R.current.multiWarned = true;
        say('That draft starts with / but has several lines, so it is not a command. Press Enter again to send it to Quox as chat, or edit it (Esc Esc clears it).', 'warn');
      }
      return;
    }
    R.current.confirmMulti = null; R.current.multiWarned = false;
    B.current = initialBuffer();
    if (R.current.pendingGrant) { // /approve N on a privileged item asked "y/N": this one line is the answer
      const g = R.current.pendingGrant; R.current.pendingGrant = null;
      if (Date.now() - g.at < 120000 && !text.startsWith('/')) {
        if (/^y(es)?$/i.test(text.trim())) {
          (async () => {
            for (const it of g.items) {
              try { await answer({ callId: it.id, inboxItemId: it.id, approvalId: it.approval_id || it.approvalId || null, tool: clip(it.title || it.id, cols - 40), target: null }, g.verb); say(`✔ Granted ${clip(it.title || it.id, cols - 20)}`, 'ok'); }
              catch (e) { dispatch({ type: 'error', text: `approval: ${e.message}` }); }
            }
          })();
        } else say('Cancelled; nothing granted.', 'dim');
        return;
      }
    }
    if (text.startsWith('/') && !text.includes('\n')) { command(text); return; }
    if (R.current.askArmed && !s.turn) { // /dragon ask with no question: this one line goes to the dragon
      R.current.askArmed = false; R.current.dragonTalk = null; touchSeen(); dispatch({ type: 'user', text });
      R.current.history.push(text); R.current.histIdx = -1; dragonTurn(DRAGON_ANSWERS, askPrompt(text)); return;
    }
    if (s.turn && !R.current.caps.steer) { // steering already refused for this turn: queue, say so once
      dispatch({ type: 'queue.add', text });
      if (!R.current.steerNoted) { R.current.steerNoted = true; say(STEER_OFF_NOTE, 'warn'); }
      return;
    }
    if (s.turn) { steer(text); return; }
    submit(text);
  }

  /** Returns true when the text was consumed as an approval key, false when it is ordinary typing. */
  function approvalKey(name, text, now) {
    const card = S.current.approvals[0];
    if (!card) return false;
    const ch = text || '';
    const g = K.current.guard;
    const armedAt = card.displayedAt ?? card.shownAt;
    // Typing never approves. Keys answer the card only when it is explicitly focused (Tab), or it arrived in this
    // turn, is not privileged, and the composer is empty. Otherwise a/d/o are ordinary text.
    const focused = K.current.cardFocus;
    if (!focused && (card.privileged || B.current.text || !cardFresh(card))) return false;
    if (card.privileged) {
      // a granted privilege: focused card, then "a" + "y", or the typed word. Undescribable ones take the word only.
      if (now - armedAt < 300) return true;
      const k = K.current;
      if (ch === 'd' && approvalKeyAllowed({ now, shownAt: armedAt, lastKeyAt: k.lastKeyAt, heldKey: g?.heldKey, ch })) { k.confirm = false; answer(card, 'reject'); return true; }
      k.typed = (k.typed + ch.toLowerCase()).slice(-APPROVE_WORD.length);
      if (k.typed === APPROVE_WORD) { k.typed = ''; k.confirm = false; answer(card, 'approve'); return true; }
      if (!card.undescribable && k.confirm && ch === 'y' && approvalKeyAllowed({ now, shownAt: armedAt, lastKeyAt: k.lastKeyAt, heldKey: g?.heldKey, ch })) { k.confirm = false; answer(card, 'approve'); return true; }
      const next = !card.undescribable && ch === 'a' && !k.confirm;
      if (next !== k.confirm) { k.confirm = next; bump(n => n + 1); }
      return true;
    }
    if (card.undescribable) {
      // no one-key approve for an action Quox cannot describe: the word must be typed, fresh
      if (ch === 'd' && approvalKeyAllowed({ now, shownAt: armedAt, lastKeyAt: K.current.lastKeyAt, heldKey: g?.heldKey, ch })) { answer(card, 'reject'); return true; }
      if (now - armedAt < 300) return true;
      K.current.typed = (K.current.typed + ch.toLowerCase()).slice(-APPROVE_WORD.length);
      if (K.current.typed === APPROVE_WORD) { K.current.typed = ''; answer(card, 'approve'); }
      return true;
    }
    if (!['a', 'd', 'o'].includes(ch)) return false; // ordinary typing: the draft keeps it
    if (!approvalKeyAllowed({ now, shownAt: armedAt, lastKeyAt: K.current.lastKeyAt, heldKey: g?.heldKey, ch })) return true;
    if (ch === 'o') { say(`open: ${card.url || '(no link)'}`); return true; }
    const action = ch === 'a' ? 'approve' : 'reject';
    answer(card, action);
    return true;
  }

  const rosterOn = () => { const ro = R.current.roster; return ro.on && ro.rows.length > 0 && rosterView({ rows: ro.rows, cols, termRows: termRows(stdout) ?? 40 }).mode === 'full'; };
  function focusRoster() { const ro = R.current.roster; ro.focus = true; ro.sel = Math.min(ro.sel, Math.min(ro.rows.length, MAX_ROSTER) - 1); ro.peek = false; ro.confirm = null; bump(n => n + 1); }
  function leaveRoster() { const ro = R.current.roster; ro.focus = false; ro.peek = false; ro.confirm = null; bump(n => n + 1); }
  /** Keys while the roster has focus. Returns true when consumed. */
  function rosterKey(name, text) {
    const ro = R.current.roster;
    const visible = Math.min(ro.rows.length, MAX_ROSTER);
    if (!visible) { leaveRoster(); return false; }
    if (ro.confirm) { // any key answers; only y stops
      const row = ro.confirm; ro.confirm = null;
      if (text === 'y') stopRow(row); else { say('Stop cancelled.'); bump(n => n + 1); }
      return true;
    }
    if (name === 'up') { ro.sel = Math.max(0, ro.sel - 1); ro.peek = false; bump(n => n + 1); return true; }
    if (name === 'down') { ro.sel = Math.min(visible - 1, ro.sel + 1); ro.peek = false; bump(n => n + 1); return true; }
    if (name === 'enter') { ro.peek = !ro.peek; bump(n => n + 1); if (ro.peek && ro.rows[ro.sel]?.kind === 'workflow') command(`/workflow ${ro.rows[ro.sel].id}`); return true; }
    if (name === 'escape') { if (ro.peek) { ro.peek = false; bump(n => n + 1); } else leaveRoster(); return true; }
    if (text === 's') { ro.confirm = ro.rows[ro.sel]; ro.peek = false; bump(n => n + 1); return true; }
    if (text) { leaveRoster(); return false; } // ordinary typing goes to the draft
    return true; // other keys are swallowed while focused
  }
  async function stopRow(row) {
    const ro = R.current.roster;
    if (!api.stopRow) return say('Stop not available on this server.', 'warn');
    const r = await api.stopRow(row);
    if (r.unavailable) return say(`Stop not available for ${row.kind} "${clip(row.name, 40)}": no governed stop route exists.`, 'warn');
    say(r.message, r.ok ? undefined : 'warn');
    if (r.ok) { refreshRoster(); }
    return ro;
  }

  function onKey(e, now) {
    const s = S.current;
    const busy = Boolean(s.turn);
    const name = e.name;
    if (name === 'ctrl-c') {
      if (R.current.bang) { R.current.bang.run.kill(); return; } // QUOXON-FW8: stops the running ! command, never quits
      if (B.current.text) { edit({ type: 'clear' }); return; }
      if (busy) { interrupt(); return; }
      if (K.current.ctrlC) return exit();
      K.current.ctrlC = 1; say('Press Ctrl+C again to quit.');
      clearTimeout(R.current.ctrlCTimer);
      R.current.ctrlCTimer = setTimeout(() => { K.current.ctrlC = 0; }, 1500);
      return;
    }
    if (name === 'ctrl-d') { if (!B.current.text) exit(); return; }
    if (R.current.roster.focus && !s.approvals.length && rosterKey(name)) return;
    if (!s.approvals.length && PL.current.onKey(name)) { bump(n => n + 1); return; }
    if (name === 'escape') {
      if (flyActive()) { R.current.fly = null; bump(n => n + 1); return; } // Esc ends the dragon's pass
      if (busy) { interrupt(); return; }
      if (R.current.askArmed) { R.current.askArmed = false; R.current.dragonTalk = null; say('Dragon ask cancelled.', 'dim'); return; }
      if (now - K.current.lastEscAt < ESC_ESC_MS && B.current.text) {
        if (looksLikeKey(B.current.text)) { edit({ type: 'clear' }); say('Draft cleared. It looked like a key, so it was not kept.'); }
        else { R.current.history.push(B.current.text); edit({ type: 'clear' }); say('Draft cleared (Up recalls it).'); }
      }
      K.current.lastEscAt = now; return;
    }
    // with a card up only draft-editing keys work (so the draft can be cleared); nothing submits or recalls
    if (cardCaptures() && !CARD_EDIT_KEYS.includes(name)) return;
    switch (name) {
      case 'enter': return onEnter(now);
      case 'shift-enter': case 'newline': return edit({ type: 'newline' });
      case 'tab':
        if (busy && B.current.text.trim()) { const t = sanitizeForSend(B.current); if (!t.ok || looksLikeKey(t.text)) return onEnter(now); dispatch({ type: 'queue.add', text: t.text.trim() }); B.current = initialBuffer(); bump(n => n + 1); }
        return;
      case 'backspace': return edit({ type: 'backspace' });
      case 'delete': return edit({ type: 'delete' });
      case 'delete-word': return edit({ type: 'deleteWordBack' });
      case 'kill-line': return edit({ type: 'killLineBack' });
      case 'left': case 'right': case 'home': case 'end': return edit({ type: name });
      case 'word-left': case 'word-right': return edit({ type: name === 'word-left' ? 'left' : 'right' });
      case 'undo': return edit({ type: 'undo' });
      case 'redo': return edit({ type: 'redo' });
      case 'up': {
        if (B.current.text === '' && s.pending.length) { const last = s.pending[s.pending.length - 1]; dispatch({ type: 'queue.pop' }); edit({ type: 'set', text: last.text }); return; }
        if (!B.current.text.slice(0, B.current.cursor).includes('\n')) {
          const hist = R.current.history;
          if (B.current.text === '' || R.current.histIdx >= 0) {
            const i = R.current.histIdx < 0 ? hist.length - 1 : Math.max(0, R.current.histIdx - 1);
            if (hist[i] !== undefined) { R.current.histIdx = i; edit({ type: 'set', text: hist[i] }); }
          }
          return;
        }
        return edit({ type: 'up' });
      }
      case 'down': {
        if (B.current.text === '' && R.current.histIdx < 0 && rosterOn()) { focusRoster(); return; }
        if (!B.current.text.slice(B.current.cursor).includes('\n') && R.current.histIdx >= 0) {
          const i = R.current.histIdx + 1;
          if (i >= R.current.history.length) { R.current.histIdx = -1; edit({ type: 'clear' }); } else { R.current.histIdx = i; edit({ type: 'set', text: R.current.history[i] }); }
          return;
        }
        return edit({ type: 'down' });
      }
      case 'ctrl-g': {
        const full = sanitizeForSend({ ...B.current }).text ?? B.current.text;
        if (isRawModeSupported) setRawMode(false);
        const out = editor(full);
        if (isRawModeSupported) setRawMode(true);
        if (out !== null && out !== undefined) edit({ type: 'set', text: out });
        return;
      }
      case 'ctrl-s': {
        if (B.current.text) { R.current.stash.push(B.current.text); edit({ type: 'clear' }); say('Draft stashed. Ctrl+S on an empty composer restores it.'); }
        else if (R.current.stash.length) edit({ type: 'set', text: R.current.stash.pop() });
        return;
      }
      default:
    }
  }

  const onData = React.useRef(null);
  const handleEvents = (events, now, burst) => {
    for (const e of events) {
      if (e.type === 'focus') { SND.current.focus(e.focused); continue; } // CSI I / CSI O, never a key
      if (R.current.sleep) { // the sleep screen eats every key: the waking key is never inserted, nothing is lost
        if (e.type === 'key' && e.name === 'ctrl-c') exit(); else wakeDragon();
        K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue;
      }
      if (LI.current.isOpen()) { LI.current.onEvent(e); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // the sign-in card takes every key
      if (CN.current.isOpen()) { CN.current.onEvent(e); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // the secure card takes every key
      if (PK.current.isOpen() && !S.current.approvals.length && PK.current.onEvent(e) !== false) { K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // /resume, /config (typing closes it and falls through)
      const card = S.current.approvals[0];
      const g = K.current.guard;
      // any different key ends the "this key was already down" suppression
      if (g?.heldKey && !(e.type === 'text' && e.text === g.heldKey)) g.heldKey = null;
      if (card && e.type === 'key' && e.name === 'tab') { K.current.cardFocus = true; bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      if (card && e.type === 'key' && e.name === 'escape' && K.current.cardFocus) { K.current.cardFocus = false; K.current.confirm = false; bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      if (e.type === 'paste') {
        K.current.lastPasteAt = now;
        edit({ type: 'paste', text: e.text }); // a card never discards a paste
      } else if (e.type === 'text') {
        if (card && approvalKey('text', e.text, now)) { /* consumed by the approval dialog */ }
        else if (!card && R.current.roster.focus && rosterKey(null, e.text)) { /* consumed by the roster */ }
        else edit({ type: 'insert', text: e.text });
      } else if (e.type === 'key') {
        if (card && cardCaptures() && !['escape', 'ctrl-c', ...CARD_EDIT_KEYS].includes(e.name)) { /* swallowed while approving */ }
        else if (e.name === 'enter' && burst) edit({ type: 'newline' }); // startup keys only: never submitted
        else onKey(e, now);
      }
      K.current.lastKeyAt = now;
      K.current.lastKeyCh = e.type === 'text' ? e.text : null;
    }
  };
  onData.current = (chunk) => {
    const now = Date.now();
    finishIntroRef.current();
    // Enter is a newline only inside a real paste (bracketed, or several lines in one chunk: keys.js).
    // Its timing relative to the previous chunk says nothing: tmux, expect and SSH batch segments.
    const burst = false;
    K.current.lastDataAt = now;
    const parsed = parseChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), K.current.keys, B.current.text);
    K.current.keys = parsed.state;
    clearTimeout(K.current.danglingTimer);
    if (hasDangling(parsed.state)) {
      K.current.danglingTimer = setTimeout(() => {
        const f = flushDangling(K.current.keys);
        K.current.keys = f.state;
        handleEvents(f.events, Date.now(), false); // as paste text: inserted, never submitted
        bump(n => n + 1);
      }, PASTE_DANGLING_MS);
    }
    handleEvents(parsed.events, now, burst);
  };

  // QUOXON J2: `quox --conversation <id>` opens that conversation interactively.
  React.useEffect(() => {
    if (!resumeConversation || !api.conversationTurns) return undefined;
    let live = true;
    api.conversationTurns(resumeConversation).then((turns) => {
      if (!live) return;
      if (!turns.length) {
        // C5: the conversation's first turn may still be running (nothing is stored until it ends).
        return api.runningTurn?.(resumeConversation).then((r) => {
          if (!live) return;
          if (r?.running) { dispatch({ type: 'ctx', ctx: { conversationId: resumeConversation } }); followTurn(resumeConversation, r.turnId); return; }
          say(`No saved turns for conversation ${resumeConversation} (not yours, expired after 7 days, or a typo). Starting a new conversation.`, 'warn');
        }) ?? say(`No saved turns for conversation ${resumeConversation} (not yours, expired after 7 days, or a typo). Starting a new conversation.`, 'warn');
      }
      dispatch({ type: 'resume', conversationId: resumeConversation, turns });
      return reattachIfRunning(resumeConversation);
    }, (e) => { if (live) dispatch({ type: 'error', text: `could not load conversation ${resumeConversation}: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); });
    return () => { live = false; };
  }, []);
  React.useEffect(() => {
    if (!startup) return undefined;
    let live = true;
    Promise.resolve().then(startup).then((note) => { if (live && note) say(note, 'warn'); }, () => {});
    return () => { live = false; };
  }, []);
  React.useEffect(() => { // E5: "While you were away" under the intro, after more than 2 h away
    if (!away) return undefined;
    let live = true;
    try { AWAY.current.last = away.read(profile); } catch { AWAY.current.last = null; }
    const last = AWAY.current.last;
    touchSeen(true);
    if (!BL.current && api.away && awayDue(last)) {
      api.away(new Date(last).toISOString()).then((d) => { if (live) dispatch({ type: 'object', obj: { type: 'away', data: { ...d, compact: true } } }); },
        (e) => { if (live && !BL.current) say(`While you were away: could not read the digest (${e?.status ? `HTTP ${e.status}` : e?.message || 'failed'}). /away to retry.`, 'warn'); });
    }
    return () => { live = false; touchSeen(true); };
  }, []);
  React.useEffect(() => { // --demo --autoplay: the whole journey with no input, on a fixed script (demo.autoplay.js)
    if (!demoAuto) return undefined;
    const P = { ...AUTOPLAY, ...demoAuto };
    const k = demoAuto.scale || 1; // tests shrink every wait by the same factor; the order never changes
    const wait = (ms) => new Promise((res) => setTimeout(res, ms / k));
    const until = async (pred, limit = 120000) => { for (let t = 0; t < limit && !R.current.closed; t += 25) { if (pred()) return true; await new Promise((res) => setTimeout(res, 25)); } return false; };
    const type = async (text, seed) => { for (const [i, d] of typingPlan(text, seed, { min: P.typeMinMs, max: P.typeMaxMs }).entries()) { if (R.current.closed) return; onData.current([...text][i]); await wait(d); } };
    (async () => {
      await wait(P.startMs);
      await type(AUTOPLAY_REQUEST, P.seed); await wait(P.afterTypeMs); onData.current('\r');
      if (!await until(() => S.current.approvals[0]?.displayedAt != null)) return;
      await wait(Math.max(P.approvalHoldMs, 450 * k)); // never shorter than the card's arming window + key-repeat guard
      onData.current('\t'); await wait(Math.max(P.afterKeyMs, 450 * k)); // explicit focus, as a person must; the key-repeat guard still applies between Tab and a
      say('autoplay presses a: approve', 'ok');
      onData.current('a'); await wait(P.afterKeyMs);
      if (!await until(() => !S.current.turn && !S.current.approvals.length && !S.current.running.length)) return;
      await wait(P.afterTurnMs);
      await type(AUTOPLAY_PROOF, P.seed + 1); await wait(P.afterTypeMs); onData.current('\r');
      await wait(P.finalHoldMs);
      if (P.exitAfterMs != null) { await wait(P.exitAfterMs); if (!R.current.closed) exit(); }
    })();
    return undefined;
  }, []);
  React.useEffect(() => { // --demo plays by itself
    if (!autoplay) return undefined;
    const t = setTimeout(() => { if (!S.current.turn && !R.current.closed) { dispatch({ type: 'user', text: autoplay }); runTurn(autoplay); } }, 600);
    return () => clearTimeout(t);
  }, []);
  React.useEffect(() => {
    if (!stdin) return undefined;
    if (isRawModeSupported) setRawMode(true);
    if (stdout?.isTTY) stdout.write(PASTE_ON);
    const fn = (d) => onData.current(d);
    if (earlyInput) { // keys typed during startup: replayed exactly as if typed now (R3 D4: an Enter submits, it is not dropped)
      earlyInput.detach();
      for (const chunk of earlyInput.chunks.splice(0)) onData.current(chunk);
    }
    stdin.on('data', fn);
    return () => {
      R.current.closed = true;
      R.current.abort?.abort(); // closing quoxon cancels the active stream (and its HTTP body)
      for (const k of ['fallbackTimer', 'ctrlCTimer']) clearTimeout(R.current[k]);
      clearTimeout(K.current.danglingTimer);
      for (const t of R.current.pollTimers) clearTimeout(t);
      R.current.pollTimers.clear();
      R.current.pollWake?.();
      stdin.off('data', fn);
      if (stdout?.isTTY) stdout.write(PASTE_OFF);
      SND.current?.dispose?.(); // focus reporting off: it must not outlive the client (or leak into a /restart child)
      if (isRawModeSupported) setRawMode(false);
    };
  }, [stdin]);

  // ---- view ----------------------------------------------------------------------------------
  // Height of everything below the live blocks, measured after each layout; sizes the live region next frame.
  React.useLayoutEffect(() => { if (chromeRef.current) chromeH.current = measureElement(chromeRef.current).height; });
  // Frame cost (tick -> React commit), for measurement only (motionStats prop; tests and the bench).
  React.useLayoutEffect(() => {
    if (!motionStats || R.current.tickPerf == null) return;
    (motionStats.costs ||= []).push(performance.now() - R.current.tickPerf);
    R.current.tickPerf = null;
  });
  const s = S.current;
  const busy = Boolean(s.turn);
  // Reveals: register what just landed, then give <Static> every leading item whose reveal has ended.
  const nowR = Date.now();
  let pendingHist = [];
  const sleeping = Boolean(R.current.sleep); // asleep: nothing is committed to scrollback, so waking loses nothing
  if (introDone.current && !sleeping) {
    if (!motionOn) committedRef.current = s.history.length;
    else {
      for (let i = committedRef.current; i < s.history.length; i++) registerFx(s.history[i], nowR);
      for (const b of s.blocks) registerFx(b, nowR);
      // The newest protocol stage stays live (its icon pulses) while it is the last thing that happened in the turn.
      const activeStage = (i) => isActiveStage(s, i);
      while (committedRef.current < s.history.length && !fxActive(s.history[committedRef.current], nowR) && !activeStage(committedRef.current)) fxRef.current.delete(s.history[committedRef.current++].id);
      pendingHist = s.history.slice(committedRef.current);
      for (const r of R.current.roster.rows) if (!rosterSeen.current.has(r.key)) rosterSeen.current.set(r.key, nowR);
    }
  }
  lastAppRender.current = nowR;
  // Composer ring: motion and colour both on. Thinking/tools cyan-purple, writing green, approval amber.
  const ring = motionOn && !mono() ? { ref: ringRef, active: busy, mode: ringMode({ approvals: s.approvals.length, act: s.turn?.act }) } : null;
  const card = s.approvals[0];
  const armed = card ? Date.now() - (card.displayedAt ?? card.shownAt) >= 300 : false;
  R.current.armedShown = armed;
  const ctxParts = [demoLabel && profile === 'demo' ? null : profile, R.current.orgName ?? org, (R.current.noAi && !s.ctx?.model ? NO_AI_STATUS : modelLabel(s.ctx, MC.current)), demoLabel ? (demoAuto ? 'demo data, nothing real runs' : null) : mode, R.current.rulesOn === false ? (rulesLabel(rules) ? 'rules: off' : null) : rulesLabel(rules)];
  const caps = R.current.caps;
  const hint = busy ? `${caps.steer ? 'Enter steer' : 'Enter queue'} · Tab queue · ${caps.interrupt ? 'Esc stop' : 'Esc disconnects'}` : 'Enter send · /help';
  const placeholder = busy ? (caps.steer ? 'Type to steer (Enter) or queue (Tab)' : 'Type to queue (Enter or Tab)') : R.current.askArmed ? ASK_PROMPT : 'Ask Quox anything…';

  // The live region (unsettled blocks + chrome) must stay SHORTER than the screen: log-update can only
  // erase rows that are still on screen, and Ink's own tall-frame path loses a line of history (term.js).
  // A tall live tail shows its latest lines; the whole block prints to <Static> in full once it settles.
  function liveRegion(kids) {
    const rows = termRows(stdout);
    if (!rows || !kids.length) return kids;
    const max = Math.max(2, rows - (chromeH.current ?? 8) - 2);
    if (liveRows([...pendingHist, ...s.blocks], cols) <= max) return kids;
    return [
      h(Box, { key: 'live-cap', paddingLeft: 2 }, h(Text, { color: c('dim'), wrap: 'truncate-end' }, clip('⋮ latest lines; the full reply prints when this part ends', cols - 2))),
      h(Box, { key: 'live-clip', height: max - 1, overflow: 'hidden', flexDirection: 'column', justifyContent: 'flex-end' },
        h(Box, { flexDirection: 'column', flexShrink: 0 }, ...kids))
    ];
  }

  function rosterNode() {
    const ro = R.current.roster;
    const view = rosterView({ rows: ro.rows, cols, termRows: termRows(stdout) ?? 40, max: MAX_ROSTER, on: ro.on, sel: ro.sel, focus: ro.focus, now: Date.now() });
    const row = ro.rows[ro.sel];
    return h(Roster, {
      view, cols,
      peek: ro.focus && ro.peek ? peekLines(row, Date.now()) : [],
      fx: motionOn ? (key) => rosterFx(key, Date.now()) : null,
      confirm: ro.focus && ro.confirm ? `Stop ${ro.confirm.kind} "${clip(ro.confirm.name, 30)}"? y to stop, any other key cancels` : null,
      hint: ro.focus && !ro.confirm ? '↑↓ select · Enter peek · s stop · Esc back' : null
    });
  }

  if (sleeping) { // the screensaver replaces the live region only; Static (scrollback) is frozen, the transcript untouched
    const rows = Math.max(8, (termRows(stdout) ?? 24) - 1), sl = R.current.sleep;
    return h(FrameContext.Provider, { value: framesRef.current }, h(Box, { flexDirection: 'column' },
      h(Static, { key: `static-${epoch}`, items: s.history.slice(0, committedRef.current) }, (it, i) => h(Box, { key: it.id, flexDirection: 'column' }, h(HistoryItem, { item: it, cols, gap: historyGap(s.history[i - 1], it, termRows(stdout)) }))),
      h(SleepScreen, { lines: sourceLines(S.current, cols, rows), cols, rows, startedAt: sl.startedAt, wakeAt: sl.wakeAt, still: sl.still })));
  }
  return h(FrameContext.Provider, { value: framesRef.current }, h(Box, { flexDirection: 'column' },
    // Nothing enters <Static> before the intro settles: Static is index-based, so prepending the intro to
    // already-printed items would drop it (and reprint the rest).
    h(Static, { key: `static-${epoch}`, items: introDone.current ? s.history.slice(0, committedRef.current) : [] }, (it, i) => h(Box, { key: it.id, flexDirection: 'column' }, h(HistoryItem, { item: it, cols, gap: historyGap(s.history[i - 1], it, termRows(stdout)) }))),
    introDone.current ? null : h(Box, { key: 'intro-live', flexDirection: 'column' }, h(Intro, { item: introItem, cols, dragon: introDragon, progress: Math.min(1, (Date.now() - introStart.current) / introMs) })),
    liveRegion([
      ...pendingHist.map((it, i) => h(Box, { key: it.id, flexDirection: 'column' }, h(FxItem, { item: it, cols, fxFor, gap: historyGap(i ? pendingHist[i - 1] : s.history[committedRef.current - 1], it, termRows(stdout)), active: busy && it.kind === 'trace' && i === pendingHist.length - 1 && !s.blocks.length }))),
      ...s.blocks.map((b, i) => { const gap = historyGap(i ? s.blocks[i - 1] : (pendingHist[pendingHist.length - 1] ?? s.history[committedRef.current - 1]), b, termRows(stdout)); return h(Box, { key: b.id, flexDirection: 'column' }, motionOn && revealTimingFor(b) ? h(FxItem, { item: b, cols, live: true, fxFor, ignition: feats().ignition, gap }) : h(HistoryItem, { item: b, cols, live: true, gap })); })]),
    h(DragonLive, { key: 'dragon', cols }),
    flyActive(nowR) ? h(FlyLive, { key: 'dragon-fly', cols, rows: termRows(stdout), startedAt: R.current.fly.startedAt, still: R.current.fly.still }) : null,
    dragonTalkVisible(nowR) ? h(DragonTalk, { key: 'dragon-talk', cols, label: R.current.dragonTalk.label, talking: !R.current.dragonTalk.armed && !R.current.dragonTalk.endedAt, since: R.current.dragonTalk.since, still: !motionOn || mono() }) : null,
    h(Box, { key: 'chrome', ref: chromeRef, flexDirection: 'column' },
    busy ? h(Working, { key: 'working', motion: motionOn && !R.current.exiting, handoff: feats().handoff, tokens: turnTokens(s.turn), act: s.turn.act, activity: describeActivity(s), since: s.turn.startedAt, interrupting: s.turn.status === 'interrupting', escLabel: caps.interrupt ? null : 'Esc disconnects' }) : null,
    card ? h(ApprovalCard, { card, org: (R.current.orgName ?? org ?? api.orgId?.()) || null, cols, armed, motionE: motionOn && nowR - (card.displayedAt ?? card.shownAt) < 1000 ? (nowR - (card.displayedAt ?? card.shownAt)) / 1000 : null, draftHint: K.current.cardFocus ? 'focus' : (B.current.text ? 'draft' : (cardFresh(card) && !card.privileged ? null : 'tab')), confirm: K.current.confirm }) : null,
    // TODO(contract v2): background agents. `background.status` is NOT in events v1, so nothing sets s.background today.
    s.background > 0 ? h(Box, { paddingLeft: 2 }, h(Text, { color: c('dim') }, `Waiting for ${s.background} background agent${s.background === 1 ? '' : 's'} to finish`)) : null,
    h(Pending, { pending: s.pending, steering: s.steering, cols }),
    h(Box, { marginTop: 1 }),
    LI.current.isOpen() ? h(LoginCard, { ...LI.current.view(), cols, profile }) : CN.current.isOpen() ? h(ConnectCard, { ...CN.current.view(), cols })
      : ring ? h(RingComposer, { buf: B.current, cols, mode: demoLabel ? 'demo' : mode, busy, placeholder, name: SN.current.name, ring })
        : h(Composer, { buf: B.current, cols, mode: demoLabel ? 'demo' : mode, busy, placeholder, name: SN.current.name }),
    !CN.current.isOpen() && PK.current.isOpen() && !card ? h(ListView, { ...PK.current.view(), cols }) : !CN.current.isOpen() && PL.current.isOpen() && !card ? h(ListView, { ...PL.current.view(), cols }) : null,
    h(StatusLine, { cols, slot: where.current.slot, agent: where.current.agent, parts: ctxParts, right: hint }),
    h(WaitingNotice, { items: s.waiting, cols }),
    h(NotifyBar, { approvals: s.notify.approvals, error: s.notify.error, cols, signedOut: Boolean(blocked), alerts: R.current.roster.all ? [] : R.current.roster.alerts }),
    rosterNode())));
}

/** A live item that may be revealing: re-renders on every clock frame by itself (not the app). */
function FxItem({ item, cols, live = false, fxFor, active = false, ignition = false, gap }) {
  const now = useFrame();
  const running = item.kind === 'tool' && item.status === 'running';
  const pulse = running || active ? now : null;
  const fx = fxFor(item, now);
  // expressive: a running tool row ignites as it lands (a short warm flare, motion/level.js ignitionGlow)
  const ignite = ignition && running && fx ? ignitionGlow(fx.e * 1000) : 0;
  return h(HistoryItem, { item, cols, live, fx, pulse, ignite, gap });
}
export { COLORS };
