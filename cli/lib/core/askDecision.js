/**
 * quox ask helpers: parse the option list and durations, and wait (bounded long-poll) for a human's answer.
 * Pure of the CLI framework so the exit codes are unit-testable. Exit codes: 0 answered, 2 expired or denied.
 */

export const EXIT_ANSWERED = 0;
export const EXIT_NO_ANSWER = 2;

/** "a: Ship now|b: Wait|c: Drop" -> [{key,label}]. A bare "a|b" gives key=label. Throws with a usable message. */
export function parseOptions(text) {
  const parts = String(text || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('--options needs at least two, e.g. "a: Ship now|b: Wait for review|c: Drop it" (or use --yn)');
  return parts.map((p) => {
    const m = /^([A-Za-z0-9]{1,8})\s*[:=]\s*(.*)$/.exec(p);
    if (m) return { key: m[1].toLowerCase(), label: m[2].trim() || m[1] };
    if (/^[A-Za-z0-9]{1,8}$/.test(p)) return { key: p.toLowerCase(), label: p };
    throw new Error(`could not read option "${p}": write it as key: label, e.g. "a: Ship now"`);
  });
}

export const YN_OPTIONS = [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }];

/** "90s" | "10m" | "2h" | "1d" | bare seconds -> seconds. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(text || '').trim());
  if (!m) throw new Error(`could not read duration "${text}": use 90s, 10m, 2h or 1d`);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

const fmtLeft = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 120 ? `${Math.round(m / 60)}h` : m >= 1 ? `${m}m` : '<1m'; };

/**
 * Long-poll a decision until it is no longer pending.
 * @param {{poll:(waitSeconds:number)=>Promise<object>, log:(s:string)=>void, sleep?:Function, now?:()=>number, maxWaitMs?:number|null, pollSeconds?:number}} o
 * @returns {Promise<{code:number, stdout:string, decision:object|null}>} stdout = chosen option key (+ note line) only when answered.
 */
export async function waitForDecision({ poll, log, now = Date.now, maxWaitMs = null, pollSeconds = 25 }) {
  const start = now();
  let errors = 0;
  for (;;) {
    let d;
    try { d = (await poll(pollSeconds)).decision; errors = 0; }
    catch (e) {
      if (e?.status === 404 || e?.status === 403 || e?.status === 401) throw e; // not a blip: a decision we cannot see
      if (++errors >= 5) throw e;
      log(`could not reach the server (${e?.message || 'failed'}), retrying (${errors}/5)`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!d) throw new Error('the server returned no decision');
    if (d.state === 'answered') return { code: EXIT_ANSWERED, stdout: `${d.answer?.option ?? ''}${d.answer?.note ? `\n${d.answer.note}` : ''}`, decision: d };
    if (d.state === 'denied') { log(`denied${d.answer?.note ? `: ${d.answer.note}` : ''}`); return { code: EXIT_NO_ANSWER, stdout: '', decision: d }; }
    if (d.state === 'expired' || d.state === 'cancelled') { log(`${d.state}, no answer${d.default ? ` (default was ${d.default}; not applied)` : ''}`); return { code: EXIT_NO_ANSWER, stdout: '', decision: d }; }
    const elapsed = now() - start;
    const left = d.expires_at ? Date.parse(d.expires_at) - now() : null;
    log(`still waiting for a human (${d.session || 'session'}, ${fmtLeft(elapsed)} elapsed${left != null ? `, ${fmtLeft(left)} left` : ''})`);
    if (maxWaitMs != null && elapsed >= maxWaitMs) { log('gave up waiting (--timeout); the question is still open: quox ask wait ' + d.id); return { code: EXIT_NO_ANSWER, stdout: '', decision: d }; }
  }
}
