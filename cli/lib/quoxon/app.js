/**
 * QUOXON app: composer + live turn. State lives in refs updated synchronously
 * (so a stdin chunk carrying several keys applies in order) and mirrored into
 * React state for rendering.
 */
import React from 'react';
import { Box, Static, Text, measureElement, useApp, useStdin, useStdout } from 'ink';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, writeSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { bufferReducer, initialBuffer, sanitizeForSend, wordAt, selection, selectedText, atVisualEdge } from './textBuffer.js';
import { MOUSE_ON, MOUSE_OFF, DSR, DOUBLE_MS, DSR_TIMEOUT_MS, mouseOnNote, screenHit, classifyClick, composerIndexAt } from './mouse.js';
import { parseChunk, initialKeyState, flushDangling, hasDangling, PASTE_ON, PASTE_OFF, PASTE_DANGLING_MS } from './keys.js';
import { isHeldFromBulk, heldReason } from './bulkRisk.js';
import { walkCard, walkReply, walkNotYesNo, walkNoCatch, walkSummary, parseDecision, matchesAgent, filterPredicate, approvalRow, approvalDetail, isDecision, parseAnswer, parsePairs } from './approvalsView.js';
import { dividerLive, GREEN_MS, RED_MS } from './dividerAocl.js';
import { reduce, initialState, approvalKeyAllowed, groupApprovals, isPrivileged, approvalSourceLabel, approvalWhat, describeInboxItem, textGate } from './events.js';
import { turnTokens } from './indicator.js';
import {
  Composer, RingComposer, Pending, ApprovalCard, AskCard, StatusLine, RowsBar, NotifyBar, Working, HistoryItem, liveRows, Intro, Roster, WaitingNotice, historyGap, INTRO_FRAMES, introAnimates, describeActivity, clampCols, clip, COLORS, revealTimingFor
, endsInRule } from './render.js';
import { c, mono } from './theme.js';
import { strayCardAnswer, strayQuestion, alreadyQueued } from './stray.js';
import { findEntry, helpModel, nearestCommands, joinWrappedSlash, commandNames, REGISTRY, visibleRegistry } from './commands.js';
import { osc52, pickCopy } from './copy.js';
import { detectSlotAgent } from './context.js';
import { rulesContext, rulesLabel, rulesLines } from './rules.js';
import { resolveCliSlash } from './slash/cliCommand.js';
import { parseBang, quoxArgv, needsTerminal, ttyFailure, runBang, footer as bangFooter, truncNote as bangTruncNote, shareText, withShared, cleanOutput, DEFAULT_TIMEOUT_MS } from './bang.js';
import { startupWhatsNew, listWhatsNew, unseenEntries, seenRecord, tryText, LIST_DEFAULT, unseenCommands, seenAfter, startupCommandLine, startupEnabled, toggleArg } from './whatsnew.js';
import { nextTip, normaliseMode, tipSettingsReply, tipsReply, DEFAULT_MODE, TIPS, tryCommand, tipText } from './tips.js';
import { findSkill, skillRows, skillDetail, skillPrompt } from './skills.js';
import { createScreenContext } from './screenContext.js';
import { askText, askQuestion, askAnswer, askChatMessage, settledAskLine, settledAskTone, askOutcomeOf, isAskClarification, askClock } from './ask.js';
import { createHandoffStreak, handoffBiggerAskText, handoffFromEvent, handoffAskText, handoffAnsweredNote, handoffSupersededNote, handoffSkippedNote } from './handoffOffer.js';
import * as selfUpdate from '../core/selfUpdate.js';
import { runRequest, runAnswer, handOverRun, runFooter } from './slotRun.js';
import { profileChooserRows, liveApi, switchAskLine, slotCreateAskLine, loginRunRequest, okProfileName } from './profileSwitch.js';
import { rosterView, peekLines, selectRows, backgroundAlerts, isExpired, applyProgress, SPIN_MS } from './roster.js';
import { runObjectCommand } from './objects/index.js';
import { peekLines as peekIdLines } from '../core/peek.js';
import { turnsFromItems, asideNoteText } from './asideView.js';
import { createMentionCache, loadMentions, receiptMentions } from './mentions.js';
const OBJECT_CMDS = new Set(['/skills', '/agents', '/workflow', '/crystal', '/memory', '/rules', '/proof', '/reconcile', '/fleet', '/prove', '/replay', '/health', '/core']);
import { intentHint } from './intent.js';
import { observerLines } from './observers.js';
import { devObserverOn, DEV_OBSERVER_REFUSAL } from './devObserver.js';
import { mindLines, mindErrorLines, mindHelpLines, MIND_HELP_ARGS } from './mind.js';
import { packageVersion } from './welcome.js';
import { feedbackPayload, feedbackPreview } from './feedback.js';
import { vetSuggestion, namedCommand } from './suggestCommand.js';
import { modeReply, normMode, PLAN_GO, MODES, MODE_ROWS } from './mode.js'; // PLAN MODE (owner 2026-10-16)
import { echoLine } from './echo.js';
import { inviteText, cleanName, loadNames, saveName, pickNamed, matchAgent, uniqueSquash, resolveSayTarget, addressLabel, sayMissText, parseTarget, nearest, listFailure, slotsTable } from './session.js';
import { pushHistory } from './promptHistory.js';
import { termRows } from './term.js';
import { cardTallerThanScreen } from './objects/view.js';
import { createConnectController, connectionLines, connectOfferFor, looksLikeKey, keyWarning, providerFor, parseOllamaArg, connectOllamaFlow, ollamaModelRows, connectCompatFlow, compatModelRows, confirmLanAllow } from './connect.js';
import { ConnectCard } from './connectCard.js';
import { cmd as mark } from './palette.js';
import { createLoginController, LoginCard, SIGNED_OUT_LINE, signedOutCard, isSessionDead } from './signin.js';
import { createStepUp } from './slash/stepUp.js';
import { StepUpCard, PresentBar } from './slash/stepUpCard.js';
import { createStepUpCmds, declinedText } from './slash/stepUpCmds.js';
import { isConsentError, consentHintLines, consentStatusLines } from './consent.js';
import { CHOICES, modelLines, selectModel, selectOllamaModel, selectCompatModel, adoptAfterConnect, selectDiscoveredModel, selectSubscriptionModel, modelLabel, fallbackNote, streamFields, normChoice } from './model.js';
import { humanSessionLines } from '../core/sessionsOverview.js';
import { activeLines, activeRows, ACTIVE_KINDS } from '../core/activeSummary.js';
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
import { runBroadcast, runAck, parsePokeArgs } from './slash/broadcastRun.js';
import { parseBroadcastText } from './slash/broadcast.js';
import { isOwnBroadcast } from './ownBroadcast.js';
import { orgLabel, isOrgId } from './orgLabel.js';
import { parseRoomSend, roomName, roomLine, senderName, parseAtSend, senderLabel, slotLine, slotOfHolder, decodeEntities, fileMessage, prepareFile, createSlotListener, createReplyWatches, isHolderLine, loadLastSlot, saveLastSlot, presenceLine } from './slotChat.js';
import { homedir as osHome } from 'node:os';
import { createRowCmd } from './slash/rowCmd.js';
import { createKillerCmds } from './slash/killer.js';
import { createUndoWish } from './slash/undoWish.js';
import { createHatWalk } from './slash/hatWalk.js';
import { createRowEngine, runShell } from './rows.js';
import { createModelCmd } from './slash/modelCmd.js';
import { createChallengeCmd } from './slash/challenge.js';
import { createSpawnCmd } from './slash/spawn.js';
import { normPrefs, parseModelSub, label as favLabel } from './modelPrefs.js';
import { ListView } from './slash/listView.js';
import { createLedger, costModel } from './slash/ledger.js';
import { statusModel, contextModel, doctorModel, chatChecks, modelText } from './slash/panels.js';
import { parseAgentsArgs, filterAgents, agentPickerRow, toolLines, whichReply, looseCommand } from './slash/agents.js';
import { createPicker } from './slash/picker.js';
import { resumeRows, pickerRow, matchConversation, turnsToHistory } from './slash/resume.js';
import { settingsList, applySettings, configRows, cycle } from './slash/settings.js';
import { countdownLine } from './countdownLine.js';
import { startBuildWatch, DIFFERENT_NOTICE } from './slash/restart.js';
import { dashboardLines } from './slash/dashboard.js';
import { supportsHyperlinks } from './markdown.js';
import { compactResult, compactError, contextFacts, compactShowLines } from './slash/compact.js';
import { intentPanel } from './intent.js';
import { awayDue, parseSince } from './away.js';
import { sitrepData } from './objects/sitrep.js';
import { mirrorErrorNote } from './objects/mirror.js';
import { launchEgg } from './egg.js';
import { INTRO_MS } from './qart.js';
import { Clock, FRAME_MS, SECOND_MS, motionAllowed, createFrames } from './motion/clock.js';
import { FrameContext, useFrame } from './motion/frame.js';
import { ringMode, ringAnimating } from './motion/ring.js';
import { TIMING, revealSpan } from './motion/reveal.js';
import { matchOrg, orgLines, orgRows } from './orgSwitch.js';
import { matchHat, hatLines, hatChoices, isPrivileged as hatIsPrivileged, mintConversationId } from './hatSwitch.js';
import { isServerDown, waitForServer, SERVER_RESTARTING, explainTermination, RETRY_HINT, isResumeRetryable, RESUME_RETRY_DELAYS, RESUME_RECONNECTING } from './resend.js';

const h = React.createElement;
const PASTE_GUARD_MS = 40;
const ASK_ECHO_MS = 1500; // TUI-INPUT: how long an Enter after a single-key ask answer is treated as the confirm habit
const MAX_ROSTER = 4;
const ESC_ESC_MS = 500;
const INTERRUPT_FALLBACK_MS = 8000;
const INTRO_FRAME_MS = 50; // intro frame period on the shared clock (the plan's length is INTRO_MS)
const HELD_WINDOW_MS = 1000; // a key seen this close before a card appears is treated as still held
const APPROVE_WORD = 'approve';
const CARD_GONE_MS = 400;


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

