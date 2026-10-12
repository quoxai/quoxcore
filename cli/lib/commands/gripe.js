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
    .option('--yes', 'skip the confirmation step and let GRIPE file it directly')
    .action(async (complaintParts, options) => {
      auth.requireAuth();
      const complaint = complaintParts.join(' ').trim();
      if (!complaint) throw new Error('say what is wrong: quox gripe "the thing that is broken"');

      // GRIPE's whole discipline is speed: it does not investigate, it files.
      // So the prompt states everything up front rather than inviting a
      // back-and-forth the terminal is a bad place for.
      const parts = [`File this gripe: ${complaint}`];
      if (options.repo) parts.push(`Repo: ${options.repo}.`);
      if (options.label) parts.push(`Label: ${options.label}.`);
      if (options.yes) parts.push('File it now without asking me to confirm.');
      else parts.push('Confirm the repo, label and title with me before filing.');

      printEvent(glyphLine('quox', 'filing gripe via GRIPE'));

      const ep = resolveEndpoint('chat.claude');
      const body = { prompt: parts.join(' '), selected_agent: 'gripe' };
      // The collector tracks which tools ran PER caller-supplied session_id;
      // sending none meant tools_used always came back [] and classification
      // fell back to parsing prose (DEVSUITE-GRIPE phase 5). One id per run.
      body.session_id = `GRIPE_CLI_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const orgId = resolveOrgId(auth, program);
      if (orgId) body.org_id = orgId;

      const data = await client.post(ep.path, { service: ep.service, body, timeout: 120000 });
      const response = data.result || data.response || data.text || '';

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }

      // tools_used is the collector's own record of which tools ran. Passing it
      // is what stops the outcome from depending on how the agent phrased its
      // reply. Absent (older collector), classification falls back to prose.
      const toolsUsed = Array.isArray(data.tools_used) ? data.tools_used : null;
      const outcome = classifyGripeResponse(response, { assumedYes: !!options.yes, toolsUsed });

      // quox#668: with --yes, a non-filing agent run is followed by the
      // deterministic file. Printing the agent's prose first ("no tool, cannot
      // file") right above "issue created" contradicted the real outcome. In
      // that case the agent's reply is superseded, so say so instead of
      // echoing a claim the next lines disprove.
      const deterministicNext = !!options.yes
        && ['no-connector', 'awaiting-confirm', 'not-filed'].some((k) => outcome.kind === k || outcome.hint === k);
      console.log('');
      if (deterministicNext) {
        printInfo('GRIPE agent did not file this itself; its reply is superseded by the direct filing below.');
      } else {
        console.log(response || '(no response)');
      }
      console.log('');

      if (outcome.kind === 'filed') {
        printEvent(events.created('quox', 'issue', outcome.url));
      } else if (outcome.kind === 'filed-unknown') {
        printWarning(
          'GRIPE called github_create_issue but no issue link came back. Check the repo before re-running: '
          + 'the issue may exist, and a re-run would file it twice.'
        );
      } else if (outcome.hint === 'no-connector' || outcome.kind === 'no-connector') {
        // quox#621: "no connector" from the AGENT is not proof the org lacks
        // one. The agent's tool-resolution can transiently fail (the gripe
        // filed on an immediate retry, same org) or the github_create_issue
        // tool may not be wired to this agent (#581) — while a healthy github
        // credential sits in the vault. The deterministic path resolves that
        // credential server-side over a DIFFERENT route (the /github/issues
        // proxy, not the agent tool), so with --yes we try it before believing
        // the agent: if a connector really exists this files it (turning a
        // silent-loss-then-retry into a first-try success); only if the vault
        // path ALSO cannot file is the connector genuinely missing, and only
        // then do we send the user to Settings.
        if (options.yes) {
          const det = await fileDeterministically({ client, complaint, options, orgId });
          if (!det?.filed) printWarning(NO_CONNECTOR_MESSAGE);
        } else {
          printWarning(NO_CONNECTOR_MESSAGE);
        }
      } else if (outcome.hint === 'auth-unavailable' || outcome.kind === 'auth-unavailable') {
        printWarning(AUTH_UNAVAILABLE_MESSAGE);
      } else if (outcome.hint === 'awaiting-confirm' || outcome.kind === 'awaiting-confirm') {
        if (options.yes) {
          await fileDeterministically({ client, complaint, options, orgId });
        } else {
          printInfo('GRIPE is asking you to confirm. Re-run with --yes to file it directly.');
        }
      } else if (outcome.kind === 'not-filed') {
        if (options.yes) {
          await fileDeterministically({ client, complaint, options, orgId });
        } else {
          printWarning('Not filed: github_create_issue was never called on this run.');
        }
      } else {
        printWarning('No issue URL came back, so treat this as NOT filed until you can see the issue.');
      }
    });
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
export async function fileDeterministically({ client, complaint, options, orgId }) {
  const repoArg = options.repo || 'quoxai/quox';
  const [owner, repo] = repoArg.includes('/') ? repoArg.split('/', 2) : ['quoxai', repoArg];
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
      },
    });
    const url = data?.issue?.html_url || data?.issue?.url || null;
    if (url) {
      printEvent(events.created('quox', 'issue', url));
      printInfo('Filed via the deterministic path (the GRIPE agent run did not file; --yes now guarantees the file).');
      return { filed: true, url };
    }
    printWarning('Deterministic file returned no issue URL; treat as NOT filed until you can see the issue.');
    return { filed: false };
  } catch (err) {
    printWarning(`Not filed: the GRIPE run did not file and the deterministic fallback failed too (${err.message}).`);
    return { filed: false, error: err.message };
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
export function classifyGripeResponse(response, { assumedYes = false, toolsUsed = null } = {}) {
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
    return { kind: 'not-filed', certain: true, hint: adviceHint(text, assumedYes) };
  }

  // No structured evidence available (an older collector, or a surface that
  // does not return tools_used). Fall back to the prose-only classification,
  // unchanged, rather than degrading every caller to "unknown".
  const hint = adviceHint(text, assumedYes);
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
function adviceHint(text, assumedYes) {
  // Platform-side authorization/availability failures beat the no-connector
  // guess. On 2026-09-21 auth's rate limiter 429'd the collector's membership
  // verify, the tool call 403'd with "no active membership", GRIPE narrated
  // "GitHub isn't connected", and this function turned a platform outage into
  // "the org has no GitHub connector configured" — a confident falsehood while
  // the vault held three healthy credentials (quox#565). These shapes come
  // from the collector's own error strings, so match them FIRST.
  if (
    /membership/i.test(text) ||
    /verification .{0,20}unavailable/i.test(text) ||
    /auth service did not answer/i.test(text) ||
    /\b(403|503|429)\b/.test(text)
  ) {
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
