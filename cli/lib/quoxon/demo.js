import { readFileSync, writeFileSync } from 'node:fs';
import { DEMO_STEPS } from './demo.fixtures.js';

const sleep = (ms, signal) => new Promise((res) => {
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); res(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/** A fake api with the same surface as createApi(), driven by DEMO_STEPS. */
/**
 * WALK-FIXES pty seam (demo only, never a real server): decisionsFile is a JSON state file
 * { items: [decision inbox items], log: [], answerDelayMs?, approvalsDelayMs? }. approvals() lists the open ones,
 * answerDecision() marks one answered and appends { id, key, note, at } to log, so a test in another process reads
 * exactly what was submitted, and when.
 */
function decisionStore(file) {
  const load = () => JSON.parse(readFileSync(file, 'utf8'));
  const wait = (ms) => new Promise(r => setTimeout(r, ms || 0));
  return {
    // staleMs: an answered item is still listed for this long (a server that lags behind its own answers)
    async open() { const d = load(); await wait(d.approvalsDelayMs); return d.items.filter(x => x.status === 'open' || (d.staleMs && x.answeredAt && Date.now() - x.answeredAt < d.staleMs)); },
    async answer(id, key, note) {
      const d0 = load(); await wait(d0.answerDelayMs);
      const d = load(); const it = d.items.find(x => x.id === id);
      if (!it || it.status !== 'open') { const e = new Error('already handled'); e.status = 404; throw e; }
      it.status = 'answered'; it.answeredAt = Date.now(); it.answer = { key, note: note || null };
      d.log.push({ id, key, note: note || null, at: Date.now() });
      writeFileSync(file, JSON.stringify(d));
      return { ok: true };
    }
  };
}

export function createDemoApi({ speed = 1, objects = false, decisionsFile = null } = {}) {
  const decs = decisionsFile ? decisionStore(decisionsFile) : null;
  let gate = null;
  let decision = 'approve';
  return {
    orgId: () => 'demo-org',
    async *stream({ turnId }, signal) {
      decision = 'approve';
      for (const step of DEMO_STEPS(turnId)) {
        if (signal?.aborted) return;
        if (step.when && step.when !== decision) continue;
        if (step.gate) { await new Promise((res) => { gate = res; signal?.addEventListener('abort', res, { once: true }); }); continue; }
        await sleep(step.wait / speed, signal);
        if (signal?.aborted) return;
        yield step.ev;
      }
    },
    async steer() { return { ok: false, reason: 'unsupported' }; },
    async interrupt() { return { ok: false }; },
    async health() { return { ok: true, url: 'demo' }; },
    // the open approval is in the inbox while the demo holds at the gate, so a poll never prunes its card
    async approvals() { return [...(gate ? [{ id: 'demo-item', title: 'host_restart on web on edge-02', approval_id: 'demo-appr', created_at: new Date().toISOString() }] : []), ...(decs ? await decs.open() : [])]; },
    ...(decs ? { async answerDecision(id, key, { note } = {}) { return decs.answer(id, key, note); }, async approvalStats() { return { awaiting: (await decs.open()).length + (gate ? 1 : 0) }; } } : {}),
    async skills() { return [{ id: 'sk1', name: 'daily-fleet-check', description: 'Check fleet health and summarise.', edition: 'stable' }]; },
    async skill(id) { return { id, name: 'daily-fleet-check', description: 'Check fleet health and summarise.', edition: 'stable' }; },
    async conversationExists() { return { exists: true }; },
    // /proof works in the demo journey (main.js asks for it); the other object views stay unavailable offline
    ...(objects ? { objects: {
      async proof(tool) {
        const env = { id: tool.envelopeId, corr: 'demo-corr', payload: { success: true, tool_name: tool.tool } };
        return { data: { tool, envelope: { ok: true, env },
          aocl: { ok: true, list: [{ intent: 'aocl.identity.verified' }, { intent: 'aocl.policy.evaluated', payload: { allPassed: true } }] },
          receipt: { ok: true, result: { status: 'WITNESSED', entry: { seq: 4069513 } } } } };
      },
      ...Object.fromEntries(['skill', 'agent', 'workflowRun', 'crystal', 'memory', 'rules', 'reconcile'].map((k) => [k, async () => ({ error: 'Object views are not available in the demo.' })]))
    } } : {}),
    async respond(_id, action) {
      if (decs && _id !== 'demo-item') return decs.answer(_id, action === 'reject' ? 'n' : 'y', null); // a yes/no decision answered as an approval (the bulk card)
      decision = action === 'reject' ? 'reject' : 'approve'; const g = gate; gate = null; g?.(); return { ok: true };
    }
  };
}
