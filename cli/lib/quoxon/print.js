/**
 * Headless mode: `quox --print "<prompt>"` sends one turn and exits.
 * (-p is --profile across quox, so print has no short flag.)
 * Exit codes: 0 completed, 2 held for approval, 3 interrupted, 4 auth, 5 unconfirmed
 * (stream closed without turn.finished), 1 other.
 */
import { textGate } from './events.js';
import { streamFields, fallbackNote } from './model.js';
import { connectOfferFor } from './connect.js';
import { isConsentError, consentPrintMessage } from './consent.js';

export const EXIT = { ok: 0, error: 1, approval: 2, interrupted: 3, auth: 4, unconfirmed: 5 };

export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  let s = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) s += chunk;
  return s;
}

/** Resolve the prompt: arg wins; absent or "-" reads stdin. */
export async function resolvePrompt(arg, stdin) {
  if (arg && arg !== '-') return arg;
  return (await readStdin(stdin)).replace(/\n+$/, '');
}

const isAuth = (e) => e?.status === 401 || /valid jwt|service key|unauthor|not authenticated/i.test(e?.message || '');
const newTurnId = () => `QXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Runs one turn. out/err are write(string) sinks. Returns the exit code. */
export async function runPrint({ api, prompt, agent = 'quox', output = 'text', conversation = null, turnId = newTurnId(), timeoutS = 0, color = false, stopGraceMs = 8000, context = undefined, choice = null, promptProfile = undefined, profile = null, out, err }) {
  if (!prompt || !prompt.trim()) { err('quox: empty prompt (pass --print "<prompt>" or pipe it on stdin)\n'); return EXIT.error; }
  const ctrl = new AbortController();
  let abandoned = false, graceTimer = null;
  // A timeout asks the SERVER to stop; only if it cannot (or does not answer in the grace) do we abandon the
  // local stream, and then we say "abandoned", never "interrupted": the server may still finish the turn.
  const requestStop = async () => {
    let r = { ok: false };
    try { if (api.interrupt) r = await api.interrupt(convo, turnId); } catch { r = { ok: false }; }
    if (r?.ok) graceTimer = setTimeout(() => { abandoned = true; ctrl.abort(); }, stopGraceMs);
    else { abandoned = true; ctrl.abort(); }
  };
  const timer = timeoutS > 0 ? setTimeout(requestStop, timeoutS * 1000) : null;
  const t0 = Date.now();
  const sum = { tools: 0, approvals: 0, receipts: [] };
  let convo = conversation, doneSession = null, status = null, text = '', sawApproval = false, errorMsg = null, authFail = false;
  const seen = new Set();
  let offer = null, handoff = null;
  let gate = null;
  try {
    for await (const ev of api.stream({ turnId, message: prompt, agent: agent || 'quox', conversationId: conversation, context, ...streamFields(choice), ...(promptProfile ? { promptProfile } : {}), ...(timeoutS > 0 ? { turnBudgetMs: timeoutS * 1000 } : {}) }, ctrl.signal)) {
      if (output === 'json') out(JSON.stringify(ev) + '\n');
      const fb = fallbackNote(choice, ev);
      if (fb) err(`quox: ${fb}\n`);
      if (!offer) offer = connectOfferFor(ev);
      if (ev.conversation_id) convo = ev.conversation_id;
      if (ev.session_id) doneSession = ev.session_id; // the server's real id: v1 events only echo the request
      if (ev.type === 'chunk' || ev.type === 'text.delta' || ev.type === 'turn.started') { const g = textGate(gate, ev); gate = g.st; if (g.append) text += ev.content; }
      else if (ev.type === 'done' && !text && ev.full_response) text = ev.full_response;
      else if (ev.type === 'tool.started' && !seen.has(ev.call_id)) { seen.add(ev.call_id); sum.tools++; }
      else if (ev.type === 'tool.finished') { if (!seen.has(ev.call_id)) { seen.add(ev.call_id); sum.tools++; } if (ev.receipt?.ward_seq != null) sum.receipts.push(ev.receipt.ward_seq); }
      else if (ev.type === 'approval.requested') { sawApproval = true; sum.approvals++; }
      else if (ev.type === 'approval.resolved') sawApproval = false;
      else if (ev.type === 'turn.handoff_suggested' && ev.handoff_suggested?.agent) handoff = ev.handoff_suggested; // QUOXON handoff offer
      else if (ev.type === 'turn.finished') status = ev.status || 'completed';
      else if (ev.type === 'error') errorMsg = isConsentError(ev) ? consentPrintMessage(ev, profile) : (ev.error || 'stream error');
    }
  } catch (e) {
    if (ctrl.signal.aborted) { status = 'abandoned'; errorMsg = `timed out after ${timeoutS}s; the server was not confirmed stopped`; }
    else { authFail = isAuth(e); errorMsg = e?.message || String(e); }
  } finally { if (timer) clearTimeout(timer); clearTimeout(graceTimer); }
  if (ctrl.signal.aborted && !status) { status = 'abandoned'; errorMsg = errorMsg || `timed out after ${timeoutS}s; the server was not confirmed stopped`; }
  if (doneSession) convo = doneSession;
  const serverStopped = abandoned && status === 'abandoned' ? false : status === 'interrupted' ? true : null;

  let code;
  if (authFail) code = EXIT.auth;
  else if (sawApproval && status !== 'interrupted' && status !== 'abandoned') { status = status === 'completed' || !status ? 'held_for_approval' : status; code = EXIT.approval; }
  else if (status === 'completed' && !errorMsg) code = EXIT.ok;
  else if (status === 'interrupted' || status === 'abandoned') code = EXIT.interrupted;
  else if (sawApproval) { status = status || 'held_for_approval'; code = EXIT.approval; }
  else if (!status && !errorMsg) { status = 'unconfirmed'; code = EXIT.unconfirmed; }
  else code = EXIT.error;
  if (!status) status = authFail ? 'auth' : 'failed';

  if (output === 'json') {
    out(JSON.stringify({ type: 'summary', status, turn_id: turnId, conversation_id: convo, duration_ms: Date.now() - t0, server_stopped: serverStopped, ...sum, ...(handoff ? { handoff_suggested: handoff } : {}) }) + '\n');
  } else if (text) out(text.endsWith('\n') ? text : text + '\n');
  if (authFail) err(`Not signed in for chat. Run: quox login -p <profile>\n`);
  else if (code === EXIT.approval) err('Held for approval: approve it in the dashboard or with `quox` /approvals.\n');
  else if (code === EXIT.unconfirmed) err('quox: Ended without confirmation from the server\n');
  else if (errorMsg) err(`quox: ${errorMsg}\n`);
  if (offer && code !== EXIT.ok) err(`${offer}\n`);
  // QUOXON handoff offer: no y/N here, so name the exact one-turn command (same question, same conversation).
  if (handoff && output !== 'json' && code === EXIT.ok) err(`quox: ${handoff.reason ? `${String(handoff.reason).replace(/\s+$/, '')} ` : ''}${handoff.name || handoff.agent} can answer it: quox --print --agent ${handoff.agent}${convo ? ` --conversation ${convo}` : ''} ${JSON.stringify(prompt)}\n`);
  return code;
}
