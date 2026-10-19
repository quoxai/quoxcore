/** `quox approvals walkthrough` and `quox inbox walkthrough`: the waiting questions, one card at a time. */
import { createInterface } from 'node:readline';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import { runWalkthrough } from '../core/walkthrough.js';

export function attachWalkthrough(parent, { client, auth }, program) {
  parent
    .command('walkthrough')
    .description('Walk through the questions waiting for you one at a time: what it does, why, my advice, then your choice')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const lp = resolveEndpoint('inbox.list', { orgId });
      const data = await client.get(lp.path, { service: lp.service, query: { status: 'open', limit: 200 } });
      const items = (data && (data.items || data)) || [];
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const lines = []; let waiting = null; let closed = false;
      rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
      rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
      const readLine = (prompt) => new Promise((res) => { if (lines.length) return res(lines.shift()); if (closed) return res(null); process.stdout.write(prompt); waiting = res; });
      try {
        await runWalkthrough(Array.isArray(items) ? items : [], {
          readLine, write: (l) => console.log(l),
          answer: async (it, key, note) => {
            const ep = resolveEndpoint('inbox.respond', { orgId, itemId: it.id });
            await client.post(ep.path, { service: ep.service, body: { action: 'answer', option: key, ...(note ? { comment: String(note).slice(0, 4000) } : {}) } });
          },
        });
      } finally { rl.close(); }
    });
}
