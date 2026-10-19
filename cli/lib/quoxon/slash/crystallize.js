/**
 * /crystallize [what]: turn what was just accomplished into a permanent reusable skill (rules, tools, tests).
 * Real: one drafting model call (draft.js), a dry-run through the skill firewall for the preview, and creation in
 * the QSKL store (POST /api/quox-skills). /crystal (is a workflow eligible to become a Crystal) is a different check.
 */
import { draftJson, transcriptText } from './draft.js';

const why = (e) => `${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}`;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

export const crystallizePrompt = (context) => [
  'Turn what was just accomplished in the conversation below into a reusable skill. Reply with ONE JSON object and nothing else. Use no tools.',
  'Shape: {"name":"kebab-case-name","category":str,"description":"one sentence","rules":[str,...],"tools":[tool name,...],',
  ' "tests":[{"name":str,"input":str,"expect":str}]}.',
  'Rules are the steps and guardrails to repeat next time. Never include secrets, keys, hostnames or personal data. Tools are only ones actually used above.',
  '', '--- conversation ---', context, '--- end ---'
].join('\n');

/** -> { body (POST /api/quox-skills), card[] } or { error } */
export function buildSkill(d, { orgId, author }) {
  const name = String(d?.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return { error: 'the draft has no valid kebab-case name' };
  const rules = (Array.isArray(d.rules) ? d.rules : []).map((r) => String(r).trim()).filter(Boolean);
  if (!rules.length) return { error: 'the draft has no rules' };
  const description = String(d.description || '').trim();
  if (!description) return { error: 'the draft has no description' };
  const tools = (Array.isArray(d.tools) ? d.tools : []).map((t) => String(t).trim()).filter(Boolean);
  const tests = {};
  for (const [i, t] of (Array.isArray(d.tests) ? d.tests : []).entries()) {
    if (t && (t.input || t.expect)) tests[String(t.name || `case-${i + 1}`)] = { input: String(t.input || ''), expect: String(t.expect || '') };
  }
  const bodyMd = [`# ${name}`, '', description, '', '## Rules', ...rules.map((r, i) => `${i + 1}. ${r}`),
    ...(tools.length ? ['', '## Tools', ...tools.map((t) => `- ${t}`)] : [])].join('\n');
  const body = { orgId, scopeId: null, name, category: String(d.category || 'general'), description, bodyMd, author: author || 'quoxon', requiredTools: tools, tests, tags: ['crystallized'] };
  const card = [
    ['Skill draft (nothing is saved until you answer):', 'accent'],
    `  Name       ${name}`,
    `  About      ${description}`,
    `  Rules      ${rules.length}   first: ${rules[0]}`,
    `  Tools      ${tools.length ? tools.join(', ') : 'none'}`,
    `  Tests      ${Object.keys(tests).length}${Object.keys(tests).length ? '   ' + Object.keys(tests).join(', ') : ''}`
  ];
  return { body, card, name };
}

export function createCrystallizeCmd({ api, say, confirm, getState, getFields }) {
  return {
    async handle(arg) {
      if (!api.skillCreate) return say('Skills are not available in this mode.', 'warn');
      const ctx = [transcriptText(getState()), String(arg || '').trim() ? `Focus: ${String(arg).trim()}` : ''].filter(Boolean).join('\n');
      if (!ctx) return say('Nothing to crystallize yet. Do the task with Quox first, or say what: /crystallize how we rotate the API key.');
      say('Drafting the skill…', 'dim');
      let d;
      try { d = await draftJson({ api, prompt: crystallizePrompt(ctx), fields: getFields() }); }
      catch (e) { return say(`Could not draft a skill: ${e.message}. Nothing was saved.`, 'warn'); }
      const b = buildSkill(d, { orgId: api.orgId?.(), author: api.userId?.() });
      if (b.error) return say(`Could not draft a usable skill: ${b.error}. Nothing was saved.`, 'warn');
      try { await api.skillCreate(b.body, { dryRun: true }); } // the server's skill firewall, before the card
      catch (e) { return say(`The skill was not saved: ${why(e)}`, 'warn'); }
      b.card.push('  Firewall   passed the server dry run');
      confirm.ask(b.card, async () => {
        try { await api.skillCreate(b.body); } catch (e) { return say(`Could not save the skill: ${why(e)}`, 'warn'); }
        say(`✔ Saved skill ${b.name}.`, 'ok');
        say(`  See it: /skills ${b.name}`);
      }, { prompt: 'Save this skill?' });
      return undefined;
    }
  };
}
