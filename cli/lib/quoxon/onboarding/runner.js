/**
 * Install runner interface (C2a). The view only ever talks to this shape:
 *
 *   runner = {
 *     kind: 'dry-run' | 'real',
 *     stages: [{ id, label }],                       // fetch, configure, build, start, health
 *     run({ onEvent, signal, request }) -> Promise<{ ok, dashboardUrl?, failedStage?, error? }>
 *   }
 *   events: { type: 'stage', id, status: 'running' | 'ok' | 'fail', at, ms? }
 *           { type: 'log', line }                    // the real log tail (`v` shows it)
 *
 * The real runner (C2b) wraps get.quox.ai -> scripts/setup.sh and maps its "Step n/7" lines onto these stages.
 * Only the dry run exists today: simulated, labelled, nothing downloaded, built or started.
 */
import { STAGES } from './copy.js';

export const STAGE_IDS = ['fetch', 'configure', 'build', 'start', 'health'];
export const stageList = () => STAGE_IDS.map(id => ({ id, label: STAGES[id] }));

const DRY_LOG = {
  fetch: ['[dry run] would clone quox, quoxflow and quoxmcp'],
  configure: ['[dry run] would generate .env secrets and a self-signed certificate'],
  build: ['[dry run] would run: docker compose build'],
  start: ['[dry run] would run: docker compose up -d'],
  health: ['[dry run] would wait for every service health check']
};

const wait = (ms, signal) => new Promise((res) => {
  if (signal?.aborted) return res();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); res(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

/** Dry run: walks the stages on a timer. `failAt` makes one stage fail (tests, demo of the failure path). */
export function createDryRunRunner({ stepMs = 450, failAt = null, now = () => Date.now(), dashboardUrl = 'https://localhost:3000' } = {}) {
  return {
    kind: 'dry-run',
    stages: stageList(),
    async run({ onEvent = () => {}, signal } = {}) {
      for (const id of STAGE_IDS) {
        if (signal?.aborted) return { ok: false, interrupted: true };
        const t0 = now();
        onEvent({ type: 'stage', id, status: 'running', at: t0 });
        for (const line of DRY_LOG[id]) onEvent({ type: 'log', line });
        await wait(stepMs, signal);
        if (signal?.aborted) return { ok: false, interrupted: true };
        if (failAt === id) {
          onEvent({ type: 'log', line: `[dry run] simulated failure at ${id}` });
          onEvent({ type: 'stage', id, status: 'fail', at: now(), ms: now() - t0 });
          return { ok: false, failedStage: id, error: 'simulated failure (dry run)' };
        }
        onEvent({ type: 'stage', id, status: 'ok', at: now(), ms: now() - t0 });
      }
      return { ok: true, dashboardUrl, dryRun: true };
    }
  };
}
