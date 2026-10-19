/**
 * The sitrep as chat Markdown (Discord, Matrix, slots): short, scannable, under one Discord message.
 * Owner 2026-10-17: "Format your sitrep" after the spoken paragraph was posted to Discord as a wall of text.
 * Pure: data in, string out. No colour codes, no box drawing (chat clients mangle both).
 */

const URGENCY = { now: '🔴', today: '🟠', this_week: '🟡', week: '🟡', whenever: '⚪', fyi: '⚪' };
const STATE = { attention: '⚠️', ok: '✅', partial: '🟡', unknown: '❔', blind: '⛔' };
export const MAX_CHARS = 1900; // Discord's limit is 2000 per message

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function age(ms) {
  if (!(ms > 0)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function clockLondon(now) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(now));
  } catch { return new Date(now).toISOString().slice(11, 16) + ' UTC'; }
}

/** opts: { now, maxNeeds (default 6), maxChars (default MAX_CHARS) } */
export function renderSitrepMarkdown(data, opts = {}) {
  const sit = (data && data.situation) || data || {};
  const now = opts.now ?? Date.now();
  const maxNeeds = opts.maxNeeds ?? 6;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const cov = sit.coverage || (sit.cannot_see && sit.cannot_see.coverage) || { live: 0, expected: 0 };
  const missing = sit.coverage && Array.isArray(sit.coverage.missing) ? sit.coverage.missing : [];
  const needs = Array.isArray(sit.needs_you) ? sit.needs_you : [];
  const low = needs.filter((n) => n.urgency === 'whenever' || n.urgency === 'fyi').length;

  const out = [];
  out.push(`**◉ LUCID sitrep** · ${clockLondon(now)} · ${cov.live}/${cov.expected} sources`);
  out.push('');
  if (!needs.length) {
    out.push('**Needs you:** nothing right now.');
  } else {
    out.push(`**Needs you (${needs.length}${low ? `, ${low} low priority` : ''})**`);
    needs.slice(0, maxNeeds).forEach((n, i) => {
      const w = n.L1 && n.L1.when && n.L1.when.waited_ms;
      const tail = [n.area, age(w)].filter(Boolean).join(', ');
      out.push(`${i + 1}. ${URGENCY[n.urgency] || '•'} ${clip(n.L0, 90)}${tail ? ` _(${tail})_` : ''}`);
    });
    if (needs.length > maxNeeds) out.push(`…and ${needs.length - maxNeeds} more: \`quox sitrep\``);
  }

  const areas = Array.isArray(sit.areas) ? sit.areas : [];
  if (areas.length) {
    out.push('');
    out.push('**At a glance**');
    for (const a of areas) out.push(`${STATE[a.state] || '•'} **${a.label || a.area}**: ${clip(a.L0, 80)}`);
  }

  const dau = Array.isArray(sit.doesnt_add_up) ? sit.doesnt_add_up : [];
  if (dau.length) {
    out.push('');
    out.push(`**Doesn't add up (${dau.length}):** ${clip(dau[0].L0, 90)}${dau.length > 1 ? ' …' : ''}`);
  }
  out.push('');
  out.push(missing.length ? `**Can't see:** ${missing.join(', ')}` : `**Can't see:** nothing, every source is reporting.`);

  // Stay inside one chat message: drop "at a glance" rows from the bottom, then needs, never the header.
  let text = out.join('\n');
  while (text.length > maxChars && out.length > 3) {
    const i = out.findLastIndex((l) => /^(✅|⚠️|🟡|❔|⛔|•) \*\*/.test(l));
    if (i < 0) break;
    out.splice(i, 1);
    text = out.join('\n');
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
