import { DEMO_STEPS } from './demo.fixtures.js';

const sleep = (ms, signal) => new Promise((res) => {
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); res(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/** A fake api with the same surface as createApi(), driven by DEMO_STEPS. */
export function createDemoApi({ speed = 1, objects = false } = {}) {
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
    async approvals() { return gate ? [{ id: 'demo-item', title: 'host_restart on web on edge-02', approval_id: 'demo-appr', created_at: new Date().toISOString() }] : []; },
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
    async respond(_id, action) { decision = action === 'reject' ? 'reject' : 'approve'; const g = gate; gate = null; g?.(); return { ok: true }; }
  };
}
