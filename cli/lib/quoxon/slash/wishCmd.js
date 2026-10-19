/** /wish: draft a governed spec, show it as one card, and on y create (skill, workflow) or file (power, code). Never installs code. */
import { wishPrompt, parseShape, creationPrompt, requestText, SHAPE_LABEL } from './wish.js';

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function createWishCmd({ api, say, card, runTurn, draft }) {
  return async function wish(arg) {
    const text = String(arg || '').trim();
    if (!text) return say('Usage: /wish <what you wish Quox could do>', 'warn');
    if (!draft) return say('/wish is not available in this mode.', 'warn');
    say('Drafting a spec for that…', 'dim');
    let spec;
    try { spec = await draft(wishPrompt(text)); } catch (e) { spec = null; say(`Draft failed: ${e?.message || e}`, 'warn'); }
    if (!spec || !String(spec).trim()) return say('Quox could not draft a spec for that, so nothing was proposed. Try /wish again.', 'warn');
    const shape = parseShape(spec);
    const body = String(spec).trim().split('\n').slice(0, 14).map(l => clip(l, 110));
    const plan = shape === 'skill' || shape === 'workflow'
      ? `On y: Quox creates it as ${shape === 'skill' ? 'an experimental skill queued for human review' : 'an inactive workflow'} through the normal governed path (you will see its tool call and receipt).`
      : `On y: the spec is filed as a feature request (${shape ? SHAPE_LABEL[shape] : 'shape unclear, treated as needing code'}). Nothing is installed; code goes through the normal build and review path.`;
    card.ask([`wish │ ${clip(text, 80)}`, ...body], // the plan is the card's "do" row
      async () => {
        if (shape === 'skill' || shape === 'workflow') { say(`Creating the ${shape}…`, 'dim'); return runTurn(creationPrompt(shape, text, spec)); }
        if (!api.gripe) return say('Filing is not available in this mode; the spec is above.', 'warn');
        const g = await api.gripe(requestText(text, spec).slice(0, 4000), { yes: true });
        if (!g.ok) return say(`Not filed: ${g.message}`, 'warn');
        const url = (g.notes || []).find(n => n.kind === 'created')?.url;
        say(url ? `Filed as a feature request: ${url}. Nothing was installed.` : 'Filed as a feature request. Nothing was installed.', 'ok');
        return undefined;
      }, 'Cancelled; nothing was created or filed.', { who: 'Quox', question: shape === 'skill' || shape === 'workflow' ? `Create the ${shape}?` : 'File it as a governed spec?', action: plan.replace(/^On y: /, '') });
    return undefined;
  };
}
