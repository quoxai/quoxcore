/**
 * `quox nucleus` — QUOXIFY PASS 2 (DEVSUITE phase 15).
 *
 * RepoBrain has been the cheap way to answer structural questions about the
 * Quox repos for a while (targeted snippets instead of whole files), but it
 * was reachable only through its own standalone binary and, for agents, a raw
 * tool. The quoxification audit called that out twice: no unified `quox`
 * verb (S-Q3), and an ungoverned side-path where the agent tool hit the
 * engine directly while the CLI did not (S-Q5).
 *
 * This verb closes the CLI half, and closes it the RIGHT way: it goes through
 * the collector's governed /api/v1/tools/execute, so the query is org-scoped
 * and audited exactly like every other tool call, rather than reaching the
 * engine behind the collector's back.
 *
 * Announce convention: RepoBrain surfaces announce themselves with 🧠 (see
 * the icon registry in CLAUDE.md), so a query is visible in a wall of
 * terminal output.
 */

import { formatDetail, printWarning } from '../core/output.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

export function registerNucleusCommands(program, { client, auth }) {
  const nucleus = program
    .command('nucleus')
    .description('Ask the codebase a question (RepoBrain, governed and audited)');

  nucleus
    .command('query', { isDefault: true })
    .description('Query the codebase and get cited file:line snippets')
    .argument('<question...>', 'the question, e.g. "where is the slot bridge verified?"')
    .option('-t, --target <repo>', 'repo to search (default: quox-dashboard)')
    .option('-n, --limit <n>', 'max snippets to return', '8')
    .action(async (questionParts, options) => {
      auth.requireAuth();
      const question = questionParts.join(' ').trim();
      if (!question) throw new Error('ask something: quox nucleus "where is X?"');

      printEvent(glyphLine('repobrain', `query "${question}"`));
      const started = Date.now();

      const ep = resolveEndpoint('v1.tools.execute');
      const body = {
        tool_name: 'codebase_query',
        input: {
          query: question,
          ...(options.target ? { repo: options.target } : {}),
          ...(options.limit ? { limit: parseInt(options.limit, 10) || 8 } : {}),
        },
      };
      const orgId = resolveOrgId(auth, program);
      if (orgId) body.org_id = orgId;

      const data = await client.post(ep.path, { service: ep.service, body, timeout: 60000 });
      const ms = Date.now() - started;

      // The tool result shape varies by engine version, so normalise rather
      // than assuming: an unexpected shape must still print SOMETHING true.
      const result = data && (data.result || data.output || data);
      const results = Array.isArray(result?.results) ? result.results
        : Array.isArray(result?.snippets) ? result.snippets
        : Array.isArray(result) ? result
        : null;

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }

      if (!results || results.length === 0) {
        printEvent(glyphLine('repobrain', `query "${question}"`, { result: '0 hits', ms }));
        printWarning('Nothing matched. Try naming a concrete symbol, filename or behaviour rather than a general description.');
        // Still show the raw payload when the shape was unexpected, so a
        // parsing gap here never looks like an empty index.
        if (result && !results) formatDetail(result, { format: program.opts().output });
        return;
      }

      printEvent(glyphLine('repobrain', `query "${question}"`, { result: `${results.length} hits`, ms }));
      for (const r of results) {
        const loc = r.file || r.path || r.source || '(unknown file)';
        const line = r.line || r.start_line || null;
        console.log('');
        console.log(`  ${loc}${line ? `:${line}` : ''}`);
        const snippet = r.snippet || r.content || r.text || '';
        for (const l of String(snippet).split('\n').slice(0, 20)) console.log(`    ${l}`);
      }
    });
}
