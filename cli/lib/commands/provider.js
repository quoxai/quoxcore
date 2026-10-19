/**
 * quox provider list | connect <kind> | test [<kind>]  (quox#1281, CLI verb first)
 *
 * The SAME backend calls as the TUI's /connect: cli/lib/quoxon/connect.js flows (connectFlow, connectOllamaFlow,
 * connectCompatFlow, connectionLines) over cli/lib/quoxon/api.js createApi (the auth vault create/update with
 * confirm_private_origin, the server-side key test and Ollama / OpenAI-compatible probes, capabilities, consent).
 * Nothing here talks to the backend on its own, so the TUI and the CLI cannot drift. The vault routes audit every
 * write server side (integration.private_origin for a private address), org-scoped by the caller's session.
 *
 * Secrets: a key is never an argv flag or argument. It arrives on stdin (--key-from-stdin) or from a hidden prompt,
 * is sent once to the server test and the vault, and is never printed (connectFlow scrubs it from any message).
 */
import { formatDetail, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { createApi, isInteractiveHuman } from '../quoxon/api.js';
import { PROVIDERS, providerFor, looksLikeKey, connectionLines, connectFlow, connectOllamaFlow, connectCompatFlow } from '../quoxon/connect.js';
import { needsConsent, consentCovers, connectConsentNote, providerLabel } from '../quoxon/consent.js';
import { readStdin } from '../quoxon/print.js';

const KINDS = Object.keys(PROVIDERS);
const SAFE_ROW = ['id', 'integration_type', 'label', 'is_default', 'test_status', 'last_tested_at', 'created_at'];
const CONTAINER_NOTE = 'Quox runs in containers: 127.0.0.1 or localhost means the Quox container, not your machine. Use the host\'s LAN IP, e.g. http://192.0.2.10:11434';

function defaultIO() {
  return {
    isTTY: () => isInteractiveHuman(),
    readStdin: () => readStdin(),
    promptSecret: async (message) => {
      const { default: inquirer } = await import('inquirer');
      const a = await inquirer.prompt([{ type: 'password', name: 'v', message, mask: '*' }]);
      return a.v;
    },
    confirm: async (message) => {
      const { default: inquirer } = await import('inquirer');
      const a = await inquirer.prompt([{ type: 'confirm', name: 'v', message, default: false }]);
      return Boolean(a.v);
    },
  };
}

const say = (lines) => { for (const [t] of lines || []) printInfo(t); };

export function registerProviderCommands(program, ctx) {
  const { client, auth, config } = ctx;
  const io = ctx.providerIO || defaultIO();
  const api = () => (ctx.makeApi ? ctx.makeApi() : createApi({ client, config, auth }));

  const provider = program
    .command('provider')
    .description('Connect the AI providers your org uses (the same as /connect in the Quox terminal)');

  // ── provider list ──────────────────────────────────────────────────────────
  provider
    .command('list')
    .description('Show which AI providers this org can use, and how each is connected')
    .action(async () => {
      auth.requireAuth();
      const a = api();
      const [vault, caps] = await Promise.all([a.connections(), a.capabilities ? a.capabilities() : null]);
      if (program.opts().output === 'json') {
        const rows = vault?.ok ? vault.rows.map((r) => Object.fromEntries(SAFE_ROW.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))) : null;
        formatDetail({ connections: rows, ...(vault?.ok ? {} : { error: vault?.error || 'vault not readable' }), capabilities: caps?.ok ? caps.capabilities : null }, { format: 'json' });
        return;
      }
      say(connectionLines(vault, caps));
    });

  // ── provider connect ───────────────────────────────────────────────────────
  const readKey = async (p, opts) => {
    if (opts.keyFromStdin) return String(await io.readStdin() || '').replace(/\r?\n$/, '').trim();
    if (io.isTTY()) return String(await io.promptSecret(`${p.name} key (hidden, never shown or stored on this machine):`) || '').trim();
    throw new Error(`No key given. Pipe it in with --key-from-stdin (for example: quox provider connect ${p.id} --key-from-stdin < keyfile), or run this in a terminal to be asked. A key is never taken as an argument.`);
  };
  const consentAfter = async (type) => {
    const a = api();
    if (!needsConsent(type) || !a.consentStatus) return;
    let rec = null; try { rec = await a.consentStatus(); } catch { rec = null; }
    if (consentCovers(rec, type)) return;
    // --yes never grants consent: it is this person's own OK to send their conversations to a third party
    if (!io.isTTY() || !a.grantConsent) { printInfo(connectConsentNote(type)); return; }
    const yes = await io.confirm(`Allow Quox to send your conversations to ${providerLabel(type)}? Your messages and tool results go to ${providerLabel(type)}, a third party, when it answers. Nothing is sent until you say yes.`);
    if (!yes) { printInfo(`Left off: nothing goes to ${providerLabel(type)} until you say so. ${connectConsentNote(type)}`); return; }
    try { await a.grantConsent(type); printInfo(`✔ Your OK is recorded: ${providerLabel(type)} can now answer. Withdraw it any time: quox consent list.`); }
    catch (e) { printInfo(`Quox could not record your OK (${e?.message || e}). Try: quox consent grant ${type}`); }
  };

  provider
    .command('connect')
    .description('Connect an AI provider for this org: a keyed provider (openai, anthropic, groq...) takes its key on stdin or a hidden prompt; a self-hosted one (ollama, lmstudio, vllm, custom) takes a URL')
    .argument('<kind>', `provider: ${KINDS.join(', ')}`)
    .argument('[url]', 'server URL for ollama / lmstudio / vllm / custom (same as --url)')
    .option('--url <url>', `server URL for a self-hosted provider. ${CONTAINER_NOTE}`)
    .option('--model <model>', 'default model to use on that server')
    .option('--key-from-stdin', 'read the API key from stdin (never pass a key as an argument)')
    .option('--yes', 'confirm connecting to an address on your private network (the server still checks it and audits the decision)')
    .addHelpText('after', `\n${CONTAINER_NOTE}\nKeys: --key-from-stdin, or run in a terminal to be asked with a hidden prompt.`)
    .action(async (kind, urlArg, opts) => {
      auth.requireAuth();
      const p = providerFor(kind);
      if (!p) throw new Error(`No provider called "${kind}". Use one of: ${KINDS.join(', ')}`);
      if (urlArg && (looksLikeKey(urlArg) || (p.card && !p.url))) throw new Error('never pass a key as an argument (it would sit in your shell history and process list). Use --key-from-stdin, or run in a terminal to be asked.');
      const a = api();
      const url = opts.url || urlArg || '';
      let r;
      if (p.id === 'ollama') {
        r = await connectOllamaFlow(a, [url, opts.model].filter(Boolean).join(' '));
        say(r.lines);
        if (r.privateAsk) {
          const q = `Connect to ${r.privateAsk.host}? It's on your private network. Quox saves only ${r.privateAsk.origin}, after the server checks it answers as Ollama.`;
          let yes = Boolean(opts.yes);
          if (!yes && io.isTTY()) yes = await io.confirm(q);
          if (!yes && !io.isTTY()) throw new Error(`${r.privateAsk.host} is on your private network. Run again with --yes to confirm this one address. Nothing was saved.`);
          if (!yes) throw new Error(`Left blocked: ${r.privateAsk.host} was not connected. Nothing was saved.`);
          r = await r.privateAsk.retry();
          say(r.lines);
        }
      } else if (p.url) {
        r = await connectCompatFlow(a, p.id, [url, opts.model].filter(Boolean).join(' '));
        say(r.lines);
        if (r.needsKey) { r = await connectFlow(a, 'custom', await readKey(PROVIDERS.custom, opts), r.extra); printInfo(r.text); if (r.disclosure) printInfo(r.disclosure); }
      } else {
        r = await connectFlow(a, p.id, await readKey(p, opts));
        printInfo(r.text);
        if (r.ok && r.disclosure) printInfo(r.disclosure);
      }
      if (r?.lanOffer) printInfo('  From the CLI an instance admin allows private targets with: quox server config lan-targets on   then run this again.');
      if (!r?.ok) throw new Error(r?.text || `${p.name} was not connected. Nothing was saved.`);
      await consentAfter(p.type);
    });

  // ── provider test ──────────────────────────────────────────────────────────
  provider
    .command('test')
    .description('Test the stored connection for a provider (or every default connection) through the vault test')
    .argument('[kind]', 'provider to test (default: every connected provider)')
    .action(async (kind) => {
      auth.requireAuth();
      const p = kind ? providerFor(kind) : null;
      if (kind && !p) throw new Error(`No provider called "${kind}". Use one of: ${KINDS.join(', ')}`);
      const vault = await api().connections();
      if (!vault?.ok) throw new Error(`Could not read the vault: ${vault?.error || 'no answer'}`);
      const types = new Set(p ? [p.type] : Object.values(PROVIDERS).map((x) => x.type));
      const rows = vault.rows.filter((r) => types.has(r.integration_type) && (r.is_default === 1 || r.is_default === true));
      if (!rows.length) throw new Error(p ? `No ${p.id} connection is stored for this org. Connect one: quox provider connect ${p.id}` : 'No provider connection is stored for this org. Connect one: quox provider connect <kind>');
      const orgId = resolveOrgId(auth, program);
      let failed = 0;
      for (const row of rows) {
        const name = (Object.values(PROVIDERS).find((x) => x.type === row.integration_type) || {}).name || row.integration_type;
        const ep = resolveEndpoint('vault.test', { orgId, id: row.id });
        let res;
        try { res = await client.post(ep.path, { service: ep.service, retries: 0 }); }
        catch (e) { res = { success: false, message: e?.message || 'failed' }; }
        if (res?.success === false) { failed++; printInfo(`✖ ${name}  ${row.label || row.id}  failed: ${res?.message || 'no reason given'}`); }
        else printInfo(`✔ ${name}  ${row.label || row.id}  ok${res?.message ? `: ${res.message}` : ''}`);
      }
      if (failed) process.exitCode = 1;
    });
}
