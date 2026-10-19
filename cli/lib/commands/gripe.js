/**
 * `quox gripe` — QUOXIFY PASS 2 (DEVSUITE phase 15).
 *
 * The bundle audit (note #2840, theme S9) found Gripe had no `quox` verb at
 * all, despite one being in its own definition of done. The customer-facing
 * filing path was chat-agent-only, which meant a user had to know an agent
 * existed and open a chat surface to report that something was broken. The
 * fastest possible complaint is a one-liner in the terminal you are already
 * in, which is exactly what the original terminal-only gripe skill was for.
 *
 * This wraps the WORKING path rather than building a second one: it talks to
 * the GRIPE agent over the same governed chat route the dashboard and the
 * Discord/Telegram bridges use, and GRIPE files the issue through the GitHub
 * connector. No parallel issue store, no second credential model (the audit
 * flagged three entry paths with three credential models; this adds a fourth
 * ENTRY but reuses the third's governed path deliberately).
 *
 * Honest prerequisite, per the audit's "disclose the prereq" finding: filing
 * needs a configured GitHub connector for the org. If it is missing, the
 * agent says so and this command surfaces that plainly instead of pretending
 * an issue was created.
 */

import { formatDetail, printInfo, printWarning } from '../core/output.js';
import { events, line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

export function registerGripeCommands(program, { client, auth }) {
  program
    .command('gripe')
    .description('File a one-liner complaint as a GitHub issue (via the GRIPE agent)')
    .argument('<complaint...>', 'the gripe, e.g. "sidebar tooltip clips on resize"')
    .option('--repo <owner/name>', 'target repo (GRIPE defaults sensibly when omitted)')
    .option('--label <label>', 'issue label, e.g. bug, idea, fleet')
    .option('--public', 'confirm filing to a PUBLIC repo (asks y/N; refused if text has internal hostnames/paths)')
    .option('--yes', 'skip the confirmation step and let GRIPE file it directly')
    .action(async (complaintParts, options) => {
      auth.requireAuth();
      const complaint = complaintParts.join(' ').trim();
      if (!complaint) throw new Error('say what is wrong: quox gripe "the thing that is broken"');

      const orgId = resolveOrgId(auth, program);
      if (options.public) {
        // QUOXON-PRIVACY: public repos only via the deterministic path with a
        // human y/N; the GRIPE agent can never confirm a public filing.
        if (!options.repo) throw new Error('--public needs an explicit --repo <name>');
        const r = await fileDeterministically({ client, complaint, options, orgId, confirmPublic: promptConfirmPublic });
        if (!r.filed) process.exitCode = 1;
        return;
      }
      printEvent(glyphLine('quox', 'filing gripe via GRIPE'));
      const data = await askGripe({ client, complaint, repo: options.repo, label: options.label, yes: !!options.yes, orgId });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }

      const r = await settleGripe({ client, data, complaint, options, orgId });
      console.log('');
      if (r.superseded) printInfo(SUPERSEDED_MESSAGE);
      else console.log(r.response || '(no response)');
      console.log('');
      for (const n of r.notes) {
        if (n.kind === 'created') printEvent(events.created('quox', 'issue', n.url));
        else if (n.kind === 'info') printInfo(n.text);
        else printWarning(n.text);
      }
    });
}

const SUPERSEDED_MESSAGE = 'GRIPE agent did not file this itself; its reply is superseded by the direct filing below.';

/**
 * Ask the GRIPE agent to file `complaint` over the governed chat route. -> the raw chat response.
 * Shared by `quox gripe` and the quox client's /gripe, so there is one filing path.
 */
