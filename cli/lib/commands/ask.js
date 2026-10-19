/**
 * `quox ask`: a session puts a fork in front of a human through the Approvals inbox (one inbox item, kind decision).
 * Who is asking, what, why, the options, the recommendation and the expiry travel with it, so ONE HITL session
 * can answer for twenty terminals. Not an approval of an action: no step-up PIN unless --high-risk.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import { readPresence, approvalPresenceFields } from './presence.js';
import { toRepoRelative, LOOSENING_HINT } from '../core/repoPath.js';
import { parseOptions, parseDuration, YN_OPTIONS, waitForDecision, EXIT_NO_ANSWER } from '../core/askDecision.js';

function heldSlotFor(session) {
  try {
    const all = JSON.parse(readFileSync(join(homedir(), '.quox', 'held-slots.json'), 'utf8'));
    const want = String(session || '').toLowerCase();
    return Object.keys(all).find((k) => String(all[k]?.session || '').toLowerCase() === want) || null;
  } catch { return null; }
}

export function registerAskCommands(program, { client, auth }) {
  const err = (s) => process.stderr.write(`${s}\n`);

  async function waitAndPrint(orgId, id, { timeoutSec = null } = {}) {
    const r = await waitForDecision({
      poll: (w) => { const ep = resolveEndpoint('inbox.decision.get', { orgId, id }); return client.get(ep.path, { service: ep.service, query: { wait: w }, timeout: (w + 15) * 1000, retries: 0 }); },
      log: err,
      maxWaitMs: timeoutSec != null ? timeoutSec * 1000 : null,
    });
    if (r.stdout) console.log(r.stdout);
    process.exitCode = r.code;
    return r;
  }

  const ask = program
    .command('ask')
    .description('Ask a human a question through the Approvals inbox: who asks, what, why, the options. Use this instead of asking in your own terminal')
    .option('--session <name>', 'which session is asking (default: $QUOX_SESSION)')
    .option('--title <text>', 'what you are asking, one line')
    .option('--why <text>', 'a simple why: what the human needs to know to decide')
    .option('--justify <text>', 'for a loosening (a check made easier to pass): why it is safe, in plain words; the card shows it on its JUSTIFY line and defaults to No without one')
    .option('--options <list>', 'the choices: "a: Ship now|b: Wait for review|c: Drop it"')
    .option('--yn', 'shorthand for a yes/no question (options y and n)')
    .option('--default <key>', 'the option you would take if nobody answers (shown, never applied for you)')
    .option('--recommend <key>', 'the option you recommend')
    .option('--expires <dur>', 'how long it stays open: 30m, 2h, 1d (default 24h, max 30d)')
    .option('--slot <name>', 'your slot, so the answer is also posted there (default: found from held slots)')
    .option('--agent <name>', 'the agent asking, when it is an agent rather than a session')
    .option('--high-risk', 'the answer needs the human step-up PIN')
    .option('--wait', 'block until answered; prints the chosen option key (and any note) on stdout, exits 2 on expiry or deny')
    .option('--timeout <dur>', 'with --wait: stop waiting after this long (the question stays open)')
    .action((options) => fileAsk(options));

  async function fileAsk(options) {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const session = options.session || process.env.QUOX_SESSION;
      if (!session) throw new Error('say which session is asking: --session <NAME>');
      if (!options.title) throw new Error('say what you are asking: --title "<what>"');
      if (options.yn && options.options) throw new Error('use --yn or --options, not both');
      if (!options.yn && !options.options) throw new Error('give the choices: --options "a: Ship now|b: Wait" (or --yn)');
      // QUOXON 2026-10-17: a high-risk ask (a loosening, anything the owner must PIN) carries a plain justification
      // 2026-10-19: three PIN approvals were wasted on loosening asks filed without --high-risk or with unusable paths
      if (!options.highRisk && /^\s*approve\s+(?:loosening|test)/i.test(options.title)) { err(`A test-edit approval must go through the loosening verb, which sets --high-risk and repo-relative paths for you:\n  ${LOOSENING_HINT}`); process.exitCode = 2; return; }
      if (options.highRisk && !String(options.justify || '').trim()) { err('High-risk asks need --justify "<2-3 plain lines the owner can judge>"'); process.exitCode = 2; return; }
      const opts = options.yn ? YN_OPTIONS : parseOptions(options.options);
      const body = {
        session, title: options.title, why: options.why, options: opts,
        ...(options.justify ? { justification: options.justify } : {}),
        default: options.default, recommend: options.recommend,
        ...(options.expires ? { expires_in_seconds: parseDuration(options.expires) } : {}),
        high_risk: Boolean(options.highRisk),
        slot: options.slot || heldSlotFor(session) || undefined,
        profile: program.opts().profile || process.env.QUOX_PROFILE || undefined,
        agent: options.agent,
      };
      const ep = resolveEndpoint('inbox.decision.create', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      // PRESENCE (owner 2026-10-16): say now whether the human is away, so this session can work on
      // something else instead of waiting. The question is filed and queued exactly as before.
      const presence = approvalPresenceFields(await readPresence(client, orgId));
      const d = { ...data.decision, ...presence };
      if (program.opts().output === 'json' && !options.wait) { console.log(JSON.stringify(d, null, 2)); return; }
      err(`asked: ${d.id} (${session}: ${d.title}); it shows in /approvals${d.expires_at ? `, open until ${d.expires_at}` : ''}`);
      if (presence.owner_away) err(`${presence.owner_away_notice}. Expect a wait: work on something else meanwhile.`);
      if (!options.wait) { console.log(d.id); return; }
      await waitAndPrint(orgId, d.id, { timeoutSec: options.timeout ? parseDuration(options.timeout) : null });
  }

  ask
    .command('loosening')
    .description('Ask a human to approve edits to test files (a check made easier to pass). Files a yes/no, high-risk (PIN) ask with repo-relative paths')
    .option('--paths <files...>', 'every test file the commit edits (absolute, worktree or repo-relative: all are normalised)')
    .option('--justify <text>', 'why it is safe, in plain words (required)')
    .option('--why <text>', 'detail: the findings, before and after lines')
    .option('--session <name>', 'which session is asking (default: $QUOX_SESSION)')
    .option('--slot <name>', 'your slot')
    .option('--expires <dur>', 'how long it stays open')
    .option('--wait', 'block until answered')
    .option('--timeout <dur>', 'with --wait: stop waiting after this long')
    .action(async (subOptions) => {
      // commander lets the parent `ask` swallow flags it shares with this verb (--justify, --why, --session...), so merge both
      const options = { ...ask.opts(), ...Object.fromEntries(Object.entries(subOptions).filter(([, v]) => v !== undefined)) };
      if (!String(options.justify || '').trim()) { err('say why it is safe: --justify "<plain words>"'); process.exitCode = 2; return; }
      const raw = [].concat(options.paths || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
      let root;
      try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { root = process.cwd(); }
      const paths = [...new Set(raw.map(toRepoRelative))];
      const missing = paths.filter((p) => !p || !existsSync(join(root, p)));
      if (!paths.length || missing.length) { err(`not found in this repo (${root}): ${missing.join(', ') || '(no paths)'}. Run from the worktree and name files that exist.`); process.exitCode = 2; return; }
      // 2026-10-19: the server truncates long titles, and the attestation names only paths found in title+body,
      // so a 7-file ask covered 3. Every path also goes in the body.
      const files = `Files (${paths.length}):\n${paths.map((p) => `- ${p}`).join('\n')}`;
      await fileAsk({ ...options, title: `Approve test edits: ${paths.join(' ')}`, why: options.why ? `${files}\n\n${options.why}` : files, yn: true, highRisk: true, justify: options.justify });
    });

  ask
    .command('status')
    .description('Show where a question stands: pending, answered, denied or expired, with the answer')
    .argument('<id>', 'the id `quox ask` printed')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('inbox.decision.get', { orgId, id });
      const d = (await client.get(ep.path, { service: ep.service })).decision;
      if (program.opts().output === 'json') { console.log(JSON.stringify(d, null, 2)); return; }
      console.log(`${d.state}${d.answer?.option ? ` ${d.answer.option}` : ''}${d.answer?.note ? ` (${d.answer.note})` : ''}`);
      if (d.state === 'expired' || d.state === 'denied') process.exitCode = EXIT_NO_ANSWER;
    });

  ask
    .command('wait')
    .description('Block until a question is answered; prints the chosen option key (and note), exits 2 on expiry or deny')
    .argument('<id>', 'the id `quox ask` printed')
    .option('--timeout <dur>', 'stop waiting after this long (the question stays open)')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await waitAndPrint(orgId, id, { timeoutSec: options.timeout ? parseDuration(options.timeout) : null });
    });
}
