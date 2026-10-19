/**
 * VOLT commands: verify evidence bundles, inspect chains, export reports
 *
 * quox volt <subcommand> [options]
 *
 * Works with VOLT evidence bundle files (JSON) and raw NDJSON chain exports.
 */

import chalk from 'chalk';
import { readFile, writeFile } from 'fs/promises';
import { printSuccess, printWarning, printInfo, formatDetail } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Peel a fetched VOLT payload down to the verifiable bundle shape
 * ({ manifest, events_ndjson?, signature? }), not the storage row around it.
 * `/volt/runs/:runId/bundle` returns { bundle: <db row> } with the actual
 * bundle nested in `row.data`; `/volt/bundles/:bundleId/download` returns the
 * bundle directly. Shared by `volt fetch` for both the initial fetch and the
 * follow-up download after `volt.bundle.create` (fleet #447).
 */
function unwrapVoltBundle(data) {
  let bundle = (data && data.bundle) ? data.bundle : data;
  if (bundle && bundle.data && typeof bundle.data === 'object' && bundle.data.manifest) {
    bundle = bundle.data;
  }
  return bundle;
}

/**
 * quox#935: a bundle is ONE JSON object carrying `manifest` and/or
 * `events_ndjson`. An events NDJSON file also starts with '{' on every line,
 * so a first-character check took every NDJSON file for a bundle and the
 * whole-file JSON.parse failed. Decide by parsing instead.
 */
export function looksLikeBundle(raw) {
  try {
    const p = JSON.parse(raw);
    return !!p && typeof p === 'object' && !Array.isArray(p) && ('manifest' in p || 'events_ndjson' in p);
  } catch {
    return false;
  }
}

const ndjsonEvents = (raw) => raw.trim().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

export function registerVoltCommands(program, ctx = {}) {
  const { client, auth } = ctx;

  const volt = program
    .command('volt')
    .description('VOLT evidence bundle verification and inspection');

  // ── volt verify ─────────────────────────────────────────────────────────────

  volt
    .command('verify')
    .description('Verify an evidence bundle or NDJSON chain file')
    .argument('<file>', 'path to bundle JSON or events NDJSON file')
    .option('--strict', 'fail on warnings too; unsigned or unpinned signatures fail')
    .option('--key <pubkey|file>', 'trusted Ed25519 public key (base64 raw, or file containing it); repeatable', (v, acc) => (acc || []).concat(v))
    .option('--trusted-keys <file>', 'JSON file: array of base64 public keys or {publicKey, keyId?} objects')
    .action(async (file, options) => {
      const raw = await readFile(file, 'utf8');

      // Detect if this is a bundle (JSON with manifest) or raw NDJSON
      const isBundle = looksLikeBundle(raw);

      if (isBundle) {
        // fleet #447: a persisted per-run bundle can be manifest_only (no
        // events_ndjson, see voltContentStore.js). Handing that straight to
        // verifyEvidenceBundle produced a bare MISSING_EVENTS error even
        // though the engine is working correctly, there is simply nothing to
        // chain-verify. Catch it here and name the remedy instead.
        let manifestOnly = null;
        try {
          const parsed = JSON.parse(raw);
          const hasEvents = typeof parsed.events_ndjson === 'string' && parsed.events_ndjson.trim().length > 0;
          if (parsed && parsed.manifest && !hasEvents) {
            manifestOnly = parsed.manifest;
          }
        } catch {
          // Not valid JSON, let verifyEvidenceBundle report its own PARSE_ERROR below.
        }

        if (manifestOnly) {
          console.log('');
          console.log(chalk.bold('VOLT Evidence Bundle Verification'));
          console.log(chalk.gray('─'.repeat(40)));
          console.log('');
          const mode = manifestOnly.bundle_mode ? ` (bundle_mode: ${manifestOnly.bundle_mode})` : '';
          printWarning(`Manifest-only bundle${mode}: no events_ndjson embedded, so there is no chain to verify.`);
          const remedy = manifestOnly.run_id
            ? `quox volt fetch ${manifestOnly.run_id}`
            : 'quox volt fetch <run_id>';
          printInfo(`Remedy: ${remedy} to build a verifiable bundle.`);
          console.log('');
          process.exitCode = 1;
          return;
        }

        const { verifyEvidenceBundle } = await import('../../../src/lib/volt/volt-verify.js');
        const trustedKeys = [];
        const addKey = (k) => {
          if (typeof k === 'string') trustedKeys.push({ publicKey: k.trim() });
          else if (k && k.publicKey) trustedKeys.push({ publicKey: k.publicKey, ...(k.keyId ? { keyId: k.keyId } : {}) });
        };
        try {
          for (const k of options.key || []) {
            let v = k;
            try { v = (await readFile(k, 'utf8')).trim(); } catch { /* literal key */ }
            addKey(v);
          }
          if (options.trustedKeys) {
            const list = JSON.parse(await readFile(options.trustedKeys, 'utf8'));
            (Array.isArray(list) ? list : list.keys || []).forEach(addKey);
          }
        } catch (err) {
          console.log(chalk.red(`Could not load trusted keys: ${err.message}`));
          process.exitCode = 1;
          return;
        }
        const result = await verifyEvidenceBundle(raw, {
          strict: !!options.strict,
          ...(trustedKeys.length ? { keys: trustedKeys } : {})
        });

        console.log('');
        console.log(chalk.bold('VOLT Evidence Bundle Verification'));
        console.log(chalk.gray('─'.repeat(40)));

        if (result.summary.bundle_id) {
          console.log(`  Bundle:   ${chalk.cyan(result.summary.bundle_id)}`);
        }
        if (result.summary.run_id) {
          console.log(`  Run:      ${chalk.cyan(result.summary.run_id)}`);
        }
        console.log(`  Version:  ${result.summary.volt_version || 'unknown'}`);
        console.log(`  Events:   ${result.summary.event_count}`);
        console.log(`  Chain:    ${result.summary.chain_valid ? chalk.green('PASS') : chalk.red('FAIL')}`);
        {
          const sigs = result.summary.signatures || [];
          if (sigs.length === 0) {
            console.log(`  Signature: ${chalk.yellow('NONE')} (bundle is unsigned)`);
          }
          for (const sg of sigs) {
            const key = `${String(sg.key_id || 'unknown').slice(0, 4)}...`;
            if (sg.valid) {
              const how = sg.trust === 'trusted' ? 'trusted' : 'embedded, not pinned';
              console.log(`  Signature: ${chalk.green('VALID')} (key ${key}, ${how})`);
            } else {
              console.log(`  Signature: ${chalk.red('INVALID')} (key ${key}, see errors)`);
            }
          }
        }
        console.log(`  Timestamps: ${result.summary.timestamps_checked || 0}`);

        if (result.errors.length > 0) {
          console.log('');
          console.log(chalk.red(`  ${result.errors.length} error(s):`));
          for (const err of result.errors) {
            console.log(chalk.red(`    ✗ [${err.code}] ${err.message}`));
            if (err.detail) console.log(chalk.gray(`      ${err.detail}`));
          }
        }
        if (result.warnings.length > 0) {
          console.log('');
          console.log(chalk.yellow(`  ${result.warnings.length} warning(s):`));
          for (const w of result.warnings) {
            console.log(chalk.yellow(`    ⚠ [${w.code}] ${w.message}`));
          }
        }

        console.log('');
        const pass = result.valid && (!options.strict || result.warnings.length === 0);
        if (pass) {
          printSuccess(`RESULT: PASS — bundle is valid (${result.summary.event_count} events verified)`);
        } else {
          console.log(chalk.red.bold(`  RESULT: FAIL`));
          process.exitCode = 1;
        }
      } else {
        // Raw NDJSON chain
        const { verifyNDJSON, formatReport } = await import('../../../src/lib/volt/volt-verifier.js');
        const result = await verifyNDJSON(raw);
        console.log('');
        console.log(formatReport(result));
        console.log('');

        if (result.result === 'PASS') {
          printSuccess('Chain verified successfully');
        } else {
          console.log(chalk.red.bold('Chain verification FAILED'));
          process.exitCode = 1;
        }
      }
    });

  // ── volt inspect ────────────────────────────────────────────────────────────

  volt
    .command('inspect')
    .description('Inspect events inside a bundle or NDJSON file')
    .argument('<file>', 'path to bundle JSON or events NDJSON file')
    .option('--events', 'list all events')
    .option('--event <seq>', 'show a single event by sequence number', parseInt)
    .option('--manifest', 'show bundle manifest only')
    .action(async (file, options) => {
      const raw = await readFile(file, 'utf8');
      const isBundle = looksLikeBundle(raw);

      let events;
      let manifest = null;

      if (isBundle) {
        const parsed = JSON.parse(raw);
        manifest = parsed.manifest;
        events = parsed.events_ndjson
          .trim()
          .split('\n')
          .filter(l => l.trim())
          .map(l => JSON.parse(l));
      } else {
        events = raw.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      }

      // --manifest: show just the bundle manifest
      if (options.manifest) {
        if (!manifest) {
          printWarning('Not a bundle file — no manifest available');
          return;
        }
        formatDetail(manifest, {
          format: program.opts().output,
          title: `Bundle Manifest: ${manifest.bundle_id || 'unknown'}`,
          fields: [
            'bundle_id', 'run_id', 'volt_version', 'event_count', 'hash_alg',
            'first_event_hash', 'last_event_hash', 'merkle_root',
            'agents_involved', 'run_status', 'started_at', 'completed_at',
            'signed', 'redactions_present', 'created_ts'
          ],
        });
        return;
      }

      // --event <seq>: show a single event
      if (options.event != null) {
        const ev = events.find(e => e.seq === options.event);
        if (!ev) {
          printWarning(`No event with seq=${options.event} (range: 1-${events.length})`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(ev, null, 2));
        return;
      }

      // --events or default: list events summary
      console.log('');
      if (manifest) {
        console.log(chalk.bold(`Bundle: ${manifest.bundle_id || 'N/A'}`));
        console.log(chalk.gray(`Run: ${manifest.run_id || 'N/A'} — ${events.length} events`));
      } else {
        console.log(chalk.bold(`NDJSON Chain — ${events.length} events`));
        if (events.length > 0) {
          console.log(chalk.gray(`Run: ${events[0].run_id || 'N/A'}`));
        }
      }
      console.log('');

      // Table header
      console.log(
        chalk.gray('  SEQ  ') +
        chalk.gray('EVENT TYPE'.padEnd(28)) +
        chalk.gray('ACTOR'.padEnd(20)) +
        chalk.gray('HASH (first 12)')
      );
      console.log(chalk.gray('  ' + '─'.repeat(75)));

      for (const ev of events) {
        const seqStr = String(ev.seq).padStart(4);
        const typeStr = (ev.event_type || 'unknown').padEnd(28);
        const actor = (ev.actor?.actor_id || '—').padEnd(20);
        const hashShort = ev.hash ? ev.hash.slice(0, 12) + '…' : '—';

        console.log(`  ${seqStr}  ${typeStr}${actor}${chalk.gray(hashShort)}`);
      }
      console.log('');
      printInfo(`${events.length} events total`);
    });

  // ── volt export ─────────────────────────────────────────────────────────────

  volt
    .command('export')
    .description('Re-export a bundle in a different format')
    .argument('<file>', 'path to bundle JSON file')
    .option('--ndjson <outfile>', 'export events as NDJSON')
    .option('--manifest <outfile>', 'export manifest as JSON')
    .option('--pretty', 'pretty-print JSON output')
    .action(async (file, options) => {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);

      if (!parsed.manifest || !parsed.events_ndjson) {
        printWarning('File does not appear to be a VOLT evidence bundle');
        process.exitCode = 1;
        return;
      }

      if (options.ndjson) {
        await writeFile(options.ndjson, parsed.events_ndjson);
        printSuccess(`Events exported to ${options.ndjson} (${parsed.manifest.event_count} events)`);
      }

      if (options.manifest) {
        const content = options.pretty
          ? JSON.stringify(parsed.manifest, null, 2)
          : JSON.stringify(parsed.manifest);
        await writeFile(options.manifest, content + '\n');
        printSuccess(`Manifest exported to ${options.manifest}`);
      }

      if (!options.ndjson && !options.manifest) {
        printInfo('Specify --ndjson <outfile> and/or --manifest <outfile> to export');
        console.log('');
        console.log('Examples:');
        console.log('  quox volt export bundle.json --ndjson events.ndjson');
        console.log('  quox volt export bundle.json --manifest manifest.json --pretty');
        console.log('  quox volt export bundle.json --ndjson events.ndjson --manifest manifest.json');
      }
    });

  // ── volt fetch ──────────────────────────────────────────────────────────────
  //
  // 2026-08-19 (proof-loop). `quox volt verify` only accepts a LOCAL FILE, and
  // no verb existed to obtain one from the running instance. The collector has
  // served /volt/runs/:runId/bundle and /volt/bundles/:bundleId/download all
  // along with nothing wired to them, so the chain a customer needs —
  // run -> bundle -> verify — was broken at exactly the step where they check
  // a receipt for themselves. That is the "keep the receipt" promise, and it
  // could not be kept from the canonical CLI.

  volt
    .command('fetch')
    .description('Download a run\'s evidence bundle so `quox volt verify` can check it')
    .argument('<runId>', 'VOLT run id (see `quox governance cert list`)')
    .option('--out <file>', 'write the bundle here (default: <runId>-bundle.json)')
    .option('--bundle-id <id>', 'fetch a specific bundle id instead of the run\'s current one')
    .option('--manifest-only', 'write the persisted manifest-only bundle as-is, skip building a verifiable one')
    .action(async (runId, options) => {
      auth.requireAuth();

      const ep = options.bundleId
        ? resolveEndpoint('volt.bundle.download', { bundleId: options.bundleId })
        : resolveEndpoint('volt.run.bundle.get', { runId });

      const data = await client.get(ep.path, { service: ep.service });

      // Unwrap to the VERIFIABLE bundle, not the storage row around it.
      //
      // /volt/runs/:runId/bundle returns { bundle: <db row> } where the row is
      // { bundle_id, run_id, created_ts, data, stored_at } and the thing
      // `quox volt verify` actually needs (manifest + events_ndjson +
      // signatures) is nested in `data`. Writing the row produced a file that
      // failed verification with MISSING_MANIFEST — the verifier was right and
      // the fetch was wrong. Peel both layers, and only accept the result if it
      // carries a manifest, so this can never hand someone a file that looks
      // like evidence and is not.
      let bundle = unwrapVoltBundle(data);
      if (!bundle) {
        printWarning(`No bundle found for ${options.bundleId || runId}`);
        process.exitCode = 1;
        return;
      }
      if (!bundle.manifest) {
        printWarning(`Fetched payload for ${options.bundleId || runId} has no manifest — refusing to write a file that would fail verification.`);
        printInfo(`Payload keys: ${Object.keys(bundle).join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const hasEvents = typeof bundle.events_ndjson === 'string' && bundle.events_ndjson.trim().length > 0;

      // fleet #447: the bundle persisted at run completion is bundle_mode:
      // 'manifest_only' (see voltContentStore.js), so a plain fetch handed
      // `quox volt verify` a file it could never chain-verify. Build the full
      // bundle on demand instead, unless the caller asked for a specific
      // bundle id (that bundle is what it is) or opted out with
      // --manifest-only.
      if (!hasEvents) {
        if (options.bundleId) {
          const out = options.out || `${options.bundleId}-bundle.json`;
          await writeFile(out, JSON.stringify(bundle, null, 2) + '\n');
          const mode = bundle.manifest.bundle_mode ? ` (bundle_mode: ${bundle.manifest.bundle_mode})` : '';
          printSuccess(`Bundle written to ${out}`);
          printWarning(`Bundle ${options.bundleId} is manifest-only${mode}, no events_ndjson to verify.`);
          const runHint = bundle.manifest.run_id;
          printInfo(runHint ? `For a verifiable bundle: quox volt fetch ${runHint}` : 'Fetch by run id for a verifiable bundle.');
          return;
        }

        if (options.manifestOnly) {
          const out = options.out || `${runId}-bundle.json`;
          await writeFile(out, JSON.stringify(bundle, null, 2) + '\n');
          printSuccess(`Bundle written to ${out}`);
          printWarning('This is a manifest-only bundle: `quox volt verify` cannot chain-verify it (no events_ndjson).');
          return;
        }

        printInfo(`Persisted bundle for ${runId} is manifest-only, building a verifiable bundle from stored events.`);

        const createEp = resolveEndpoint('volt.bundle.create');
        const created = await client.post(createEp.path, { service: createEp.service, body: { run_id: runId } });
        const bundleId = created && created.bundle_id;
        if (!bundleId) {
          printWarning(`Could not build a verifiable bundle for ${runId}.`);
          process.exitCode = 1;
          return;
        }

        const downloadEp = resolveEndpoint('volt.bundle.download', { bundleId });
        const fullData = await client.get(downloadEp.path, { service: downloadEp.service });
        const fullBundle = unwrapVoltBundle(fullData);
        if (!fullBundle || !fullBundle.manifest) {
          printWarning(`Built bundle ${bundleId} but could not download it, no manifest in the response.`);
          process.exitCode = 1;
          return;
        }

        const out = options.out || `${runId}-bundle.json`;
        await writeFile(out, JSON.stringify(fullBundle, null, 2) + '\n');
        const eventCount = fullBundle.manifest.event_count;
        printSuccess(`Bundle ${bundleId} written to ${out}${eventCount != null ? ` (${eventCount} events)` : ''}`);
        printInfo(`Verify it: quox volt verify ${out}`);
        return;
      }

      const out = options.out || `${options.bundleId || runId}-bundle.json`;
      await writeFile(out, JSON.stringify(bundle, null, 2) + '\n');

      const events = bundle.manifest && bundle.manifest.event_count;
      printSuccess(`Bundle written to ${out}${events != null ? ` (${events} events)` : ''}`);
      printInfo(`Verify it: quox volt verify ${out}`);
    });

  // ── volt summary ────────────────────────────────────────────────────────────

  volt
    .command('summary')
    .description('Quick summary of a bundle (no verification)')
    .argument('<file>', 'path to bundle JSON or events NDJSON file')
    .action(async (file) => {
      const raw = await readFile(file, 'utf8');
      // quox#935: an events NDJSON file gets a chain summary instead of a crash.
      if (!looksLikeBundle(raw)) {
        let evs;
        try { evs = ndjsonEvents(raw); } catch {
          printWarning('File is neither a VOLT evidence bundle nor an events NDJSON file');
          process.exitCode = 1;
          return;
        }
        const counts = {};
        for (const ev of evs) counts[ev.event_type] = (counts[ev.event_type] || 0) + 1;
        console.log('');
        console.log(chalk.bold(`VOLT NDJSON Chain Summary (${evs.length} events)`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(`  Run ID:     ${chalk.cyan(evs[0]?.run_id || 'N/A')}`);
        console.log(`  Events:     ${evs.length} events`);
        if (Object.keys(counts).length > 0) {
          console.log('');
          console.log(chalk.bold('  Event Types:'));
          for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(count).padStart(4)}  ${type}`);
          }
        }
        console.log('');
        return;
      }
      const parsed = JSON.parse(raw);

      if (!parsed.manifest) {
        printWarning('File does not appear to be a VOLT evidence bundle');
        process.exitCode = 1;
        return;
      }

      const m = parsed.manifest;
      const events = parsed.events_ndjson
        ?.trim()
        .split('\n')
        .filter(l => l.trim()) || [];

      // Event type breakdown
      const typeCounts = {};
      for (const line of events) {
        try {
          const ev = JSON.parse(line);
          typeCounts[ev.event_type] = (typeCounts[ev.event_type] || 0) + 1;
        } catch { /* skip */ }
      }

      console.log('');
      console.log(chalk.bold('VOLT Bundle Summary'));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`  Bundle ID:  ${chalk.cyan(m.bundle_id || 'N/A')}`);
      console.log(`  Run ID:     ${chalk.cyan(m.run_id || 'N/A')}`);
      console.log(`  Version:    ${m.volt_version || 'N/A'}`);
      console.log(`  Status:     ${m.run_status || 'N/A'}`);
      console.log(`  Events:     ${m.event_count || events.length}`);
      console.log(`  Agents:     ${(m.agents_involved || []).join(', ') || 'none'}`);
      console.log(`  Policies:   ${(m.policy_ids_evaluated || []).length} evaluated`);
      console.log(`  HITL:       ${m.hitl_decisions || 0} decisions`);
      console.log(`  Signed:     ${m.signed ? 'yes' : 'no'}`);
      console.log(`  Redacted:   ${m.redactions_present ? 'yes' : 'no'}`);
      console.log(`  Created:    ${m.created_ts || 'N/A'}`);
      console.log(`  Started:    ${m.started_at || 'N/A'}`);
      console.log(`  Completed:  ${m.completed_at || 'N/A'}`);

      if (Object.keys(typeCounts).length > 0) {
        console.log('');
        console.log(chalk.bold('  Event Types:'));
        const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
        for (const [type, count] of sorted) {
          console.log(`    ${String(count).padStart(4)}  ${type}`);
        }
      }
      console.log('');
    });

  // ── volt accept / acceptance ────────────────────────────────────────────────
  // SEO-MOAT (owner ruling 2026-09-03): the "did it work" layer. The chain
  // proves what happened; this records whether it achieved its intent — an
  // attestation, not automated evaluation. The server derives WHO attested
  // from the credential class (human/agent/service) and witnesses the
  // verdict as its own VOLT run pinning the target run's head_hash, so an
  // agent marking its own work "pass" is visible as exactly that.

  volt
    .command('accept')
    .description('Attest a terminal run\'s outcome: did it achieve its intent?')
    .argument('<runId>', 'VOLT run id (VR_...) — see `quox volt fetch`')
    .requiredOption('--verdict <verdict>', "'pass' or 'fail'")
    .option('--reason <text>', 'what you checked and what you saw')
    .action(async (runId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('volt.run.acceptance.post', { runId });
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { verdict: options.verdict, reason: options.reason || null },
      });
      const v = data.verdict || {};
      printSuccess(`Acceptance recorded: ${v.verdict} on ${runId} (attested by ${v.actor_type}.${v.actor_id})`);
      if (v.evidence_run_id) printInfo(`Witnessed as VOLT run ${v.evidence_run_id} (pins target head_hash ${String(v.target_head_hash || '').slice(0, 12)}...)`);
    });

  volt
    .command('acceptance')
    .description('Show a run\'s acceptance verdict history (latest is the standing verdict)')
    .argument('<runId>', 'VOLT run id (VR_...)')
    .action(async (runId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('volt.run.acceptance.get', { runId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.latest, { format: program.opts().output });
      if ((data.history || []).length > 1) {
        printInfo(`${data.history.length} verdicts total — latest supersedes; history is append-only.`);
      }
    });
}