export async function askGripe({ client, complaint, repo, label, yes = false, orgId = null }) {
  // GRIPE's whole discipline is speed: it does not investigate, it files.
  // So the prompt states everything up front rather than inviting a
  // back-and-forth the terminal is a bad place for.
  const parts = [`File this gripe: ${complaint}`];
  if (repo) parts.push(`Repo: ${repo}.`);
  if (label) parts.push(`Label: ${label}.`);
  if (yes) parts.push('File it now without asking me to confirm.');
  else parts.push('Confirm the repo, label and title with me before filing.');
  const ep = resolveEndpoint('chat.claude');
  const body = { prompt: parts.join(' '), selected_agent: 'gripe' };
  // The collector tracks which tools ran PER caller-supplied session_id;
  // sending none meant tools_used always came back [] and classification
  // fell back to parsing prose (DEVSUITE-GRIPE phase 5). One id per run.
  body.session_id = `GRIPE_CLI_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (orgId) body.org_id = orgId;
  return client.post(ep.path, { service: ep.service, body, timeout: 120000 });
}

/**
 * Decide the outcome of a GRIPE run and, with yes, run the deterministic file when the agent did not.
 * -> { response, outcome, superseded, url, notes: [{ kind: 'created', url } | { kind: 'info'|'warn', text }] }.
 * Prints nothing: the caller renders the notes (console for `quox gripe`, history lines for /gripe).
 */
export async function settleGripe({ client, data, complaint, options = {}, orgId = null }) {
  const response = data?.result || data?.response || data?.text || '';
  const yes = !!options.yes;
  // tools_used is the collector's own record of which tools ran. Passing it
  // is what stops the outcome from depending on how the agent phrased its
  // reply. Absent (older collector), classification falls back to prose.
  const toolsUsed = Array.isArray(data?.tools_used) ? data.tools_used : null;
  const outcome = classifyGripeResponse(response, { assumedYes: yes, toolsUsed, complaint });
  // quox#668: with --yes, a non-filing agent run is followed by the
  // deterministic file. Printing the agent's prose first ("no tool, cannot
  // file") right above "issue created" contradicted the real outcome. In
  // that case the agent's reply is superseded, so say so instead of
  // echoing a claim the next lines disprove.
  const superseded = yes && ['no-connector', 'awaiting-confirm', 'not-filed'].some((k) => outcome.kind === k || outcome.hint === k);
  const notes = [];
  let url = null;
  const det = async () => {
    const r = await fileDeterministically({ client, complaint, options, orgId, quiet: true });
    notes.push(...r.notes); if (r.url) url = r.url;
    return r;
  };
  if (outcome.kind === 'filed') {
    url = outcome.url; notes.push({ kind: 'created', url });
  } else if (outcome.kind === 'filed-unknown') {
    notes.push({ kind: 'warn', text: 'GRIPE called github_create_issue but no issue link came back. Check the repo before re-running: '
      + 'the issue may exist, and a re-run would file it twice.' });
  } else if (outcome.hint === 'no-connector' || outcome.kind === 'no-connector') {
    // quox#621: "no connector" from the AGENT is not proof the org lacks
    // one. The agent's tool-resolution can transiently fail (the gripe
    // filed on an immediate retry, same org) or the github_create_issue
    // tool may not be wired to this agent (#581), while a healthy github
    // credential sits in the vault. The deterministic path resolves that
    // credential server-side over a DIFFERENT route (the /github/issues
    // proxy, not the agent tool), so with --yes we try it before believing
    // the agent: if a connector really exists this files it (turning a
    // silent-loss-then-retry into a first-try success); only if the vault
    // path ALSO cannot file is the connector genuinely missing, and only
    // then do we send the user to Settings.
    if (yes) {
      const r = await det();
      if (!r.filed) notes.push({ kind: 'warn', text: NO_CONNECTOR_MESSAGE });
    } else {
      notes.push({ kind: 'warn', text: NO_CONNECTOR_MESSAGE });
    }
  } else if (outcome.hint === 'auth-unavailable' || outcome.kind === 'auth-unavailable') {
    notes.push({ kind: 'warn', text: AUTH_UNAVAILABLE_MESSAGE });
  } else if (outcome.hint === 'awaiting-confirm' || outcome.kind === 'awaiting-confirm') {
    if (yes) await det();
    else notes.push({ kind: 'info', text: 'GRIPE is asking you to confirm. Re-run with --yes to file it directly.' });
  } else if (outcome.kind === 'not-filed') {
    if (yes) await det();
    else notes.push({ kind: 'warn', text: 'Not filed: github_create_issue was never called on this run.' });
  } else {
    notes.push({ kind: 'warn', text: 'No issue URL came back, so treat this as NOT filed until you can see the issue.' });
  }
  return { response, outcome, superseded, url, notes };
}

// quox#478: --yes must GUARANTEE a headless file, not merely ask the model
// nicely. When the LLM run verifiably did not file (tools_used is the
// collector's own record), fall back to the governed GitHub proxy
// (POST /github/issues: user-authed, entitlement-gated, credential resolved
// from the org vault server-side) and file deterministically. Deliberately
// NOT run after 'filed-unknown' (the issue may exist; a second file would
// duplicate it). It IS now run after 'no-connector' with --yes (quox#621):
// the proxy resolves the vault credential over a DIFFERENT route than the
// agent tool, so it succeeds when the agent merely failed to resolve/​wire the
// tool (#581) — and the caller falls back to NO_CONNECTOR_MESSAGE only if this
// also cannot file. Still NOT auto-run after auth-unavailable (a 403/429/503
// is a platform outage the proxy would hit too; retrying shortly is the fix).
// Returns { filed, url?, error? } so the caller can decide the message.
async function promptConfirmPublic(repo) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`${repo} is PUBLIC. This issue will be world-readable. File it? [y/N] `);
    return /^y(es)?$/i.test(a.trim());
  } finally { rl.close(); }
}

export async function fileDeterministically({ client, complaint, options, orgId, quiet = false, confirmPublic = null }) {
  const notes = [];
  const say = (n) => { notes.push(n); if (quiet) return; if (n.kind === 'created') printEvent(events.created('quox', 'issue', n.url)); else if (n.kind === 'info') printInfo(n.text); else printWarning(n.text); };
  const repoArg = options.repo || 'quoxai/quox';
  const [owner, repo] = repoArg.includes('/') ? repoArg.split('/', 2) : ['quoxai', repoArg];
  let confirmed = false;
  if (options.public) {
    confirmed = typeof confirmPublic === 'function' ? !!(await confirmPublic(`${owner}/${repo}`)) : false;
    if (!confirmed) { say({ kind: 'warn', text: 'Not filed: public filing was not confirmed.' }); return { filed: false, notes }; }
  }
  const firstLine = complaint.split('\n')[0];
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const ep = resolveEndpoint('github.issue.create');
  try {
    const data = await client.post(ep.path, {
      service: ep.service,
      body: {
        owner,
        repo,
        title,
        body: `## Gripe\n${complaint}\n\n## Context\n- Filed deterministically by \`quox gripe --yes\` (the GRIPE agent run did not file; quox#478 guarantee path)\n- Priority: minor / off-task observation\n\n## Suggested Action\nInvestigate and fix if confirmed.`,
        labels: [options.label || 'fleet/qa'],
        ...(orgId ? { org_id: orgId } : {}),
        ...(confirmed ? { confirm_public: true } : {}),
      },
    });
    const url = data?.issue?.html_url || data?.issue?.url || null;
    if (url) {
      say({ kind: 'created', url });
      say({ kind: 'info', text: 'Filed via the deterministic path (the GRIPE agent run did not file; --yes now guarantees the file).' });
      return { filed: true, url, notes };
    }
    say({ kind: 'warn', text: 'Deterministic file returned no issue URL; treat as NOT filed until you can see the issue.' });
    return { filed: false, notes };
  } catch (err) {
    say({ kind: 'warn', text: `Not filed: the GRIPE run did not file and the deterministic fallback failed too (${err.message}).` });
    return { filed: false, error: err.message, notes };
  }
}

