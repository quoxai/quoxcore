/**
 * /mode (owner 2026-10-16 "/say quoxon a but log b"): this window's mode.
 *   ask   (default) Quox asks you before it acts; what needs approval is your org's policy.
 *   plan  Quox investigates (read tools) and proposes the steps and exact commands; it runs nothing that
 *         changes state. The SERVER enforces it: the turn carries mode 'plan' (lib/planMode.js in the collector).
 *   auto  not built. Logged as a plan: it needs standing grants first.
 * Window-scoped: carried across /restart (QUOX_RESTART_MODE), never written to the shared profile.
 */

export const MODES = ['ask', 'plan'];
export const AUTO_NOT_YET = 'not available yet: auto mode needs standing grants (planned).';
export const PLAN_GO = 'go ahead with the plan';

/** -> 'plan' | 'ask' (anything else, including 'auto', is 'ask'). */
export function normMode(v) {
  return String(v || '').trim().toLowerCase() === 'plan' ? 'plan' : 'ask';
}

const DESC = {
  ask: 'ask first: Quox asks you before it acts. What needs your approval is your org\'s policy on the server (/approvals lists what is waiting).',
  plan: 'plan only: Quox investigates with read tools and proposes the steps and the exact commands. It runs nothing that changes state; the server enforces it.',
};

/** One line per mode for the arrow-key chooser (the same one /model uses). Auto is not offered: it is not built. */
export const MODE_ROWS = [
  { id: 'ask', text: 'ask first: Quox asks before it acts' },
  { id: 'plan', text: 'plan only: Quox proposes the steps and runs nothing that changes state' },
];

/**
 * Pure: the reply to `/mode [arg]` given the current mode.
 * -> { text, tone, mode? } where mode is set only when it changes.
 */
export function modeReply(arg, current) {
  const cur = normMode(current);
  const a = String(arg || '').trim().toLowerCase();
  if (!a || /^(-h|--help|help|\?)$/.test(a)) {
    return { tone: null, text: `mode ${DESC[cur]}\nOptions: /mode ask (the default), /mode plan (plan only). Auto mode is ${AUTO_NOT_YET}` };
  }
  if (a === 'auto') return { tone: 'warn', text: `/mode auto is ${AUTO_NOT_YET} Options: /mode ask, /mode plan.` };
  if (!MODES.includes(a)) return { tone: 'warn', text: `Unknown mode '${clipWord(a)}'. Options: /mode ask, /mode plan.` };
  if (a === cur) return { tone: 'dim', text: `Already in mode ${DESC[cur]}` };
  return { mode: a, tone: 'ok', text: a === 'plan' ? `mode ${DESC.plan} /mode ask to go back.` : `mode ${DESC.ask}` };
}

function clipWord(w) { return w.length > 20 ? `${w.slice(0, 19)}…` : w; }
