/** /wish: the prompt that makes Quox draft a spec, reading its shape back, and the follow-up prompts. */
export const SHAPE_LABEL = { skill: 'a skill', workflow: 'a workflow', power: 'a power from a repo', code: 'needs code' };

export const wishPrompt = (wish) => 'The user wishes Quox could do something it cannot do today. Do NOT build or install anything and do not call any state-changing tool. '
  + 'Reply with a SHORT design spec, plain lines, no preamble, using exactly these labels:\n'
  + 'What it does: one or two sentences.\n'
  + 'Uses: which existing Quox tools, CLI commands or APIs it would call.\n'
  + 'Hat: which hat and permissions it needs.\n'
  + 'Tests: what would prove it works.\n'
  + 'Shape: exactly one of skill | workflow | power | code  (skill = a procedure an agent follows; workflow = a scheduled or triggered sequence of existing steps; power = packaged from a repo; code = needs new code).\n\n'
  + `Wish: ${String(wish).trim().slice(0, 1500)}`;

/** -> 'skill' | 'workflow' | 'power' | 'code' | null (no readable Shape line). */
export function parseShape(spec) {
  const m = /^\s*shape\s*:\s*(skill|workflow|power|code)\b/im.exec(String(spec || ''));
  return m ? m[1].toLowerCase() : null;
}

export const creationPrompt = (shape, wish, spec) => (shape === 'skill'
  ? `The user approved this spec. Create it now as a skill with skill_manage (op=create; it lands experimental and queued for review, which is expected). Use only what the spec says.\n\nWish: ${wish}\n\n${spec}`
  : `The user approved this spec. Create it now as a workflow with your workflow tool, left inactive: do not activate it or deploy it, and do not schedule it. Use only what the spec says.\n\nWish: ${wish}\n\n${spec}`);

export const requestText = (wish, spec) => `Feature request from /wish: ${wish}\n\nDrafted spec:\n${String(spec).trim()}\n\nNo shape of skill or workflow fit, so this needs the normal build and review path.`;