const NO_CONNECTOR_MESSAGE =
  'No issue was filed: the org has no GitHub connector configured. Set one up in Settings > Integrations, then re-run.';

const AUTH_UNAVAILABLE_MESSAGE =
  'No issue was filed: a platform authorization step failed (membership verify or credential resolve did not answer). '
  + 'This is NOT a missing GitHub connector. Retry shortly; if it persists, check auth service health.';

/**
 * Decide what actually happened from GRIPE's reply.
 *
 * Split out of the action handler so it can be tested against real agent
 * wording. The missing-connector branch used to match
 * /not configured|no github|credential|connector/i, which does not match what
 * the agent actually says. Observed live on 2026-08-23:
 *
 *   "GitHub isn't connected for this org, no issue-filing tool is available
 *    right now. Connect GitHub in Settings > Integrations and I'll file it
 *    immediately after. I'm not fabricating an issue number."
 *
 * None of the four alternatives appear in that sentence, so the specific,
 * actionable "connect GitHub in Settings" advice was skipped and the user got
 * the generic "treat this as NOT filed" instead. Both are honest, which is why
 * this never showed up as a bug: it degraded to a vaguer truth rather than a
 * falsehood. It still costs the user the one sentence that says what to do.
 *
 * Matching prose with a regex is fragile by nature and this will drift again
 * when the agent's phrasing changes. It is deliberately biased toward the
 * generic branch: a missed connector hint is a papercut, whereas wrongly
 * claiming a connector problem would send someone to Settings for a fault
 * that is not there. The URL check stays first and stays authoritative, since
 * a real issue link is the only thing that proves filing.
 */
