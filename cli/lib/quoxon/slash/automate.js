/**
 * /automate [task]: turn the conversation (or the task you name) into a persistent workflow.
 * Real: the draft is ONE model call (draft.js); creation uses the quoxflow workflow store (POST /api/workflows) and
 * activation registers its trigger (POST /api/workflows/:id/activate), the same calls as `quox workflow apply` and
 * `quox trigger workflow-activate`. The model only fills a small, validated shape; node types are an allowlist.
 */
import { draftJson, transcriptText } from './draft.js';

const STEP_TYPES = new Set(['agent:invoke', 'approval:gate', 'notification:deliver', 'util:log']);
const CRON_RE = /^\s*\S+(\s+\S+){4}\s*$/;
const why = (e) => `${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workflow';

export const automatePrompt = (context) => [
  'Draft a persistent automation from the conversation below. Reply with ONE JSON object and nothing else. Use no tools.',
  'Shape: {"name":str,"description":str,"trigger":{"type":"schedule","cron":"5-field cron","timezone":"UTC"} or {"type":"webhook","path":"/name"},',
  ' "steps":[{"id":str,"type":"agent:invoke"|"approval:gate"|"notification:deliver"|"util:log","label":str,"prompt":str (agent:invoke) or "message":str (others)}],',
  ' "recovery":{"onFailure":"stop"|"continue","retry":bool}}.',
  'Infer the trigger and schedule from what the user wants; add an approval:gate before anything irreversible or external; keep 2 to 6 steps.',
  '', '--- conversation ---', context, '--- end ---'
].join('\n');

/** Validate the model draft and build the quoxflow workflow definition. -> { def, card[] } or { error } */
export function buildWorkflow(d, now = Date.now()) {
  if (!d || typeof d.name !== 'string' || !d.name.trim()) return { error: 'the draft has no name' };
  const t = d.trigger || {};
  let trigger;
  if (t.type === 'schedule' && typeof t.cron === 'string' && CRON_RE.test(t.cron)) trigger = { id: 'trigger', type: 'trigger:schedule', config: { cron: t.cron.trim(), timezone: t.timezone || 'UTC' } };
  else if (t.type === 'webhook' && typeof t.path === 'string' && t.path.trim()) trigger = { id: 'trigger', type: 'trigger:webhook', config: { path: t.path.trim(), method: 'POST' } };
  else return { error: 'the draft has no valid trigger (a 5-field cron schedule or a webhook path)' };
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!steps.length || steps.length > 8) return { error: 'the draft needs between 1 and 8 steps' };
  const nodes = [trigger];
  for (const [i, s] of steps.entries()) {
    if (!s || !STEP_TYPES.has(s.type)) return { error: `step ${i + 1} has a type that is not allowed (${s?.type})` };
    const id = `s${i + 1}`, label = String(s.label || s.type);
    const text = String(s.prompt || s.message || '').trim();
    if (!text) return { error: `step ${i + 1} (${label}) has no prompt or message` };
    const config = s.type === 'agent:invoke' ? { agent_id: 'quox', prompt: text, label }
      : s.type === 'approval:gate' ? { label, message: text, approvers: ['*'], expiresIn: '48h' }
        : s.type === 'notification:deliver' ? { title: label, message: text }
          : { level: 'info', message: text, label };
    nodes.push({ id, type: s.type, config });
  }
  const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id }));
  const stop = (d.recovery?.onFailure || 'stop') !== 'continue';
  const retry = d.recovery?.retry === true;
  const def = {
    id: `${slug(d.name)}-${now.toString(36)}`, name: d.name.trim(), description: String(d.description || '').slice(0, 500),
    nodes, edges, settings: { errorBehavior: stop ? 'stop' : 'continue', retryOnFailure: retry, saveEvidence: true },
    metadata: { source: 'quoxon /automate' }
  };
  const when = trigger.type === 'trigger:schedule' ? `schedule  ${trigger.config.cron} (${trigger.config.timezone})` : `webhook  POST ${trigger.config.path}`;
  const gates = nodes.filter((n) => n.type === 'approval:gate').map((n) => n.config.label);
  const card = [
    ['Workflow draft (nothing is created until you answer):', 'accent'],
    `  Name       ${def.name}`,
    `  Trigger    ${when}`,
    `  Steps      ${nodes.slice(1).map((n) => n.config.label || n.type).join(' > ')}`,
    `  Approvals  ${gates.length ? gates.join(', ') : 'none (it runs without asking)'}`,
    `  Recovery   ${stop ? 'stop on failure' : 'continue on failure'}${retry ? ', retry on' : ''}`
  ];
  return { def, card };
}

export function createAutomateCmd({ api, say, confirm, getState, getFields }) {
  return {
    async handle(arg) {
      if (!api.workflowCreate) return say('Workflows are not available in this mode.', 'warn');
      const ctx = [transcriptText(getState()), String(arg || '').trim() ? `User wants to automate: ${String(arg).trim()}` : ''].filter(Boolean).join('\n');
      if (!ctx) return say('Nothing to automate yet. Do the task with Quox first, or say what: /automate every monday send me a signup digest.');
      say('Drafting the workflow…', 'dim');
      let d;
      try { d = await draftJson({ api, prompt: automatePrompt(ctx), fields: getFields() }); }
      catch (e) { return say(`Could not draft a workflow: ${e.message}. Nothing was created.`, 'warn'); }
      const b = buildWorkflow(d);
      if (b.error) return say(`Could not draft a usable workflow: ${b.error}. Nothing was created.`, 'warn');
      confirm.ask(b.card, async () => {
        let c;
        try { c = await api.workflowCreate(b.def); } catch (e) { return say(`Could not create the workflow: ${why(e)}`, 'warn'); }
        const id = c?.id || b.def.id;
        try { await api.workflowActivate(id); } catch (e) { say(`Workflow ${id} was created but NOT activated (${why(e)}), so it will not run on its own. quox trigger workflow-activate ${id}`, 'warn'); return say(`  See it: /workflow ${id}`); }
        say(`✔ Workflow "${b.def.name}" created and active (id ${id}).`, 'ok');
        say(`  See it: /workflow ${id}`);
      }, { prompt: 'Create and activate this workflow?' });
      return undefined;
    }
  };
}