export function App({ slotAgent, notifyMs = 4000, resultPollMs = 3000, resultTimeoutMs = 120000, rosterMs = 15000, api: apiProp, profile: profileProp = 'default', org = null, version = '0.1.0', cwd = '', columns, demoLabel = null, verbose = 'on', mode = 'ask', editor = openEditor, introNote = null, animateIntro, earlyInput = null, startup = null, blocked: blockedProp = null, signedOut: signedOutProp = null, autoplay = null, rules = null, welcome = false, sessionName = null, invite = false, slotsAvailable = true, namesPath, transcript = null, modelChoice = null, resumeConversation = null, resume = null, restartSlot = null, restartAttach = null, slotRetryDelays = [2000, 5000, 10000, 20000, 30000], resumeRetryDelays = RESUME_RETRY_DELAYS, onRestart = null, onDemo = null, healthRecheck = null, healthRecheckDelays = [5000, 10000, 20000, 40000, 60000], restartCheck = null, updater = null, startSha = null, buildWatch = startBuildWatch, autoRestartMs = null, autoTickMs = 1000, env = process.env, motion, motionStats = null, away = null, tipStartup = false, whatsNewStartup = false, interactive, resendDelays = null, demoAuto = null, agentLogin: agentLoginProp = false, humanProfiles = [], switchProfile = null, loginCandidates = [], slotRecordPath = undefined, spawnStatePath = undefined, noReplyMs = 90000, replyWatchMs = 30 * 60 * 1000, historyStore = null, runSpawn = spawnSync, runHandOverDelayMs = 60, mouseScreen = null, runNow = Date.now, whatsNewEntries = undefined }) {
  // Z2H: signed-out is ONE state (card at the top + /login), not scattered errors. While it holds, `blocked` is the
  // one-line answer, so chat, /connect and the digest/approvals pollers stay quiet instead of printing raw 401s.
  // PROFILE-SWITCH (owner 2026-10-16): the window's api is swappable in place (profileSwitch.js liveApi); `who` is the
  // profile this window switched to with a y or /profile (null = as launched). Same conversation, attach, slot, groups.
  const APX = React.useRef(null);
  if (!APX.current || APX.current.from !== apiProp) APX.current = { live: apiProp, from: apiProp };
  const APIP = React.useRef(null); APIP.current ??= liveApi(APX); const api = APIP.current;
  const [who, setWho] = React.useState(null);
  const profile = who?.profile ?? profileProp;
  const agentLogin = who ? who.agentLogin : agentLoginProp;
  const WHO = React.useRef(null); WHO.current = { profile, agentLogin };
  const [signedOut, setSignedOut] = React.useState(signedOutProp);
  const blocked = blockedProp || (signedOut ? SIGNED_OUT_LINE : null);
  const signedOutRef = React.useRef(null); signedOutRef.current = signedOut;
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
    ...(invite ? [{ id: 'invite', kind: 'note', text: inviteText({ slots: slotsAvailable }) }] : [])];
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
  const K = React.useRef({ keys: initialKeyState(), lastKeyAt: null, lastKeyCh: null, lastDataAt: 0, lastPasteAt: 0, lastEscAt: 0, ctrlC: 0, guard: null, dismissed: new Set(), cardFocus: false, confirm: false, cardGoneAt: 0, typed: '', danglingTimer: null });
  const chromeRef = React.useRef(null);
  const chromeH = React.useRef(null);
  const R = React.useRef({ abort: null, histIdx: -1, history: [], stash: [], reviewing: false, fallbackTimer: null, ctrlCTimer: null, banner: null, closed: false, pollTimers: new Set(), caps: { steer: true, interrupt: true }, confirmMulti: null, roster: { rows: [], all: false, allRows: [], alerts: [], sources: null, on: true, focus: false, sel: 0, peek: false, confirm: null, stopping: false } });
  // QUOXON-HISTORY: Up recalls what was typed in earlier runs too (most recent first); main.js passes the file store.
  if (!R.current.histLoaded) { R.current.histLoaded = true; try { R.current.history = historyStore?.load?.() || []; } catch { R.current.history = []; } }
  const remember = (t) => { if (pushHistory(R.current.history, t)) { try { historyStore?.add?.(t); } catch { /* history is a convenience */ } } };
  // E5: when this profile was last seen (read once at launch, before it is refreshed), and a throttled touch.
  const AWAY = React.useRef({ last: null, touched: 0 });
  const touchSeen = (force = false) => {
    const now = Date.now();
    if (!away || (!force && now - AWAY.current.touched < 60000)) return;
    AWAY.current.touched = now;
    try { away.write(profile, now); } catch { /* best effort */ }
  };

  const SND = React.useRef(null); SND.current ??= createSound({ api, stdout }); // QuoxSound: one subscription point (dispatch)
  /** QUOXON-FW15: the one card shown: the oldest waiting approval (this conversation first, then other sessions/plugins) not dismissed with Tab. */
  const queueOf = (st) => { const all = [...st.approvals, ...st.waiting]; const live = new Set(all.map(x => x.callId)); for (const id of K.current.dismissed) if (!live.has(id)) K.current.dismissed.delete(id); return all.filter(x => !K.current.dismissed.has(x.callId)); };
  const headCard = (st) => queueOf(st)[0] || null;
  const SCX = React.useRef(null); SCX.current ??= createScreenContext(); // SCREEN-CONTEXT: the events ring + changed-only bookkeeping for the terminal block
  const dispatch = (a) => {
    if (a.type === 'note') SCX.current.notice(a.text, a.tone);
    else if (a.type === 'error') SCX.current.error(a.text);
    else if (a.type === 'event' && a.ev) {
      if (a.ev.type === 'error') SCX.current.error(a.ev.error || a.ev.message || 'error');
      else if (a.ev.type === 'turn.finished' && a.ev.status && !['ok', 'success', 'completed'].includes(a.ev.status)) SCX.current.failedTurn(a.ev.status);
    }
    transcript?.action(a.redact !== undefined ? { ...a, text: a.redact } : a); // dev transcript capture (off by default; see transcript.js); `redact` is what the capture sees instead of a secret-bearing text
    const prevS = S.current; S.current = reduce(prevS, { now: Date.now(), ...a }); SND.current.observe(prevS, S.current, a);
    if (motionOn && !mono() && feats().moods) { const m = moodForEvent(prevS, a, S.current); if (m) playDragon(m); } // cinematic: the dragon reacts
    // Per shown card: remember the key that was already down when it appeared, and restart the typed word.
    const c0 = headCard(S.current);
    if (!c0 && K.current.guard) K.current.cardGoneAt = Date.now();
    const gid = c0 ? `${c0.callId}:${c0.displayedAt}` : null;
    if (gid !== K.current.guard?.id) {
      const k = K.current;
      const held = c0 && k.lastKeyAt != null && Date.now() - k.lastKeyAt < HELD_WINDOW_MS ? k.lastKeyCh : null;
      k.guard = gid ? { id: gid, heldKey: held, since: Date.now() } : null;
      k.confirm = false; k.cardFocus = false;
    }
    if (!R.current.closed) bump(n => n + 1);
  };
  const edit = (a) => { B.current = bufferReducer(B.current, a); if (!B.current.text) { R.current.multiWarned = false; R.current.confirmMulti = null; } bump(n => n + 1); };
  // ASK-SETTLE (owner 2026-10-17: "questions should go once answered, or change to answer"): an ask is a LIVE card
  // (never printed to scrollback while open); reconcileAsks settles it to one line once it is no longer open.
  const askSeq = React.useRef(0);
  const say = (text, tone) => {
    if (tone !== 'ask') return dispatch({ type: 'note', text, tone });
    const id = `ask-${++askSeq.current}`;
    R.current.lastAsk = { text, question: askQuestion(text), id };
    K.current.composerClicked = false; // TUI-INPUT: a new card is the active prompt until the composer is clicked again
    dispatch({ type: 'ask.open', id, text, at: Date.now() });
    if (typeof queueMicrotask === 'function') queueMicrotask(() => reconcileAsks()); // bind it to its open state
    return undefined;
  };
  // QUOXON-ASK: every question for the human is ONE shape (▶ reason. question? keys), highlighted. Never say a raw y/N.
  const ask = (question, opts) => say(askText(question, opts), 'ask');
  // PLAN MODE: this window's mode ('ask' | 'plan'). Window-scoped: rides /restart, never the shared profile.
  const MD = React.useRef(null); MD.current ??= normMode(mode);
  const askerName = () => String(SN.current?.agent || where.current?.agent || 'Quox').toUpperCase(); // a model-suggested command: who asks
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
  // QUOXON-STEPUP: the PIN card. The digits live in its closure box only: never dispatched, buffered, in history,
  // undo, the transcript or any log. Agent logins never get a PIN field (slash/stepUp.js).
  const SU = React.useRef(null);
  SU.current ??= createStepUp({ api, agentLogin: () => WHO.current.agentLogin, onAgentLogin: () => offerSwitch(), refresh: () => bump(n => n + 1), note: (t, tone) => say(t, tone), emit: (a) => dispatch(a), settingsUrl: async () => { try { const b = await api.dashboardBase?.(); return b ? `${String(b).replace(/\/$/, '')}/settings` : null; } catch { return null; } } });
  const SUC = React.useRef(null);
  SUC.current ??= createStepUpCmds({ api, stepUp: SU.current, say: (t, tone) => say(t, tone), lastBlock: () => R.current.lastBlock || null, orgOf: () => api.orgId?.() || null });
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
  const KC = React.useRef(null); KC.current ??= createKillerCmds({ api, say: (t, tone) => say(t, tone), getState: () => S.current, getFields: () => streamFields(MC.current) }); // /watch, /automate, /crystallize
  // /undo last and /wish (slash/undoWish.js): one card, y/n on the next composer line.
  const HW = React.useRef(null); // CUSTOM-HATS: /hat new|edit|delete walk
  HW.current ??= createHatWalk({ api, say: (t, tone) => say(t, tone), bump: () => bump(n => n + 1) });
  const UW = React.useRef(null);
  UW.current ??= createUndoWish({
    api, say: (t, tone) => say(t, tone), getItems: () => [...S.current.history, ...S.current.blocks],
    runTurn: (t) => runTurn(t),
    draft: async (prompt) => { // the spec is drafted by a normal governed turn; its answer is read back
      if (S.current.turn) throw new Error('wait for the current turn or press Esc first');
      const before = (S.current.answers || []).slice(-1)[0]?.id ?? null;
      await runTurn(prompt);
      const last = (S.current.answers || []).slice(-1)[0];
      return last && last.id !== before ? last.text : null;
    }
  });
  const CH = React.useRef(null);
  CH.current ??= createChallengeCmd({ api, say: (t, tone) => say(t, tone), getState: () => S.current, sendTurn: (t) => submit(t) });
  const SPN = React.useRef(null);
  SPN.current ??= createSpawnCmd({ api, say: (t, tone) => say(t, tone), session: () => SN.current.name || S.current.ctx.conversationId || 'quox', from: () => senderLabel({ slot: where.current.slot || null, display: myDisplay() }), statePath: spawnStatePath });
  React.useEffect(() => { if (!blocked && !demoLabel && api.slotSay) SPN.current.sweep().catch(() => {}); }, []); // release this session's overdue VMs
  // QUOXON-FW17: custom rows above the status line (rows.js engine, slash/rowCmd.js).
  const RW = React.useRef(null);
  RW.current ??= createRowCmd({
    api, say: (t, tone) => say(t, tone), bump: () => bump(n => n + 1), cols: () => cols,
    engine: createRowEngine({ fetchUrl: (u) => (api.rowFetch ? api.rowFetch(u) : Promise.reject(new Error('not available'))), fetchQuox: (src) => (api.rowFetchQuox ? api.rowFetchQuox(src) : Promise.reject(new Error('not available'))), runCmd: runShell, onChange: () => bump(n => n + 1) })
  });
  // Rows load once the window is usable: a window started signed out loads them after /login (owner lost the QPE bar 2026-10-15).
  const rowsLoaded = React.useRef(false);
  React.useEffect(() => { if (!blocked && !demoLabel && !rowsLoaded.current) { rowsLoaded.current = true; RW.current.load(); } }, [blocked]);
  React.useEffect(() => () => RW.current.stopEngine(), []);
  PL.current ??= createPalette({
    getDraft: () => B.current.text, setDraft: (t) => edit({ type: 'set', text: t }),
    run: (t) => { remember(t); command(t); }, say: (t, tone) => say(t, tone),
    ctx: () => ({ api, caps: R.current.contract, blocked: BL.current }),
    source: createArgSources({ api, getPrefs: () => MP.current.prefs, getRows: () => RW.current?.all() }),
    refresh: () => bump(n => n + 1),
    // MENTIONS: agents, hosts and tasks fetched once per session on the first @; receipts are this session's own tool envelopes
    mentions: blocked ? null : { cache: createMentionCache({ load: () => loadMentions(api), refresh: () => bump(n => n + 1) }), local: () => receiptMentions([...S.current.history, ...S.current.blocks]) }
  });
  React.useEffect(() => MM.current.startOnDefault({
    flagged: modelChoice != null, off: Boolean(blocked || demoLabel),
    dispatchCtx: () => dispatch({ type: 'ctx', ctx: NO_RAN })
  }), []);
  const LG = React.useRef(null); LG.current ??= createLedger(); // /cost, /context: real usage only
  // /restart auto: saved per profile (profile.quoxon.restartAuto). `newId` = the newest installed build seen; `cancelledId` = the build whose countdown a key cancelled.
  const AR = React.useRef(null); AR.current ??= { on: (api.settings?.() || {}).restartAuto === true, newId: null, cancelledId: null, timer: null, endsAt: 0 };
  // Countdown length: the autoRestartMs prop (tests), else QUOX_RESTART_COUNTDOWN seconds (default 10; 0 = restart at once).
  const countdownMs = () => { if (autoRestartMs != null) return autoRestartMs; const n = Number(env.QUOX_RESTART_COUNTDOWN); return (env.QUOX_RESTART_COUNTDOWN != null && env.QUOX_RESTART_COUNTDOWN !== '' && Number.isFinite(n) && n >= 0 ? n : 10) * 1000; };
  const cdLog = (phase, seconds = null) => transcript?.action({ type: 'restart.countdown', phase, seconds, build: AR.current.newId }); // lifecycle in the dev transcript
  const stopCountdown = () => { clearTimeout(AR.current.timer); AR.current.timer = null; AR.current.endsAt = 0; };
  React.useEffect(() => (startSha ? buildWatch({ startSha, repeat: true, onNotice: (t, id) => {
    AR.current.newId = id || t;
    if (!AR.current.on) say(t === DIFFERENT_NOTICE ? t : 'a newer quox is installed: /restart (or /restart auto on)', 'dim');
  } }) : undefined), []);
  const autoIdle = () => { // nothing for a restart to interrupt
    const s = S.current;
    return !s.turn && !s.approvals.length && !s.pending.length && B.current.text === '' && !R.current.pendingWalk && !R.current.bang && !R.current.sleep
      && !R.current.restarting && !R.current.exiting && !LI.current.isOpen() && !SU.current.isOpen() && !CN.current.isOpen() && !PK.current.isOpen() && !blocked;
  };
  React.useEffect(() => {
    const id = setInterval(() => {
      const a = AR.current;
      if (!a.on || !a.newId || a.newId === a.cancelledId || R.current.restarting) return;
      if (a.timer) { if (!autoIdle()) { stopCountdown(); cdLog('held'); bump(n => n + 1); if (R.current.pendingWalk) say('Restart held: it waits until the walkthrough ends.', 'dim'); } else bump(n => n + 1); return; } // ticks the visible countdown
      if (!autoIdle()) return;
      const ms = countdownMs();
      if (ms <= 0) { cdLog('timed-out', 0); doRestart(); return; }
      a.endsAt = Date.now() + ms;
      cdLog('started', Math.round(ms / 1000));
      a.timer = setTimeout(() => { stopCountdown(); if (AR.current.on && autoIdle()) { cdLog('timed-out'); doRestart(); } else { cdLog('held'); bump(n => n + 1); } }, ms);
      bump(n => n + 1);
    }, autoTickMs);
    return () => { clearInterval(id); stopCountdown(); };
  }, []);
  // /restart carried a slot: re-check it out under this window's label before the old one is gone. /restart auto tends to
  // fire just as a new build lands, which is often while the collector redeploys, so a timeout or 5xx is retried; if it
  // never answers, the "Reattach to slot X? y/N" ask is offered instead of leaving the window silently slotless.
  React.useEffect(() => { if (restartSlot && !blocked && api.checkoutSlot) carrySlot(restartSlot); }, []);
  // /restart carried an /attach (agent or slot): re-attach once the window can act (owner 2026-10-15 "why dont u reattach").
  const attachCarried = React.useRef(false);
  React.useEffect(() => {
    if (!restartAttach || blocked || attachCarried.current) return;
    attachCarried.current = true;
    if (S.current.turn) { R.current.pendingAttach = restartAttach; say(`Re-attaching to ${restartAttach.replace(/^(agent|slot):/, '')} when this turn ends.`, 'dim'); return; } // a resumed turn would refuse it
    command(`/attach ${restartAttach}`);
  }, [blocked]);
  React.useEffect(() => { // any other way the resumed turn ends (reattach path, Esc): carry the attach then
    if (R.current.pendingAttach && !S.current.turn) { const a = R.current.pendingAttach; R.current.pendingAttach = null; command(`/attach ${a}`); }
  });
  async function carrySlot(nm) {
    for (let i = 0; ; i++) {
      if (R.current.closed || SC.current.slot) return; // closed, or this window checked a slot out meanwhile (/slot); a slot merely inherited from a parent Claude session does not count
      const r = await takeSlot(nm, true, { quietTransient: true });
      if (!r?.transient) return;
      if (i >= slotRetryDelays.length) {
        if (R.current.closed || SC.current.slot) return;
        SC.current.reattach = { slot: nm, take: true, at: Date.now() };
        say(`slot ${nm}: could not reattach after the restart (${r.message}).`, 'warn');
        ask(`Reattach to slot ${nm}?`, { action: `/slot ${nm} --take` });
        return;
      }
      if (i === 0) say(`slot ${nm}: reattaching after the restart is slow (${r.message}); retrying.`, 'dim');
      await new Promise((res) => { const t = setTimeout(res, slotRetryDelays[i]); t.unref?.(); });
    }
  }
  React.useEffect(() => { // a TUI-held slot lapses to stale after 15m without a heartbeat
    if (!api.slotHeartbeat) return undefined;
    const id = setInterval(() => { const sl = where.current.slot; if (sl) api.slotHeartbeat(sl, slotSession()); }, 5 * 60 * 1000);
    id.unref?.();
    return () => clearInterval(id);
  }, []);
  // ---- QUOXON-MESH: slot chat (slotChat.js) ----------------------------------------------------------------
  const SC = React.useRef(null); SC.current ??= { listener: null, slot: null, pendingFile: null, reattach: null, rooms: new Map(), active: null };
  const realCwd = () => (cwd ? String(cwd).replace(/^~(?=\/|$)/, osHome()) : process.cwd());
  const myDisplay = () => { try { return api.displayName?.() || null; } catch { return null; } };
  const myLabel = () => senderLabel({ slot: where.current.slot || null, display: myDisplay() });
  /** Listen on the held slot's live stream; every message lands as a chat line above the composer. */
  function listenSlot(nm) {
    SC.current.listener?.stop(); SC.current.listener = null; SC.current.slot = nm || null;
    if (!nm || !api.slotStream || R.current.closed) return;
    const label = myLabel();
    let paused = false;
    const l = createSlotListener({
      open: (q, signal) => api.slotStream(nm, { since: q.since, excludeFrom: label }, signal),
      wait: api.slotWait ? ({ since }) => api.slotWait(nm, { since, excludeFrom: label }) : null,
      onMessage: (m0) => {
        // a broadcast carries the sender's session, not its slot: look the slot up so the header shows the reply address
        if (m0.from_slot || !api.slots || !parseBroadcastText(m0.text)) return handle(m0);
        Promise.resolve().then(() => api.slots()).then(rows => handle({ ...m0, from_slot: slotOfHolder(rows, m0.from) || undefined }), () => handle(m0));
      },
      onState: (st) => {
        if (st.error && st.failures === 1 && !R.current.closed) { paused = true; streamPausedNote(`slot ${nm}`, st.error); }
        else if (st.connected && paused && !R.current.closed) { paused = false; say(`✔ slot ${nm}: reconnected`, 'dim'); }
      },
    });
    function handle(m) {
      {
        if (typeof m.text === 'string') m = { ...m, text: decodeEntities(m.text) };
        noteReply(m); noteSender(m);
        if (R.current.closed || SC.current.slot !== nm || (label && m.from === label)) return;
        if (isOwnBroadcast(m, { label, display: myDisplay(), userId: api.userId?.() || null })) return; // your own broadcast is not news: the "BROADCAST sent" card told you
        { const ln = slotLine(m); const bc = parseBroadcastText(m.text); const rq = runRequest(m, { orgId: R.current.orgId ?? api.orgId?.() ?? null, now: runNow() }); if (rq) armRun(rq, ln); else dispatch({ type: 'slotmsg', line: bc ? { ...ln, urgent: bc.urgent, broadcast: true } : ln }); }
        rememberSender(m);
        if ((api.settings?.() || {}).slotBell !== 'off') { try { stdout?.write?.('\x07'); } catch { /* no tty */ } }
      }
    }
    SC.current.listener = l; l.start({});
  }
  React.useEffect(() => () => { SC.current.listener?.stop(); SC.current.listener = null; for (const t of SC.current.waits?.values() || []) clearTimeout(t); }, []);
  // ---- SLOT-RUN B: a slot sender asks the human to run ONE command here (slotRun.js) ------------------
  /** Show the request (the full command, always) and, when it may run, arm the y/N/c ask for RUN_TTL_MS. */
  function armRun(rq, ln) {
    if (rq.runnable) {
      const prev = SC.current.runAsk;
      if (prev && Date.now() < prev.expiresAt) say(`${prev.who}'s earlier run request was replaced by this one. It was not run.`, 'warn');
      if (prev) settleRun(prev, { kind: 'closed' });
      rq = { ...rq, askId: `run-${++askSeq.current}` };
      SC.current.runAsk = { ...rq, at: Date.now() };
      (SC.current.runCards ??= new Map()).set(rq.askId, rq); // held live until settled (see commitLimit)
    }
    const show = () => dispatch({ type: 'slotmsg', line: { ...ln, run: rq } });
    show();
    if (rq.runnable) R.current.lastAsk = { text: '', question: `Run \`${rq.cmd}\` (${rq.who} asked: ${rq.why || 'no reason given'})?`, redo: show };
  }
  const runAskOpen = () => Boolean(SC.current.runAsk && runNow() < SC.current.runAsk.expiresAt); // one clock: the run-ask clock decides open and expired alike
  /** ASK-SETTLE: history may go to <Static> (scrollback, immutable) only up to the first armed run card. */
  function commitLimit(s0) {
    const held = SC.current.runCards;
    if (held?.size) for (let i = committedRef.current; i < s0.history.length; i++) { const r = s0.history[i]?.line?.run; if (r?.askId && !r.settled && held.has(r.askId)) return i; }
    return s0.history.length;
  }
  /** y: hand the terminal to the user's own shell for the command (like /restart's hand-over), then resume. Never the model. */
  function runSlotCommand(ra) {
    if (R.current.bang) { SC.current.runAsk = ra; return say('A command is still running. Ctrl+C stops it, then answer again.', 'warn'); }
    say(`$ ${ra.cmd}`, 'accent');
    say(`Running ${ra.who}'s command in your shell, with this terminal handed over. Quox comes back when it ends.`, 'dim');
    setTimeout(() => {
      if (R.current.closed || R.current.exiting) return;
      const r = handOverRun({ cmd: ra.cmd, env, cwd: realCwd(), stdout, setRawMode: isRawModeSupported ? setRawMode : null, spawn: runSpawn, resume: mouseResume() });
      transcript?.bang?.(ra.cmd, r.error ? 'error' : (r.signal || r.code));
      say(`${ra.who}'s command: ${runFooter(r)}`, !r.error && !r.signal && r.code === 0 ? 'ok' : 'warn');
      bump(n => n + 1);
    }, runHandOverDelayMs);
    return undefined;
  }
  /** Say whether the recipient is live; if it is, one gold line when no reply comes. Older servers send no presence. */
  function announceDelivery(slot, r) {
    const p = presenceLine(slot, r.presence, agoText);
    if (!p) return say(`✔ delivered to ${slot}`, 'ok');
    say(p.text, p.tone);
    const wait = SC.current.waits ??= new Map();
    clearTimeout(wait.get(slot)); wait.delete(slot);
    if (p.listening) {
      const t = setTimeout(() => { wait.delete(slot); if (!R.current.closed) say(`no reply from ${slot} yet`, 'warn'); }, noReplyMs);
      t.unref?.(); wait.set(slot, t);
    } else if (r.presence?.state === 'not_listening') {
      // Transcript fp 6a482d60fe83 (2026-10-16): an attached window got nothing for 4 minutes after "not listening".
      // No reply within the wait: ONE wake ask for this message; y runs /poke <slot> (the keeper wake).
      const seenAt = r.presence.last_checked_in_at || null;
      const t = setTimeout(() => {
        wait.delete(slot);
        if (R.current.closed) return;
        R.current.wakeAsk = { slot, at: Date.now() };
        ask('Wake it now?', { action: `/poke ${slot}`, reason: `${slot} hasn't replied (not listening, ${seenAt ? `last checked in ${agoText(seenAt)}` : 'no check-in on record'})` });
      }, noReplyMs);
      t.unref?.(); wait.set(slot, t);
    }
    return undefined;
  }
  /** SLOTS-REPLY2: after a send into slot X, also show X's holder's lines arriving in X (30 min). Own slot is already listened. */
  function watchReplies(slot, sent) {
    if (!api.slotStream || R.current.closed) return;
    SC.current.replyWatch ??= createReplyWatches({
      open: (nm, q, signal) => api.slotStream(nm, { since: q.since }, signal),
      wait: api.slotWait ? (nm, { since }) => api.slotWait(nm, { since }) : null,
      ttlMs: replyWatchMs,
      skipSlot: (nm) => nm === where.current.slot || SC.current.rooms?.has(nm),
      isMine: (m) => { const l = myLabel(); return Boolean(l && m?.from === l); },
      onReply: (nm, m) => {
        if (R.current.closed) return;
        noteReply(m); noteSender(m);
        const ln = slotLine(m); const rq = runRequest(m, { orgId: R.current.orgId ?? api.orgId?.() ?? null, now: runNow() });
        if (rq) armRun(rq, ln); else dispatch({ type: 'slotmsg', line: ln });
        rememberSender(m);
      },
    });
    SC.current.replyWatch.arm(slot, sent);
  }
  React.useEffect(() => () => { SC.current.replyWatch?.stop(); }, []);
  // SLOTS-REPLY2: every slotSay names the session this window checked its slot out as, so the server can stamp from_slot from its hold record.
  api.bindHolderSession?.(() => slotSession());
  /** Any inbound line from a slot we are waiting on cancels its "no reply" nudge. */
  function noteReply(m) {
    const waits = SC.current.waits; if (!waits?.size) return;
    for (const [slot, t] of waits) if (isHolderLine(m, slot)) { clearTimeout(t); waits.delete(slot); } // case-insensitive: LUCID is the holder of lucid
  }
  /** @slot, /say, /send: straight to the slot, no model turn, signed as this window; prints once delivered. */
  // A typed slot name resolved against the org's slots ignoring case, hyphens, underscores and spaces; else as typed.
  async function canonSlot(nm, { senders = false } = {}) {
    return (await sayTarget(nm, { senders })).slot;
  }
  /** SLOTS-REPLY: names that recently spoke here with a verified slot (from_slot); /say <that name> reaches the slot. */
  function noteSender(m) {
    if (!m?.from || !m?.from_slot) return;
    const list = SC.current.senders ??= [];
    list.push({ from: m.from, from_slot: m.from_slot });
    if (list.length > 200) list.splice(0, list.length - 200);
  }
  // -> { slot, label }: the slot to post to and how to show it (slot first, the name it was reached by in brackets).
  // A slot name, or the session holding one ("/say SITE-CLI"), or (senders) a name that recently spoke with a slot.
  async function sayTarget(nm, { senders = false } = {}) {
    if (!nm) return { slot: nm, label: nm };
    let rows = [];
    if (api.slots) { try { rows = await api.slots(); } catch { rows = []; } }
    const t = resolveSayTarget(nm, Array.isArray(rows) ? rows : [], senders ? SC.current.senders : null);
    if (!t) return { slot: nm, label: nm };
    return { slot: t.slot, label: t.via === 'slot' ? t.slot : addressLabel(t.slot, t.name) };
  }
  /** A dropped slot stream: a server restart (connection cut) is routine and says so calmly; anything else keeps the error. */
  function streamPausedNote(where, err) {
    if (/terminated|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|other side closed|502|503/i.test(String(err || ''))) return say(`${where}: Quox server restarting, reconnecting (nothing is lost).`, 'dim');
    return say(`${where}: live messages paused (${err}); retrying.`, 'warn');
  }
  /** QUOXON-REPLY (owner 2026-10-15: "click the sender to reply"; no mouse tracking, so /r): who last messaged me. */
  function rememberSender(m) {
    const who = m?.from_slot || String(m?.from || '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (!who) return;
    R.current.lastSender = who;
    if (m?.from_slot && !R.current.replyHinted) { // no hint for a sender with no reply address: it would contradict "(no reply address)"
      R.current.replyHinted = true;
      say(`Tab (empty prompt) or /r <text> replies to ${who}`, 'dim');
    }
  }
  /** /slots, /slot list: every slot, who holds it and how recently, one line each (held first). */
  async function listSlots(all = false) {
    if (!api.slots) return say('Slots are not available in this mode.', 'warn');
    let rows; try { rows = await api.slots(); } catch (e) { return say(`Couldn't list slots: ${e?.message || 'failed'}`, 'warn'); }
    const list = (Array.isArray(rows) ? rows : []).filter(r => r?.name);
    if (!list.length) return say('No slots yet. /slot <name> gives this session one.');
    const held = list.filter(r => r.holder_session && r.state !== 'free'), free = list.filter(r => !(r.holder_session && r.state !== 'free'));
    const lines = [...slotsTable(list, { mine: where.current.slot, cols: Math.max(20, cols - 2), all }), `${held.length} held, ${free.length} free${where.current.slot ? ' · * this window' : ''}. /say <slot or session> <text> reaches a held one.`];
    for (const n of new Set(list.map(r => r.human_presence?.away && r.human_presence.notice).filter(Boolean))) lines.push(`⏸ ${n}`); // PRESENCE
    return say(lines.join('\n'));
  }
  async function sendToSlot(slot, text) {
    const target = await sayTarget(slot, { senders: true });
    slot = target.slot;
    if (!api.slotSay) return say('Slots are not available in this mode.', 'warn');
    if (SC.current.rooms.has(slot)) return postRoom(slot, text); // a joined room posts as a member
    const r = await api.slotSay(slot, text, { from: myLabel(), fast: true, fromSlot: where.current.slot || null });
    if (!r.ok && r.status === 404 && api.slots) { let rows = []; try { rows = await api.slots(); } catch { /* the list is a hint only */ } return say(sayMissText(slot, rows), 'warn'); }
    if (!r.ok) return say(`slot ${slot}: ${r.message}`, 'warn');
    const ln = slotLine({ from: slot, text, created_at: r.message?.created_at || new Date().toISOString() });
    dispatch({ type: 'slotmsg', line: { ...ln, glyph: '→', who: target.label || slot, file: null, out: true, delivered: true } });
    announceDelivery(slot, r);
    watchReplies(slot, r.message);
    if (r.humanPresence?.away && r.humanPresence.notice) say(`⏸ ${r.humanPresence.notice}`, 'warn'); // PRESENCE
    if (r.roomPending) say(`${slot} is new: listening windows have it; its chat room copy is queued, delivering when the room is ready.`, 'dim');
    return undefined;
  }
  // ---- QUOXON-ROOMS: a slot as a group room. Joining subscribes (no hold); `#room text` posts; rooms list with unread. ----
  const roomMe = () => slotSession();
  const roomSigned = () => { const d = myDisplay(); return d ? `${roomMe()} (${d})` : roomMe(); };
  const isMine = (m) => { const f = String(m?.from || ''); return f === roomMe() || f.startsWith(`${roomMe()} (`); };
  async function joinRoom(nm, { resume = false } = {}) {
    if (!api.slotJoin || !api.slotStream) return say('Rooms are not available in this mode.', 'warn');
    const rooms = SC.current.rooms;
    if (rooms.has(nm)) { if (!resume) say(`Already in #${nm}. #${nm} <text> posts; #${nm} alone makes it the default.`, 'dim'); return true; }
    const me = roomMe();
    if (!resume) {
      const r = await api.slotJoin(nm, me, myDisplay());
      if (!r.ok) { say(`#${nm}: ${r.message}`, 'warn'); return false; }
    }
    let since = null;
    try { // a one-line-each backlog of the last ~10, so a join lands in the middle of the conversation
      const rows = await (api.slotMessages ? api.slotMessages(nm, 10) : []);
      for (const m of rows) { dispatch({ type: 'slotmsg', line: roomLine(nm, m) }); since = m.created_at || since; }
    } catch { /* the live stream still starts; the backlog is a courtesy */ }
    if (R.current.closed) return false;
    const entry = { listener: null, unread: 0 };
    entry.listener = createSlotListener({
      open: (q, signal) => api.slotStream(nm, { since: q.since, excludeFrom: me, session: me }, signal),
      wait: api.slotWait ? ({ since: sn }) => api.slotWait(nm, { since: sn, excludeFrom: me }) : null,
      onMessage: (m) => {
        noteReply(m); noteSender(m);
        if (R.current.closed || !SC.current.rooms.has(nm) || isMine(m)) return;
        if (SC.current.active !== nm) entry.unread += 1; // before the dispatch, so the status line's count is current
        dispatch({ type: 'slotmsg', line: roomLine(nm, m) });
        rememberSender(m);
        if ((api.settings?.() || {}).slotBell !== 'off') { try { stdout?.write?.('\x07'); } catch { /* no tty */ } }
      },
      onState: (st) => { if (st.error && st.failures === 1 && !R.current.closed) streamPausedNote(`#${nm}`, st.error); },
    });
    rooms.set(nm, entry); bump(n => n + 1); // the status line's groups update now, even on a quiet resume
    entry.listener.start({ since });
    if (!resume) say(`Joined #${nm}. #${nm} <text> posts as ${roomSigned()}; #${nm} alone makes it the default target (a bare # undoes it); /leave ${nm} leaves.`, 'ok');
    return true;
  }
  async function leaveRoom(nm) {
    const e = SC.current.rooms.get(nm);
    if (!e) return say(`You are not in #${nm}. /rooms lists the rooms you are in.`, 'dim');
    e.listener?.stop(); SC.current.rooms.delete(nm);
    if (SC.current.active === nm) SC.current.active = null;
    bump(n => n + 1);
    const r = await api.slotLeave?.(nm, roomMe());
    say(r && !r.ok ? `Left #${nm} here; the server did not confirm (${r.message}).` : `Left #${nm}.`, r && !r.ok ? 'warn' : 'ok');
  }
  function showRooms() {
    const rooms = SC.current.rooms;
    if (!rooms.size) return say('No rooms joined. /join <slot> joins one (any slot in this org).', 'dim');
    for (const [nm, e] of rooms) {
      const live = e.listener?.state?.().connected ? '' : ' (reconnecting)';
      say(`${SC.current.active === nm ? '> ' : '  '}#${nm}  ${e.unread ? `${e.unread} unread` : 'no unread'}${SC.current.active === nm ? '  (default target)' : ''}${live}`, e.unread ? 'accent' : 'dim');
    }
  }
  async function setActiveRoom(nm) {
    if (!(await joinRoom(nm))) return;
    SC.current.active = nm; const e = SC.current.rooms.get(nm); if (e) e.unread = 0;
    say(`Default target is #${nm}: plain lines now post there. A bare # puts it back.`, 'ok');
  }
  async function postRoom(nm, text) {
    if (!api.slotSay) return say('Rooms are not available in this mode.', 'warn');
    if (!SC.current.rooms.has(nm) && !(await joinRoom(nm))) return;
    const r = await api.slotSay(nm, text, { roomSession: roomMe(), fast: true });
    if (!r.ok) return say(`#${nm}: ${r.message}`, 'warn');
    const e = SC.current.rooms.get(nm); if (e) e.unread = 0;
    dispatch({ type: 'slotmsg', line: { ...roomLine(nm, { from: roomSigned(), text, created_at: r.message?.created_at || new Date().toISOString() }, { out: true }), delivered: true } });
  }
  /** `/group-chat join|leave|<text>` and /join, /leave: a typed slot name is checked BEFORE "Ask Quox". */
  async function slotNameCommand(cmdWord, rest) {
    let nm = roomName(cmdWord.replace(/^\//, ''));
    if (!nm || !api.slots) return false;
    let rows = null;
    try { rows = await api.slots(); } catch { return false; }
    const hit = uniqueSquash(nm, (Array.isArray(rows) ? rows : []).map(x => x.name));
    if (!hit) return false;
    nm = hit.toLowerCase();
    const t = String(rest || '').trim();
    if (/^join$/i.test(t)) await joinRoom(nm);
    else if (/^leave$/i.test(t)) await leaveRoom(nm);
    else if (!t) await setActiveRoom(nm);
    else await postRoom(nm, t);
    return true;
  }
  React.useEffect(() => { // rooms are server truth: a restarted named window rejoins quietly
    // keyed like roomMe(): the name, else the conversation an unnamed window joined under (restart resumes it)
    const me = SN.current.name || resumeConversation;
    if (blocked || demoLabel || !api.slotRooms || !me) return;
    api.slotRooms(me).then((rows) => { for (const r of rows) joinRoom(String(r.slot_name), { resume: true }); }).catch(() => {});
  }, []);

  async function slotLog(nArg) {
    const nm = where.current.slot;
    if (!nm) return say('No slot held. /slot <name> gives this session one.', 'warn');
    if (!api.slotMessages) return say('Slots are not available in this mode.', 'warn');
    const n = Math.min(Math.max(parseInt(nArg, 10) || 20, 1), 100);
    let rows;
    try { rows = await api.slotMessages(nm, n); } catch (e) { return say(`slot ${nm}: ${e?.message || 'failed'}`, 'warn'); }
    if (!rows.length) return say(`No messages in ${nm} yet.`);
    say(`Last ${rows.length} in ${nm} (seen by Quox):`);
    for (const m of rows) { // SLOT-RUN: an old run request is shown, never armed (only a live one can be answered)
      noteSender(m); const rq = runRequest(m);
      dispatch({ type: 'slotmsg', line: { ...slotLine(m), full: true, ...(rq ? { run: { ...rq, runnable: false, danger: null, refuse: 'it was sent earlier, and only a live request can be answered here' } } : {}) } });
    }
    return undefined;
  }
  async function sendFile(slot, p) {
    const f = prepareFile(p, { cwd: realCwd() });
    if (!f.ok) return say(f.message, 'warn');
    if (f.hits) {
      SC.current.pendingFile = { slot, f, at: Date.now() };
      return ask(`Send it to ${slot} with ${f.hits === 1 ? 'that' : 'those'} redacted?`, { action: `send ${f.name} to slot ${slot}, ${f.hits} value${f.hits === 1 ? '' : 's'} replaced by [redacted]`, reason: `${f.name} has ${f.hits} secret-shaped value${f.hits === 1 ? '' : 's'}.` });
    }
    return sendToSlot(slot, fileMessage({ name: f.name, body: f.body, size: f.size }));
  }
  // Startup: the slot this profile last held in this directory, free or stale (or still under our old label), is offered once.
  React.useEffect(() => {
    if (blocked || demoLabel || restartSlot || !api.checkoutSlot || !api.slots) return;
    const rec = loadLastSlot({ profile, cwd: realCwd(), path: slotRecordPath });
    if (!rec) return;
    api.slots().then((rows) => {
      const row = (Array.isArray(rows) ? rows : []).find(x => String(x.name) === rec.slot);
      if (!row || SC.current.slot || R.current.closed) return; // only this window's own checkout suppresses the ask, not an inherited one
      const mine = row.holder_session && rec.session && row.holder_session === rec.session;
      if (row.state === 'free' || row.state === 'stale' || !row.holder_session || mine) {
        SC.current.reattach = { slot: rec.slot, take: Boolean(mine || row.state === 'stale'), at: Date.now() };
        ask(`Reattach to slot ${rec.slot}?`, { action: `/slot ${rec.slot}` });
      }
    }).catch(() => { /* no ask when the server cannot say */ });
  }, []);
  React.useEffect(() => { if (resume && !blocked) resumeCmd(resume === true ? '' : String(resume)); }, []);
  React.useEffect(() => { if (!blocked && !demoLabel) aiConnected().then((st) => { R.current.noAi = st === false ? true : st === true ? false : undefined; bump(n => n + 1); }); }, []);
  // Tips (tips.js): mode, rotation and "already used" persist on the profile (quoxon.tips / tipsSeen / tipsUsed).
  // QUOXON-MOUSE: optional mouse (default off, saved per profile). `tty` = tracking is on at the terminal right now.
  const MO = React.useRef(null);
  MO.current ??= { on: (api.settings?.() || {}).mouse === 'on', tty: false, chain: Promise.resolve(), drag: null, last: null, onCursor: null, exitFn: null };
  const TP = React.useRef(null);
  TP.current ??= (() => { const q = api.settings?.() || {}; const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []); return { mode: normaliseMode(q.tips) || DEFAULT_MODE, seen: arr(q.tipsSeen), used: arr(q.tipsUsed) }; })();
  const showTip = async ({ startup: atLaunch = false } = {}) => {
    const t = TP.current;
    if (t.mode === 'off') return atLaunch ? undefined : say('Tips are off. /tip-settings all turns them back on.');
    let hosts; try { hosts = await api.hostCount?.(); } catch { hosts = undefined; } // unknown never skips a tip
    if (atLaunch && S.current.approvals.length) return undefined; // never over an approval
    let plugins; try { plugins = await api.installedPlugins?.(); } catch { plugins = undefined; } // unreadable = plugin tips hidden
    const signals = { hosts, modelFavs: MP.current.prefs.favourites.length, rows: RW.current.all().length };
    const contract = R.current.contract || null;
    const r = nextTip({ mode: t.mode, contract, plugins, signals, used: t.used, seen: t.seen });
    if (!r.tip) return atLaunch ? undefined : say('No tips to show right now for this install.');
    t.seen = r.seen; api.saveSetting?.('tipsSeen', t.seen);
    if (R.current.sleep) return undefined; // no tip over the sleep screen
    return dispatch({ type: 'tip', text: tipText(r.tip), cmd: r.tip.try });
  };
  const tipStarted = React.useRef(false);
  // What's new (whatsnew.js): once per newer build; first ever run only records. Wins the startup slot over the tip.
  const showWhatsNew = () => {
    if (!whatsNewStartup || blocked || demoLabel) return false;
    const st = api.settings?.() || {};
    const r = startupWhatsNew({ build: version, last: st.whatsNew, entries: whatsNewEntries });
    if (r.record) api.saveSetting?.('whatsNew', r.record);
    if (welcome || !startupEnabled(st)) return false;
    if (r.show.length) { dispatch({ type: 'whatsnew', items: r.show.map(e => ({ title: e.title, cmd: tryText(e) })), more: r.more }); return true; }
    const line = startupCommandLine(unseenCommands({ registry: visibleRegistry(), seen: st.whatsNewSeen })); // /whatsnew marks them seen
    if (!line) return false;
    dispatch({ type: 'whatsnew', head: "What's new", pad: true, items: [{ title: line, cmd: '' }], more: 0 });
    return true;
  };
  const startupTip = () => {
    if (tipStarted.current || blocked) return;
    tipStarted.current = true;
    const shown = showWhatsNew();
    if (tipStartup && !welcome && !shown) showTip({ startup: true });
  };
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
    if (SN.current.name && id && SN.current.saved !== key) { SN.current.saved = key; saveName(id, SN.current.name, namesPath, { profile, org: R.current.orgName ?? org ?? null }); }
  });

  // Live approvals count: refreshed from the inbox every 30 s. A failed refresh keeps the last
  // known count and records the error; it never reads as "0 waiting".
  // The org's name, or "org …H398" while it is unknown; never a raw ULID. A lookup that failed at startup (server down)
  // is retried on the next successful poll (owner 2026-10-18).
  const orgShown = () => orgLabel(R.current.orgName ?? org, R.current.orgId ?? api.orgId?.() ?? null);
  const retryOrgName = async () => {
    const cur = R.current.orgName ?? org;
    if ((cur && !isOrgId(cur)) || !api.orgs || R.current.orgLookup) return;
    const id = R.current.orgId ?? api.orgId?.() ?? null; if (!id) return;
    R.current.orgLookup = true;
    try {
      const hit = (await api.orgs()).find((o) => o?.id === id);
      const nm = hit?.name || hit?.slug;
      if (nm && !isOrgId(nm)) { R.current.orgName = nm; dispatch({ type: 'notify', patch: {} }); }
    } catch { /* still unknown: the next successful poll tries again */ } finally { R.current.orgLookup = false; }
  };
  const refreshNotify = async () => {
    if (BL.current) return;
    const N = R.current.notify || (R.current.notify = { fails: 0, authLost: false });
    try {
      const items = await api.approvals();
      if (N.authLost) say('Signed in again: approvals are back.', 'ok');
      else if (N.slow) say('Quox server is back.', 'ok');
      N.fails = 0; N.authLost = false; N.slow = false;
      dispatch({ type: 'notify', patch: { approvals: items.length, error: null } });
      retryOrgName();
      dispatch({ type: 'inbox.sync', ids: items.map(i => i.id) });
      R.current.openIds = { ids: new Set(items.map(i => i.id)), at: Date.now() }; // a walk skips a card answered elsewhere since it started
      // Provider paths that emit no approval.requested still surface here, as the same card.
      for (const item of items) dispatch({ type: 'approval.found', item, since: R.current.startedAt, userId: api.userId?.() || null });
    } catch (e) {
      N.fails++; // counted apart from an empty inbox
      const msg = e?.message || 'failed';
      if (!e?.transient && (e?.status === 401 || isSessionDead(e) || /No authentication token|service key|unauthori[sz]ed/i.test(msg))) {
        N.authLost = true;
        markSignedOut(e?.reason || null); // one card, then the pollers go quiet until /login
        dispatch({ type: 'notify', patch: { error: null } });
        return;
      }
      if (e?.transient && !N.slow) { N.slow = true; say('Quox server is slow or unreachable, retrying.', 'warn'); } // QUOXON-FW12: not signed out
      dispatch({ type: 'notify', patch: { error: msg } });
    }
  };
  React.useEffect(() => {
    // Back off on repeated failure (x2 per miss, capped at 60 s); the normal cadence returns after one success.
    let timer = null, stopped = false;
    const tick = async () => {
      // Stale sign-in: the credentials file changed (another window refreshed, or `quox login` ran). While this
      // window reads as signed out, re-read them and retry once; a still-dead session just marks itself again.
      try {
        if (api.credentialsChanged?.() && BL.current && signedOutRef.current && api.reloadCredentials?.()) {
          setSignedOut(null); BL.current = blockedProp || null;
          R.current.notify = { fails: 0, authLost: false };
          refreshRoster();
        }
      } catch { /* a failed stat never blocks the poll */ }
      await refreshNotify();
      if (stopped) return;
      const f = R.current.notify?.fails || 0;
      timer = setTimeout(tick, f ? Math.min(60000, notifyMs * 2 ** Math.min(f, 12)) : notifyMs);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  // #904 part 3: a provider refusing turns (weekly limit, no credits) shows in the status area before
  // you type into it. Polled once a minute; a failed read keeps the last answer (never "fine").
  React.useEffect(() => {
    if (!api.providerHealth) return undefined;
    let timer = null, stopped = false;
    const tick = async () => {
      if (!BL.current) {
        const list = await api.providerHealth();
        // Only the provider this window uses (owner 2026-10-15: "only need to know if using openai"): the chosen
        // model's provider, else the provider the last turn ran on. Unknown yet: say nothing; a failing turn says why.
        const mine = String(MC.current?.provider || S.current?.ctx?.provider || '').toLowerCase();
        const hits = list ? list.filter(e => mine && String(e.provider || '').toLowerCase() === mine) : null;
        if (hits) dispatch({ type: 'notify', patch: { providerLines: hits.map(e => `⚠ ${e.line || e.provider + ' ' + e.state}: chat on it fails until then`) } });
      }
      if (!stopped) timer = setTimeout(tick, 60000);
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
      applyProgress(r.rows, (R0.progress ||= new Map()), Date.now());
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
  const dividerSlowRef = React.useRef({}); // TUI-DIVIDER: per-turn slow-redraw marker (dividerRule.noteFrameGap)
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
    if (motionOn && !mono() && R.current.roster.rows.some((x) => x.state === 'running')) return true; // pulse spinner frames
    if (motionOn) {
      if (commitLimit(s0) > committedRef.current && !fxActive(s0.history[committedRef.current], now) && !isActiveStage(s0, committedRef.current)) return true; // commit to Static
      for (const r of R.current.roster.rows) if (rosterFx(r.key, now) != null || !rosterSeen.current.has(r.key)) return true;
    }
    const card0 = s0.approvals[0];
    if (card0) {
      const age = now - (card0.displayedAt ?? card0.shownAt);
      if (motionOn && (age < 1000 || R.current.cardMidAnim)) return true; // arrival animation, plus one settled render if the last draw was mid-animation (a late tick on a loaded box left the title scrambled for good)
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
    if (R.current.roster.rows.length) d.push({ every: motionOn && !mono() && R.current.roster.rows.some((x) => x.state === 'running') ? SPIN_MS : SECOND_MS }); // SPIN_MS: the roster pulse spinner
    if (ringAnimating(ringRef.current)) d.push({ every: FRAME_MS }); // the ring settling after the turn
    if (motionOn && !mono() && dividerLive(s0.divider, now)) { // TUI-DIVIDER: the AOCL strip, then its green/red hold; nothing once it is over
      d.push({ every: FRAME_MS });
      if (s0.divider.endedAt != null) d.push({ at: s0.divider.endedAt + (s0.divider.phase === 'done' ? GREEN_MS : RED_MS) + 1 });
    }
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
    if (item.kind === 'object' && !fxRef.current.has(item.id) && cardTallerThanScreen(item, cols, termRows(stdout) ?? 40, now)) return; // TUI-UX #5: a card taller than the screen never decodes in (it would leave a garbled copy in scrollback)
    const e = fxRef.current.get(item.id);
    if (!e) { fxRef.current.set(item.id, { at: now, timing: t, running: item.kind === 'tool' && item.status === 'running', settleAt: null }); if (motionStats) (motionStats.reveals ||= []).push({ id: item.id, kind: item.kind, text: item.text ?? null, timing: t }); } // motionStats: which items started a decode-in, for a test that cannot rely on sampling a 0.28 s window
    else if (e.running && item.status !== 'running' && e.settleAt == null) e.settleAt = now;
  };
  const rosterFx = (key, now) => { const at = rosterSeen.current.get(key); const e = at == null ? null : (now - at) / 1000; return e != null && e < revealSpan(TIMING.roster) ? e : null; };
  function fxBusy(now) {
    const s0 = S.current;
    if (commitLimit(s0) > committedRef.current) return true;
    if (s0.blocks.some(b => fxActive(b, now))) return true;
    const card0 = s0.approvals[0];
    if (card0 && (now - (card0.displayedAt ?? card0.shownAt) < 1000 || R.current.cardMidAnim)) return true; // owed a settled draw
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
  const slotSession = () => SN.current.name || S.current.ctx.conversationId || 'quox';
  const agoText = (iso) => { const m = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : null; return m == null || Number.isNaN(m) ? 'a while ago' : m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
  // Check a slot out for this window. A hold by another session of the SAME user is offered as a takeover (y/N, or --take).
  const takeSlot = async (nm, take, { quietTransient = false } = {}) => {
    const r = await api.checkoutSlot(nm, slotSession(), { take });
    if (!r.ok && r.transient && quietTransient) return r; // carrySlot retries and speaks for itself
    if (r.ok) {
      where.current = { ...where.current, slot: nm }; bump(x => x + 1);
      listenSlot(nm);
      saveLastSlot({ profile, cwd: realCwd(), slot: nm, session: slotSession(), path: slotRecordPath });
      const from = r.tookOver?.from;
      return say(from ? `Slot ${nm} checked out (took over your ${r.tookOver.state === 'stale' ? 'stale ' : ''}session '${from}'). Messages to ${nm} show here as they arrive.` : `Slot ${nm} checked out. Messages to ${nm} show here as they arrive; @<slot> <text> sends.`, 'ok');
    }
    const h = r.held;
    if (h?.same_user) {
      R.current.slotAsk = { nm, at: Date.now() };
      return ask('Take it over?', { action: `/slot ${nm} --take`, reason: `${nm} is held by your other session '${h.holder_session}' (last seen ${agoText(h.last_seen)}); /slot ${nm} --take also works.` });
    }
    if (h) return say(`slot ${nm} is held by ${h.holder_session || 'another user'}${h.since ? ` since ${h.since}` : ''}. It is not yours to take.`, 'warn');
    if (r.unlicensed) return say(r.message, 'warn');
    return say(`slot ${nm}: ${r.message}`, 'warn');
  };
  // QUOXON-STEPUP: the server decides what needs a person. We try with any live step-up token; on 403 step_up_required
  // we ask for the PIN (masked card) and retry once. `proactive` (/authorise) asks first. Deny never needs a PIN.
  const respondWithStepUp = async (card, action, { proactive = false, reason = null, bulk = false } = {}) => {
    const via = `tty ${sessionLabel()}`;
    const subject = { line1: `${action === 'approve' ? 'approve' : 'reject'} ${String(card.tool || card.inboxItemId || 'item')}${card.target ? ` · ${String(card.target)}` : ''}`, raisedBy: card.raisedBy || null, risk: card.risk || null };
    const ask = async () => {
      const r = await SU.current.request({ scope: 'approve', orgId: api.orgId?.() || null, subject });
      if (!r.ok) { const err = new Error(declinedText(r.reason)); err.stepUpDeclined = true; throw err; }
    };
    if (action !== 'approve') return api.respond(card.inboxItemId, action, { via, reason });
    if (proactive && !SU.current.token('approve')) await ask();
    try { return await api.respond(card.inboxItemId, action, { via, stepUp: SU.current.headers('approve'), bulk }); }
    catch (e) {
      if (!(e?.status === 403 && e?.body?.error === 'step_up_required')) throw e;
      SU.current.drop('approve'); // a stale or mismatched token must not be reused
      await ask();
      return api.respond(card.inboxItemId, action, { via, stepUp: SU.current.headers('approve'), bulk });
    }
  };
  // QUOXON-STEPUP: an override id is single-use; the next turn carries it once, then it is gone.
  const takeOverride = () => { const o = R.current.override; R.current.override = null; return o && o.until > Date.now() ? o.id : undefined; };
  const sessionLabel = () => String(SN.current.name || (S.current.ctx.conversationId ? String(S.current.ctx.conversationId).slice(0, 12) : 'new session')).replace(/\s+/g, ' ').slice(0, 40);
  // APPROVALS-AUDIT: a typed number is a position. If the list moved since the owner last saw it, refuse and show it again.
  const listChanged = async () => {
    if (R.current.walkSend || !R.current.shownIds) return false;
    let items; try { items = await api.approvals(); } catch { return false; }
    const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
    const ids = groupApprovals(items, { conversationId: S.current.ctx.conversationId, cardIds }).flatMap(g => g.items.map(x => x.item.id));
    const seen = R.current.shownIds;
    if (ids.length === seen.length && ids.every((x, i) => x === seen[i])) return false;
    say('The list changed since you last saw it, so nothing was sent. Here it is again:', 'warn');
    await command('/approvals');
    return true;
  };
  // WALKTHROUGH: decisions one card at a time. Identity is the decision id (items are held by id), never a list position.
  // WALK-FIXES (owner 2026-10-17: "escape to exit survey. two came at once. didnt submit each answer as i gave it, exited
  // halfway thru and tried again, answered question returned"): ONE walk and ONE card on screen at a time (a second start
  // joins the walk already running); each answer is sent the moment it is given and the next card shows as soon as the
  // server took it; a line typed while an answer is still on its way is never applied to the card just answered; Esc or any
  // command ends the walk with a summary; an id answered in this window never comes back, and a list held from earlier
  // (a bulk card, a range) is re-read from the server before its first card.
  const WALK_TTL = 1800000;
  const walkAnsweredIds = () => (R.current.walkAnswered ||= new Set());
  const walkCloseCard = (W, why = 'next') => { if (W?.card) { W.card.at = Date.now(); W.card.walkWhy = why; W.card = null; } }; // why: next/done settle silently; stop = interrupted
  const walkKeysText = (it) => { const ks = it.payload.options.map(o => o.key); return ks.length > 1 ? `${ks.slice(0, -1).join(', ')} or ${ks[ks.length - 1]}` : ks.join(''); };
  // EXPIRED-ASK (owner 2026-10-17 21:23): a question whose time ran out is gone: say so plainly and move on, never "the question stays".
  const askExpiry = (it) => { const t = Date.parse(it?.due_at ?? it?.payload?.expires_at); return Number.isFinite(t) ? t : null; };
  const expiredText = (it) => { const t = askExpiry(it); return t ? `That question expired at ${askClock(t)}, so there's nothing to answer.` : "That question is no longer open, so there's nothing to answer."; };
  const walkGoneElsewhere = (W, id) => { const o = R.current.openIds; return Boolean(o && o.at > W.startedAt && !o.ids.has(id)); };
  const walkSummaryLines = (W, head) => {
    const sending = R.current.walkSend && W.current && !W.done.has(W.current) ? W.current : null;
    const left = W.ids.filter(id => !W.done.has(id) && id !== sending).map(id => W.items[id].title || id);
    const lines = walkSummary({ answered: W.answered, skipped: W.skipped.map(id => W.items[id].title || id), left });
    if (head) lines[0] = lines[0].replace(/^Walkthrough done/, head);
    if (sending) lines.push(`  … still sending: ${W.items[sending].title || sending}`);
    return { lines, open: left.length + W.skipped.length };
  };
  const walkEnd = (why) => { // Esc, a command, or a card left too long: the walk stops here and says where it stands
    const W = R.current.pendingWalk; if (!W) return false;
    R.current.pendingWalk = null; R.current.focusedDecision = null; K.current.walkEndAt = Date.now(); walkCloseCard(W, 'stop');
    const { lines, open } = walkSummaryLines(W, `Walkthrough stopped (${why})`);
    say(' ');
    lines.forEach((l, k) => say(l, k === 0 ? 'ok' : undefined));
    if (open) say('Nothing else was sent. /walkthrough picks up what is still waiting.', 'dim');
    queueMicrotask(() => reconcileAsks());
    return true;
  };
  const walkShow = () => {
    endAskEcho(); // TUI-INPUT: a new walk card is a new prompt; the last answer's echo must not sit in front of it
    const W = R.current.pendingWalk; if (!W) return;
    walkCloseCard(W); // the card just answered or skipped settles; only the next one is open
    const gone = walkAnsweredIds();
    let nextId = null;
    for (const id of W.ids) {
      if (W.done.has(id)) continue;
      if (gone.has(id)) { W.done.add(id); continue; } // answered in this window already: never shown again
      { const ex = askExpiry(W.items[id]); if (ex && ex <= Date.now()) { W.done.add(id); (W.dropped ||= new Set()).add(id); refreshNotify(); say(`"${clip(W.items[id].title || id, 60)}": ${expiredText(W.items[id])}`, 'accent'); continue; } }
      if (walkGoneElsewhere(W, id)) { W.done.add(id); say(`"${clip(W.items[id].title || id, 70)}" is no longer waiting (answered elsewhere or expired). Moving on.`, 'dim'); continue; }
      nextId = id; break;
    }
    if (!nextId) { R.current.pendingWalk = null; R.current.focusedDecision = null; K.current.walkEndAt = Date.now(); say(' '); for (const l of walkSummaryLines(W).lines) say(l, l.startsWith('Walkthrough') ? 'ok' : undefined); queueMicrotask(() => reconcileAsks()); return; }
    const live = W.ids.filter(id => !(W.dropped && W.dropped.has(id))); // expired or gone questions are not counted
    const it = W.items[nextId]; const c = walkCard(it, live.indexOf(nextId) + 1, live.length, { cols: cols - 2 });
    W.current = nextId; W.at = Date.now(); W.card = { at: W.at, walk: nextId };
    say(' ');
    c.lines.forEach((l, k) => say(l, k === 0 ? 'warn' : k === c.recoLine ? 'reco' : undefined));
    ask('Your choice, with an optional note', { who: it.payload.session || '', action: '', reason: '', keys: '· Esc stops', plain: true });
  };
  const walkStart = async (list, { fresh = false, quiet = false } = {}) => {
    let decs = (list || []).filter(isDecision);
    if (!fresh && decs.length) { // a list held from before: only what the server still has waiting
      try { const open = new Set((await api.approvals()).map(x => x.id)); decs = decs.filter(x => open.has(x.id)); } catch { /* slow server: the answered-in-this-window set below still applies */ }
    }
    const gone = walkAnsweredIds();
    decs = decs.filter(x => !gone.has(x.id));
    const W0 = R.current.pendingWalk;
    if (W0) { // one walk at a time: a second start joins the walk on screen, never a second card
      const add = decs.filter(x => !W0.ids.includes(x.id));
      for (const x of add) { W0.ids.push(x.id); W0.items[x.id] = x; }
      if (add.length) say(`${add.length} more question${add.length === 1 ? '' : 's'} added to this walkthrough (now ${W0.ids.length}).`, 'dim');
      return undefined;
    }
    if (!decs.length) return say('No question is waiting for you.');
    R.current.pendingWalk = { ids: decs.map(x => x.id), items: Object.fromEntries(decs.map(x => [x.id, x])), done: new Set(), answered: [], skipped: [], current: null, card: null, at: Date.now(), startedAt: Date.now() };
    if (!quiet) say(`${decs.length} question${decs.length === 1 ? '' : 's'} waiting for you. One at a time; answer with a choice, then an optional note; Esc stops. Risky ones (high risk, test changes, restarts) always come here, one at a time.`, 'dim'); // /approvals already said it once in its own header
    walkShow();
    return undefined;
  };
  // NOTE-CONFIRM (transcript review 2026-10-17): an answer with a note can contradict its option, so every note is confirmed first, unless it starts with "fyi".
  const noteNeedsConfirm = (note) => { const t = String(note ?? '').trim(); return Boolean(t && !/^fyi\b/i.test(t) && /\b(not|no|never|without|only|except|instead|unless|limit\w*|max\w*|at most|at least)\b|n't\b|\d/i.test(t)); }; // only a note that could change the choice asks first; a plain comment goes through with the note attached
  const noteCard = (st) => {
    say(' ');
    say(st.batch ? `You are answering ${st.count} questions (${st.label}), and your note says: "${clip(st.note, Math.max(30, cols - 50))}".` : `You chose (${st.key}) ${st.label}, and your note says: "${clip(st.note, Math.max(30, cols - 40))}".`, 'warn');
    say(`A note can change what you mean${st.batch ? ', and this one would go with every answer' : ''}. Send it as:`);
    say(`  [1] the note wins (recommended)   [2] the option${st.batch ? 's' : ''} as written${st.batch ? '' : `, (${st.key}) ${clip(st.label, 40)}`}   [3] edit`);
    say('  y or Enter sends 1 · n sends 2 · e edits');
    R.current.noteAsk = { ...st, at: Date.now() };
    bump(n => n + 1);
  };
  const noteResolve = async (choice, st) => {
    if (choice === '3') { edit({ type: 'set', text: st.walk ? `${st.key} ${st.note}` : `/answer ${st.cmd} "${st.note}"` }); return; }
    const note2 = choice === '1' ? `[note overrides the option as written (${st.label})] ${st.note}` : `[sent as the option as written; the note did not change it] ${st.note}`;
    R.current.noteBypass = true;
    try { if (st.walk) await walkHandle(`${st.key} ${note2}`); else await command(`/answer ${st.cmd} "${note2}"`); }
    finally { R.current.noteBypass = false; }
  };
  const walkHandle = async (text) => {
    const W = R.current.pendingWalk; const it = W?.items[W.current];
    if (!it) { R.current.pendingWalk = null; return false; }
    dispatch({ type: 'walk.reply', text, id: it.id }); // the transcript keeps what was typed at each card
    if (R.current.walkSend) { // the last answer is still on its way: this line must not land on the card just answered
      edit({ type: 'set', text });
      say(`Still sending your answer to "${clip(it.title || it.id, 60)}". Your line is kept in the box; press Enter when the next card shows.`, 'warn');
      return true;
    }
    if (Date.now() - W.at >= WALK_TTL) { say('That card sat open for 30 minutes, so nothing was sent. Here it is again:', 'warn'); walkShow(); return true; }
    const rep = walkReply(it, text);
    if (!rep) { say(walkNoCatch(it), 'warn'); W.at = Date.now(); if (W.card) W.card.at = W.at; return true; }
    if (rep.notYesNo) { say(walkNotYesNo(it), 'warn'); W.at = Date.now(); if (W.card) W.card.at = W.at; return true; }
    if (rep.defer) { W.done.add(it.id); W.skipped.push(it.id); walkShow(); return true; }
    if (rep.ask) { W.at = Date.now(); submit(`Explain this decision to me in two plain sentences and say what you would do, about THIS one only. Title: ${it.title}. Asked by: ${it.payload.session || 'a session'}. Why: ${it.payload.why || 'not given'}. Options: ${it.payload.options.map(o => `${o.label} (${o.key})`).join('; ')}. Decision id: ${it.id}.`); return true; }
    const n = S.current.inbox.findIndex(x => x.id === it.id) + 1; // routed by id; the position is only looked up at the moment of sending
    if (!n) { say(`"${it.title}" is no longer waiting (answered or expired). Moving on.`, 'warn'); W.done.add(it.id); walkShow(); return true; }
    if (askExpiry(it) && askExpiry(it) <= Date.now()) { W.done.add(it.id); (W.dropped ||= new Set()).add(it.id); refreshNotify(); say(expiredText(it), 'accent'); walkShow(); return true; }
    if (rep.note && noteNeedsConfirm(rep.note) && !R.current.noteBypass) {
      const o = it.payload.options.find(x => x.key === rep.key);
      noteCard({ walk: true, key: rep.key, label: o?.label || rep.key, note: rep.note, id: it.id });
      return true;
    }
    R.current.lastAnswered = null;
    R.current.walkSend = true;
    try { await command(`/answer ${n} ${rep.key}${rep.note ? ` "${rep.note}"` : ''}`); } finally { R.current.walkSend = false; }
    if (R.current.lastAnswered === it.id) {
      walkAnsweredIds().add(it.id);
      W.done.add(it.id); W.answered.push({ title: it.title, word: `${it.payload.options.find(o => o.key === rep.key).label}${rep.note ? ` (note: ${rep.note.length} characters)` : ''}` });
      if (R.current.pendingWalk === W) walkShow(); // stopped while it was sending: the answer stands, no further card
    } else if (R.current.goneAsk === it.id) { // the server says it is gone: nothing to answer, on to the next card
      R.current.goneAsk = null; W.done.add(it.id); walkAnsweredIds().add(it.id); refreshNotify();
      if (R.current.pendingWalk === W) walkShow();
    } else if (R.current.pendingWalk === W) { say('Not answered; the question stays. Say a choice again, s to skip, or Esc to stop.', 'warn'); W.at = Date.now(); if (W.card) W.card.at = W.at; }
    return true;
  };
  const answer = async (card, action, { proactive = false, batch = false, reason = null, bulk = false } = {}) => {
    if (R.current.answering?.has(card.callId)) return;
    (R.current.answering ||= new Set()).add(card.callId);
    try {
      if (!card.inboxItemId && card.approvalId && !batch) { // an event card that never learned its inbox id: find it, never answer null
        try { card = { ...card, inboxItemId: (await api.approvals()).find(i => (i.payload?.approval_id || i.approval_id || i.aee_correlation_id) === card.approvalId)?.id || null }; } catch { /* falls through to the 404 path */ }
      }
      await respondWithStepUp(card, action, { proactive, reason, bulk });
      // The demo's stream carries on to its own tool result, so no "running, result later" note, no poll, no stale count.
      dispatch({ type: 'approval.sent', callId: card.callId, action, tool: card.tool, target: card.target, approvalId: card.approvalId, inboxItemId: card.inboxItemId || null, quiet: Boolean(demoLabel), foreign: Boolean(card.foreign), batch });
      if (demoLabel) { B.current = initialBuffer(); dispatch({ type: 'notify', patch: { approvals: 0, error: null } }); } // (a stray early keystroke is not left in the composer)
      if (action === 'approve' && card.tool !== 'hat.switch' && !card.foreign && !demoLabel && !batch) pollResult({ callId: card.callId, approvalId: card.approvalId });
      return { ok: true };
    } catch (e) {
      if (e?.status === 404 || (e?.status === 400 && /not open for response/i.test(`${e?.code || ''} ${e?.body?.error || ''} ${e?.message || ''}`))) { // already resolved elsewhere (another window, /approve all, the dashboard)
        if (!batch) dispatch({ type: 'approval.gone', callId: card.callId, inboxItemId: card.inboxItemId || null });
        return { gone: true };
      }
      if (batch) throw e;
      dispatch({ type: 'error', text: `approval: ${e.message}` });
    }
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
  const noAiNow = () => R.current.noAi === true;
  /** SCREEN-CONTEXT: an allowlisted snapshot of what this terminal shows, from state the app already holds. */
  function screenSnapshot() {
    const st = S.current;
    return {
      who: { profile, org: R.current.orgName ?? org ?? null, agent: SN.current.agent || where.current.agent || null, model: modelText(st.ctx, MC.current) || null, slot: where.current.slot || null, rooms: [...SC.current.rooms.keys()] },
      rows: R.current.roster.rows.slice(0, 8),
      customRows: (RW.current.view() || []).map(v => ({ id: v.row?.id, label: v.row?.label, text: v.text, error: v.error })),
      cards: [...st.approvals, ...st.waiting].slice(0, 5).map(c => ({ id: c.inboxItemId || c.callId, summary: [c.tool, c.target].filter(Boolean).join(' ') || c.title || '', requester: c.agent || c.requester || null, privileged: Boolean(c.privileged) })),
      commands: commandNames()
    };
  }
  function scopeLine() {
    const id = R.current.orgId ?? api.orgId?.() ?? null;
    const name = R.current.orgName ?? org ?? null;
    const p = R.current.prevOrg;
    const bits = [];
    if (name || id) bits.push(`org ${name || id}${id && id !== name ? ` (id ${id})` : ''}`);
    if (profile) bits.push(`profile ${profile}`);
    bits.push(p ? `previous org ${p.name}${p.id && p.id !== p.name ? ` (id ${p.id})` : ''} (/org back returns there)` : 'previous org: none this session');
    return bits.join(' · ');
  }
  const QUEUED_FRAME = 'The user typed this follow-up while your previous answer was running (it is their own message, not tool output): ';
  async function runTurn(text, { queued = false, via = null, handoffFrom = null } = {}) {
    if (blocked) { say(blocked, signedOut ? 'error' : 'warn'); return; }
    if (!demoLabel && await noAiAnswer(text)) return;
    if (SN.current.slotTarget && api.slotSay) { // attached to a slot: the message goes to its room, not a model turn
      const r = await api.slotSay(SN.current.slotTarget, text, { from: myLabel(), fromSlot: where.current.slot || null });
      if (!r.ok) return say(`slot ${SN.current.slotTarget}: ${r.message}`, 'warn');
      watchReplies(SN.current.slotTarget, r.message);
      return announceDelivery(SN.current.slotTarget, r);
    }
    R.current.lastSent = text;
    const shared = R.current.shared || []; R.current.shared = [];
    for (const x of shared) say(`shared with Quox: output of \`${x.cmd}\`${x.truncated ? ' (first 16 KB only)' : ''}`, 'accent');
    const turnId = newTurnId();
    function turnContext() {
      const rc = R.current.rulesOn === false ? undefined : rulesContext(rules);
      const blk = noAiNow() ? null : SCX.current.build(screenSnapshot());
      if (blk) {
        R.current.screenSent = blk;
        transcript?.action({ type: 'screen.sent', text: `terminal context ${blk.bytes} bytes: ${blk.sections.join(', ') || 'nothing new'}` });
      }
      // Owner 2026-10-15 "u should always know what scope it is set to": every turn names the current org (name and
      // id), the profile and the previous org, even with /context off, so "which org am I in" and "switch back" are
      // answered from this, never from history.
      const scope = scopeLine();
      if (!blk?.text) return scope ? { ...(rc || {}), scope } : rc;
      return { ...(rc || {}), terminal: blk.text, ...(scope ? { scope } : {}) };
    }
    const open = (signal) => api.stream({ turnId, message: withShared(queued ? QUEUED_FRAME + text : text, shared), agent: via || SN.current.agent || 'quox', conversationId: S.current.ctx.conversationId, ...(handoffFrom ? { handoffFrom } : {}), heldSlot: where.current.slot ? { name: where.current.slot, session: slotSession(), display: myDisplay() } : null, context: turnContext(), overrideId: takeOverride(), ...(MD.current === 'plan' ? { mode: 'plan' } : {}), ...streamFields(MC.current) }, signal);
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

  // The assistant handed us a slash command (terminal_suggest_command). Vet it here; the y/N answer runs it as if typed.
  function offerSuggestion(ev) {
    const seen = (R.current.suggestSeen ||= new Set());
    if (ev.call_id && seen.has(ev.call_id)) return; // a replayed event must not ask twice
    if (ev.call_id) seen.add(ev.call_id);
    const v = vetSuggestion(ev.suggest_command);
    if (!v.ok) { say(`Not offered: ${clip(String(ev.suggest_command).slice(0, 60), 60)} (${v.reason}).`, 'warn'); return; }
    if (v.readOnly && ev.suggest_explicit === true) { say(`ran ${v.line}`, 'dim'); command(v.line); return; }
    R.current.suggestAsk = { line: v.line, at: Date.now() };
    // Asked AFTER the answer, last thing on screen (owner 2026-10-15: mid-stream it scrolled away above the reply).
    R.current.suggestLine = askText(`Run ${clip(v.line, cols - 20)}?`, { who: askerName(), action: v.line, reason: ev.suggest_reason ? String(ev.suggest_reason).replace(/[.\s]+$/, '') : '' });
  }
  // QUOXON-ASK safety net: the answer named ONE runnable command but the model did not offer it: offer it here, same ask.
  function offerNamed(text) {
    const v = namedCommand(text);
    if (!v) return;
    R.current.suggestAsk = { line: v.line, at: Date.now() };
    R.current.suggestLine = askText(`Run ${clip(v.line, cols - 20)}?`, { who: askerName(), action: v.line, reason: 'Quox named this command in its answer' });
  }
  function flushSuggestion() {
    const t = R.current.suggestLine; if (!t) return;
    R.current.suggestLine = null;
    if (R.current.suggestAsk) R.current.suggestAsk.at = Date.now(); // the answer window starts when it is shown
    say(t, 'ask');
  }

  // QUOXON handoff offer: the SAME question to the suggested agent for this one turn; the window stays attached.
  async function runHandoff(a) {
    say(`↪ Asking ${a.h.name} this one: ${clip(a.text, Math.max(20, cols - 30))}`, 'dim');
    R.current.handoffTurn = true; // the handed-over turn answers without a suggestion; that must not break the streak
    try { await runTurn(a.text, { via: a.h.agent, handoffFrom: a.h.from }); } finally { R.current.handoffTurn = false; }
    say(handoffAnsweredNote(a.h), 'dim');
    bump(n => n + 1);
  }
  async function consumeTurn(turnId, open, { keepOnDown = false } = {}) {
    R.current.caps.steer = true; R.current.steerNoted = false; // steer support is learned per turn (provider paths differ)
    R.current.durable = false; // learned from the server: v1.1 events carry a seq
    dispatch({ type: 'turn.begin', turnId });
    const ctrl = new AbortController();
    R.current.abort = ctrl;
    let offered = false, sawEvent = false, down = false;
    let answerText = '', suggested = false, gate = null; // the safety net reads the answer when no suggestion came
    try {
      for await (const ev of open(ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        sawEvent = true;
        if (typeof ev?.seq === 'number') R.current.durable = true;
        LG.current.observe(ev);
        dispatch({ type: 'event', ev });
        if (ev.type === 'tool.finished' && ev.suggest_command) { suggested = true; offerSuggestion(ev); }
        if (ev.type === 'turn.handoff_suggested') { const ho = handoffFromEvent(ev, SN.current.agent); if (ho) R.current.handoffPending = { h: ho, text: R.current.lastSent || '' }; } // QUOXON handoff offer
        if (ev.type === 'chunk' || ev.type === 'text.delta') { const g = textGate(gate, ev); gate = g.st; if (g.append && answerText.length < 20000) answerText += String(ev.content); }
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
        if (e?.status === 423 && typeof e?.body?.block_id === 'string') { // QUOXON-STEPUP: a policy block; a person may override it once
          R.current.lastBlock = { blockId: e.body.block_id, agentId: e.body.safety?.agent || null, text: String(e.body.message || e.message || '').slice(0, 200) };
          say(`Blocked by policy (${e.body.block_id}). A person can override this one action: /override last <reason>`, 'warn');
        }
        // TUI-DIVIDER: a refusal before the stream opened names the layers it really evaluated; the rule lights them.
        if (Array.isArray(e?.body?.aocl_layers)) for (const l of e.body.aocl_layers) dispatch({ type: 'event', ev: { type: 'aocl.layer', ...l } });
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
      const planDone = MD.current === 'plan' && !down && !ctrl.signal.aborted && Boolean(answerText);
      if (!suggested && !down && !ctrl.signal.aborted && answerText && MD.current !== 'plan') offerNamed(answerText); // plan mode: the plan card below is the one next step
      // QUOXON handoff offer: the attached agent lacks the tools for this ask. The handoff card answers the actual question,
      // so it wins over the agent's own suggested command (owner live 22:42: "Run /vm list?" took the slot and the handoff
      // card was dropped silently). Nothing is dropped silently: a superseded or skipped card says so in one line.
      const hp = R.current.handoffPending; R.current.handoffPending = null;
      const hpOk = Boolean(hp && !down && !ctrl.signal.aborted && hp.text);
      if (hpOk && !planDone && R.current.suggestLine) {
        const line = R.current.suggestAsk?.line || '';
        R.current.suggestLine = null; R.current.suggestAsk = null;
        say(handoffSupersededNote(hp.h, line), 'dim');
      }
      const newOffer = Boolean(R.current.suggestLine) || planDone || (hpOk && !planDone);
      flushSuggestion();
      if (hpOk && planDone) say(handoffSkippedNote(hp.h), 'dim');
      else if (hpOk) {
        const hs = (R.current.handoffStreak ??= createHandoffStreak()).offered(hp.h.from);
        if (hs.escalate) { R.current.handoffAsk = { ...hp, at: Date.now(), bigger: true, count: hs.count }; say(handoffBiggerAskText(hp.h, hs.count), 'ask'); } // same agent, 2+ turns in a row: offer to move the window
        else { R.current.handoffAsk = { ...hp, at: Date.now() }; say(handoffAskText(hp.h, hp.text, cols), 'ask'); }
      }
      if (!hpOk && !down && !ctrl.signal.aborted && !R.current.handoffTurn) R.current.handoffStreak?.clear(); // a turn with no suggestion breaks the streak
      if (planDone) { R.current.planAsk = { at: Date.now() }; ask('Run this plan now?', { who: askerName(), action: `switch to /mode ask and send "${PLAN_GO}"` }); }
      if (R.current.pendingAttach && !S.current.turn) { const a = R.current.pendingAttach; R.current.pendingAttach = null; command(`/attach ${a}`); }
      const ra = R.current.reask; R.current.reask = null; // y/N/c: the chat about an ask is over: the same ask again, fresh window
      if (ra && !newOffer && askOpen()) { touchAsks(); if (ra.redo) ra.redo(); else say(ra.text, 'ask'); }
    }
    return down ? { down: true } : undefined;
  }

  React.useEffect(() => {
    if (R.current.sleep && R.current.sleep.wakeAt == null && S.current.approvals.length) wakeDragon(); // an approval always wakes it
    const s = S.current;
    if (!s.turn && s.autoDrain && s.pending.length) {
      const next = s.pending[0];
      dispatch({ type: 'queue.shift' });
      runQueued(next.text);
    }
  });

  // A queued or steered draft that is a slash command runs as that command when its turn comes; it is never sent as chat.
  function runQueued(text, { checked = false } = {}) {
    if (text.startsWith('/') && !text.includes('\n')) { command(text); return; }
    const stray = checked ? null : strayCardAnswer(text, commandNames()); // TUI-INPUT: "n/help" = a card answer that leaked into the composer
    if (stray) { R.current.strayAsk = { text, command: stray.command, at: Date.now() }; ask(strayQuestion(stray)); return; }
    dispatch({ type: 'user', text, queued: true });
    runTurn(text, { queued: true });
  }

  function echoCmd(text) { // a command the human typed (or confirmed): shown like any prompt line, before its output
    const e = echoLine(text, { cols });
    dispatch({ type: 'user', text: e.shown, full: e.full, echo: true });
  }

  // PRESENCE (owner 2026-10-16): /afk and /sleep tell the server, so sessions and LLMs know you are not at this
  // terminal (approvals still queue; nothing is approved). /back or any typed turn marks you present.
  async function setPresence(state, note) {
    if (!api.setPresence) return { ok: true, local: true }; // demo / offline: the local mark is all there is
    try { return await api.setPresence(state, { note: note || undefined, slots: where.current.slot ? [where.current.slot] : undefined }); }
    catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
  }
  const presenceFail = (r) => say(`Sessions can't see that (${r.status ? `HTTP ${r.status}` : r.message || 'failed'}): this window still collects for /back, but other sessions do not know.`, 'warn');
  function markPresent(action = 'chat') {
    if (/^\/(afk|sleep|back|away)(\s|$)/.test(String(action).replace(/^slash /, ''))) return;
    if (AWAY.current.afk) { // this window set the flag: a typed turn here is the owner back (explicit, as before)
      AWAY.current.afk = null;
      setPresence('present').then((r) => { if (!r.ok) presenceFail(r); }, () => {});
      return;
    }
    // PRESENCE (owner 2026-10-19): a window that never set the flag (restarted TUI) still clears the server's stale one,
    // but only from a real terminal (api.noteActivity is a no-op for --print, pipes and proof runs). Welcome shows once.
    if (!api.noteActivity) return;
    api.noteActivity(action).then((r) => {
      if (r?.welcome?.away_text && !AWAY.current.welcomed) { AWAY.current.welcomed = true; say(`✔ Welcome back, you were away ${r.welcome.away_text}`, 'ok'); }
    }, () => {});
  }
  function submit(text) {
    touchSeen();
    markPresent(/^\//.test(text.trim()) ? `slash ${text.trim().split(/\s+/)[0]}` : 'chat');
    dispatch({ type: 'user', text });
    const tip = intentHint(text); // a hint only: the turn still goes to the model
    if (tip) say(tip);
    const panel = intentPanel(text); // the same panel as the command, from local facts, above the answer
    if (panel) showPanel(panel, { local: true });
    remember(text);
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
  async function agentsPicker(filter) {
    if (!api.agents) return say('Agents are not available in this mode.', 'warn');
    let list;
    try { list = await api.agents(); } catch (e) { return say(`Couldn't check agents: ${listFailure(e, profile)}`, 'warn'); }
    const rows = filterAgents(list, filter);
    if (!rows.length) return say(filter ? `No agent matches "${filter}". /agents list shows them all.` : 'No agents found.', 'warn');
    PK.current.open({ title: filter ? `Agents matching "${filter}"` : 'Agents', rows: rows.map(agentPickerRow), hint: '↑↓ select · Enter show card · Esc cancel', onPick: (_, i) => command(`/agents ${rows[i].agent_id}`) });
    return undefined;
  }
  async function agentTools(name) {
    if (!api.objects?.agent) return say('Object views are not available in this mode.', 'warn');
    let r;
    try { r = await api.objects.agent(name); } catch (e) { return say(`agent: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}`, 'warn'); }
    if (r?.error) return say(clip(r.error, cols - 4), r.tone || 'warn');
    for (const [t, tone] of toolLines(r.data)) say(clip(t, cols - 4), tone === 'plain' ? undefined : tone);
    return undefined;
  }
  function showWhich(arg) {
    const sl = where.current.slot || null;
    const r = whichReply(arg, {
      profile, agentLogin, org: R.current.orgName ?? org ?? null, agent: SN.current.agent || where.current.agent,
      hat: S.current.ctx.hat, model: modelText(S.current.ctx, MC.current),
      slot: SN.current.slotTarget ? `${SN.current.slotTarget} (chatting)` : sl, slotLive: Boolean(sl && SC.current.listener?.state?.().connected),
      conversationId: S.current.ctx.conversationId, sessionName: SN.current.name
    });
    if (r.error) return say(r.error, 'warn');
    if (r.rows.length === 1) return say(`${r.rows[0][0]}: ${r.rows[0][1]}`);
    return help([{ kind: 'head', text: 'Which' }, ...r.rows.map(([key, text]) => ({ kind: 'row', key, text }))]);
  }
  async function showPanel(cmd, { local = false } = {}) {
    const base = { ctx: S.current.ctx, choice: MC.current, agent: SN.current.agent || where.current.agent, conversationId: S.current.ctx.conversationId };
    if (cmd === '/cost') return help(costModel(LG.current));
    if (cmd === '/status') {
      let hl = R.current.lastHealth || null;
      if (!local && api.health) { hl = await api.health(8000); R.current.lastHealth = hl; }
      return help(statusModel({ ...base, profile, org: orgShown(), serverUrl: api.serverUrl?.() || hl?.url || null, health: hl, slot: where.current.slot, sessionName: SN.current.name, version, local: local && !hl }));
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
      return help(contextModel({ ...base, server, serverError, tokens: LG.current.conversationTokens(S.current.ctx.conversationId), rules, rulesOn: R.current.rulesOn !== false, skills, memory, screen: { on: SCX.current.on, last: R.current.screenSent || null } }));
    }
    return undefined;
  }
  /** gh #1157: a resume that meets a restarting collector says one calm line and retries with backoff (about 2 min); past the cap it rethrows marked gaveUp. */
  async function reconnecting(fn, st = {}) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!isResumeRetryable(e) || R.current.closed) throw e;
        if (i >= resumeRetryDelays.length) { if (e && typeof e === 'object') e.reconnectGaveUp = true; throw e; }
        if (!st.noted) { st.noted = true; say(RESUME_RECONNECTING, 'dim'); }
        await new Promise(r => setTimeout(r, resumeRetryDelays[i]));
        if (R.current.closed) throw e;
      }
    }
  }
  function resumeGaveUp(id) { return say(`Quox server is still not answering after about 2 minutes. ${id ? `/resume ${id}` : '/resume'} to try again.`, 'warn'); }
  async function resumeTo(row, st = {}) {
    if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
    let turns;
    try { turns = await reconnecting(() => api.conversationTurns(row.id), st); } catch (e) { if (R.current.closed) return undefined; if (e?.reconnectGaveUp) return resumeGaveUp(row.id); if (e?.status === 404) return say('That conversation is not on the server any more (it keeps them 7 days).', 'warn'); return dispatch({ type: 'error', text: `resume: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); }
    const t = turnsToHistory(turns);
    dispatch({ type: 'ctx', ctx: { conversationId: row.id } });
    SN.current.name = loadNames(namesPath)[row.id]?.name || null; SN.current.saved = null;
    if (!t.total && SN.current.name) SN.current.saved = `${row.id}|${SN.current.name}`; // nothing found: do not re-stamp the saved name
    say(`Resumed "${clip(row.title, cols - 20)}"${row.agent ? ` with ${row.agent}` : ''}.`, 'ok');
    dispatch({ type: 'history.add', items: t.items, answers: t.answers });
    if (!t.total && agentLogin && row.byName) {
      const h = humanProfiles.find(x => x !== profile);
      return say(`${row.byName} was saved by another profile. Start with quox -p ${h || '<human profile>'} to resume it.`, 'warn');
    }
    say(t.total ? `Showing the last ${t.shown} of ${t.total} stored messages. Your next message continues this conversation.` : 'The server has no stored messages for it (it keeps them 7 days). Your next message continues it anyway.', 'dim');
    return reattachIfRunning(row.id);
  }
  async function resumeCmd(q) {
    if (!api.conversations || !api.conversationTurns) return say('Resume is not available in this mode.', 'warn');
    let rows; const st = {};
    try {
      const [list, index] = await reconnecting(() => Promise.all([api.conversations(30), api.sessionsIndex ? api.sessionsIndex().catch(() => null) : null]), st);
      rows = resumeRows(list, index, loadNames(namesPath));
    } catch (e) { if (R.current.closed) return undefined; if (e?.reconnectGaveUp) return resumeGaveUp(q ? String(q).trim() : null); return dispatch({ type: 'error', text: `resume: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); }
    if (q) {
      const m = matchConversation(rows, q);
      if (m.row) return resumeTo(m.row, st);
      if (!m.ambiguous) {
        // Beyond the last 30 listed: a full id, or an exact saved local name, resumes directly.
        const names = loadNames(namesPath); const want = String(q).trim();
        if (/^QXC_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(want)) return resumeTo({ id: want, title: names[want]?.name || want, agent: null }, st);
        const hit = pickNamed(names, want, profile);
        if (hit?.ambiguous) return say(`"${q}" matches ${hit.ambiguous.length} conversations (saved by different profiles): ${hit.ambiguous.map(x => x.slice(0, 12)).join(', ')}. Use more of the id.`, 'warn');
        if (hit) return resumeTo({ id: hit.id, title: hit.entry.name, agent: null, byName: want }, st);
      }
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
  function bangCommand(bang, { echoed = false } = {}) {
    if (bang.kind === 'reserved') return say('!! is reserved. Use ! followed by a command, e.g. !ls or !quox inbox list.', 'warn');
    if (bang.kind === 'empty') return say('Usage: !<command> runs it here, !quox <args> runs this quox as you. Output stays on your screen; /share sends it to Quox.', 'warn');
    let plan = { cmd: bang.cmd };
    if (bang.kind === 'quox') {
      plan = quoxArgv(bang.args, { profile });
      if (plan.refuse && !plan.tty) return say(plan.refuse, 'warn');
    }
    const cmd = bang.cmd;
    const timeoutMs = Number(env.QUOX_BANG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    if (!echoed) say(`$ ${cmd}`, 'accent');
    // BANG-TTY (owner 2026-10-16): a known interactive command or an interactive quox leaf gets the terminal
    if (plan.tty || needsTerminal(bang)) return bangHandOver(cmd, plan.tty || plan);
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
      if (ttyFailure(r)) { say(bangFooter(r, { timeoutMs }), 'warn'); return bangHandOver(cmd, plan); } // it wanted a terminal: retry handed over
      if (r.stdinNote) say(r.stdinNote, 'warn');
      say(bangFooter(r, { timeoutMs }), r.code === 0 && !r.timedOut && !r.killed ? 'ok' : 'warn');
      bump(n => n + 1);
    });
  }

  /** BANG-TTY: run a ! command with the terminal handed over (the run-request path: raw mode and mouse off, back after). */
  function bangHandOver(cmd, plan) {
    say('This needs a real terminal: handing it over. Quit it to come back.', 'dim');
    const hold = { run: { kill: () => {}, done: null }, cmd, handover: true };
    R.current.bang = hold; // nothing else starts in the gap before the hand-over
    setTimeout(() => {
      if (R.current.bang === hold) R.current.bang = null;
      if (R.current.closed || R.current.exiting) return;
      const target = plan.argv ? { file: process.execPath, args: plan.argv } : { cmd: plan.cmd ?? cmd };
      const r = handOverRun({ ...target, env, cwd: process.cwd(), stdout, setRawMode: isRawModeSupported ? setRawMode : null, spawn: runSpawn, resume: mouseResume() });
      transcript?.bang?.(cmd, r.error ? 'error' : (r.signal || r.code));
      say(runFooter(r), !r.error && !r.signal && r.code === 0 ? 'ok' : 'warn');
      bump(n => n + 1);
    }, runHandOverDelayMs);
    return undefined;
  }

  function cliSlashRun(hit) {
    if (hit.cls === 'never') return say(`${hit.display} will not run from here (credentials, install or other never-from-chat commands). Run it in your own terminal if you mean it.`, 'warn');
    const bang = { kind: 'quox', args: hit.args, cmd: hit.display };
    if (hit.cls === 'write') { R.current.cliAsk = { bang, at: Date.now() }; say(hit.display, 'accent'); return ask('Run it?', { action: hit.display, reason: 'This quox command writes.' }); }
    if (R.current.bang) return say('A command is still running. Ctrl+C stops it.', 'warn');
    say(`ran ${hit.display}`, 'dim');
    return bangCommand(bang);
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

  /** /update (owner 2026-10-16): the shared updater (core/selfUpdate.js) checks, the y answer hands the terminal to it. */
  async function updateCommand() {
    if (!onRestart) return say('Update is not available in this mode.', 'warn');
    if (S.current.turn) return say('A turn is running. Wait for it, then /update.', 'warn');
    if (R.current.updateChecking) return say('Already checking for updates…', 'dim');
    R.current.updateChecking = true;
    say('Checking for updates…', 'dim');
    let plan;
    try {
      const u = selfUpdate;
      plan = updater ? await updater.check() : await u.checkUpdate(u.detectInstall({}));
      const lines = u.updateLines(plan);
      const tone = !plan.ok || plan.refused ? 'warn' : plan.upToDate ? 'ok' : undefined;
      for (const l of lines) say(l.startsWith('  · ') ? clip(l, cols - 4) : l, tone); // a refusal or failure is said in full
      if (!plan.ok || plan.upToDate || plan.refused) return undefined;
      R.current.updateAsk = { plan, at: Date.now() };
      return say(u.updateAsk(plan), 'ask');
    } catch (e) {
      return say(`Could not check for updates: ${e?.message || e}`, 'warn');
    } finally { R.current.updateChecking = false; }
  }

  // PROFILE-SWITCH: an agent-login window that needs a person offers the human login (y switches, never automatic);
  // with no human login on this machine it offers `quox login -p <name>` as a run card instead.
  function offerSwitch() {
    const { profile: me, agentLogin: isAgent } = WHO.current;
    if (!isAgent) return undefined;
    const human = humanProfiles.find(x => x !== me && okProfileName(x));
    if (human) { R.current.profileAsk = { name: human, at: Date.now() }; return say(switchAskLine(me, human), 'ask'); }
    const cand = loginCandidates.find(x => x !== me && okProfileName(x)) || 'me';
    return offerLogin(cand, `This window is an agent login (${me}) and no human login is signed in on this machine.`);
  }
  function offerLogin(name, lead) {
    return armRun(loginRunRequest(name, `${lead} Sign ${name} in, then /profile ${name} switches this window to it.`, runNow()), { who: 'Quox', glyph: 'Ⓠ', text: '' });
  }
  /** Switch this window to `name`: in place when main can build its api (keeps everything), else /restart into -p name. */
  async function switchTo(name) {
    const me = WHO.current.profile;
    if (!okProfileName(name)) return say(`"${clip(String(name), 40)}" is not a profile name.`, 'warn');
    if (name === me) return say(`This window is already ${me}.`, 'dim');
    if (S.current.turn) return say('A turn is running. Wait for it (or press Esc), then switch.', 'warn');
    if (switchProfile && !where.current.slot) { // a held slot belongs to the old identity: the restart hand-over carries it properly
      say(`Switching this window to ${name}…`, 'dim');
      let r;
      try { r = await switchProfile(name, { org: api.windowOrgId?.() || null }); } catch (e) { r = { ok: false, reason: e?.message || 'failed' }; }
      if (r?.ok && r.api) {
        APX.current.live = r.api;
        const next = { profile: name, agentLogin: Boolean(r.agentLogin) };
        WHO.current = next; setWho(next);
        if (r.orgName !== undefined) R.current.orgName = r.orgName;
        R.current.notify = { fails: 0, authLost: false };
        dispatch({ type: 'notify', patch: { error: null } });
        refreshNotify(); refreshRoster();
        return say(`✔ Switched this window to ${name}. Same conversation${SN.current.agent ? `, still attached to ${SN.current.agent}` : ''}.${r.note ? ` ${r.note}` : ''}`, 'ok');
      }
      if (r?.reason === 'not_signed_in') return offerLogin(name, `${name} is not signed in on this machine.`);
      if (!onRestart) return say(`Could not switch to ${name} (${r?.reason || 'failed'}). Still ${me}.`, 'warn');
      say(`Could not switch in place (${r?.reason || 'failed'}). Restarting into ${name} instead.`, 'warn');
    } else if (!switchProfile && !humanProfiles.includes(name)) return offerLogin(name, `${name} is not a signed-in profile on this machine.`);
    if (!onRestart) return say(`Switching profile is not available in this mode. Quit and run: quox -p ${name}`, 'warn');
    return doRestart({ profile: name });
  }

  async function doRestart(extra = {}) {
    if (R.current.restarting) return say('Already restarting…', 'dim');
    R.current.restarting = true; stopCountdown();
    let target;
    if (restartCheck) { // never let go of the terminal for a quox that cannot start: say so and stay
      say('Checking the installed quox…', 'dim');
      const c = await restartCheck();
      if (!c.ok) { R.current.restarting = false; return say(`Could not restart: ${c.bin} did not start (${c.error}). Still in this client.`, 'warn'); }
      target = c.onPath || undefined;
    }
    say(`Restarting${S.current.ctx.conversationId ? ' into this conversation' : ''}…`, 'dim');
    onRestart({ conversationId: S.current.ctx.conversationId || null, name: SN.current.name || null, slot: where.current.slot || null, attach: SN.current.agent ? `agent:${SN.current.agent}` : (SN.current.slotTarget ? `slot:${SN.current.slotTarget}` : null), org: api.windowOrgId?.() || null, ...(MD.current === 'plan' ? { mode: 'plan' } : {}), bin: target, ...extra });
    return exit(30);
  }

  async function command(line) {
    if (/^\/\/(\s|$)/.test(line.trim())) line = line.trim().replace(/^\/\//, '/note');
    const [cmd0, arg] = line.trim().split(/\s+/);
    const cmd = cmd0 === '/agent' ? '/agents' : cmd0; // /agent is the same command
    if (!['/afk', '/sleep', '/back', '/away'].includes(cmd)) markPresent(`slash ${cmd}`); // PRESENCE: any slash command but /afk and /sleep is the owner being back
    if (cmd !== '/note' && cmd !== '/context') SCX.current.command(line.trim());
    if (cmd !== '/note') transcript?.command(/^\/(authenticate|authorise|authorize)$/.test(cmd) && !/^[\d,\s-]*$/.test(line.trim().replace(/^\S+\s*/, '')) ? cmd : line); // QUOXON-STEPUP: never record a stray argument that might be a PIN
    const restArg = line.trim().replace(/^\S+\s*/, '');
    touchSeen();
    if (TIPS.some(x => tryCommand(x) === cmd) && !TP.current.used.includes(cmd)) { TP.current.used = [...TP.current.used, cmd]; api.saveSetting?.('tipsUsed', TP.current.used); } // using a thing retires its tip
    let objArg = restArg;
    if (cmd === '/agents') { // list picker, tools list, or the card (agents.js: list/tools/show are verbs, never names)
      const p = parseAgentsArgs(restArg);
      if (p.mode === 'usage') return say(p.text, 'warn');
      if (p.mode === 'list') return agentsPicker(p.filter);
      if (p.mode === 'tools') return agentTools(p.name);
      objArg = p.name;
    }
    if (OBJECT_CMDS.has(cmd) && !(cmd === '/rules' && arg)) { // inline object views (objects/): a card into history, or an honest note
      const r = await runObjectCommand(cmd, objArg, { objects: api.objects, rules, rulesOn: R.current.rulesOn, items: [...S.current.history, ...S.current.blocks], conversationId: S.current.ctx?.conversationId });
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
        if (!devObserverOn()) return say(DEV_OBSERVER_REFUSAL, 'warn');
        if (!restArg) return say('Usage: /note <text>  (or // text). Nothing to note.', 'warn');
        if (!transcript?.note) return say('notes need dev transcripts on (touch ~/.config/quox/dev-transcripts)', 'warn');
        transcript.note(restArg.slice(0, 2000));
        return say('noted for the observer', 'dim');
      }
      case '/rename': {
        if (!restArg) return say(SN.current.name ? `Session name: ${SN.current.name}` : 'This session has no name. Use /rename <name>.');
        const n = cleanName(restArg);
        SN.current.name = n; SN.current.saved = null; bump(x => x + 1);
        if (where.current.slot && api.checkoutSlot) { // the slot's holder label follows the name, or this window would be locked out of its own slot
          const r = await api.checkoutSlot(where.current.slot, n, { take: true });
          if (!r.ok) return say(`Session named "${n}", but slot ${where.current.slot} still carries the old label: ${r.message}`, 'warn');
        }
        return say(`Session named "${n}".`, 'ok');
      }
      case '/challenge': return CH.current.run(restArg);
      case '/spawn': return SPN.current.run(restArg);
      case '/ask': // owner typed /ask hyperion <question> (2026-10-16): same as /say
      case '/say': { // QUOXON-MESH: straight to a slot, no model turn
        const m = /^(\S+)\s+([\s\S]*\S[\s\S]*)$/.exec(restArg || '');
        if (!m) return say('Usage: /say <slot>[,<slot>...] <text>', 'warn');
        const to = [...new Set(m[1].split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
        if (to.length < 2) return sendToSlot(to[0] || m[1].toLowerCase(), m[2].trim());
        // QUOXON-SAY-CC: one line to several slots; each copy names everyone it went to, so they know who else has it
        const slots = await Promise.all(to.map(t => canonSlot(t, { senders: true })));
        const head = `(to ${slots.join(', ')}) `;
        for (const sl of slots) await sendToSlot(sl, head + m[2].trim());
        return undefined;
      }
      case '/join': { const nm = roomName(restArg); if (!nm) return say('Usage: /join <slot>  (or #<slot>)', 'warn'); return joinRoom(nm); }
      case '/leave': { const nm = roomName(restArg); if (!nm) return say('Usage: /leave <slot>', 'warn'); return leaveRoom(nm); }
      case '/rooms': case '/groups': return showRooms();
      case '/broadcast': case '/page':
        return runBroadcast({ api, kind: cmd === '/page' ? 'page' : 'broadcast', arg: restArg, from: myLabel(), say, card: (m) => dispatch({ type: 'bcard', card: m }), isClosed: () => R.current.closed });
      case '/ack': return runAck({ api, arg: restArg, slot: where.current.slot || null, say });
      case '/send': { // QUOXON-MESH: a local text file into a slot (inline, 64 KB cap, secrets scrubbed on a yes)
        const m = /^(\S+)\s+(.+)$/.exec(restArg || '');
        if (!m) return say('Usage: /send <slot> <file>', 'warn');
        if (!api.slotSay) return say('Slots are not available in this mode.', 'warn');
        return sendFile(m[1].toLowerCase(), m[2]);
      }
      case '/slot': {
        if (!restArg) return say(where.current.slot ? `Slot: ${where.current.slot}` : 'No slot. Use /slot <name> to give this session an address.');
        if (/^log(\s+\d+)?$/.test(restArg.trim())) return slotLog(restArg.trim().split(/\s+/)[1]);
        if (/^(?:list|ls|help|all)$/i.test(restArg.trim())) return listSlots(/^all$/i.test(restArg.trim())); // owner 2026-10-15: "/slot help" must not check out a slot called help
        if (!api.checkoutSlot) return say('Slots are not available in this mode.', 'warn');
        const toks = restArg.split(/\s+/);
        const forceCreate = toks.includes('--create');
        const take = toks.includes('--take');
        let nm = toks.find(t => !t.startsWith('--')) || '';
        if (!nm) return say('Usage: /slot <name> [--create] [--take]', 'warn');
        if (!forceCreate) nm = await canonSlot(nm);
        if (!forceCreate && api.slots) { // a name that is not a real slot but is close to one is a typo, not a request to create
          let slots = null;
          try { slots = await api.slots(); } catch { slots = null; }
          if (Array.isArray(slots) && !slots.some(x => String(x.name) === nm)) {
            const near = await nearbyTargets(nm, slots);
            if (near.length) { // owner 2026-10-16: offer, don't instruct. The near misses stay as the line above the card.
              say(`Slot "${nm}" not found. Did you mean: ${near.join(', ')}?`, 'warn');
              R.current.slotCreateAsk = { nm, at: Date.now() };
              return say(slotCreateAskLine(nm), 'ask');
            }
          }
        }
        return takeSlot(nm, take);
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
        const slotList = Array.isArray(slots) ? slots : [];
        const slotKey = pt.kind === 'agent' ? null : uniqueSquash(pt.name, slotList.map(x => x.name));
        const slotRow = slotKey ? slotList.find(x => String(x.name) === slotKey) : null;
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
          const host = slotRow.holder_identity ? String(slotRow.holder_identity).replace(/^resident:/, '') : (slotRow.host_name || slotRow.hostname || null); // RESTORE-TUI: a named host from an older server row still shows
          const lbl = `slot ${slotRow.name}${host ? ` (${host})` : ''}`;
          const alt = both ? ` To pick the agent instead: /attach agent:${pt.name}` : '';
          if (!pt.rest) return say(`Attached to ${lbl}. Your next messages go to it. /detach returns to CommanderQ.${alt}`, 'ok');
          const r = await api.slotSay(slotRow.name, pt.rest, { from: myLabel(), fromSlot: where.current.slot || null });
          if (!r.ok) return say(`Attached to ${lbl}, but the message was not sent: ${r.message}`, 'warn');
          return say(`Attached to ${lbl}. Sent: ${pt.rest}${alt}`, 'ok');
        }
        SN.current.slotTarget = null;
        SN.current.agent = m.agent.id; where.current = { ...where.current, agent: m.agent.id }; bump(x => x + 1);
        const alt = both ? ` To pick the slot instead: /attach slot:${pt.name}` : '';
        say(`Attached to ${m.agent.id}. Your next turns go to it. /detach returns to CommanderQ.${alt}`, 'ok');
        if (pt.rest) { dispatch({ type: 'user', text: pt.rest }); remember(pt.rest); runTurn(pt.rest); }
        return undefined;
      }
      case '/peek': { // PEEK: the same lookup as `quox peek <id>`, in this window's org
        const pid = restArg.trim().split(/\s+/)[0] || '';
        if (!api.peek) return say('Peek is not available in this mode. In a terminal: quox peek <id>', 'warn');
        if (!pid) return say('Usage: /peek <id>. An envelope, inbox item, objective, workflow run, WARD receipt or agent id.', 'warn');
        let pr;
        try { pr = await api.peek(pid); } catch (e) { return say(`Peek failed: ${listFailure(e, profile)}`, 'warn'); }
        if (pr?.hit) return dispatch({ type: 'object', obj: { type: 'peek', data: pr } }); // a boxed card: the label column survives
        for (const l of peekIdLines(pr)) say(clip(l.text, cols - 4), l.tone === 'ok' ? undefined : l.tone || undefined);
        return undefined;
      }
      case '/aside': { // ASIDE: no tools, no conversation id; the answer is a separate read-only block
        const q = restArg.trim();
        if (!api.aside) return say('Asides are not available in this mode. In a terminal: quox aside "<question>"', 'warn');
        if (!q) return say('Usage: /aside <question>. A read-only side question: no tools, not added to this conversation.', 'warn');
        say('Asking on the side (read only, no tools)…', 'dim');
        let ar;
        try { ar = await api.aside(q, turnsFromItems([...S.current.history, ...S.current.blocks])); } catch (e) { return say(`Aside failed: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}. Nothing was changed.`, 'warn'); }
        dispatch({ type: 'note', text: asideNoteText(q, ar.text, ar), tone: 'aside' });
        return undefined;
      }
      case '/hosts': {
        if (/^add\b/i.test(restArg || '')) { for (const l of await hostLines()) say(l); return undefined; }
        say('To see the hosts your Quox knows: quox fleet hosts (in a terminal).');
        return say('To add one, no AI needed: /hosts add');
      }
      case '/login': { // /login <name> for a profile that is already signed in: switch this window to it (PROFILE-SWITCH)
        const ln = restArg.trim().split(/\s+/)[0] || '';
        if (ln && ln !== profile && humanProfiles.includes(ln)) return switchTo(ln);
        LI.current.open(); return undefined;
      }
      case '/profile': {
        const pn = restArg.trim().split(/\s+/)[0] || '';
        if (pn && pn !== 'list') return switchTo(pn);
        const others = humanProfiles.filter(x => x !== profile);
        say(`This window is ${profile} (${agentLogin ? 'agent login' : 'human login'}).${others.length ? ` Switch with ${others.map(o => `/profile ${o}`).join(' or ')}.` : ' No other signed-in profile on this machine: /profile <name> offers to sign one in.'}`);
        // PROFILE-CHOOSER: one list of profiles and this login's orgs; a pick changes THIS window only.
        let orgList = [], orgNote = null;
        if (api.orgs) { try { orgList = await Promise.race([api.orgs(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 5000))]); } catch (e) { orgNote = `Orgs not listed: ${listFailure(e, profile)}`; } }
        const prow = profileChooserRows({ current: WHO.current.profile, humanProfiles, loginCandidates, orgs: orgList, orgId: R.current.orgId ?? api.orgId?.() ?? null });
        if (orgNote) say(orgNote, 'warn');
        if (prow.length < 2) return undefined;
        PK.current.open({ title: 'Switch profile or org (this window only)', rows: prow, sel: 0, hint: '↑↓ select · Enter switch (an org asks first) · Esc cancel', onPick: (row) => {
          const p = row?.pick || {};
          if (p.profile) return p.profile === WHO.current.profile ? say(`This window is already ${p.profile}.`, 'dim') : switchTo(p.profile);
          if (p.login) return switchTo(p.login);
          if (p.org) return p.org.id === (R.current.orgId ?? api.orgId?.() ?? null) ? say(`Already in ${p.org.name}.`, 'dim') : command(`/org switch ${p.org.slug || p.org.id}`);
          return undefined;
        } });
        return undefined;
      }
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
          else if (r.ok) { await adoptConnected(pv.id, { host: r.host, model: r.model }); await CN.current.askConsent(pv.type); }
          return undefined;
        }
        if (pv?.url) { // B3: Ollama takes a URL, probed and saved server side
          { const u = parseOllamaArg(restArg.replace(/^\S+\s*/, '')).url; if (u) say(`Checking ${u} from the server…`); }
          const r = await connectOllamaFlow(api, restArg.replace(/^\S+\s*/, ''));
          for (const [t, tone] of r.lines) say(t, tone)  /* Z2H-R3: notes wrap; clipping cut the egress message at "localho…" */;
          R.current.lanOffer = r.lanOffer ? { ...r.lanOffer, providerId: 'ollama' } : null;
          if (r.privateAsk) CN.current.askPrivate(r.privateAsk, async (c) => { if (c.ok) await adoptConnected('ollama', { host: c.host, model: c.model }); }); // #1288: y/N for this one address
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
      case '/row': return RW.current.handle(restArg);
      case '/watch': return KC.current.watch(restArg);
      case '/automate': return KC.current.automate(restArg);
      case '/crystallize': return KC.current.crystallize(restArg);
      case '/undo': return UW.current.undo(restArg);
      case '/wish': return UW.current.wish(restArg);
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
      case '/workflow': case '/crystal': case '/memory': case '/proof': case '/reconcile': case '/fleet': case '/prove': case '/replay': return undefined; // answered above (runObjectCommand)
      case '/agent': case '/agents': return undefined; // answered above (picker, tools, card)
      case '/which': return showWhich(arg);
      case '/detach':
        SN.current.agent = null; SN.current.slotTarget = null; where.current = { ...where.current, agent: SN.current.baseAgent }; bump(x => x + 1);
        return say('Back to CommanderQ.');
      case '/sessions': {
        // SESSIONS (owner 2026-10-15): name and where first; ids only with `refs`.
        const flags = new Set(String(restArg || '').toLowerCase().split(/\s+/).filter(Boolean));
        if (api.sessionsIndex) {
          try {
            const lines = humanSessionLines(await api.sessionsIndex(), { localHost: osHostname(), names: loadNames(namesPath), all: flags.has('all'), refs: flags.has('refs') || flags.has('ids') });
            for (const l of lines) say(clip(l.text, cols - 4), l.tone);
          } catch (e) { dispatch({ type: 'error', text: `sessions: ${e.status ? `HTTP ${e.status}: ` : ''}${e.message}` }); }
          return undefined;
        }
        if (!api.conversations) return say('Sessions are not available in this mode.', 'warn');
        try {
          const rows = await api.conversations(); const names = loadNames(namesPath);
          if (!rows.length) return say('No recent conversations.');
          for (const r of rows) say(clip(`${names[r.id]?.name || r.title || '(untitled)'}  ${r.updated_at ? `· ${String(r.updated_at).slice(0, 16).replace('T', ' ')}` : ''}${flags.has('refs') ? `  · ${r.id}` : ''}`, cols - 4));
        } catch (e) { dispatch({ type: 'error', text: `sessions: ${e.message}` }); }
        return undefined;
      }
      case '/active': {
        const words = String(restArg || '').toLowerCase().split(/\s+/).filter(Boolean);
        const filter = words.find(w => ACTIVE_KINDS.includes(w)) || null;
        if (words.some(w => w !== 'all' && !ACTIVE_KINDS.includes(w))) return say('Usage: /active [sessions|slots|agents] [all]', 'warn');
        if (!api.sessionsIndex) return say('Active is not available in this mode.', 'warn');
        try {
          let unread = null; if (api.slots) { try { unread = new Map((await api.slots()).map((x) => [x.name, x.unread_count || 0])); } catch { /* the count is a nicety */ } }
          for (const l of activeRows(await api.sessionsIndex(), { filter, cols, unread })) say(l.text, l.tone); // TUI-UX: one wrapped row per session, never clipped
        } catch (e) { say(`active: ${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`, 'warn'); }
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
        if (arg === 'auto') { // /restart auto [on|off]: bare toggles
          const v = String(restArg.split(/\s+/)[1] || '').toLowerCase();
          if (v && v !== 'on' && v !== 'off') return say('Usage: /restart auto [on|off]', 'warn');
          const a = AR.current; a.on = v ? v === 'on' : !a.on;
          if (!a.on) { clearTimeout(a.timer); a.timer = null; }
          api.saveSetting?.('restartAuto', a.on); bump(n => n + 1);
          return say(a.on ? 'Auto-restart is on. When a newer quox is installed and you are idle, this client restarts into the same conversation.' : 'Auto-restart is off.', a.on ? 'accent' : 'dim');
        }
        if (!leaveArmed('restart')) return undefined;
        R.current.leaveAsk = null;
        return doRestart();
      }
      case '/update': return updateCommand();
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
      case '/context':
        if (arg === 'off' || arg === 'on') {
          SCX.current.on = arg === 'on';
          bump(n => n + 1);
          return say(arg === 'on' ? 'Terminal context on: each message carries what this screen shows (2 KB max, secrets masked).' : 'Terminal context off for this session: Quox no longer sees your roster, approvals, commands or notices.');
        }
        return showPanel('/context');
      case '/status': case '/cost': case '/usage':
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
      case '/whatsnew': {
        const tg = toggleArg(arg);
        if (tg) { api.saveSetting?.('whatsNewStartup', tg); return say(tg === 'on' ? "What's new will show at startup when there is something new." : "What's new is off at startup. /whatsnew still works any time; /whatsnew on turns it back on.", 'ok'); }
        const all = String(arg).trim().toLowerCase() === 'all';
        const st = api.settings?.() || {};
        const cs = unseenCommands({ registry: visibleRegistry(), seen: st.whatsNewSeen, all });
        if (cs.length) { say(`${all ? 'All commands' : 'New commands'} (${cs.length}):`); cs.forEach(e => say(`${e.usage ? e.usage.split(/\s+[\[<|]/)[0] : '/' + e.id}: ${e.desc}`)); }
        else say('No new commands since you last looked.');
        api.saveSetting?.('whatsNewSeen', seenAfter(REGISTRY));
        // QUOXON-WHATSNEW3: only entries newer than the last one shown (all: every entry), then mark them seen.
        const unseen = all ? listWhatsNew('all', whatsNewEntries).entries : unseenEntries(st.whatsNew, whatsNewEntries);
        const shown = all ? unseen : unseen.slice(0, LIST_DEFAULT);
        const entry = (e) => { say(`${e.title}: ${e.text}`); if (tryText(e)) say(`Try: ${tryText(e)}`); };
        say("What's new in Quox:");
        if (shown.length) { say(all ? `Every entry (${unseen.length}):` : `New since you last looked (${unseen.length}):`); shown.forEach(entry); if (unseen.length > shown.length) say(`${unseen.length - shown.length} more: /whatsnew all`); }
        else { const top = listWhatsNew('', whatsNewEntries).entries[0]; say('Nothing new since you last looked.'); if (top) say(`Latest: ${top.title}${tryText(top) ? ` (try ${tryText(top)})` : ''}. /whatsnew all lists every entry.`); }
        if (shown.length || !st.whatsNew?.id) api.saveSetting?.('whatsNew', seenRecord(version, whatsNewEntries)); return true; }
      case '/tips': { let plugins = []; try { plugins = (await api.installedPlugins?.()) || []; } catch { /* unreadable: plugin tips hidden */ }
        const r = tipsReply(arg, { mode: TP.current.mode, plugins });
        if (r.tips) { say(r.head); r.tips.forEach(t => dispatch({ type: 'tip', text: t.text, cmd: t.cmd })); r.tail.forEach(l => say(l)); return true; }
        r.lines.forEach((l, i) => say(l, i ? undefined : r.tone === 'plain' ? undefined : r.tone)); return true; }
      case '/tip-settings': {
        const r = tipSettingsReply(arg, TP.current.mode);
        if (r.mode) { TP.current.mode = r.mode; api.saveSetting?.('tips', r.mode); }
        return say(r.text, r.tone === 'plain' ? undefined : r.tone);
      }
      case '/welcome': { // replay the first screen: the Q art with the greeting text beside it, and (a real terminal, 40+ rows) the dragon greeting. No setup side effects: nothing is saved, no state is reset.
        dispatch({ type: 'introShow', text: introItem.text, cols: introItem.cols });
        if (motionOn && !mono() && (termRows(stdout) ?? 0) >= 40) { playDragon('greeting'); bump(n => n + 1); }
        return true; }
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
      case '/hat': { // quox#1183: change hats with no model turn. A normal hat switches now; a privileged one asks y/N.
        if (!api.hats || !api.bindHat) return say('Hat switching is not available in this mode.', 'warn');
        const R0 = R.current; const q = restArg.trim().replace(/^switch\b\s*/i, ''); // "/hat switch" is "/hat": the chooser
        const hatSub = q.split(/\s+/)[0].toLowerCase();
        if (hatSub === 'new' || hatSub === 'edit' || hatSub === 'delete') { // CUSTOM-HATS (owner 2026-10-17): own hats, walked one card at a time
          if (!api.createHat || !api.updateHat || !api.deleteHat) return say('Custom hats are not available in this mode.', 'warn');
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          return HW.current.start(hatSub, q.slice(hatSub.length).trim());
        }
        if (q === 'yes') {
          const t = R0.hatPending; R0.hatPending = null;
          if (!t) return say('Nothing to confirm. /hat <name> first.', 'warn');
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          let conv = S.current.ctx.conversationId;
          if (!conv) { conv = mintConversationId(randomUUID()); dispatch({ type: 'ctx', ctx: { conversationId: conv } }); }
          try { await api.bindHat(conv, t.id); } catch (e) { return say(`Hat not switched: ${e?.message || 'the server refused'}.`, 'warn'); }
          return say(`Hat switched: ${t.from || 'current'} → ${t.name}. Your next message runs on it.`, 'ok');
        }
        let hats, active = null;
        try { hats = await api.hats(); } catch (e) { return say(`Couldn't list hats: ${listFailure(e, profile)}`, 'warn'); }
        try { active = api.activeHat ? await api.activeHat(S.current.ctx.conversationId || null) : null; } catch { active = null; }
        if (!q || q === 'list') {
          if (!hats.length) return say('No hats on this server.', 'warn');
          const hw = Math.min(26, Math.max(4, ...hats.map(x => [...String(x.name || x.key)].length)));
          const hrows = hats.map(x => ({ key: `${x.key === active?.key ? '* ' : '  '}${String(x.name || x.key).padEnd(hw)}`, text: `${x.description || x.definition?.description || x.key}${hatIsPrivileged(x) ? '  (privileged: asks you first)' : ''}` }));
          PK.current.open({ title: 'Change hat for this conversation', rows: hrows, sel: Math.max(0, hats.findIndex(x => x.key === active?.key)), hint: '↑↓ select · Enter put it on · Esc cancel', onPick: (_, i) => command(`/hat ${hats[i].key}`) });
          return undefined;
        }
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        const m = matchHat(q, hats);
        if (m.ambiguous) return say(`"${q}" matches more than one hat: ${hatChoices(m.ambiguous)}. Be more specific.`, 'warn');
        if (!m.hat) return say(`No hat matches "${q}". Hats you can pick: ${hatChoices(hats) || 'none'}.`, 'warn');
        if (active?.key === m.hat.key) return say(`Already wearing the ${m.hat.name || m.hat.key} hat.`);
        R0.hatPending = { id: m.hat.id, key: m.hat.key, name: m.hat.name || m.hat.key, from: active?.name || null, at: Date.now() };
        if (!hatIsPrivileged(m.hat)) return command('/hat yes'); // the person typed it: that is the authorization
        return ask(`Put on the ${R0.hatPending.name} hat?`, { action: `/hat ${m.hat.key}`, reason: 'It is a privileged hat: its tools can change real systems.' });
      }
      case '/org': {
        if (!api.orgs) return say('Org switching is not available in this mode.', 'warn');
        const R0 = R.current, curId = R0.orgId ?? api.orgId?.() ?? null;
        const sub = (restArg.match(/^(\S+)\s*(.*)$/) || [])[1] || '';
        const query = (restArg.match(/^\S+\s+(.*)$/) || [])[1]?.trim() || '';
        let list;
        try { list = await api.orgs(); } catch (e) { return say(`Couldn't list your orgs: ${listFailure(e, profile)}`, 'warn'); }
        if (!sub || sub === 'list' || (sub === 'switch' && !query)) { // a bare /org switch offers the chooser, never a Usage line
          if (!list.length) return say('No orgs returned for this login.', 'warn');
          const orows = orgRows(list);
          const ow = Math.min(30, Math.max(4, ...orows.map(x => [...x.name].length)));
          PK.current.open({ title: 'Move this session to an org', rows: orows.map(x => ({ key: `${x.id === curId ? '* ' : '  '}${x.name.padEnd(ow)}`, text: `${x.slug || x.id}${x.role ? `  (${x.role})` : ''}` })), sel: Math.max(0, orows.findIndex(x => x.id === curId)), hint: '↑↓ select · Enter switch (you confirm first) · Esc cancel', onPick: (_, i) => (orows[i].id === curId ? say(`Already in ${orows[i].name}.`) : command(`/org switch ${orows[i].slug || orows[i].id}`)) });
          return undefined;
        }
        if (sub === 'yes') {
          const t = R0.orgPending; R0.orgPending = null;
          if (!t) return say('Nothing to confirm. /org switch <name> first.', 'warn');
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          if (!api.switchOrg) return say('Org switching is not available in this mode.', 'warn');
          let done;
          try { done = await api.switchOrg(t.id); } catch (e) { return say(`Not switched. ${e?.message || 'The server refused.'} You are still in ${R0.orgName ?? org ?? 'the same org'}.`, 'warn'); }
          R0.prevOrg = curId ? { id: curId, name: R0.orgName ?? org ?? curId } : null; // /org back returns here
          R0.orgId = done.id; R0.orgName = done.name;
          dispatch({ type: 'ctx', ctx: { conversationId: null } });
          SN.current.name = null; SN.current.saved = null;
          dispatch({ type: 'history.reset' });
          if (stdout?.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H');
          setEpoch(e => e + 1); bump(n => n + 1);
          return say(`Switched to ${done.name}. New conversation in that org.`, 'ok');
        }
        if (sub === 'back' || sub === '-') { // owner 2026-10-15 "switch back": no "type /org switch <the org you were in>"
          const p = R0.prevOrg;
          if (!p) return say('No previous org in this session yet. /org lists yours.', 'warn');
          if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
          R0.orgPending = { id: p.id, name: p.name, at: Date.now() };
          if (R.current.preConfirmed === 'org') { R.current.preConfirmed = null; return command('/org yes'); }
          return ask(`Switch back to ${p.name}?`, { action: `/org switch ${p.id} (${p.name})`, reason: 'This starts a new conversation in that org.' });
        }
        if (sub !== 'switch') return say('Usage: /org, /org switch <name or id>, or /org back', 'warn');
        if (!query) return say('Usage: /org switch <name or id>. /org lists them.', 'warn');
        if (S.current.turn) return say('Wait for the current turn or press Esc first.', 'warn');
        const m = matchOrg(query, list);
        if (m.ambiguous) return say(`"${query}" matches more than one: ${m.ambiguous.map(o => o.name).join(', ')}. Be more specific.`, 'warn');
        if (!m.org) return say(`No org of yours matches "${query}". /org lists them.`, 'warn');
        if (m.org.id === curId) return say(`Already in ${m.org.name}.`);
        R0.orgPending = { id: m.org.id, name: m.org.name, at: Date.now() };
        // Already said yes to the suggested "/org switch X? y/N": one confirmation, not two (owner 2026-10-15).
        if (R.current.preConfirmed === 'org') { R.current.preConfirmed = null; return command('/org yes'); }
        return ask(`Switch to ${m.org.name}?`, { action: `/org switch ${m.org.id} (${m.org.name})`, reason: 'This starts a new conversation in that org.' });
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
      case '/vm': {
        if (!api.vm) return say('/vm is not available in this mode.', 'warn');
        if (!restArg) return say('Usage: /vm <list|info|doctor|start|stop|reboot|shutdown|snapshot|pool|node> <target> [args]', 'warn');
        try {
          const r = await api.vm(restArg.split(/\s+/));
          for (const l of r.lines) say(l, r.tone || undefined);
        } catch (e) { dispatch({ type: 'error', text: `vm: ${e?.status ? `HTTP ${e.status} ` : ''}${e?.message || 'failed'}` }); }
        return undefined;
      }
      case '/hyperion': {
        if (!api.hyperion) return say('/hyperion is not available in this mode.', 'warn');
        try {
          const r = await api.hyperion();
          for (const l of r.lines) say(l, r.tone || undefined);
        } catch (e) { dispatch({ type: 'error', text: `hyperion: ${e?.status ? `HTTP ${e.status} ` : ''}${e?.message || 'failed'}` }); }
        return undefined;
      }
      case '/sitrep': {
        if (!api.sitrep) return say('/sitrep is not available in this mode.', 'warn');
        const r = await api.sitrep();
        return dispatch({ type: 'object', obj: { type: 'sitrep', data: sitrepData(r.situation, r.approvals) } });
      }
      case '/afk': { // owner 2026-10-15: "/afk need a break, keep my requests organised for my return"
        const at = Date.now(); AWAY.current.last = at; AWAY.current.afk = { at, note: restArg || '' };
        try { away?.write?.(profile, at); } catch { /* the in-memory mark still works for this window */ }
        say(`Away from ${new Date(at).toISOString().slice(11, 16)} UTC${restArg ? ` (${clip(restArg, 80)})` : ''}. Approvals and messages keep collecting; when you're back, /back shows everything since, grouped.`, 'ok');
        const pr = await setPresence('away', restArg);
        if (!pr.ok) presenceFail(pr);
        else if (!pr.local) say(`Sessions now see: ${pr.notice || 'you are away'}. Nothing is approved while you are away; /back or any message marks you present.`, 'dim');
        return undefined;
      }
      case '/back': { // PRESENCE: present on the server too, then the digest
        AWAY.current.afk = null;
        const pr = await setPresence('present');
        if (!pr.ok) presenceFail(pr);
        return command('/away');
      }
      case '/observe': { // owner 2026-10-16: a note to the observer (the QUOXON session watching this window)
        if (!devObserverOn()) return say(DEV_OBSERVER_REFUSAL, 'warn');
        if (!restArg.trim()) return say('Usage: /observe <text>  (posts into the quoxon slot, for the session that watches your window)', 'warn');
        if (!api.slotSay) return say('Slots are not available in this mode.', 'warn');
        const r = await api.slotSay('quoxon', restArg.trim(), { from: myLabel(), fast: true, fromSlot: where.current.slot || null });
        if (!r.ok) return say(`observe: not delivered (${r.message})`, 'warn');
        return say('✔ noted for the observer (quoxon)', 'ok');
      }
      case '/poke': case '/wake': case '/nudge': case '/ping': case '/slap': case '/awaken': { // owner tried all five on 2026-10-15
        const m = parsePokeArgs(restArg); // FORCE-WAKE: --force is a no-op, never page text
        if (!m) return say(`Usage: ${cmd} <slot or session> [text]  (an urgent page; they are asked to acknowledge, and an idle session is woken to read it, even with an unsent draft, which is set aside and put back)`, 'warn');
        return command(`/page ${m.slot} ${m.text ? m.text.trim() : `are you there? (${cmd.slice(1)} from ${myLabel() || 'the owner'})`}`);
      }
      case '/away': {
        if (!api.away) return say('/away is not available in this mode.', 'warn');
        const p = parseSince(restArg, { lastSeen: AWAY.current.last });
        if (!p.ok) return say(p.error, 'warn');
        try { dispatch({ type: 'object', obj: { type: 'away', data: await api.away(p.since) } }); }
        catch (e) { say(`away: could not read the digest (${e?.status ? `HTTP ${e.status}` : e?.message || 'failed'}). Nothing is assumed.`, 'warn'); }
        return undefined;
      }
      case '/mind': {
        if (!api.mind) return say('/mind is not available in this mode.', 'warn');
        if (MIND_HELP_ARGS.has(restArg.toLowerCase())) { for (const [text, tone] of mindHelpLines()) say(text, tone); return undefined; }
        try { for (const [text, tone] of mindLines(await api.mind(restArg || undefined))) say(text, tone); }
        catch (e) {
          const isCommand = (n) => REGISTRY.some(x => x.kind === 'command' && x.status === 'active' && x.id === n);
          for (const [text, tone] of mindErrorLines(e, restArg, { isCommand })) tone === 'error' ? dispatch({ type: 'error', text }) : say(text, tone);
        }
        return undefined;
      }
      case '/observer': case '/observers': case '/lucid': {
        if (!api.observers) return say('Observers are not available in this mode.', 'warn');
        try { for (const [text, tone] of observerLines(await api.observers(), cols)) say(text, tone); }
        catch (e) { dispatch({ type: 'error', text: `observers: ${e.message}` }); }
        return undefined;
      }
      case '/approvals': {
        if (/^help$/i.test(restArg.trim())) { // the syntax lives here, not above every list
          say(`${mark('/approve N')} ${mark('/deny N <reason>')} ${mark('/approvals N')} detail ${mark('/approvals walkthrough')} one at a time ${mark('/approvals mine|agents|old|<agent>')} filter (privileged: ${mark('/approve N confirm')})`);
          return undefined;
        }
        let items;
        try { items = await api.approvals(); }
        catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}). That does not mean nothing is waiting; try again or run: quox inbox list` }); }
        let stats = null; let statsErr = null;
        if (api.approvalStats) { try { stats = await api.approvalStats(); } catch (e) { statsErr = e.message; } }
        const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
        const groups = groupApprovals(items, { conversationId: S.current.ctx.conversationId, cardIds });
        const flat = groups.flatMap(g => g.items.map(x => x.item));
        dispatch({ type: 'inbox', items: flat });
        R.current.shownIds = flat.map(x => x.id);
        dispatch({ type: 'notify', patch: { approvals: flat.length, error: null } });
        const hidden = stats ? Math.max(0, stats.awaiting - flat.length) : 0;
        if (!flat.length && !hidden && !statsErr) return say('Nothing waiting for you.', 'ok');
        const fArg = restArg.trim();
        if (/^walkthrough$/i.test(fArg)) return walkStart(flat, { fresh: true });
        if (/^\d+$/.test(fArg)) { // /approvals N: everything the item carries
          const it = flat[Number(fArg) - 1];
          if (!it) return say(`No such item: [${fArg}] (${flat.length} listed).`, 'warn');
          for (const l of approvalDetail(it, Number(fArg))) say(l);
          say(' ');
          if (isDecision(it)) { R.current.focusedDecision = { n: Number(fArg), id: it.id, at: Date.now() }; return say(`${mark(`/answer ${fArg} ${it.payload.options.map(o => o.key).join('|')}`)} with an optional "note", or ${mark(`/deny ${fArg} <reason>`)}`, 'warn'); }
          return say(`${mark(`/approve ${fArg}`)} or ${mark(`/deny ${fArg} <reason>`)}`, 'warn');
        }
        const keep = filterPredicate(fArg || null, { userId: api.userId?.() || null, conversationId: S.current.ctx.conversationId });
        const shown = new Set(flat.filter(keep));
        const nDec = flat.filter(isDecision).length;
        const cardFirst = nDec > 0 && !fArg; // plain /approvals opens straight on the one-at-a-time card
        if (cardFirst) say(`${nDec} question${nDec === 1 ? '' : 's'} waiting for you.`, 'warn');
        else if (nDec) { const k1 = flat.findIndex(isDecision) + 1; const ks = flat[k1 - 1].payload.options.map(o => o.key).join('|'); say(`${nDec} question${nDec === 1 ? '' : 's'} waiting for you; I take them one at a time below${nDec > 1 ? ' (/yestoall answers every yes/no at once)' : ''}. Typed form: /answer ${k1} ${ks}, with an optional "note".`, 'dim'); }
        if (cardFirst && flat.length > nDec) say(`${flat.length - nDec} other approval${flat.length - nDec === 1 ? '' : 's'} wait${flat.length - nDec === 1 ? 's' : ''} too: ${mark('/approve N')} or ${mark('/deny N <reason>')}; ${mark('/approvals help')} has the syntax.`, 'dim'); // plain /approvals: the walk takes the questions; the syntax wall lives in /approvals help
        else if (flat.length > nDec || (fArg && !cardFirst)) say(`${flat.length} waiting${fArg ? `, ${shown.size} match "${fArg}"` : ''}. ${mark('/approve N')} ${mark('/deny N <reason>')} ${mark('/approvals N')} detail ${mark('/approvals mine|agents|old|<agent>')} (privileged: ${mark('/approve N confirm')}):`, 'warn');
        let n = 0;
        for (const g of groups) {
          const rows = g.items.map(x => ({ x, k: ++n })).filter(r => shown.has(r.x.item) && !cardFirst);
          if (!rows.length) continue;
          say(' ');
          say(`${g.group}:`, 'warn');
          for (const r of rows) { say(approvalRow(r.x.item, r.k, { cols: cols - 2 })); if (isDecision(r.x.item)) say(' '); }
        }
        if (flat.length && !shown.size) say(`Nothing matches "${fArg}".`, 'warn');
        if (flat.length) say(' ');
        if (nDec && !fArg) walkStart(flat, { fresh: true, quiet: true });
        if (hidden) {
          const others = humanProfiles.filter(h => h !== profile);
          const whoTxt = agentLogin ? `${profile} (an agent login), so it can't approve these` : `${profile}, which cannot act on these`;
          say(`${hidden} more approval${hidden === 1 ? ' is' : 's are'} waiting org-wide. This window is signed in as ${whoTxt}.${others.length ? ` Quit and run: quox -p ${others[0]}${others.length > 1 ? ` (human profiles found: ${others.join(', ')})` : ''}. Or approve in the dashboard Approvals page, or: quox inbox -p ${others[0]} respond <id> --action approve|reject` : ' Approve in the dashboard Approvals page.'}`, 'warn');
          if (agentLogin) offerSwitch(); // one keypress instead of quit and relaunch
        }
        if (statsErr) say(`Could not check the org-wide approval count (${statsErr}); the list above is what the inbox returned.`, 'warn');
        return undefined;
      }
      case '/feedback': { // owner 2026-10-15: /feedback goes to the quox.ai feedback API (/gripe stays GitHub)
        if (!api.feedback) return say('/feedback is not available in this mode.', 'warn');
        const fb = feedbackPayload(restArg, version);
        if (!fb) return say('Usage: /feedback <text>  (5 to about 4900 characters; goes to the Quox team at quox.ai)', 'warn');
        for (const l of feedbackPreview(fb)) say(clip(l, cols - 4), 'dim');
        R.current.feedbackAsk = { payload: fb, at: Date.now() };
        return ask('Send it?', { action: 'send the feedback above to https://api.quox.ai/api/feedback (the Quox team)' });
      }
      case '/mouse': {
        const v = arg.trim().toLowerCase();
        if (!v) return say(`Mouse is ${MO.current.on ? 'on' : 'off'}. /mouse ${MO.current.on ? 'off' : 'on'} to change it.`);
        if (v !== 'on' && v !== 'off') return say('Usage: /mouse on|off', 'warn');
        MO.current.on = v === 'on'; MO.current.drag = null;
        api.saveSetting?.('mouse', v);
        mouseTerm(MO.current.on);
        return say(MO.current.on ? mouseOnNote() : 'Mouse off. Your terminal selects, copies and scrolls as usual again.', MO.current.on ? undefined : 'ok');
      }
      case '/r': case '/reply': {
        if (!R.current.lastSender) return say('Nobody has messaged you in this window yet. /say <slot> <text> starts one.', 'warn');
        if (!restArg) return say(`Usage: /r <text>  (replies to ${R.current.lastSender})`, 'warn');
        return sendToSlot(R.current.lastSender.toLowerCase(), restArg.trim());
      }
      // Dragon verbs (owner 2026-10-15), only where an existing command does exactly that; the rest are an idea, not code.
      case '/mode': { // PLAN MODE (owner 2026-10-16): /mode [ask|plan]; auto is planned, not built
        if (!restArg.trim()) { // same arrow-key chooser as /model; /mode -h still explains
          const cur = normMode(MD.current);
          PK.current.open({ title: 'Mode for this window', rows: MODE_ROWS.map(x => ({ key: `${x.id === cur ? '* ' : '  '}${x.id}`, text: x.text })), sel: MODES.indexOf(cur), hint: '↑↓ select · Enter use · Esc cancel', onPick: (_, i) => command(`/mode ${MODES[i]}`) });
          return undefined;
        }
        const m = modeReply(restArg, MD.current);
        if (m.mode) { MD.current = m.mode; R.current.planAsk = null; bump(n => n + 1); }
        return say(m.text, m.tone || undefined);
      }
      case '/sleep': { // owner typed /sleep first (2026-10-16); it now MEANS sleeping: sessions stop waiting on approvals
        const at = Date.now(); AWAY.current.last = at; AWAY.current.afk = { at, note: 'sleeping' };
        try { away?.write?.(profile, at); } catch { /* the in-memory mark still works for this window */ }
        const pr = await setPresence('sleeping');
        if (!pr.ok) presenceFail(pr);
        return command('/dragon sleep');
      }
      case '/roar': return command(`/broadcast${restArg ? ` ${restArg}` : ''}`);
      case '/soar': return command(`/fleet${restArg ? ` ${restArg}` : ''}`);
      case '/summon': return command(`/attach${restArg ? ` ${restArg}` : ''}`);
      case '/huh': return command(`/dragon explain${restArg ? ` ${restArg}` : ''}`); // owner 2026-10-15: shortcut for /dragon explain
      case '/slots': return listSlots(/^all$/i.test(restArg.trim()));
      case '/mirror': {
        // The Mirror itself: this org's server-built Mirror, what CommanderQ is told every turn (not /mind).
        if (!api.mirror) return say('/mirror is not available in this mode.', 'warn');
        const view = /^agents?$/i.test(restArg.trim()) ? 'agents' : null;
        try { dispatch({ type: 'object', obj: { type: 'mirror', data: { ...(await api.mirror()), ...(view ? { view } : {}) } } }); }
        catch (e) { say(mirrorErrorNote(e), 'warn'); }
        return undefined;
      }
      case '/core': case '/health': case '/collector-health': return command('/status'); // owner reached for these first; /health and /core are the dashboard card above when the objects api is there
      case '/walkthrough': return command('/approvals walkthrough');
      case '/yestoall': return command(`/approve all${arg ? ` ${arg}` : ''}`); // owner 2026-10-15: alias of /approve all
      case '/authenticate': {
        if (/\d{4,}/.test(restArg)) return say('Never type your PIN after a command. It is asked for in a private card.', 'warn');
        await SUC.current.authenticate(); bump(n => n + 1); return undefined;
      }
      case '/override': {
        const res = await SUC.current.override(restArg);
        if (res?.override_id && res.enforced) R.current.override = { id: res.override_id, until: Date.parse(res.expires_at) || Date.now() + 300000 };
        return undefined;
      }
      case '/authorise': case '/authorize': {
        if (/\d{4,}/.test(restArg)) return say('Never type your PIN after a command. It is asked for in a private card.', 'warn');
        let authArg = restArg;
        if (!authArg.trim()) { // QUOXON-1191: bare /authorise picks the one item that needs a PIN; with several it lists them
          let li = S.current.inbox;
          if (!li.length) { try { li = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds: [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean) }).flatMap(g => g.items.map(x => x.item)); dispatch({ type: 'inbox', items: li }); } catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); } }
          const needs = li.map((x, k) => ((isDecision(x) ? x.payload.high_risk === true && x.payload.options.some(o => o.key === 'y') : (x.payload?.approval_context?.risk === 'high' || x.payload?.high_risk === true)) ? k + 1 : 0)).filter(Boolean);
          if (needs.length === 1) authArg = String(needs[0]);
          else return say(needs.length ? `${needs.length} items need your PIN, so say which: ${needs.map(k => mark(`/authorise ${k}`)).join(' ')}` : 'Usage: /authorise N  (approve item N with your PIN; list them with /approvals). Nothing waiting needs a PIN right now.', 'warn');
        }
        R.current.authorising = true; // /approve's answer() asks for the PIN first when there is no live step-up
        try { await command(`/approve ${authArg}`); } finally { R.current.authorising = false; }
        return undefined;
      }
      case '/answer': { // quox ask: pick an option of a decision a session asked
        const words = line.trim().split(/\s+/).slice(1);
        const fo = R.current.focusedDecision;
        const pa = parseAnswer(words, { focusN: fo && Date.now() - fo.at < 600000 ? fo.n : null, raw: line.trim().replace(/^\S+\s*/, '') });
        if (pa.bad) return say(`Usage: ${mark('/answer 3 b')} (item number, then the option letter), optionally with a note: ${mark('/answer 3 b "after Friday"')}. Several at once: ${mark('/answer 1 y 2 n')}. List them with ${mark('/approvals')}.`, 'warn');
        if (await listChanged()) return undefined;
        let list = S.current.inbox;
        if (!list.length || (pa.n ? !list[pa.n - 1] : true)) {
          try {
            const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
            list = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds }).flatMap(g => g.items.map(x => x.item));
            dispatch({ type: 'inbox', items: list });
          } catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); }
        }
        if (pa.ns) { // QUOXON-1191: /answer 1-5 y, /answer 1,3,4 y: validate all, ask the PIN once if any is high risk
          const keyOf = (k) => pa.keys?.[k] ?? pa.key; // QUOXON-1191b: pairs carry their own y|n per item
          if (pa.ns.some(k => !list[k - 1])) {
            try { list = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds: [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean) }).flatMap(g => g.items.map(x => x.item)); dispatch({ type: 'inbox', items: list }); }
            catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); }
          }
          if (pa.note && noteNeedsConfirm(pa.note) && !R.current.noteBypass) { // NOTE-CONFIRM: one card for the whole batch
            const base = pa.keys ? pa.ns.map(k => `${k} ${pa.keys[k]}`).join(' ') : `${pa.ns.join(',')} ${pa.key}`;
            noteCard({ walk: false, batch: true, count: pa.ns.length, cmd: base, key: pa.key, label: pa.keys ? [...new Set(Object.values(pa.keys))].join('/') : pa.key, note: pa.note });
            return undefined;
          }
          const bad = pa.ns.filter(k => !list[k - 1] || !isDecision(list[k - 1]) || !list[k - 1].payload.options.some(o => o.key === keyOf(k)));
          if (bad.length) return say(`Nothing sent. ${bad.map(k => `[${k}]`).join(' ')} ${bad.length === 1 ? 'is' : 'are'} not ${list.length ? `a decision with option "${bad.map(keyOf).filter((v, i, a2) => a2.indexOf(v) === i).join('/')}"` : 'listed'}. Use ${mark('/approvals')} to see the options.`, 'warn');
          const bulkAns = pa.ns.length > 1 && !pa.keys; // explicit per-item pairs (1 y 2 n) name each item and key themselves
          let walkAfter = null;
          const heldNs = bulkAns ? pa.ns.filter(k => keyOf(k) !== 'n' && isHeldFromBulk(list[k - 1])) : []; // a bulk yes never covers a risky ask
          if (heldNs.length) {
            pa.ns = pa.ns.filter(k => !heldNs.includes(k));
            say(`${heldNs.length} risky decision${heldNs.length === 1 ? '' : 's'} held back from the bulk yes (${[...new Set(heldNs.map(k => heldReason(list[k - 1])))].join(', ')}). I will take ${heldNs.length === 1 ? 'it' : 'them'} one at a time, with the full text, after the rest.`, 'warn');
            walkAfter = heldNs.map(k => list[k - 1]);
          }
          const items = pa.ns.map(k => list[k - 1]);
          const gate = pa.ns.some(k => keyOf(k) !== 'n' && list[k - 1].payload.high_risk === true);
          const askPin = async () => { const r = await SU.current.request({ scope: 'approve', orgId: api.orgId?.() || null, subject: { line1: `answer ${items.length} decisions ${[...new Set(pa.ns.map(keyOf))].join('/')}`, raisedBy: null, risk: 'high' } }); if (!r.ok) { const err = new Error(declinedText(r.reason)); err.stepUpDeclined = true; throw err; } };
          try { if (gate && !SU.current.token('approve')) await askPin(); }
          catch (e) { return say(`Not answered: ${e.message}. Nothing was sent.`, 'warn'); }
          const okIds = []; const failedK = [];
          for (const k of pa.ns) {
            const x = list[k - 1];
            const go = () => api.answerDecision(x.id, keyOf(k), { note: pa.note || null, stepUp: SU.current.headers('approve'), bulk: bulkAns });
            try {
              try { await go(); }
              catch (e) { if (!(e?.status === 403 && e?.body?.error === 'step_up_required')) throw e; SU.current.drop('approve'); await askPin(); await go(); }
              okIds.push(x.id); walkAnsweredIds().add(x.id);
              say(`✔ answered [${k}] ${x.payload.session || 'session'}: ${clip(x.title || x.id, Math.max(20, cols - 40))} -> (${keyOf(k)})`, 'ok');
              if (x.payload.slot && api.slotSay) await api.slotSay(String(x.payload.slot).toLowerCase(), `Your question "${clip(x.title, 80)}" was answered: ${keyOf(k)}. Read it with: quox ask status ${x.id}`, { from: myLabel() });
            } catch (e) { failedK.push(`[${k}] ${e?.status === 404 || e?.status === 400 ? 'already handled or expired' : e.message}`); if (e?.stepUpDeclined) break; }
          }
          if (failedK.length) say(`Not answered: ${failedK.join('; ')}`, 'warn');
          R.current.focusedDecision = null;
          dispatch({ type: 'inbox', items: list.filter(x => !okIds.includes(x.id)) });
          if (R.current.shownIds) R.current.shownIds = list.filter(x => !okIds.includes(x.id)).map(x => x.id);
          if (walkAfter) walkStart(walkAfter);
          return undefined;
        }
        if (!pa.n) { // no number: fine when exactly one decision is open
          const idx = list.map((x, k) => (isDecision(x) ? k + 1 : 0)).filter(Boolean);
          if (idx.length !== 1) return say(idx.length ? `${idx.length} decisions are open, so say which: ${idx.slice(0, 3).map(k => mark(`/answer ${k} ${list[k - 1].payload.options.map(o => o.key).join('|')}`)).join(' ')}` : 'No decision is waiting for an answer.', 'warn');
          pa.n = idx[0];
        }
        const it = list[pa.n - 1];
        if (!it) return say(`No such item: [${pa.n}] (${list.length} listed).`, 'warn');
        if (!isDecision(it)) return say(`[${pa.n}] is an approval, not a question. Use ${mark(`/approve ${pa.n}`)} or ${mark(`/deny ${pa.n} <reason>`)}.`, 'warn');
        if (!it.payload.options.some(o => o.key === pa.key)) return say(`[${pa.n}] has no option "${pa.key}". Options: ${it.payload.options.map(o => `(${o.key}) ${o.label}`).join(' ')}`, 'warn');
        if (pa.note && noteNeedsConfirm(pa.note) && !R.current.noteBypass) { noteCard({ walk: false, cmd: `${pa.n} ${pa.key}`, key: pa.key, label: it.payload.options.find(o => o.key === pa.key).label, note: pa.note, id: it.id }); return undefined; }
        say(`Answering: ${clip(it.title || it.id, Math.max(20, cols - 30))} → ${it.payload.options.find(o => o.key === pa.key).label} (${pa.key})${pa.note ? `, with your note (${pa.note.length} characters)` : ''}`, 'dim'); // DECISION-LABELS: say which question and which option BEFORE it is sent
        try { // QUOXON-1191: a yes to a high-risk ask needs the PIN: ask up front, or on the server's step_up_required, then retry once
          const gate = it.payload.high_risk === true && pa.key !== 'n';
          const subject = { line1: `answer ${String(it.title || "")}`, raisedBy: it.payload.session || null, risk: 'high' };
          const askPin = async () => { const r = await SU.current.request({ scope: 'approve', orgId: api.orgId?.() || null, subject }); if (!r.ok) { const err = new Error(declinedText(r.reason)); err.stepUpDeclined = true; throw err; } };
          if (gate && !SU.current.token('approve')) await askPin();
          const go = () => api.answerDecision(it.id, pa.key, { note: pa.note || null, stepUp: SU.current.headers('approve') });
          try { await go(); }
          catch (e) {
            if (!(e?.status === 403 && e?.body?.error === 'step_up_required')) throw e;
            SU.current.drop('approve'); await askPin(); await go();
          }
        }
        catch (e) {
          if (e?.stepUpDeclined) return say(R.current.walkSend ? `Not answered: ${e.message}.` : `Not answered: ${e.message}. Run ${mark(`/answer ${pa.n} ${pa.key}`)} again when you can confirm.`, 'warn'); // in a walkthrough the card says what to do next
          if (e?.status === 404 || e?.status === 400) { R.current.goneAsk = it.id; return say(`[${pa.n}] ${expiredText(it)}`, 'accent'); }
          return dispatch({ type: 'error', text: `answer: ${e.message}` });
        }
        say(' ');
        say(`✔ answered [${pa.n}] ${it.payload.session || 'session'}: ${clip(it.title || it.id, Math.max(20, cols - 40))} -> (${pa.key}) ${it.payload.options.find(o => o.key === pa.key).label}${pa.note ? ` (note: ${clip(pa.note, 40)})` : ''}`, 'ok');
        say(' ');
        R.current.lastAnswered = it.id; walkAnsweredIds().add(it.id);
        if (it.payload.slot && api.slotSay) { // WALK-FIXES: the answer is already recorded; the slot post never holds up the next card
          const slotNote = (m) => say(`Answer recorded; could not post it to slot ${it.payload.slot} (${m}). The asker gets it from: quox ask wait ${it.id}`, 'warn');
          const posting = Promise.resolve().then(() => api.slotSay(String(it.payload.slot).toLowerCase(), `Your question "${clip(it.title, 80)}" was answered: ${pa.key}${pa.note ? ` (${pa.note})` : ''}. Read it with: quox ask status ${it.id}`, { from: myLabel() })).then(r => { if (!r?.ok) slotNote(r?.message || 'no reply'); }, e => slotNote(e?.message || 'failed'));
          if (!R.current.walkSend) await posting;
        }
        R.current.focusedDecision = null;
        dispatch({ type: 'inbox', items: list.filter(x => x.id !== it.id) });
        if (R.current.shownIds) R.current.shownIds = list.filter(x => x.id !== it.id).map(x => x.id);
        return undefined;
      }
      case '/approve': case '/deny': {
        const verb = cmd === '/approve' ? 'approve' : 'reject';
        const words = line.trim().split(/\s+/).slice(1);
        const prs = cmd === '/approve' ? parsePairs(words) : null; // QUOXON-1191b: /approve 1 y 2 n, 1y 2n
        if (prs) {
          if (prs.bad) return say(`Could not read "${words.join(' ')}". Use each number once: ${mark('/approve 1 y 2 n')}.`, 'warn');
          let pl = S.current.inbox;
          if (!pl.length || prs.some(x => !pl[x.k - 1])) {
            try { pl = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds: [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean) }).flatMap(g => g.items.map(x => x.item)); dispatch({ type: 'inbox', items: pl }); }
            catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); }
          }
          const missingP = prs.filter(x => !pl[x.k - 1]);
          if (missingP.length) return say(`Nothing sent. ${missingP.map(x => `[${x.k}]`).join(' ')} ${missingP.length === 1 ? 'is' : 'are'} not listed (${pl.length} listed). Use ${mark('/approvals')}.`, 'warn');
          const decP = prs.filter(x => isDecision(pl[x.k - 1])); const plainP = prs.filter(x => !isDecision(pl[x.k - 1]));
          if (decP.length) await command(`/answer ${decP.map(x => `${x.k} ${x.key}`).join(' ')}`);
          for (const x of plainP) await command(x.key === 'y' ? `/approve ${x.k}` : `/deny ${x.k}`);
          return undefined;
        }
        const pd = parseDecision(words, verb, { raw: line.trim().replace(/^\S+\s*/, '') });
        const { confirm, all, agent, reason } = pd; const nums = pd.nums;
        const spec = words.filter(w => w !== 'confirm');
        const usage = `Usage: ${mark(`${cmd} N [N...]`)} | ${mark(`${cmd} 1,2`)}${verb === 'approve' ? ` | ${mark('/approve 1 y 2 n')}` : ''} | ${mark(`${cmd} 1-3`)} | ${mark(`${cmd} all`)} | ${mark(`${cmd} agent <name>`)}${verb === 'reject' ? `   (add a reason after the target: ${mark('/deny 2 wrong host')})` : ''}   (privileged ones need: ${mark(`${cmd} N confirm`)}). List them with ${mark('/approvals')}.`;
        if (pd.bad) return say(`${spec.length ? `Could not read "${spec.join(' ')}". ` : ''}${usage}`, 'warn');
        if (!all && !agent && nums.length && await listChanged()) return undefined;
        let list = S.current.inbox;
        if (!list.length || (!all && nums.some(k => !list[k - 1]))) { // never send the user back to /approvals: fetch the same list, in the same order, ourselves
          try {
            const cardIds = [...S.current.approvals, ...S.current.waiting].map(x => x.inboxItemId).filter(Boolean);
            list = groupApprovals(await api.approvals(), { conversationId: S.current.ctx.conversationId, cardIds }).flatMap(g => g.items.map(x => x.item));
            dispatch({ type: 'inbox', items: list });
          } catch (e) { return dispatch({ type: 'error', text: `Could not check inbox approvals (${e.message}); try again or run: quox inbox list` }); }
        }
        if (!list.length) return say('Nothing is waiting for your approval.', 'warn');
        let targets = all ? list.map((_, k) => k + 1) : [...new Set(nums)];
        if (agent) {
          targets = list.map((it, k) => (matchesAgent(it, agent) ? k + 1 : 0)).filter(Boolean);
          if (!targets.length) return say(`Nothing waiting from "${agent}". ${mark('/approvals agents')} shows who is asking.`, 'warn');
        }
        const privOf = (it) => isPrivileged({ tool: it.payload?.approval_context?.method?.tool, risk: it.payload?.approval_context?.risk, flag: it.payload?.privileged === true || it.payload?.approval_context?.privileged === true, title: it.title });
        const bulkish = Boolean(all || agent || targets.length > 1); const heldRisky = [];
        const heldDecisions = []; const done = []; const heldPriv = []; const failed = []; const missing = []; const gone = [];
        const label = (k) => { const it = list[k - 1]; return `[${k}] ${approvalSourceLabel(it)}: ${approvalWhat(it)}`; }; // owner 2026-10-15: no repeated who, no cut at all (lines wrap); the server caps summary length
        for (const k of targets) {
          const it = list[k - 1];
          if (!it) { missing.push(k); continue; }
          if (isDecision(it)) {
            if (all || agent) { heldDecisions.push(k); continue; } // a bulk approve never answers a human question for you
            if (verb === 'approve' && bulkish && isHeldFromBulk(it)) { heldRisky.push(k); continue; } // risky asks are never part of a bulk yes
            if (verb === 'approve' && !bulkish && it.payload.options.some(o => o.key === 'y')) say(`Answering: ${it.title || it.id} → ${it.payload.options.find(o => o.key === 'y').label} (y)`, 'dim');
            if (verb === 'approve' && !it.payload.options.some(o => o.key === 'y')) { failed.push(`[${k}] is a question, not yes/no: /answer ${k} ${it.payload.options.map(o => o.key).join('|')}  ${it.payload.options.map(o => `(${o.key}) ${o.label}`).join(' ')}`); continue; }
          }
          if (verb === 'approve' && privOf(it) && !(confirm && !all && !agent)) { heldPriv.push(k); continue; }
          try {
            const dsc = describeInboxItem(it); // APPROVAL-WHAT: record the real action and target, not a clipped title
            const r = await answer({ callId: it.id, inboxItemId: it.id, approvalId: it.approval_id || it.approvalId || null, tool: dsc.tool || clip(it.title || it.id, cols - 40), target: dsc.target, raisedBy: approvalSourceLabel(it), risk: it.payload?.approval_context?.risk || null }, verb, { batch: true, reason, proactive: Boolean(R.current.authorising) && verb === 'approve', bulk: bulkish && isDecision(it) });
            if (r?.gone) gone.push(k); else if (r?.ok) done.push(k);
          } catch (e) { failed.push(`[${k}] ${e.message}`); }
        }
        if (done.length || gone.length || failed.length || missing.length) say(' ');
        for (const k of done) say(`${verb === 'approve' ? '✔ approved' : '✔ denied'} ${label(k)}${reason ? ` (reason: ${clip(reason, 40)})` : ''}`, 'ok');
        if (gone.length) say(`already handled: ${gone.map(k => `[${k}]`).join(' ')}`, 'accent');
        if (done.length > 1) say(`${verb === 'approve' ? 'Approved' : 'Denied'}: ${done.map(k => `[${k}]`).join(' ')}`, 'ok');
        if (missing.length) say(`No such item: ${missing.map(k => `[${k}]`).join(' ')} (${list.length} listed).`, 'warn');
        for (const f of [...new Set(failed)]) dispatch({ type: 'error', text: `approval: ${f}` });
        for (const k of done) { // quox ask: tell the asking session on its slot, as /answer does
          const it = list[k - 1];
          if (isDecision(it) && it.payload.slot && api.slotSay) await api.slotSay(String(it.payload.slot).toLowerCase(), `Your question "${clip(it.title, 80)}" was ${verb === 'approve' ? 'answered: y' : `declined${reason ? ` (${reason})` : ''}`}. Read it with: quox ask status ${it.id}`, { from: myLabel() });
        }
        if (done.length || gone.length || failed.length || missing.length) say(' ');
        const letteredHeld = heldDecisions.filter(k => !list[k - 1].payload.options.some(o => o.key === 'y'));
        const riskyYn = verb === 'approve' ? heldDecisions.filter(k => !letteredHeld.includes(k) && isHeldFromBulk(list[k - 1])) : [];
        const walkKs = [...new Set([...letteredHeld, ...riskyYn, ...heldRisky])].sort((a, b) => a - b);
        const ynShown = heldDecisions.filter(k => !letteredHeld.includes(k) && !riskyYn.includes(k));
        const ynHeld = verb === 'approve' && all && !agent ? ynShown : [];
        if (ynShown.length) say(`${ynShown.length} decision${ynShown.length === 1 ? '' : 's'} left for you to pick: ${ynShown.map(k => `/answer ${k} ${list[k - 1].payload.options.map(o => o.key).join('|')}`).join(', ')} (or /deny ${ynShown.join(',')} <reason>)`, 'warn');
        if (ynHeld.length) { // ONE card for the LOW-RISK y/N decisions only, each listed in full; risky ones were held back for the walkthrough
          for (const k of ynHeld) say(`  [${k}] ${list[k - 1].title || list[k - 1].id}`, 'dim');
          R.current.pendingGrant = { cmd, verb, items: ynHeld.map(k => list[k - 1]), ks: ynHeld, decisions: true, hi: 0, at: Date.now(), thenWalk: walkKs.length ? walkKs.map(k => list[k - 1]) : null };
          ask(`Answer yes to ${ynHeld.length === 1 ? 'it' : `all ${ynHeld.length}`}?`, { who: '', action: `/answer ${ynHeld.join(',')} y`, reason: `${walkKs.length ? `${walkKs.length} risky or lettered held back for the walkthrough. ` : ''}Each one listed above is answered yes.`, keys: 'y answers yes to these, N cancels' });
        }
        if (walkKs.length) {
          say(`${walkKs.length} question${walkKs.length === 1 ? '' : 's'} held back from any bulk yes (${[...new Set(walkKs.map(k => heldReason(list[k - 1]) || 'needs a real choice'))].join(', ')}). I will take ${walkKs.length === 1 ? 'it' : 'them'} one at a time, with the full text, each with your own yes.`, 'warn');
          if (!ynHeld.length) walkStart(walkKs.map(k => list[k - 1])); // with a bulk card up, the walkthrough starts once the card is answered
        }
        if (heldPriv.length && (all || agent)) say(`${heldPriv.length} privileged left: ${heldPriv.map(k => `${cmd} ${k} confirm`).join(', ')}`, 'warn');
        else if (heldPriv.length) { // ask inline instead of sending the user to a second command
          R.current.pendingGrant = { cmd, verb, items: heldPriv.map(k => list[k - 1]), at: Date.now() };
          for (const k of heldPriv) {
            const it = list[k - 1]; const c = it.payload?.approval_context || {};
            const tools = [].concat(c.elevated_tools || c.tools || it.payload?.tools || c.method?.target || []).filter(Boolean).join(', ');
            say(`Grant ${clip(it.title || it.id, cols - 30)} (privileged)${tools ? `: elevated tools ${tools}` : ''}${c.on_behalf_of?.conversation_id ? ' for that conversation' : ''}`, 'warn');
          }
          ask(`Grant ${heldPriv.length === 1 ? 'it' : `all ${heldPriv.length}`}?`, { who: heldPriv.map(k => approvalSourceLabel(list[k - 1])).filter(Boolean)[0] || '', action: `${cmd} ${heldPriv.join(' ')} confirm`, reason: 'privileged: it grants elevated tools.', keys: 'y grants, anything else cancels' });
        }
        return undefined;
      }
      default: {
        const e = findEntry(cmd);
        if (e && e.status === 'planned') return say(`${e.usage} is planned, not built yet. /help shows what works today.`, 'warn');
        if (!e && await slotNameCommand(cmd, restArg)) return undefined;
        const cliHit = resolveCliSlash(cmd, restArg); // QUOXON-FW: slash words that name a real quox CLI leaf
        if (cliHit) return cliSlashRun(cliHit);
        const loose = looseCommand(cmd, restArg);
        if (loose?.run) { say(`ran ${loose.name}`, 'dim'); return command(loose.run); }
        if (loose?.suggest) return say(`Unknown command ${cmd}. Did you mean ${loose.suggest}? (/help lists them)`, 'warn');
        if (loose?.ask) { R.current.askQuox = { text: loose.ask, at: Date.now() }; return ask('Ask Quox instead?', { action: `send as a chat turn: ${loose.ask}`, reason: 'Not a command.' }); }
        const near = nearestCommands(cmd);
        if (!near.length) return say(`Unknown command ${cmd}. Try /help`, 'warn');
        // spelling-only hints keep the plain "/a or /b" line; keyword hints say what each command does
        const byWords = near.some(x => x.kw);
        say(`Unknown command ${cmd}. Did you mean ${byWords ? near.map(x => (x.desc ? `${x.name} (${x.desc})` : x.name)).join(', ') : near.map(x => x.name).join(' or ')}? (/help lists them)`, 'warn');
        if (near.length === 1) { // one strong match: offer it as a y/N card (vetted, never a human-typed command)
          const v = vetSuggestion(near[0].name);
          if (v.ok) { R.current.suggestAsk = { line: v.line, at: Date.now() }; ask(`Run ${v.line}?`, { action: v.line, reason: 'Nearest command to what you typed.' }); }
        }
        return undefined;
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
      const host = row?.holder_identity ? String(row.holder_identity).replace(/^resident:/, '') : (row?.host_name || row?.hostname || null); // never host_id: an internal id
      out.push(`slot ${n}${host ? ` (${host})` : ''}`);
    }
    const ids = (Array.isArray(ag) ? ag : []).map(a => String(a?.agent_id ?? a?.id ?? a?.name ?? ''));
    for (const n of nearest(name, ids)) out.push(`agent ${n}`);
    return out;
  }

  // QUOXON-ASK y/N/c (owner 2026-10-15 "i need y/n/chat more"): the open composer asks, each with its own answer
  // handler below. An ask counts as open while its 2-minute window runs.
  const ASK_TTL = 120000;
  function openAskStates() {
    const fresh = (x) => (x && Date.now() - (x.at ?? 0) < ASK_TTL ? x : null);
    const W = R.current.pendingWalk; const walkCardSt = W && W.card && Date.now() - W.at < WALK_TTL ? W.card : null; // WALK-FIXES: one card per decision, open as long as the walk (30 min), not the 2-minute ask clock
    return [walkCardSt, ...[R.current.wakeAsk, R.current.pendingGrant, R.current.feedbackAsk, R.current.slotAsk, R.current.slotCreateAsk, R.current.profileAsk, R.current.cliAsk, R.current.updateAsk, R.current.orgPending, R.current.hatPending, HW.current.card(), RW.current.walk.card(), R.current.suggestAsk && !R.current.suggestLine ? R.current.suggestAsk : null, R.current.handoffAsk, R.current.askQuox, R.current.strayAsk, R.current.planAsk, SC.current.pendingFile, SC.current.reattach, CH.current.pending, SPN.current.pending].map(fresh)].filter(Boolean);
  }
  const askOpen = () => openAskStates().length > 0 || KC.current.pending?.() || UW.current.pending?.() || runAskOpen();
  function touchAsks() { for (const x of openAskStates()) x.at = Date.now(); KC.current.touch?.(); UW.current.touch?.(); }
  // ASK-SETTLE (owner 2026-10-17: "questions should go once answered, or change to answer"): each live ask card is
  // bound to the open state it asks about; once that state is no longer open the card goes and ONE line stays:
  // "✔ Wake it now? yes (00:44)", "⌛ ... expired, not answered", "↷ ... no longer open". Run requests likewise.
  const askBind = React.useRef(new Map()); // card id -> its state object | 'kc' | 'uw' | 'any'
  function askStateOpen(st) {
    if (st === 'kc') return Boolean(KC.current.pending?.());
    if (st === 'uw') return Boolean(UW.current.pending?.());
    if (st === 'any') return askOpen();
    return openAskStates().includes(st);
  }
  function settleRun(rq, outcome, now = Date.now()) {
    SC.current.runCards?.delete(rq.askId);
    dispatch({ type: 'slotmsg.settle', askId: rq.askId, text: settledAskLine(`Run ${clip(String(rq.cmd || ''), Math.max(20, cols - 40))}?`, outcome, now), tone: settledAskTone(outcome.kind) });
  }
  function reconcileAsks() {
    const now = Date.now();
    const takeAnswer = () => { const a = R.current.askAnswer; R.current.askAnswer = null; return a && now - a.at < 3000 ? a : null; };
    const bind = askBind.current;
    const cards = [...(S.current.asks || [])].reverse(); // newest first: an answer belongs to the newest card it closes
    for (const cd of cards) {
      if (!bind.has(cd.id)) {
        const taken = new Set(bind.values());
        const st = openAskStates().filter(x => !taken.has(x)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
        bind.set(cd.id, st || (KC.current.pending?.() ? 'kc' : UW.current.pending?.() ? 'uw' : 'any'));
      }
      const st = bind.get(cd.id);
      if (askStateOpen(st)) continue;
      bind.delete(cd.id);
      const expired = st && typeof st === 'object' ? now - (st.at ?? 0) >= ASK_TTL : false;
      if (st && typeof st === 'object' && st.walkWhy) { // a walkthrough card: a normal end says nothing (the summary does), an interruption says so
        takeAnswer();
        if (st.walkWhy === 'stop') dispatch({ type: 'ask.settle', id: cd.id, text: 'The question closed before you answered.', tone: 'plain' });
        else dispatch({ type: 'ask.settle', id: cd.id, text: '', tone: 'plain', silent: true });
        continue;
      }
      const outcome = expired ? { kind: 'expired' } : takeAnswer() || { kind: st === 'any' || st === 'kc' || st === 'uw' ? 'expired' : 'closed' };
      dispatch({ type: 'ask.settle', id: cd.id, text: settledAskLine(askQuestion(cd.text), outcome, now), tone: settledAskTone(outcome.kind) });
    }
    for (const [id, rq] of [...(SC.current.runCards || new Map())]) {
      const live = SC.current.runAsk?.askId === id;
      if (live && runAskOpen()) continue;
      const expired = rq.expiresAt != null && (runNow() >= rq.expiresAt || now >= rq.expiresAt);
      const outcome = expired ? { kind: 'expired' } : (!live && takeAnswer()) || { kind: 'closed' };
      settleRun(rq, outcome, now);
    }
  }
  React.useEffect(() => {
    const t = setInterval(() => { if ((S.current.asks || []).length || SC.current.runCards?.size) reconcileAsks(); }, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, []);
  /** c or free text while an ask is open: keep it open, send a chat turn about it, and show the same ask again after. */
  function chatAboutAsk(text) {
    const la = R.current.lastAsk;
    const q = la?.question || 'the question above';
    touchAsks();
    R.current.reask = la || null;
    const msg = askChatMessage(text, q);
    touchSeen(); dispatch({ type: 'user', text: /^c(hat)?$/i.test(text.trim()) ? msg : text.trim() }); remember(text); R.current.histIdx = -1;
    runTurn(msg);
  }

  function onEnter(now) {
    if (now - K.current.lastPasteAt < PASTE_GUARD_MS) return; // post-paste guard
    if (now - K.current.cardGoneAt < CARD_GONE_MS) return; // keys meant for the card must not send a turn
    let buf = B.current;
    // y/N/c: Enter alone answers an open ask "no" (the default), as typing n does.
    if (!buf.text.trim() && R.current.pendingWalk && !R.current.denyReason) { say('Type a choice for the card above (s skips, Esc stops). Enter alone answers nothing.', 'dim'); return; } // WALK-FIXES: an empty Enter must never answer "no"
    if (!buf.text.trim() && !R.current.denyReason && !S.current.turn && askOpen()) { B.current = { ...initialBuffer(), text: 'n', cursor: 1 }; buf = B.current; }
    if (buf.text.endsWith('\\')) { edit({ type: 'set', text: buf.text.slice(0, -1) + '\n', keepPastes: true }); return; }
    if (!buf.text.trim()) {
      if (R.current.noteAsk && Date.now() - R.current.noteAsk.at < 300000) { const st = R.current.noteAsk; R.current.noteAsk = null; noteResolve('1', st); return; } // Enter on the note card = the recommended choice
      if (R.current.denyReason) { const d = R.current.denyReason; R.current.denyReason = null; if (Date.now() - d.at < 120000) { answer(d.card, 'reject'); return; } } // Enter on "Reason?" skips it
      const s = S.current;
      if (!s.turn && s.pending.length) { dispatch({ type: 'queue.shift' }); runQueued(s.pending[0].text); }
      return;
    }
    const chk = sanitizeForSend(buf);
    if (!chk.ok) { B.current = { ...chk.buffer, undo: buf.undo, redo: buf.redo }; say(chk.note, 'warn'); bump(n => n + 1); return; }
    let text = chk.text.trim();
    const wrapped = joinWrappedSlash(text); // a wrapped paste of "/say slot long text": one command, not a refusal
    if (wrapped) { text = wrapped.text; say(`joined ${wrapped.lines} lines`, 'dim'); }
    const keyHit = looksLikeKey(text);
    if (keyHit) { B.current = initialBuffer(); R.current.confirmMulti = null; say(keyWarning(keyHit), 'warn'); return; } // never sent, never in history
    if (text.startsWith('!') && text.includes('\n')) { // owner 2026-10-15: a wrapped `!git ... push origin\nHEAD:main` ran as two commands
      const joined = text.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
      B.current = { ...initialBuffer(), text: joined, cursor: joined.length }; R.current.confirmMulti = null;
      say(`That ! command arrived on ${text.split('\n').filter(l => l.trim()).length} lines (a wrapped paste?). Joined into one line in the composer: check it, then Enter runs it.`, 'warn');
      bump(n => n + 1); return;
    }
    const bang = parseBang(text);
    if (bang) { // QUOXON-FW8: the user's own command on their own machine; never a turn, never the server
      if (bang.kind !== 'reserved' && bang.kind !== 'empty' && R.current.bang) { say('A command is still running. Ctrl+C stops it; your draft is kept.', 'warn'); return; }
      B.current = initialBuffer(); R.current.confirmMulti = null; remember(text); R.current.histIdx = -1;
      echoCmd(text); bangCommand(bang, { echoed: true }); bump(n => n + 1); return;
    }
    const s = S.current;
    const isCommand = text.startsWith('/') && !text.includes('\n');
    const ws = R.current.wokeSwallowed; R.current.wokeSwallowed = null;
    if (ws && !isCommand && !text.startsWith('!') && now - ws.at < 15000 && !askOpen() && !R.current.pendingWalk) { // the key that woke the screen was not typed: this line may be missing its first letter, so nothing goes to the model unless the user means it
      B.current = { ...initialBuffer(), text, cursor: text.length };
      say('Not sent: the key that woke the screen was not typed, so this line may be missing its first letter. Check it, then press Enter to send.', 'warn'); bump(n => n + 1); return;
    }
    if (blocked && !isCommand) { // Z2H-R4: clear the box (else the next /login is appended and refused); Up recalls the message
      remember(text); R.current.histIdx = -1; B.current = initialBuffer(); say(blocked, 'warn'); bump(n => n + 1); return;
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
    K.current.composerClicked = false;
    if (R.current.handoffAsk?.bigger && /^(y(es)?|no?|c|keep)$/i.test(text.trim())) { // "Switch this window back to CommanderQ?" y switch / n just this one / c keep asking
      const a = R.current.handoffAsk; R.current.handoffAsk = null;
      const t = text.trim().toLowerCase();
      const kind = t[0] === 'y' ? 'yes' : t[0] === 'n' ? 'no' : 'dismissed';
      R.current.askAnswer = { kind, at: Date.now() }; queueMicrotask(() => reconcileAsks());
      const hs = R.current.handoffStreak;
      if (Date.now() - a.at >= 120000) { say('That offer expired. Nothing changed.', 'dim'); return; }
      if (kind === 'yes') { hs?.clear(); echoCmd('/detach'); command('/detach'); return; }
      if (kind === 'no') { hs?.restart(); runHandoff(a); return; }
      hs?.mute(); say(`Staying with ${a.h.fromName}.`, 'dim'); return;
    }
    // ASK-SETTLE: an answer is remembered; the card it closes settles to one line once this line is handled.
    let askDismissed = false; // a chat line that is not a question about the offer answers it by moving on: the card closes itself
    if (askOpen() && !R.current.noteAsk) {
      const o = askOutcomeOf(text, { runWord: runAskOpen() }) || (askAnswer(text) === 'chat' && !S.current.turn && !R.current.pendingWalk && !isAskClarification(text) ? { kind: 'dismissed' } : null);
      const OWN = ['wakeAsk', 'pendingGrant', 'feedbackAsk', 'slotAsk', 'slotCreateAsk', 'profileAsk', 'cliAsk', 'updateAsk', 'orgPending', 'hatPending', 'suggestAsk', 'askQuox', 'planAsk'];
      const foreign = KC.current.pending?.() || UW.current.pending?.() || HW.current.card() || SC.current.pendingFile || SC.current.reattach || CH.current.pending || SPN.current.pending || runAskOpen();
      if (o?.kind === 'dismissed' && foreign) { /* a card owned by another module keeps its own rules: the line is about it, as before */ }
      else if (o) {
        askDismissed = o.kind === 'dismissed';
        R.current.askAnswer = { ...o, at: Date.now() }; queueMicrotask(() => reconcileAsks());
        if (askDismissed) for (const k of OWN) R.current[k] = null; // the offer is gone: the line below is plain chat, not an answer to anything
      }
    }
    // y/N/c: c or any other free text keeps the open ask and asks Quox about it first (never a silent cancel).
    if (R.current.noteAsk) { // NOTE-CONFIRM: the line is the pick (1, 2, 3); anything else leaves the card and nothing was sent
      const st = R.current.noteAsk; R.current.noteAsk = null;
      const pick = ({ 1: '1', 2: '2', 3: '3', y: '1', yes: '1', n: '2', no: '2', e: '3', edit: '3' })[text.trim().toLowerCase()];
      if (Date.now() - st.at < 300000 && pick) { noteResolve(pick, st); return; }
      noteResolve('3', st); // anything else backs out: the whole answer is put back in the composer, never dropped
      say('Not sent. Your answer and note are back in the composer; press Enter to send it, or edit it first.', 'warn');
      return;
    }
    if (R.current.pendingWalk && !text.startsWith('/')) { walkHandle(text); return; } if (R.current.pendingWalk) walkEnd(`you ran ${text.split(/\s+/)[0]}`); // WALKTHROUGH: the line is the answer to the card on screen; a command ends the walk with its summary
    if (!askDismissed && !S.current.turn && !noAiNow() && askAnswer(text) === 'chat' && askOpen() && !(runAskOpen() && /^run$/i.test(text.trim()))) { chatAboutAsk(text); return; }
    if (KC.current.answer(text)) return; // y/n after a /watch, /automate or /crystallize preview card
    if (UW.current.answer(text)) return; // y/n after a /undo or /wish card
    if (HW.current.active() && HW.current.answer(text)) return; // CUSTOM-HATS: the next line of a /hat new|edit|delete walk
    if (RW.current.walk.active() && RW.current.walk.answer(text)) return; // ROWS: the next line of a /row new|edit walk
    if (R.current.denyReason) { // the n card asked "Reason? (Enter to skip)": this one line is the reason
      const d = R.current.denyReason; R.current.denyReason = null;
      if (Date.now() - d.at < 120000 && !text.startsWith('/')) { answer(d.card, 'reject', { reason: text.trim() || null }); return; }
    }
    if (R.current.pendingGrant) { // /approve N on a privileged item asked "y/N": this one line is the answer
      const g = R.current.pendingGrant; R.current.pendingGrant = null;
      if (Date.now() - g.at < 120000 && !text.startsWith('/')) {
        if (/^y(es)?$/i.test(text.trim())) {
          (async () => {
            if (g.decisions) g.items = g.items.filter(it => !isHeldFromBulk(it)); // defence: a risky ask never rides the bulk card
            if (g.decisions && g.hi) { // one PIN for the whole batch; the token then rides on every item
              const r = SU.current.token('approve') ? { ok: true } : await SU.current.request({ scope: 'approve', orgId: api.orgId?.() || null, subject: { line1: `answer yes to ${g.items.length} decisions (${g.hi} high risk)`, raisedBy: null, risk: 'high' } });
              if (!r.ok) return say(`Not answered: ${declinedText(r.reason)}. Nothing was sent.`, 'warn');
            }
            for (const it of g.items) {
              if (g.decisions) {
                try {
                  const r = await answer({ callId: it.id, inboxItemId: it.id, approvalId: null, tool: clip(it.title || it.id, cols - 40), target: null, raisedBy: it.payload.session || null, risk: it.payload.high_risk ? 'high' : null }, 'approve', { batch: true, bulk: true });
                  walkAnsweredIds().add(it.id); // answered (or already handled): a walk never shows it again
                  if (r?.gone) say(`already handled: ${clip(it.title || it.id, cols - 30)}`, 'accent'); else say(`✔ answered yes: ${clip(it.title || it.id, cols - 24)}`, 'ok');
                  if (r?.ok && it.payload.slot && api.slotSay) await api.slotSay(String(it.payload.slot).toLowerCase(), `Your question "${clip(it.title, 80)}" was answered: y. Read it with: quox ask status ${it.id}`, { from: myLabel() });
                } catch (e) { dispatch({ type: 'error', text: `approval: ${e.message}` }); if (e?.stepUpDeclined) return; }
                continue;
              }
              try { await answer({ callId: it.id, inboxItemId: it.id, approvalId: it.approval_id || it.approvalId || null, tool: clip(it.title || it.id, cols - 40), target: null }, g.verb); say(`✔ Granted ${clip(it.title || it.id, cols - 20)}`, 'ok'); }
              catch (e) { dispatch({ type: 'error', text: `approval: ${e.message}` }); }
            }
            if (g.thenWalk) walkStart(g.thenWalk); // WALK-FIXES: the ONE start, once the yeses are in (it used to start here AND straight away: two cards)
          })();
        } else { say('Cancelled; nothing granted.', 'dim'); if (g.thenWalk) { const w = g.thenWalk; setTimeout(() => walkStart(w), 0); } }
        return;
      }
    }
    if (R.current.feedbackAsk) { // /feedback showed the exact payload and asked "Send it? y/N"
      const a = R.current.feedbackAsk; R.current.feedbackAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) {
        say('Sending to quox.ai…', 'dim');
        (async () => {
          const r = await api.feedback(a.payload, { version });
          if (!r?.ok) say(`Feedback not sent: ${r?.message || 'failed'}`, 'warn');
          else say(`✔ Sent to the Quox team at quox.ai${r.id != null ? ` (feedback #${r.id})` : ''}. Thank you.`, 'ok');
        })();
        return;
      }
      if (!text.startsWith('/')) { say('Not sent.', 'dim'); return; }
    }
    if (R.current.wakeAsk) { // "<slot> hasn't replied ... Wake it now? y/N/c": y pokes it (/poke = an urgent page that wakes it)
      const a = R.current.wakeAsk; R.current.wakeAsk = null;
      if (askAnswer(text) === 'yes' && Date.now() - a.at < 120000) { echoCmd(`/poke ${a.slot}`); command(`/poke ${a.slot}`); return; }
      if (!text.startsWith('/')) { say('Not woken.', 'dim'); return; }
    }
    if (R.current.profileAsk) { // PROFILE-SWITCH "Switch? y/N/c": only y switches
      const a = R.current.profileAsk; R.current.profileAsk = null;
      if (askAnswer(text) === 'yes' && Date.now() - a.at < 120000) { switchTo(a.name); return; }
      if (!text.startsWith('/')) { say(`Not switched. This window stays ${WHO.current.profile}.`, 'dim'); return; }
    }
    if (R.current.slotCreateAsk) { // "No slot X. Create it? y/N/c" from a /slot near miss: y runs /slot X --create
      const a = R.current.slotCreateAsk; R.current.slotCreateAsk = null;
      if (askAnswer(text) === 'yes' && Date.now() - a.at < 120000) { const l = `/slot ${a.nm} --create`; echoCmd(l); command(l); return; }
      if (!text.startsWith('/')) { say('No slot created.', 'dim'); return; }
    }
    if (R.current.slotAsk) { // "Take it over? y/N" from /slot
      const a = R.current.slotAsk; R.current.slotAsk = null;
      if (/^y(es)?$/i.test(text.trim())) { takeSlot(a.nm, true); return; }
      if (!text.startsWith('/')) { say('Left it alone.', 'dim'); return; }
    }
    if (CH.current.answer(text) || SPN.current.answer(text)) return; // /challenge: "Resolve these? y/N"
    if (R.current.updateAsk) { // /update: "Update now and restart? y/N/c"; y hands the terminal to the update, then restarts
      const a = R.current.updateAsk; R.current.updateAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) {
        if (S.current.turn) { say('A turn is running. Wait for it, then /update.', 'warn'); return; }
        say(`Updating: ${a.plan.command.display} runs in this terminal, then quox restarts into this conversation.`, 'dim');
        doRestart({ update: a.plan }); return;
      }
      if (!text.startsWith('/')) { say('Not updated. Nothing was changed.', 'dim'); return; }
    }
    if (R.current.cliAsk) { // QUOXON-FW: a slash word named a WRITE quox command: "Run it? y/N" (typing y is the authorization)
      const a = R.current.cliAsk; R.current.cliAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { if (R.current.bang) say('A command is still running. Ctrl+C stops it.', 'warn'); else bangCommand(a.bang); bump(n => n + 1); return; }
      if (!text.startsWith('/')) { say('Not run.', 'dim'); return; }
    }
    if (R.current.hatPending && !text.startsWith('/')) { // "Put on the NSOC hat? y/N" from /hat: y switches (/hat yes still works)
      const a = R.current.hatPending;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - (a.at || 0) < 120000) { command('/hat yes'); return; }
      R.current.hatPending = null; say('Hat not changed.', 'dim'); return;
    }
    if (R.current.orgPending && !text.startsWith('/')) { // "Switch to X? y/N" from /org switch: y switches (/org yes still works)
      const a = R.current.orgPending;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - (a.at || 0) < 120000) { command('/org yes'); return; }
      R.current.orgPending = null; say(`Not switched. Still in ${R.current.orgName ?? org ?? 'the same org'}.`, 'dim'); return;
    }
    if (R.current.suggestAsk) { // "Run /slot hitl? y/N" from terminal_suggest_command: y runs it as if typed (normal command path)
      const a = R.current.suggestAsk; R.current.suggestAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { const v = vetSuggestion(a.line); if (v.ok) { R.current.preConfirmed = v.id === 'org' ? 'org' : null; echoCmd(v.line); command(v.line); bump(n => n + 1); } return; }
      if (!text.startsWith('/')) { say('Not run.', 'dim'); return; }
    }
    if (R.current.handoffAsk) { // "Hand this question to CommanderQ?" (yes or no): yes asks it once, the attach stays
      const a = R.current.handoffAsk; R.current.handoffAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { runHandoff(a); return; }
      if (!text.startsWith('/')) { say('Not handed over.', 'dim'); return; }
    }
    if (R.current.planAsk) { // PLAN MODE: "Run this plan now? y/N/c": y switches back to ask and sends the go-ahead
      const a = R.current.planAsk; R.current.planAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { MD.current = 'ask'; bump(n => n + 1); say('mode ask first: running the plan.', 'dim'); submit(PLAN_GO); return; }
      if (!text.startsWith('/')) { say('Not run. Still plan only (/mode ask to switch).', 'dim'); return; }
    }
    if (R.current.strayAsk) { // TUI-INPUT: "Did you mean /help? y/N/c" before a queued "n/help" is sent: y runs the command, n sends it as typed
      const a = R.current.strayAsk; R.current.strayAsk = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { echoCmd(a.command); command(a.command); return; }
      if (/^no?$/i.test(text.trim()) && Date.now() - a.at < 120000) { runQueued(a.text, { checked: true }); return; }
    }
    if (R.current.askQuox) { // an unknown "/words ..." offered to ask Quox: "y/N"
      const a = R.current.askQuox; R.current.askQuox = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - a.at < 120000) { submit(a.text); return; }
      if (!text.startsWith('/')) { say('Not sent.', 'dim'); return; }
    }
    if (SC.current.pendingFile) { // /send found secret-shaped values: "y/N" (send redacted)
      const pf = SC.current.pendingFile; SC.current.pendingFile = null;
      if (/^y(es)?$/i.test(text.trim()) && Date.now() - pf.at < 120000) { sendToSlot(pf.slot, fileMessage({ name: pf.f.name, body: pf.f.redacted, size: Buffer.byteLength(pf.f.redacted) })); return; }
      if (!text.startsWith('/')) { say('Not sent.', 'dim'); return; }
    }
    if (SC.current.reattach) { // startup "Reattach to slot X? y/N"
      const ra = SC.current.reattach; SC.current.reattach = null;
      if (/^y(es)?$/i.test(text.trim())) { takeSlot(ra.slot, ra.take); return; }
      if (/^no?$/i.test(text.trim())) { say('Left it.', 'dim'); return; }
    }
    if (SC.current.runAsk) { // SLOT-RUN: "Run it? y/N/c" (or "run" for a dangerous one) on a slot sender's command
      const ra = SC.current.runAsk;
      const v = runAnswer(text, ra);
      if (runNow() >= ra.expiresAt) { // runNow: the run-ask clock (a prop so a test can move it 10 minutes without freezing Date.now)
        SC.current.runAsk = null;
        if (v === 'run' || v === 'needs-run' || v === 'no') { say(`That run request from ${ra.who} expired (run requests last 10 minutes). Not run; ask them to send it again.`, 'warn'); return; }
      } else if (v === 'run') { SC.current.runAsk = null; runSlotCommand(ra); return; }
      else if (v === 'needs-run') { say(`Not run yet. ${ra.danger}, so type run to run it, or n to skip.`, 'warn'); return; }
      else if (v === 'no') { SC.current.runAsk = null; transcript?.bang?.(ra.cmd, 'declined'); say('Not run.', 'dim'); return; }
    }
    if (text.startsWith('/') && !text.includes('\n')) { remember(text); R.current.histIdx = -1; echoCmd(text); command(text); return; } // Up recalls commands too
    const roomSend = api.slotSay ? parseRoomSend(text) : null;
    if (roomSend) { // QUOXON-ROOMS: #room text posts, bare #room makes it the default target
      remember(text); R.current.histIdx = -1;
      if (roomSend.text) postRoom(roomSend.room, roomSend.text); else setActiveRoom(roomSend.room);
      return;
    }
    if (SC.current.active && text.trim() === '#') { SC.current.active = null; say('Back to Quox: plain lines go to the model again.', 'ok'); return; }
    if (SC.current.active && api.slotSay && !text.startsWith('!') && !text.includes('\n')) { // default room target
      remember(text); R.current.histIdx = -1;
      postRoom(SC.current.active, text.trim()); return;
    }
    const atSend = parseAtSend(text);
    if (atSend && api.slotSay) { // QUOXON-MESH: @slot text goes straight to the slot, no model turn, even mid-turn
      remember(text); R.current.histIdx = -1;
      sendToSlot(atSend.slot, atSend.text); return;
    }
    if (R.current.askArmed && !s.turn) { // /dragon ask with no question: this one line goes to the dragon
      R.current.askArmed = false; R.current.dragonTalk = null; touchSeen(); dispatch({ type: 'user', text });
      remember(text); R.current.histIdx = -1; dragonTurn(DRAGON_ANSWERS, askPrompt(text)); return;
    }
    if (s.turn && alreadyQueued(text, { pending: s.pending, steering: s.steering, waiting: R.current.waitingServer })) { say('Already queued: that exact message is waiting to send.', 'dim'); return; } // TUI-INPUT: Enter again on the same queued text adds no copy
    if (s.turn && !R.current.caps.steer) { // steering already refused for this turn: queue, say so once
      dispatch({ type: 'queue.add', text });
      if (!R.current.steerNoted) { R.current.steerNoted = true; say(STEER_OFF_NOTE, 'warn'); }
      return;
    }
    if (s.turn) { steer(text); return; }
    submit(text);
  }

  /**
   * QUOXON-FW15: y/n answer the shown card, but ONLY while the composer is empty (no draft, not mid-command). With a draft
   * they are ordinary text, which is what stops a stray keystroke approving. A privileged (or undescribable) card needs
   * two deliberate presses: y, then y again; any other key cancels. Returns true when the key was consumed.
   */
  // ---- QUOXON-MOUSE ------------------------------------------------------------------------------
  /** Turn tracking on or off at the terminal (TTY only). On also arms an exit hook so a crash never leaves it on. */
  function mouseTerm(on) {
    const M = MO.current;
    if (!stdout?.isTTY || Boolean(on) === M.tty) return;
    try { stdout.write(on ? MOUSE_ON : MOUSE_OFF); } catch { /* closed */ }
    M.tty = Boolean(on);
    if (on && !M.exitFn) { M.exitFn = () => { try { writeSync(process.stdout.fd ?? 1, MOUSE_OFF); } catch { /* closed */ } }; process.once('exit', M.exitFn); }
    if (!on && M.exitFn) { process.removeListener('exit', M.exitFn); M.exitFn = null; }
  }
  /** What a run hand-over writes when it takes the terminal back (tracking was turned off for the child). */
  function mouseResume() { return MO.current.tty ? MOUSE_ON : ''; }
  /** The terminal's cursor row (DSR), or null when it does not answer in time. */
  function cursorRow() {
    return new Promise((res) => {
      const t = setTimeout(() => { MO.current.onCursor = null; res(null); }, DSR_TIMEOUT_MS);
      MO.current.onCursor = (row) => { clearTimeout(t); MO.current.onCursor = null; res(row); };
      try { stdout.write(DSR); } catch { clearTimeout(t); MO.current.onCursor = null; res(null); }
    });
  }
  /** -> what Ink drew under screen cell (x, y): { text, col, inFrame, frameRow, frameLines, rowsBelow } | null. */
  async function locate(x, y, row = null) {
    if (mouseScreen) return mouseScreen.at(x, y);
    const scr = stdout?.screen;
    if (!scr) return null;
    const cr = row ?? await cursorRow();
    if (cr == null) return null;
    const hit = screenHit(scr.snapshot(), cr, x, y);
    return hit ? { ...hit, cursorRow: cr } : null;
  }
  function onMouse(e) {
    if (!MO.current.on || e.button !== 'left') return;
    if (e.action !== 'press' && e.action !== 'drag' && e.action !== 'release') return;
    MO.current.chain = MO.current.chain.then(() => mouseEvent(e)).catch(() => {}); // in order: a drag never overtakes its press
  }
  async function mouseEvent(e) {
    const M = MO.current;
    if (R.current.closed || R.current.sleep) return;
    if (e.action === 'release') { M.drag = null; copySelection(); return; }
    if (e.action === 'drag') {
      if (!M.drag) return;
      const hit = await locate(e.x, e.y, M.drag.cursorRow);
      const idx = hit?.inFrame ? composerIndexAt(hit.frameLines, hit.frameRow, e.x, B.current) : null;
      if (idx != null) edit({ type: 'select', anchor: M.drag.anchor, cursor: idx });
      return;
    }
    // a modal card (PIN, sign-in, secure connect) takes keys only: a click never answers it
    if (SU.current.isOpen() || LI.current.isOpen() || CN.current.isOpen()) return;
    const hit = await locate(e.x, e.y);
    if (!hit) return;
    const now = Date.now();
    const idx = hit.inFrame ? composerIndexAt(hit.frameLines, hit.frameRow, e.x, B.current) : null;
    if (idx != null) {
      const dbl = M.last && now - M.last.at < DOUBLE_MS && M.last.x === e.x && M.last.y === e.y;
      M.last = dbl ? null : { at: now, x: e.x, y: e.y };
      if (dbl) { const w = wordAt(B.current.text, idx); edit({ type: 'select', anchor: w.from, cursor: w.to }); copySelection(); return; }
      edit({ type: 'place', index: idx }); K.current.composerClicked = true;
      M.drag = { anchor: B.current.cursor, cursorRow: hit.cursorRow ?? null };
      return;
    }
    M.last = null;
    const what = classifyClick(hit);
    if (!what) return;
    if (what.kind === 'sender') {
      if (!what.slot) return say(`${what.who} has no reply address (it did not send from a slot), so there is nothing to /say to.`, 'warn');
      const draft = B.current.text;
      const body = draft.startsWith('/say ') ? draft.replace(/^\/say\s+\S*\s?/, '') : draft;
      edit({ type: 'set', text: `/say ${what.slot} ${body}`, keepPastes: true });
      return;
    }
    if (what.kind === 'key') {
      if (B.current.text) return say('Your draft is not empty, so a click does not answer. Clear it, or press the key.', 'warn');
      if (what.source === 'approval') { handleEvents([{ type: 'text', text: what.key }], now, false); return; }
      if (!askOpen()) return;
      if (what.key === 'run' || (what.key === 'y' && runAskOpen())) return say('A click never runs a command. Press y or type run.', 'warn');
      handleEvents([{ type: 'text', text: what.key }, { type: 'key', name: 'enter' }], now, false);
    }
    return undefined;
  }

  /**
   * TUI-INPUT: a single y, n or c answers the open y/N/c ask (the "Reattach to slot X?" card and friends) exactly as
   * typing it and Enter does, and never reaches the composer. Only while the composer is empty and was not clicked;
   * a draft in progress keeps its keys (same rule as approval cards). Returns true when the key was consumed.
   */
  function askKey(ch, now) {
    if (!ch || ch.length !== 1 || !/^[ync]$/i.test(ch)) return false;
    const k = K.current;
    if (B.current.text || k.composerClicked || R.current.sleep) return false;
    if (k.walkEndAt && now - k.walkEndAt < ASK_ECHO_MS && !askOpen() && !R.current.pendingWalk) { // a walk card just closed: a late y/n/c is its answer arriving after the walk, never a chat message
      B.current = { ...initialBuffer(), text: ch, cursor: 1 };
      k.askEcho = { ch, at: now }; clearTimeout(k.askEchoTimer);
      k.askEchoTimer = setTimeout(() => { endAskEcho(); bump(n => n + 1); }, ASK_ECHO_MS + 50); k.askEchoTimer.unref?.();
      bump(n => n + 1); return true;
    }
    if (!askOpen() || R.current.pendingWalk || R.current.denyReason || HW.current.active?.()) return false;
    if (/c/i.test(ch) && (S.current.turn || noAiNow())) { say('Quox is busy or off; c chats about this question once it can. y or n answers it now.', 'dim'); return true; }
    B.current = { ...initialBuffer(), text: ch, cursor: 1 };
    onEnter(now);
    // The answer is already given. The key stays on screen for ASK_ECHO_MS as its echo; an Enter in that window is the
    // old "type y, press Enter" habit and is swallowed, and ANY other key wipes the echo first (so "n" + "/help" is never "n/help").
    B.current = { ...initialBuffer(), text: ch, cursor: 1 };
    k.askEcho = { ch, at: now };
    clearTimeout(k.askEchoTimer);
    k.askEchoTimer = setTimeout(() => { endAskEcho(); bump(n => n + 1); }, ASK_ECHO_MS + 50);
    k.askEchoTimer.unref?.();
    bump(n => n + 1);
    return true;
  }
  function endAskEcho() {
    const k = K.current; const ae = k.askEcho;
    k.askEcho = null; clearTimeout(k.askEchoTimer);
    if (ae && B.current.text === ae.ch) B.current = initialBuffer();
  }

  function approvalKey(name, text, now) {
    const card = headCard(S.current);
    if (!card) return false;
    const ch = text || '';
    const k = K.current;
    const g = k.guard;
    if (R.current.denyReason && Date.now() - R.current.denyReason.at < 120000) return false; // typing the deny reason: y/n are text
    if (B.current.text && !k.cardFocus) { k.confirm = false; return false; } // a draft in progress: the key is text (Tab focuses the card, draft kept)
    const armedAt = Math.max(card.displayedAt ?? card.shownAt ?? 0, g?.since ?? 0);
    const ok = () => approvalKeyAllowed({ now, shownAt: armedAt, lastKeyAt: k.lastKeyAt, heldKey: g?.heldKey, ch });
    if (k.confirm) { // second press of a two-press grant
      k.confirm = false;
      if (ch.toLowerCase() === 'y' && ok()) { answer(card, 'approve'); return true; }
      bump(n => n + 1);
      return true; // any other key cancels
    }
    const key = ch.toLowerCase();
    if (key === 'c' && !S.current.turn && !noAiNow()) { // y/N/c: chat about the approval first; the card stays
      if (!ok()) return true;
      const what = card.what || [card.tool, card.target].filter(Boolean).join(' ') || 'this approval';
      const msg = `Tell me more about: approve ${what}, before I decide`;
      touchSeen(); dispatch({ type: 'user', text: msg }); runTurn(msg); bump(n => n + 1); return true;
    }
    if (key !== 'y' && key !== 'n') return false; // ordinary typing: the composer keeps it
    if (!ok()) return true; // too early / key repeat: swallowed, never answered
    if (key === 'n' && k.cardFocus) { k.cardFocus = false; answer(card, 'reject'); return true; } // focused over a draft: the composer holds the draft, so no reason prompt
    if (key === 'n') { // ask why in one line; Enter skips. The card stays until the answer is sent.
      R.current.denyReason = { card, at: Date.now() }; say('Reason? (Enter to skip)', 'warn'); bump(n => n + 1); return true;
    }
    if (card.privileged || card.undescribable) { k.confirm = true; bump(n => n + 1); return true; }
    answer(card, 'approve');
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

  /** COMPOSER-EDIT: cells the draft has per row (the composer box is `cols` wide, less the "› " prompt). */
  function composerWidth() { return Math.max(1, cols - 2); }
  /** COMPOSER-EDIT: copy the composer selection to the clipboard with OSC 52 (works over SSH; needs a terminal that allows it). */
  function copySelection() {
    const t = selectedText(B.current);
    if (!t || !stdout?.isTTY) return;
    try { stdout.write(osc52(t)); } catch { /* closed */ }
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
    // quick reply (owner 2026-10-15): Tab in an EMPTY composer pre-fills "/say <last sender> " (before the palette, which owns Tab otherwise)
    if (name === 'tab' && !B.current.text && R.current.lastSender && !headCard(s)) { edit({ type: 'set', text: `/say ${R.current.lastSender.toLowerCase()} ` }); return; }
    if (!headCard(s) && PL.current.onKey(name)) { bump(n => n + 1); return; } // gate on the card actually SHOWN: an approval put away with Tab (or still queued) must not swallow Tab/Up/Down while the palette is on screen
    if (name === 'escape') {
      if (selection(B.current)) { edit({ type: 'place', index: B.current.cursor }); return; } // COMPOSER-EDIT: Esc drops a selection, nothing else
      if (flyActive()) { R.current.fly = null; bump(n => n + 1); return; } // Esc ends the dragon's pass
      if (busy) { interrupt(); return; }
      if (R.current.askArmed) { R.current.askArmed = false; R.current.dragonTalk = null; say('Dragon ask cancelled.', 'dim'); return; }
      if (HW.current.cancel()) return; // CUSTOM-HATS: Esc ends the hat walk, nothing sent
      if (RW.current.walk.cancel()) return; // ROWS: Esc ends the row walk, nothing saved
      if (R.current.pendingWalk) { walkEnd('Esc'); K.current.lastEscAt = now; return; } // WALK-FIXES: Esc leaves the walkthrough with a summary; the draft stays
      if (now - K.current.lastEscAt < ESC_ESC_MS && B.current.text) {
        if (looksLikeKey(B.current.text)) { edit({ type: 'clear' }); say('Draft cleared. It looked like a key, so it was not kept.'); }
        else { remember(B.current.text); edit({ type: 'clear' }); say('Draft cleared (Up recalls it).'); }
      }
      K.current.lastEscAt = now; return;
    }
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
      case 'word-left': case 'word-right': return edit({ type: name === 'word-left' ? 'wordLeft' : 'wordRight' });
      case 'kill-line-forward': return edit({ type: 'killLineForward' }); // Ctrl+K
      case 'delete-word-forward': return edit({ type: 'deleteWordForward' }); // Alt+D, Ctrl+Delete
      case 'select-left': case 'select-right': case 'select-up': case 'select-down': case 'select-home': case 'select-end':
      case 'select-word-left': case 'select-word-right': { // COMPOSER-EDIT: Shift selection, copied to the clipboard (OSC 52)
        const move = { 'select-word-left': 'wordLeft', 'select-word-right': 'wordRight' }[name] || name.slice(7);
        edit({ type: 'extend', move, width: composerWidth() });
        copySelection();
        return;
      }
      case 'undo': return edit({ type: 'undo' });
      case 'redo': return edit({ type: 'redo' });
      case 'up': {
        if (B.current.text === '' && s.pending.length) { const last = s.pending[s.pending.length - 1]; dispatch({ type: 'queue.pop' }); edit({ type: 'set', text: last.text }); return; }
        if (atVisualEdge(B.current, 'up', composerWidth())) { // COMPOSER-EDIT: Up walks wrapped rows first, history from the top row
          const hist = R.current.history;
          if (B.current.text === '' || R.current.histIdx >= 0) {
            const i = R.current.histIdx < 0 ? hist.length - 1 : Math.max(0, R.current.histIdx - 1);
            if (hist[i] !== undefined) { R.current.histIdx = i; edit({ type: 'set', text: hist[i] }); }
          }
          return;
        }
        return edit({ type: 'up', width: composerWidth() });
      }
      case 'down': {
        if (B.current.text === '' && R.current.histIdx < 0 && rosterOn()) { focusRoster(); return; }
        if (atVisualEdge(B.current, 'down', composerWidth()) && R.current.histIdx >= 0) {
          const i = R.current.histIdx + 1;
          if (i >= R.current.history.length) { R.current.histIdx = -1; edit({ type: 'clear' }); } else { R.current.histIdx = i; edit({ type: 'set', text: R.current.history[i] }); }
          return;
        }
        return edit({ type: 'down', width: composerWidth() });
      }
      case 'ctrl-g': {
        const full = sanitizeForSend({ ...B.current }).text ?? B.current.text;
        mouseTerm(false); // the editor gets a plain terminal (QUOXON-MOUSE), and tracking comes back after
        if (isRawModeSupported) setRawMode(false);
        const out = editor(full);
        if (isRawModeSupported) setRawMode(true);
        mouseTerm(MO.current.on);
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
      if (e.type === 'cursor') { MO.current.onCursor?.(e.row); continue; } // the answer to a click's DSR, never a key
      if (e.type === 'mouse') { onMouse(e); continue; } // QUOXON-MOUSE: never text, never a key
      if (K.current.askEcho) { // TUI-INPUT: see askKey
        const stale = now - K.current.askEcho.at > ASK_ECHO_MS;
        const enter = e.type === 'key' && e.name === 'enter';
        endAskEcho();
        if (enter && !stale) { bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // swallowed: no empty or stray message
      }
      if (AR.current.timer && e.type === 'key') { // the countdown owns two keys: Esc stays on this version, Enter restarts now; anything else is typing (a draft holds the restart)
        if (e.name === 'escape') { stopCountdown(); cdLog('cancelled'); AR.current.cancelledId = AR.current.newId; say("Restart cancelled. /restart when you're ready.", 'accent'); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
        if (e.name === 'enter' && autoIdle()) { stopCountdown(); cdLog('restart-now'); doRestart(); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      }
      if (R.current.sleep) { // the sleep screen eats the waking key (nothing is lost), except "/": slash commands always work asleep
        if (e.type === 'key' && e.name === 'ctrl-c') { exit(); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
        if (R.current.sleep.wakeAt != null) { /* already waking: later keys are typed as normal, so "/back" typed in one go is not cut short */ }
        else {
          wakeDragon();
          if (e.type === 'text' && e.text === '/') edit({ type: 'insert', text: '/' });
          else if (e.type === 'text') R.current.wokeSwallowed = { at: now };
          K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue;
        }
      }
      if (SU.current.isOpen()) { SU.current.onEvent(e); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // the PIN card takes every key: nothing reaches the composer, history or undo
      if (LI.current.isOpen()) { LI.current.onEvent(e); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // the sign-in card takes every key
      if (CN.current.isOpen()) { CN.current.onEvent(e); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // the secure card takes every key
      if (PK.current.isOpen() && !S.current.approvals.length && PK.current.onEvent(e) !== false) { K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; } // /resume, /config (typing closes it and falls through)
      const card = headCard(S.current);
      const g = K.current.guard;
      // any different key ends the "this key was already down" suppression
      if (g?.heldKey && !(e.type === 'text' && e.text === g.heldKey)) g.heldKey = null;
      // Tab (composer empty) puts the card away into the status line until a NEW approval arrives
      // RESTORE-TUI: Tab with a draft focuses the card (the draft is kept, never queued or sent); Esc returns to the draft
      if (card && e.type === 'key' && e.name === 'tab' && B.current.text) { K.current.cardFocus = true; K.current.confirm = false; bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      if (card && e.type === 'key' && e.name === 'escape' && K.current.cardFocus) { K.current.cardFocus = false; K.current.confirm = false; bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      if (card && e.type === 'key' && e.name === 'tab' && !B.current.text) { for (const x of queueOf(S.current)) K.current.dismissed.add(x.callId); K.current.confirm = false; bump(n => n + 1); K.current.lastKeyAt = now; K.current.lastKeyCh = null; continue; }
      if (card && K.current.confirm && e.type === 'key') { K.current.confirm = false; bump(n => n + 1); } // any other key cancels a pending privileged confirm
      if (e.type === 'paste') {
        K.current.lastPasteAt = now;
        edit({ type: 'paste', text: e.text }); // a card never discards a paste
      } else if (e.type === 'text') {
        if (card && approvalKey('text', e.text, now)) { /* consumed by the approval dialog */ }
        else if (!card && R.current.roster.focus && rosterKey(null, e.text)) { /* consumed by the roster */ }
        else if (!card && askKey(e.text, now)) { /* consumed by the open ask */ }
        else edit({ type: 'insert', text: e.text });
      } else if (e.type === 'key') {
        if (e.name === 'enter' && burst) edit({ type: 'newline' }); // startup keys only: never submitted
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
    reconnecting(() => api.conversationTurns(resumeConversation)).then((turns) => {
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
    }, (e) => { if (!live || R.current.closed) return; if (e?.reconnectGaveUp) { resumeGaveUp(resumeConversation); return; } dispatch({ type: 'error', text: `could not load conversation ${resumeConversation}: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}` }); });
    return () => { live = false; };
  }, []);
  React.useEffect(() => {
    if (!startup) return undefined;
    let live = true;
    let timer = null;
    const slow = (note) => /is not answering/.test(note);
    // A slow collector keeps being probed (capped backoff, one timer, none once it answers) so the notice can settle itself.
    const recheck = (i) => {
      const delays = healthRecheckDelays; if (!healthRecheck || !delays?.length) return;
      timer = setTimeout(async () => {
        timer = null;
        let hl = null; try { hl = await healthRecheck(); } catch { hl = null; }
        if (!live) return;
        if (hl?.ok) { say('✔ QuoxCORE is answering again', 'accent'); return; }
        recheck(Math.min(i + 1, delays.length - 1));
      }, delays[Math.min(i, delays.length - 1)]);
    };
    Promise.resolve().then(startup).then((note) => {
      if (!live || !note) return;
      if (slow(note)) { if (startup.said) return; startup.said = true; } // once per session, even if the probe is mounted twice
      say(note, 'warn');
      if (slow(note)) recheck(0);
    }, () => {});
    return () => { live = false; clearTimeout(timer); };
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
      say('autoplay presses y: approve', 'ok');
      onData.current('y'); await wait(P.afterKeyMs);
      if (!await until(() => !S.current.turn && !S.current.approvals.length && !S.current.running.length)) return;
      await wait(Math.max(P.afterTurnMs, 450 * k)); // never shorter than CARD_GONE_MS: an Enter right after the card closes is swallowed (matters only when tests shrink the waits)
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
    if (MO.current.on) mouseTerm(true); // /mouse on, saved for this profile
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
      mouseTerm(false); // mouse tracking never outlives the client (or leaks into a /restart child)
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
    const lim = commitLimit(s); // ASK-SETTLE: an armed run card stays live until it settles
    if (!motionOn) committedRef.current = Math.max(committedRef.current, lim);
    else {
      for (let i = committedRef.current; i < s.history.length; i++) registerFx(s.history[i], nowR);
      for (const b of s.blocks) registerFx(b, nowR);
      // The newest protocol stage stays live (its icon pulses) while it is the last thing that happened in the turn.
      const activeStage = (i) => isActiveStage(s, i);
      while (committedRef.current < lim && !fxActive(s.history[committedRef.current], nowR) && !activeStage(committedRef.current)) fxRef.current.delete(s.history[committedRef.current++].id);
      for (const r of R.current.roster.rows) if (!rosterSeen.current.has(r.key)) rosterSeen.current.set(r.key, nowR);
    }
    pendingHist = s.history.slice(committedRef.current);
  }
  lastAppRender.current = nowR;
  // Composer ring: motion and colour both on. Thinking/tools cyan-purple, writing green, approval amber.
  const ring = motionOn && !mono() ? { ref: ringRef, active: busy, mode: ringMode({ approvals: s.approvals.length, act: s.turn?.act }) } : null;
  const queue = queueOf(s);
  const card = queue[0] || null;
  const armed = card ? Date.now() - Math.max(card.displayedAt ?? card.shownAt ?? 0, K.current.guard?.since ?? 0) >= 300 : false;
  R.current.cardMidAnim = Boolean(card && motionOn && nowR - (card.displayedAt ?? card.shownAt) < 1000); // this render draws the card mid-animation (appDue keeps it due until a settled draw)
  if (motionStats && motionOn && card && card.displayedAt != null && !(motionStats.cards ||= []).some(x => x.card.callId === card.callId)) motionStats.cards.push({ card, org: orgShown() || null }); // the card took the draw-in path (a test renders it at fixed motionE)
  R.current.armedShown = armed;
  const ctxParts = [demoLabel && profile === 'demo' ? null : profile, orgShown(), (R.current.noAi && !s.ctx?.model ? NO_AI_STATUS : modelLabel(s.ctx, MC.current)), demoLabel ? (demoAuto ? 'demo data, nothing real runs' : null) : MD.current, R.current.rulesOn === false ? (rulesLabel(rules) ? 'rules: off' : null) : rulesLabel(rules), AR.current.on ? '↻ auto' : null]; // [5]: auto-restart, context row of the status
  const caps = R.current.caps;
  const hint = (busy ? `${caps.steer ? 'Enter steer' : 'Enter queue'} · Tab queue · ${caps.interrupt ? 'Esc stop' : 'Esc disconnects'}` : ''); // owner 22:12 "Lose this: Enter send · /help": only the hint a running turn needs is shown
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

  // The ⏸ approval row under the status line already says how many wait: the "▶ N approvals waiting" line is then a duplicate.
  function approvalRowShown() {
    const ro = R.current.roster;
    if (!ro.on || !ro.rows.some(r => r.kind === 'approval')) return false;
    const v = rosterView({ rows: ro.rows, cols, termRows: termRows(stdout) ?? 40, max: MAX_ROSTER, on: ro.on, sel: ro.sel, focus: ro.focus, now: Date.now() });
    return v.mode === 'full' && v.lines.some(l => l.kind === 'approval');
  }

  function rosterNode() {
    const ro = R.current.roster;
    const view = rosterView({ rows: ro.rows, cols, termRows: termRows(stdout) ?? 40, max: MAX_ROSTER, on: ro.on, sel: ro.sel, focus: ro.focus, now: Date.now(), motion: motionOn && !mono() });
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
  const ruleAbove = endsInRule({ card, asks: s.asks || [], background: s.background, pending: s.pending, steering: s.steering, countdown: Boolean(AR.current.timer && AR.current.endsAt) }) && !(SU.current.isOpen() || LI.current.isOpen() || CN.current.isOpen());
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
    card ? h(ApprovalCard, { card, org: orgShown() || null, cols, armed, motionE: motionOn && nowR - (card.displayedAt ?? card.shownAt) < 1000 ? (nowR - (card.displayedAt ?? card.shownAt)) / 1000 : null, draftHint: K.current.cardFocus ? 'focus' : (B.current.text ? 'draft' : null), confirm: K.current.confirm, position: { i: 1, n: queue.length } }) : null,
    ...(s.asks || []).map(a => h(Box, { key: a.id, flexDirection: 'column' }, h(AskCard, { text: a.text, cols }))), // ASK-SETTLE: open asks are live
    // TODO(contract v2): background agents. `background.status` is NOT in events v1, so nothing sets s.background today.
    s.background > 0 ? h(Box, { paddingLeft: 2 }, h(Text, { color: c('dim') }, `Waiting for ${s.background} background agent${s.background === 1 ? '' : 's'} to finish`)) : null,
    h(Pending, { pending: s.pending, steering: s.steering, cols }),
    AR.current.timer && AR.current.endsAt ? h(Box, { key: 'restart-countdown', paddingLeft: 2 }, h(Text, { color: c('accent'), bold: true }, countdownLine(Math.max(1, Math.ceil((AR.current.endsAt - Date.now()) / 1000)), cols))) : null,
    ruleAbove ? null : h(Box, { marginTop: 1 }),
    SU.current.isOpen() ? h(StepUpCard, { view: SU.current.view(), cols }) : LI.current.isOpen() ? h(LoginCard, { ...LI.current.view(), cols, profile }) : CN.current.isOpen() ? h(ConnectCard, { ...CN.current.view(), cols })
      : ring ? h(RingComposer, { buf: B.current, cols, mode: demoLabel ? 'demo' : MD.current, busy, placeholder, name: SN.current.name, model: ctxParts[2], topRule: !ruleAbove, ring, divider: s.divider ? { d: s.divider, slow: dividerSlowRef.current } : null })
        : h(Composer, { buf: B.current, cols, mode: demoLabel ? 'demo' : MD.current, busy, placeholder, name: SN.current.name, model: ctxParts[2], topRule: !ruleAbove }),
    !CN.current.isOpen() && PK.current.isOpen() && !card ? h(ListView, { ...PK.current.view(), cols }) : !CN.current.isOpen() && PL.current.isOpen() && !card ? h(ListView, { ...PL.current.view(), cols }) : null,
    h(RowsBar, { rows: RW.current.view(), cols }),
    h(PresentBar, { stepUp: SU.current, cols }),
    h(StatusLine, { cols, slot: where.current.slot, agent: where.current.agent, groups: [...SC.current.rooms].map(([name, e]) => ({ name, unread: e.unread })), parts: ctxParts, right: hint }),
    h(WaitingNotice, { items: s.waiting.filter(x => K.current.dismissed.has(x.callId)), cols }),
    h(NotifyBar, { approvals: s.notify.approvals, error: s.notify.error, cols, signedOut: Boolean(blocked), hideCount: approvalRowShown(), alerts: [...(s.notify.providerLines || []), ...(R.current.roster.all ? [] : R.current.roster.alerts)] }),
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