export function classifyGripeResponse(response, { assumedYes = false, toolsUsed = null, complaint = '' } = {}) {
  const text = String(response ?? '');
  const url = (text.match(/https:\/\/github\.com\/\S+\/issues\/\d+/) || [])[0];
  if (url) return { kind: 'filed', url, certain: true };

  // The Claude CLI's own error for a NATIVE call to a tool that is not native.
  // In CLI-tools mode the catalogue runs only via `quox tool exec`, so this
  // string means github_create_issue never ran (2026-10-10: every --yes gripe
  // fell to "unknown" on it and never reached the direct filing).
  if (/No such tool available/i.test(text)) {
    return { kind: 'not-filed', certain: true, hint: null };
  }

  // Structured evidence beats prose. The collector returns `tools_used` on
  // every chat response, so whether github_create_issue actually RAN is a fact,
  // not something to infer from English. Reading the outcome out of the agent's
  // wording is what this function got wrong twice: once when the
  // missing-connector phrasing changed, once when the bare word "connector"
  // matched a healthy reply. A third regex patch would be the same mistake
  // again, so the outcome now comes from the tool list and prose is demoted to
  // a HINT about what to advise, where being wrong costs a sentence rather than
  // a false claim.
  // An EMPTY list is NOT evidence. The collector tracks MCP tool calls per
  // caller-supplied session_id, so a request that sends none gets [] back
  // whether or not the tool ran. Reading that as "never called" would replace a
  // hedged truth with a confident falsehood and invite a duplicate issue.
  // Absence of evidence is not evidence of absence.
  if (Array.isArray(toolsUsed) && toolsUsed.length > 0) {
    const ran = toolsUsed.some((t) => String(t).endsWith('github_create_issue'));
    if (ran) {
      // The tool ran and returned no link. Saying "filed" would invent an
      // issue; saying "not filed" would send the user to file a duplicate.
      return { kind: 'filed-unknown', certain: true };
    }
    return { kind: 'not-filed', certain: true, hint: adviceHint(text, assumedYes, complaint) };
  }

  // No structured evidence available (an older collector, or a surface that
  // does not return tools_used). Fall back to the prose-only classification,
  // unchanged, rather than degrading every caller to "unknown".
  const hint = adviceHint(text, assumedYes, complaint);
  if (hint === 'no-connector') return { kind: 'no-connector' };
  if (hint === 'auth-unavailable') return { kind: 'auth-unavailable' };
  if (hint === 'awaiting-confirm') return { kind: 'awaiting-confirm' };
  return { kind: 'unknown' };
}

/**
 * What to ADVISE when nothing was filed. This is a hint, never an outcome:
 * getting it wrong costs the user one unhelpful sentence, where getting the
 * outcome wrong costs them a duplicate issue or a phantom one.
 *
 * @returns {'no-connector'|'awaiting-confirm'|null}
 */
// The platform-failure shapes adviceHint matches first. Each is a global regex so a match can be blanked.
const AUTH_SIGNALS = [/membership/gi, /verification .{0,20}unavailable/gi, /auth service did not answer/gi, /\b(403|503|429)\b/g];

function adviceHint(text, assumedYes, complaint = '') {
  // 2026-10-17: GRIPE's confirmation reply echoes the complaint, so a gripe ABOUT an HTTP 403 (or the membership
  // page) read as a platform auth failure and "File it?" became "a platform authorization step failed". A signal
  // counts only where the user did not write it: whatever the complaint itself contains is blanked first.
  const userText = String(complaint || '');
  let authText = text;
  for (const re of AUTH_SIGNALS) {
    for (const m of new Set(userText.match(re) || [])) authText = authText.split(m).join(' ');
  }
  // Platform-side authorization/availability failures beat the no-connector
  // guess. On 2026-09-21 auth's rate limiter 429'd the collector's membership
  // verify, the tool call 403'd with "no active membership", GRIPE narrated
  // "GitHub isn't connected", and this function turned a platform outage into
  // "the org has no GitHub connector configured" — a confident falsehood while
  // the vault held three healthy credentials (quox#565). These shapes come
  // from the collector's own error strings, so match them FIRST.
  if (AUTH_SIGNALS.some((re) => { re.lastIndex = 0; return re.test(authText); })) {
    return 'auth-unavailable';
  }

  // Every alternative here must carry its own NEGATION. The bare words
  // `credential` and `connector` used to be alternatives on their own, and on
  // 2026-08-23 that fired on a reply where GRIPE said "Yes, I can see it" and
  // then echoed the user's word inside the proposed issue title. The CLI told
  // the user to go configure a connector that was working. `connector` and
  // `credential` are what this feature is ABOUT, so they appear in healthy
  // replies constantly; only a negation makes them evidence of anything.
  const noConnector =
    /not configured/i.test(text) ||
    /no github/i.test(text) ||
    /github (is|isn't|is not|was not|wasn't)\s*(n't)?\s*connect/i.test(text) ||
    /no issue[- ]filing tool/i.test(text) ||
    /connect github/i.test(text) ||
    /no (\w+ ){0,2}(credential|connector|integration)/i.test(text) ||
    /(credential|connector|integration)s?\s+(is|are)\s+(not|un)(configured|available|connected|set)/i.test(text);
  if (noConnector) return 'no-connector';

  // Only meaningful when the caller did NOT pass --yes: with --yes the prompt
  // already told GRIPE to file without asking, so a reply with no URL is an
  // unknown outcome, not a confirmation prompt.
  if (!assumedYes) return 'awaiting-confirm';
  return null;
}
