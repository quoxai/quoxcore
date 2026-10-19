'use strict';
/**
 * #904 (2026-10-14): when the Claude CLI exits non-zero because the provider
 * refused the turn (the server's subscription hit its weekly limit), the user
 * saw only "CLI exited with code 1" while the CLI's own output said exactly why.
 * This reads that output (stream-json lines, or one --output-format json object)
 * and returns a plain sentence, or null when nothing in it says why.
 */

const LIMIT_NAMES = { seven_day: 'weekly', five_hour: '5-hour' };

function resetText(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const iso = new Date(n * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function cliFailureReason(stdout, stderr) { // eslint-disable-line no-unused-vars
  const out = String(stdout || '');
  let limit = null;
  let result = null;
  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'rate_limit_event' && o.rate_limit_info && o.rate_limit_info.status === 'rejected') limit = o.rate_limit_info;
    if (o.type === 'result' && o.is_error) result = o;
  };
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { take(JSON.parse(t)); } catch { /* not a whole JSON line */ }
  }
  if (!limit && !result) {
    try { take(JSON.parse(out.trim())); } catch { /* not one JSON object either */ }
  }
  if (!limit && !result) return null;

  const said = result && typeof result.result === 'string' ? result.result.trim() : '';
  if (limit) {
    const kind = LIMIT_NAMES[limit.rateLimitType] || 'usage';
    const when = resetText(limit.resetsAt);
    return `The Claude subscription this server uses has hit its ${kind} limit${when ? `, which resets ${when}` : ''}. `
      + 'Connect another AI provider in Settings, or wait for the reset.'
      + (said ? ` The provider said: ${said}` : '');
  }
  const status = result.api_error_status ? ` (HTTP ${result.api_error_status})` : '';
  return `The AI provider refused the turn${status}: ${said || 'no reason given'}`;
}

module.exports = { cliFailureReason };
