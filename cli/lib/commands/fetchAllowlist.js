/**
 * `quox fetch allow` — the URL prefixes this org's agents may GET through the
 * governed web_fetch_allowlisted tool (quox#1171). Default-deny: nothing is
 * fetchable until an org admin adds a prefix. Every call goes through the
 * collector; adding and removing need a human org admin (the server refuses
 * agent tokens).
 */

import { resolveEndpoint } from '../api/endpoints.js';

async function call(client, id, params = {}, body) {
  const ep = resolveEndpoint(id, params);
  const opts = { service: ep.service };
  if (body) opts.body = body;
  switch (ep.method) {
    case 'POST': return client.post(ep.path, opts);
    case 'DELETE': return client.delete(ep.path, opts);
    default: return client.get(ep.path, opts);
  }
}

export function registerFetchAllowlistCommands(program, ctx) {
  const { client } = ctx;

  const f = program
    .command('fetch')
    .description('Governed agent fetch: which URLs your agents may GET');

  const al = f.command('allow')
    .description('The URL prefixes this org allows agents to fetch (default-deny)');

  al.command('list', { isDefault: true })
    .description('Show the allowed URL prefixes for this org')
    .action(async () => {
      const d = await call(client, 'fetchAllowlist.list');
      if (d.prefixes?.length) {
        process.stdout.write('allowed prefixes:\n');
        for (const e of d.prefixes) process.stdout.write(`  ${e.url_prefix}${e.note ? `  (${e.note})` : ''}\n`);
      } else {
        process.stdout.write('none allowed yet: agents cannot fetch anything. Add one with `quox fetch allow add <url-prefix>`\n');
      }
    });

  al.command('add <url-prefix>')
    .description('Allow agents to GET URLs under a prefix, e.g. https://status.example.com/api/')
    .option('--note <text>', 'why it is allowed, shown alongside it later')
    .action(async (urlPrefix, opts) => {
      try {
        const d = await call(client, 'fetchAllowlist.add', {}, { url_prefix: urlPrefix, note: opts.note });
        process.stdout.write(`allowed ${d.entry.url_prefix}\n`);
        process.stdout.write(`  ${d.prefixes.length} prefix(es) now allowed for this org\n`);
      } catch (err) {
        if (err?.status === 400 && err?.message) {
          process.stderr.write(`Not added: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  al.command('remove <url-prefix>')
    .description('Stop allowing a URL prefix')
    .action(async (urlPrefix) => {
      const d = await call(client, 'fetchAllowlist.remove', { prefix: urlPrefix });
      if (d.removed) process.stdout.write(`removed ${urlPrefix}\n`);
      else process.stdout.write(`nothing to remove: ${urlPrefix} was not allowed for this org\n`);
    });
}

export default registerFetchAllowlistCommands;
