/** Backend calls behind /watch, /automate and /crystallize, kept out of api.js (one spread there). */
import { resolveEndpoint } from '../../api/endpoints.js';

export function createKillerApi({ client }) {
  return {
    async watchCreate(body) { const ep = resolveEndpoint('agent-schedules.create'); return client.post(ep.path, { service: ep.service, body }); },
    async watchList() { const ep = resolveEndpoint('agent-schedules.list'); return client.get(ep.path, { service: ep.service, retries: 0 }); },
    async watchStop(id) { const ep = resolveEndpoint('agent-schedules.delete', { id }); return client.delete(ep.path, { service: ep.service }); },
    /** quoxflow-direct, as `quox workflow apply`: -> the stored workflow (has .id). */
    async workflowCreate(def) { const ep = resolveEndpoint('workflows.applyCreate'); const d = await client.post(ep.path, { service: ep.service, body: def }); return d?.data || d; },
    /** As `quox trigger workflow-activate`: registers the workflow's triggers. */
    async workflowActivate(workflowId) { const ep = resolveEndpoint('workflows.activate', { workflowId }); return client.post(ep.path, { service: ep.service, body: {} }); },
    /** QSKL store create. { dryRun: true } asks only for the skill firewall verdict (throws 422 when blocked). */
    async skillCreate(body, { dryRun = false } = {}) { const ep = resolveEndpoint('skills.create'); const d = await client.post(ep.path, { service: ep.service, body, query: dryRun ? { dry_run: 'true' } : undefined }); return d?.data || d; }
  };
}
