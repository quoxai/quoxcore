/**
 * `quox qlarity` — governed browser inspection from the terminal.
 *
 * House gate: nothing ships without CLI parity, and it matters more here than
 * usual. Qlarity exists so an agent stops guessing at runtime state and stops
 * asking a human to paste the console. An agent reaches for a CLI, not a
 * dashboard panel, so this IS the primary surface and the view mirrors it.
 *
 * Every call goes through the collector proxy, which is the governed boundary:
 * it resolves the org, enforces the licence gate and emits the AEE envelope.
 * There is no direct-to-service flag, deliberately — BLUEPRINT defect 5.1 is
 * exactly a standalone CLI that defaults to the ungoverned path, and this
 * command was written after that finding rather than before it.
 *
 * The one-shot form is the one people will actually use:
 *
 *     quox qlarity read http://localhost:5173/ --selector .card --inspector pseudo_style
 *
 * It opens a session, reads, prints, and closes. A leaked session is a browser
 * context sitting on the server until the reaper takes it, so the convenient
 * path is also the tidy one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

/**
 * Rethrow so bin/quox.js's handleError sets the house exit code (3 auth,
 * 7 network, statusToExitCode otherwise). An earlier version caught
 * everything and exited 1, which looked fine and quietly broke the contract
 * every other command keeps: `quox plan` exits 3 on an expired session and
 * this exited 1 for the same cause.
 *
 * The added value here is the EXPLANATION, not the exit code, so annotate and
 * rethrow rather than swallow.
 */
function annotate(err) {
  const msg = err?.message || String(err);
  if (/not licensed/i.test(msg)) {
    err.message = `${msg}\nThe service is running and refusing you: that is the licence gate working, not a fault.`;
  } else if (/egress_denied|not_in_allowlist/i.test(msg)) {
    err.message = `${msg}\nThe origin is not on this deployment's allowlist. Default-deny is the policy; widen it deliberately.`;
  } else if (/org_context_required/i.test(msg)) {
    err.message = `${msg}\nNo organisation context. Run \`quox auth login\` or select an org first.`;
  }
  throw err;
}

// quox#907: a browser login is slower than a read; well above the client's 30s default.
const LOGIN_TIMEOUT_MS = 120000;

async function call(client, id, params = {}, body, extra = {}) {
  const ep = resolveEndpoint(id, params);
  const opts = { service: ep.service, ...extra };
  if (body) opts.body = body;
  switch (ep.method) {
    case 'POST': return client.post(ep.path, opts);
    case 'DELETE': return client.delete(ep.path, opts);
    default: return client.get(ep.path, opts);
  }
}

/**
 * Local bookkeeping for `quox qlarity login` (issue #15): which server-side
 * session, per origin, THIS CLI created and successfully logged in. This is
 * deliberately client-side rather than a qlarity/collector concept — the
 * server has no notion of "a session the CLI is allowed to reuse", only
 * sessions and their org. A one-shot verb cross-checks an entry here against
 * the server's live session list (see findReusableSessionId) before ever
 * trusting it, so a stale or server-reaped entry is never silently reused.
 */
function qlaritySessionsFile() {
  return path.join(os.homedir(), '.local', 'share', 'quox', 'qlarity-sessions.json');
}

function readLoggedInSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(qlaritySessionsFile(), 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLoggedInSessions(map) {
  const file = qlaritySessionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

/**
 * Pure matcher, exported for unit tests: given the CLI's own origin ->
 * session bookkeeping and the ORG's live session list (from
 * `qlarity.sessions.list`), decide which session id (if any) is safe to
 * reuse for `targetOrigin`. A recorded session that the server no longer
 * lists (reaped, closed, or belonging to a different org entirely) is never
 * reused — that would either 404 or silently attach to the wrong context.
 * @param {Record<string, {sessionId: string}>} loggedInMap
 * @param {Array<{id: string}>} liveSessions
 * @param {string} targetOrigin
 * @returns {string|null}
 */
export function findReusableSessionId(loggedInMap, liveSessions, targetOrigin) {
  const entry = loggedInMap?.[targetOrigin];
  if (!entry?.sessionId) return null;
  const alive = Array.isArray(liveSessions) && liveSessions.some((s) => s.id === entry.sessionId);
  return alive ? entry.sessionId : null;
}

/**
 * The one-shot lifecycle every single-page command shares: reuse a session
 * `quox qlarity login` already authenticated for this origin when one is
 * still live, otherwise create a fresh one, then open the url on it.
 *
 * Callers are responsible for closing a FRESH session on every exit path
 * (see `read` below) — that half is NOT folded in here, because a command
 * that fails between open and its own work still needs the session id to
 * close it, AND a reused/explicit session must never be auto-closed by a
 * one-shot verb (that would silently log the caller back out). The
 * `reused` flag on the return value is what a caller uses to decide.
 */
async function openSession(client, url, { waitUntil, extraWaitMs, sessionId: explicitSessionId } = {}) {
  let sessionId = explicitSessionId || null;
  let reused = Boolean(explicitSessionId);

  if (!sessionId) {
    try {
      const origin = new URL(url).origin;
      const loggedIn = readLoggedInSessions();
      if (loggedIn[origin]) {
        const live = await call(client, 'qlarity.sessions.list');
        const reusable = findReusableSessionId(loggedIn, live.sessions || [], origin);
        if (reusable) {
          sessionId = reusable;
          reused = true;
        } else {
          // Stale bookkeeping (the session was reaped or closed server-side):
          // drop it so the next one-shot does not re-check a dead session id.
          delete loggedIn[origin];
          writeLoggedInSessions(loggedIn);
        }
      }
    } catch {
      // Reuse is an optimisation, never a hard requirement — fall through to
      // creating a fresh session exactly as before this feature existed.
    }
  }

  if (!sessionId) {
    const s = await call(client, 'qlarity.session.create', {}, {});
    sessionId = s.id;
  }

  const openBody = { url };
  // SPA pages finish rendering AFTER the load event, so a plain 'load' capture
  // catches a splash/initialising screen. These pass through to qlarity's
  // navigate (wait_until + extra_wait_ms) so one-shots can wait for the app.
  if (waitUntil) openBody.wait_until = waitUntil;
  if (extraWaitMs) openBody.extra_wait_ms = extraWaitMs;
  let opened;
  try {
    opened = await call(client, 'qlarity.session.open', { sessionId }, openBody);
  } catch (err) {
    // quox#680: this throws BEFORE the caller learns the session id, so the
    // caller's finally cannot close it. A FRESH session is closed right here
    // (three failed opens used to fill the org's 3-session cap -> 429). A
    // reused/logged-in session is left alone, same as the callers' rule.
    if (!reused) {
      try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* reaper will get it */ }
    }
    throw err;
  }
  return { sessionId, opened, reused };
}

/** Shared parse of the settle options common to the one-shot inspection verbs. */
function settleOpts(options) {
  const out = {};
  if (options.waitUntil) out.waitUntil = options.waitUntil;
  if (options.settle) {
    const ms = parseInt(options.settle, 10);
    if (Number.isFinite(ms) && ms > 0) out.extraWaitMs = ms;
  }
  return out;
}

/**
 * quox#735: parse `--viewport WxH` and `--device-scale-factor n` for screenshot.
 * Bounds mirror qlarity's server-side check (min 320x320, max 3840x2160, dsf
 * 1-3) so a bad value fails here, before a session is created. Returns the
 * body fragment to merge into the screenshot request ({} when neither given).
 * @throws {Error} with a plain message on invalid input
 */
export function parseCaptureGeometryOptions({ viewport, deviceScaleFactor } = {}) {
  const out = {};
  if (viewport !== undefined) {
    const m = /^(\d+)x(\d+)$/i.exec(String(viewport).trim());
    if (!m) throw new Error(`Invalid --viewport "${viewport}": expected WxH, e.g. 1440x900`);
    const width = parseInt(m[1], 10);
    const height = parseInt(m[2], 10);
    if (width < 320 || height < 320 || width > 3840 || height > 2160) {
      throw new Error(`Invalid --viewport ${width}x${height}: must be between 320x320 and 3840x2160`);
    }
    out.viewport = { width, height };
  }
  if (deviceScaleFactor !== undefined) {
    const n = Number(deviceScaleFactor);
    if (!Number.isFinite(n) || n < 1 || n > 3) {
      throw new Error(`Invalid --device-scale-factor "${deviceScaleFactor}": must be a number from 1 to 3`);
    }
    out.device_scale_factor = n;
  }
  return out;
}

/** Where one-shot screenshots land. Binary, so stdout is the wrong place. */
function screenshotDir() {
  return path.join(os.homedir(), '.local', 'share', 'quox', 'qlarity-shots');
}

function screenshotFilename(url) {
  let host = 'page';
  try { host = new URL(url).hostname || host; } catch { /* keep default */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${host}-${ts}.png`;
}

export function registerQlarityCommands(program, ctx) {
  const { client } = ctx;

  const q = program
    .command('qlarity')
    .description('Qlarity: open a page, ask it a question, keep the receipt');

  // quox#560: `read`/`console`/`network` declare their own local `--json`
  // flag (for `--json` without a preceding `-o`/`--output`), which
  // `mergeShadowedGlobals` (lib/core/global-flags.js) correctly hands down
  // when the root `--json` shorthand is used. But the root's OTHER, equally
  // canonical way to request JSON — `-o json` / `--output json`, which every
  // other command in the CLI honours via `program.opts().output` — is a
  // DIFFERENT attribute name (`output`, not `json`) that these subcommands
  // never declare locally, so there is nothing for the merge hook to hand
  // down and `-o json qlarity read ...` silently fell back to table-ish
  // text output. Checking the root's resolved output format here alongside
  // the local flag makes both spellings equivalent, matching every other
  // command.
  const wantsJson = (options) => Boolean(options.json) || program.opts().output === 'json';

  q.command('health')
    .description('Service health through the governed proxy')
    .action(async () => {
      try {
        const d = await call(client, 'qlarity.health');
        process.stdout.write(`\u{1F50D} QLARITY: ${d.status} — ${d.sessions} session(s), egress ${d.egress}\n`);
      } catch (err) {
        annotate(err);
      }
    });

  q.command('allowlist')
    .description('Which origins this deployment may inspect')
    .action(async () => {
      try {
        const d = await call(client, 'qlarity.allowlist');
        process.stdout.write(`policy: ${d.policy}\n`);
        if (!d.entries?.length) {
          process.stdout.write('no origins declared — nothing can be inspected (safe default)\n');
        } else {
          for (const e of d.entries) process.stdout.write(`  ${e}\n`);
        }
      } catch (err) {
        annotate(err);
      }
    });

  // NO-ENV-ONLY-CONFIG (2026-08-18). `allowlist` above reports the install-wide
  // env list an operator set on the host. THIS group is the one a customer can
  // change themselves, which is what makes QLarity usable by its own buyer:
  // before it, a new org opened QLarity, was told nothing could be inspected,
  // and had no way to declare an origin without shell access.
  const al = q.command('origins')
    .description("The origins THIS org may inspect (add/remove without touching the host)");

  al.command('list', { isDefault: true })
    .description('Show this org\'s declared origins, and the install-wide ones')
    .action(async () => {
      try {
        const d = await call(client, 'qlarity.orgAllowlist.list');
        process.stdout.write(`policy: ${d.policy}\n`);
        if (d.origins?.length) {
          process.stdout.write('this org:\n');
          for (const e of d.origins) process.stdout.write(`  ${e.origin}${e.note ? `  (${e.note})` : ''}\n`);
        } else {
          process.stdout.write("this org: none declared yet — add one with `quox qlarity origins add <origin>`\n");
        }
        if (d.install_wide?.length) {
          process.stdout.write('install-wide (set by the operator, applies to every org):\n');
          for (const e of d.install_wide) process.stdout.write(`  ${e}\n`);
        }
      } catch (err) {
        annotate(err);
      }
    });

  al.command('add <origin>')
    .description('Declare an origin this org may inspect, e.g. https://staging.example.com')
    .option('--note <text>', 'why it is allowed, shown alongside it later')
    .action(async (origin, opts) => {
      try {
        const d = await call(client, 'qlarity.orgAllowlist.add', {}, { origin, note: opts.note });
        process.stdout.write(`\u{1F50D} QLARITY: added ${d.entry.origin}\n`);
        process.stdout.write(`  ${d.origins.length} origin(s) now declared for this org\n`);
      } catch (err) {
        // A refusal here is usually a wildcard or a typo, and the server sends
        // the reason. Surface it instead of a bare 400.
        if (err?.status === 400 && err?.message) {
          process.stderr.write(`Not added: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        annotate(err);
      }
    });

  al.command('remove <origin>')
    .description('Stop allowing an origin')
    .action(async (origin) => {
      try {
        const d = await call(client, 'qlarity.orgAllowlist.remove', { origin });
        if (d.removed) process.stdout.write(`\u{1F50D} QLARITY: removed ${origin}\n`);
        else process.stdout.write(`nothing to remove: ${origin} was not declared for this org\n`);
      } catch (err) {
        annotate(err);
      }
    });

  q.command('inspectors')
    .description('The named reads available (data in, never code)')
    .action(async () => {
      try {
        const d = await call(client, 'qlarity.inspectors.list');
        for (const i of d.inspectors || []) {
          process.stdout.write(`  ${i.name.padEnd(16)} ${i.describe}\n`);
        }
      } catch (err) {
        annotate(err);
      }
    });

  q.command('sessions')
    .description('Open sessions for this org')
    .action(async () => {
      try {
        const d = await call(client, 'qlarity.sessions.list');
        if (!d.sessions?.length) { process.stdout.write('no open sessions\n'); return; }
        for (const s of d.sessions) {
          process.stdout.write(`  ${s.id}  ${s.url || '(no page)'}  last used ${s.last_used_at}\n`);
        }
      } catch (err) {
        annotate(err);
      }
    });

  q.command('close <sessionId>')
    .description('Close a session and free its browser context')
    .action(async (sessionId) => {
      try {
        await call(client, 'qlarity.session.close', { sessionId });
        process.stdout.write(`closed ${sessionId}\n`);
      } catch (err) {
        annotate(err);
      }
    });

  /**
   * The workhorse. Opens, reads, prints, closes — including on failure, so a
   * bad selector does not strand a browser context.
   */
  q.command('read <url>')
    .description('One-shot: open a page, run an inspector, print the result, close')
    .option('--inspector <name>', 'named inspector', 'computed_style')
    .option('--selector <css>', 'CSS selector for the inspector')
    .option('--properties <list>', 'comma-separated CSS properties to narrow the result')
    .option('--key <key>', 'storage key (storage inspector)')
    .option('--assert <type>', 'assertion for the `expect` inspector (exists|visible|text_contains|count_equals|attribute_equals|…)')
    .option('--value <value>', 'expected value for the `expect` inspector')
    .option('--name <attr>', 'attribute name (attribute / expect attribute_equals inspectors)')
    .option('--widths <list>', 'comma-separated viewport widths for the `responsive_sweep` inspector')
    .option('--depth <n>', 'tree depth for the `dom_summary` inspector')
    .option('--wait-until <cond>', 'navigation wait: load | domcontentloaded | networkidle')
    .option('--settle <ms>', 'extra settle time after navigation, ms')
    .option('--session <id>', 'reuse an existing session (e.g. one left open by `quox qlarity login`) instead of opening a fresh one')
    .option('--json', 'raw JSON output')
    .action(async (url, options) => {
      let sessionId = null;
      let reused = false;
      try {
        const { sessionId: sid, opened, reused: wasReused } = await openSession(client, url, { ...settleOpts(options), sessionId: options.session });
        sessionId = sid;
        reused = wasReused;

        const args = {};
        if (options.selector) args.selector = options.selector;
        if (options.key) args.key = options.key;
        if (options.properties) args.properties = options.properties.split(',').map((x) => x.trim());
        // clarify-parity inspectors: expect (assert/value/name), responsive_sweep
        // (widths), dom_summary (depth). Passed as data; the fixed page-side body
        // lives in qlarity/src/inspectors.js.
        if (options.assert) args.assert = options.assert;
        if (options.value !== undefined) args.value = options.value;
        if (options.name) args.name = options.name;
        if (options.widths) args.widths = options.widths.split(',').map((x) => x.trim());
        if (options.depth !== undefined) args.depth = parseInt(options.depth, 10);

        const r = await call(client, 'qlarity.session.inspect', { sessionId },
          { inspector: options.inspector, ...args });

        const blocked = await call(client, 'qlarity.session.blocked', { sessionId });

        if (wantsJson(options)) {
          process.stdout.write(`${JSON.stringify({ page: opened, result: r.result, blocked: blocked.blocked }, null, 2)}\n`);
        } else {
          process.stdout.write(`\u{1F50D} QLARITY: ${opened.url} (${opened.status}) ${opened.title || ''}\n\n`);
          process.stdout.write(`${options.inspector}:\n${JSON.stringify(r.result, null, 2)}\n`);
          if (blocked.blocked?.length) {
            // Surfaced even on success: a page that silently failed to load a
            // subresource looks fine and is not.
            process.stdout.write(`\nblocked by egress policy (${blocked.blocked.length}):\n`);
            for (const b of blocked.blocked) process.stdout.write(`  ${b.url} -> ${b.reason}\n`);
          }
        }
      } catch (err) {
        annotate(err);
      } finally {
        // Always, including on failure — UNLESS the session was reused (a
        // `quox qlarity login` session, or an explicit --session): closing
        // one of those would silently log the caller back out. A stranded
        // FRESH context lives until the reaper and counts against this
        // org's concurrency cap meanwhile, so those are always closed.
        if (sessionId && !reused) {
          try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* reaper will get it */ }
        }
      }
    });

  /**
   * Console and network are read-only recorders attached at page open (see
   * the server's attachRecorders), so a one-shot here needs no `inspect`
   * step: open, read the ring buffer, print, close.
   */
  q.command('console <url>')
    .description('One-shot: open a page, print its console log, close')
    .option('--wait-until <cond>', 'navigation wait: load | domcontentloaded | networkidle')
    .option('--settle <ms>', 'extra settle time after navigation, ms')
    .option('--session <id>', 'reuse an existing session instead of opening a fresh one')
    .option('--json', 'raw JSON output')
    .action(async (url, options) => {
      let sessionId = null;
      let reused = false;
      try {
        const { sessionId: sid, opened, reused: wasReused } = await openSession(client, url, { ...settleOpts(options), sessionId: options.session });
        sessionId = sid;
        reused = wasReused;

        const c = await call(client, 'qlarity.session.console', { sessionId });

        if (wantsJson(options)) {
          process.stdout.write(`${JSON.stringify({ page: opened, messages: c.messages, total: c.total, dropped: c.dropped }, null, 2)}\n`);
        } else {
          process.stdout.write(`\u{1F50D} QLARITY: ${opened.url} (${opened.status}) ${opened.title || ''}\n\n`);
          process.stdout.write(`console (${c.total}):\n${JSON.stringify(c.messages, null, 2)}\n`);
          if (c.dropped) {
            // Reported, never hidden: a caller reading a truncated log would
            // otherwise draw the wrong conclusion about what the page logged.
            process.stdout.write(`\n${c.dropped} message(s) dropped (ring buffer full)\n`);
          }
        }
      } catch (err) {
        annotate(err);
      } finally {
        if (sessionId && !reused) {
          try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* reaper will get it */ }
        }
      }
    });

  q.command('network <url>')
    .description('One-shot: open a page, print its network log, close')
    .option('--wait-until <cond>', 'navigation wait: load | domcontentloaded | networkidle')
    .option('--settle <ms>', 'extra settle time after navigation, ms')
    .option('--session <id>', 'reuse an existing session instead of opening a fresh one')
    .option('--json', 'raw JSON output')
    .action(async (url, options) => {
      let sessionId = null;
      let reused = false;
      try {
        const { sessionId: sid, opened, reused: wasReused } = await openSession(client, url, { ...settleOpts(options), sessionId: options.session });
        sessionId = sid;
        reused = wasReused;

        const n = await call(client, 'qlarity.session.network', { sessionId });

        if (wantsJson(options)) {
          process.stdout.write(`${JSON.stringify({ page: opened, events: n.events, total: n.total, dropped: n.dropped }, null, 2)}\n`);
        } else {
          process.stdout.write(`\u{1F50D} QLARITY: ${opened.url} (${opened.status}) ${opened.title || ''}\n\n`);
          process.stdout.write(`network (${n.total}):\n${JSON.stringify(n.events, null, 2)}\n`);
          if (n.dropped) {
            process.stdout.write(`\n${n.dropped} event(s) dropped (ring buffer full)\n`);
          }
        }
      } catch (err) {
        annotate(err);
      } finally {
        if (sessionId && !reused) {
          try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* reaper will get it */ }
        }
      }
    });

  /**
   * Screenshots come back as base64 JSON (see qlarity's app.js: the digest
   * is what makes an image witnessable, and the governed proxy assumes
   * JSON), so this writes the decoded bytes to a file and prints the path —
   * stdout is the wrong place for binary.
   */
  q.command('screenshot <url>')
    .description('One-shot: open a page, capture a screenshot, save it to a file, close')
    .option('--selector <css>', 'CSS selector to capture a single element instead of the viewport')
    .option('--full-page', 'capture the full scrollable page, not just the viewport')
    .option('--wait-until <cond>', "navigation wait: load | domcontentloaded | networkidle (SPAs want networkidle)")
    .option('--settle <ms>', 'extra settle time after navigation, ms (for SPAs that hydrate after load)')
    .option('--wait-for <css>', 'wait for this element to be visible before the shot (SPAs paint after load; capped 10s)')
    .option('--wait-ms <n>', 'wait this many ms right before the shot, capped 10s (prefer --wait-for when you know the element)', (v) => parseInt(v, 10))
    .option('--no-reduced-motion', 'do NOT emulate prefers-reduced-motion (default emulates it so animated heroes/reveals render for the capture)')
    .option('--viewport <WxH>', 'capture viewport for this call, e.g. 1440x900 or 390x844 (320x320 to 3840x2160; default 1280x720)')
    .option('--device-scale-factor <n>', 'device pixel ratio for this call, 1 to 3 (default 1)')
    .option('--session <id>', 'reuse an existing session instead of opening a fresh one')
    .action(async (url, options) => {
      let sessionId = null;
      let reused = false;
      try {
        // Validate before any session exists: nothing to leak on a typo.
        let geometry;
        try {
          geometry = parseCaptureGeometryOptions(options);
        } catch (e) {
          process.stderr.write(`${e.message}\n`);
          process.exitCode = 2;
          return;
        }
        const { sessionId: sid, opened, reused: wasReused } = await openSession(client, url, { ...settleOpts(options), sessionId: options.session });
        sessionId = sid;
        reused = wasReused;

        const body = { ...geometry };
        if (options.selector) body.selector = options.selector;
        if (options.fullPage) body.full_page = true;
        if (options.waitFor) body.wait_for = options.waitFor;
        if (Number.isFinite(options.waitMs)) body.wait_ms = options.waitMs;
        // commander sets reducedMotion=false only when --no-reduced-motion is passed.
        if (options.reducedMotion === false) body.reduced_motion = false;

        const shot = await call(client, 'qlarity.session.screenshot', { sessionId }, body);

        const dir = screenshotDir();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, screenshotFilename(opened.url || url));
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

        process.stdout.write(`\u{1F50D} QLARITY: ${opened.url} (${opened.status}) ${opened.title || ''}\n`);
        process.stdout.write(`saved ${shot.bytes} bytes to ${file}\n`);
        process.stdout.write(`sha256 ${shot.sha256}\n`);
        if (shot.viewport) {
          process.stdout.write(`viewport ${shot.viewport.width}x${shot.viewport.height} @${shot.device_scale_factor ?? 1}x\n`);
        }
      } catch (err) {
        annotate(err);
      } finally {
        if (sessionId && !reused) {
          try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* reaper will get it */ }
        }
      }
    });

  q.command('eval <url> <script>')
    .description('Request approval to run arbitrary JS. Files an inbox item and exits; never runs inline.')
    .action(async (url, script) => {
      let sessionId = null;
      try {
        const { sessionId: sid } = await openSession(client, url);
        sessionId = sid;
        const r = await call(client, 'qlarity.session.eval', { sessionId }, { script });
        process.stdout.write(`\u{1F50D} QLARITY: ${r.status} — inbox item ${r.inbox_item_id}\n`);
        process.stdout.write('Arbitrary evaluation is always a human approval. Nothing has run.\n');
      } catch (err) {
        annotate(err);
      } finally {
        // The session is NOT closed here: the approved script needs it. The
        // reaper reclaims it if nobody approves.
        if (sessionId) process.stdout.write(`session ${sessionId} left open for the approved run\n`);
      }
    });

  /**
   * Governed authed-session bootstrap (issue #15). Only ever sends a
   * `credential_id` to the collector — never a raw password — and the
   * collector resolves it server-side against a stored `browser_login`
   * vault credential (see server.js's resolveQlarityLoginCredential). The
   * session is deliberately kept open on success and recorded locally so
   * `read`/`console`/`network`/`screenshot` one-shots against the SAME
   * origin pick it up automatically instead of opening a fresh, logged-out
   * one (see openSession's reuse check above).
   */
  q.command('login <origin>')
    .description('Log in to <origin> via a stored browser_login vault credential, leaving the session open for other qlarity verbs to reuse')
    .requiredOption('--credential <idOrName>', 'vault credential id or label (must be a browser_login credential)')
    .option('--login-path <path>', 'login form path, if the credential does not already declare one')
    .action(async (origin, options) => {
      let normalizedOrigin;
      try {
        normalizedOrigin = new URL(origin).origin;
      } catch {
        process.stderr.write(`Not a valid origin: ${origin}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const credentialId = await resolveBrowserLoginCredentialId(ctx, options.credential);

        const loggedIn = readLoggedInSessions();
        let sessionId = findReusableSessionId(
          loggedIn,
          (await call(client, 'qlarity.sessions.list')).sessions || [],
          normalizedOrigin,
        );
        let fresh = false;
        if (!sessionId) {
          const s = await call(client, 'qlarity.session.create', {}, {});
          sessionId = s.id;
          fresh = true;
        }

        const body = { origin: normalizedOrigin, credential_id: credentialId };
        if (options.loginPath) body.login_path = options.loginPath;

        // quox#907: a real login (page load, form fill, cookie wait) can outlast the CLI's 30s default on a loaded
        // box, and the server kept finishing it, so every timed-out retry left a headless browser behind. Give login
        // its own budget, and close a session THIS call created when the login call fails (as openSession does, #680).
        let r;
        try {
          r = await call(client, 'qlarity.session.login', { sessionId }, body, { timeout: LOGIN_TIMEOUT_MS });
        } catch (loginErr) {
          if (fresh) {
            try { await call(client, 'qlarity.session.close', { sessionId }); } catch { /* the server reaper will get it */ }
          }
          throw loginErr;
        }

        if (r.logged_in) {
          loggedIn[normalizedOrigin] = { sessionId, logged_in_at: new Date().toISOString() };
          writeLoggedInSessions(loggedIn);
          process.stdout.write(`\u{1F50D} QLARITY: logged in to ${normalizedOrigin} — session ${sessionId} kept open for reuse\n`);
          process.stdout.write(`evidence: ${r.evidence}\n`);
        } else {
          // Do NOT record this session as reusable: a failed login left
          // open and later "reused" would silently serve a logged-out page.
          process.stdout.write(`\u{1F50D} QLARITY: no new session cookie appeared for ${normalizedOrigin} — login likely failed\n`);
          process.stdout.write(`session ${sessionId} left open for inspection (not marked reusable); close it with \`quox qlarity close ${sessionId}\` when done\n`);
          process.exitCode = 1;
        }
      } catch (err) {
        annotate(err);
      }
    });

  return q;
}

/**
 * Resolve a `--credential` value (a vault credential id, OR a case-
 * insensitive match on its label) to a credential id, scoped to
 * `browser_login` credentials only — the same integration type
 * server.js's resolveQlarityLoginCredential requires.
 */
async function resolveBrowserLoginCredentialId({ client, auth, program }, idOrName) {
  const orgId = resolveOrgId(auth, program);
  const ep = resolveEndpoint('vault.list', { orgId });
  const data = await client.get(ep.path, { service: ep.service, query: { type: 'browser_login' } });
  const rows = data.credentials || data || [];
  const match = rows.find((r) => r.id === idOrName)
    || rows.find((r) => (r.label || '').toLowerCase() === String(idOrName).toLowerCase());
  if (!match) {
    const err = new Error(
      `No browser_login credential matched "${idOrName}". Run \`quox vault list --type browser_login\` to see stored credentials.`,
    );
    err.status = 404;
    throw err;
  }
  return match.id;
}

export default registerQlarityCommands;
