/**
 * /compact: POST /api/v1/conversations/:id/compact asks the server to summarise the conversation (keeping
 * decisions); the summary becomes the head of the conversation for later turns. This module only words the
 * result and the refusals; nothing is summarised on the client.
 */
export const SUMMARY_LINES = 6;

/** 18400 -> "18.4k", 950 -> "950". */
export function kTokens(n) {
  if (n == null || n === '') return '?';
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  if (v < 1000) return String(Math.round(v));
  return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/** The result -> { head, tone, summaryLines, more, notes[] }. */
export function compactResult(r, { max = SUMMARY_LINES } = {}) {
  const lines = String(r?.summary || '').split('\n').map(l => l.replace(/\s+$/, '')).filter((l, i, a) => l || (i > 0 && a[i - 1]));
  const n = Number(r?.turns_compacted) || 0;
  const head = r?.unchanged
    ? `Nothing new to compact; the summary is already up to date (${kTokens(r?.tokens_after)} tokens).`
    : `Compacted ${n} turn${n === 1 ? '' : 's'}: ${kTokens(r?.tokens_before)} -> ${kTokens(r?.tokens_after)} tokens`;
  const notes = [];
  if (!r?.unchanged && Number(r?.tokens_after) > Number(r?.tokens_before)) notes.push('The summary is longer than what it replaced: this conversation was too short to gain from compacting.');
  if (r?.provider || r?.model) notes.push(`Summarised by ${[r.provider, r.model].filter(Boolean).join(' ')}.`);
  if (Array.isArray(r?.tool_activity) && r.tool_activity.some(t => t?.tools?.length)) notes.push('/compact show lists the tool activity recorded in those turns, the basis for any action the summary names.');
  if (r?.cli_session_reset) notes.push('The Claude CLI session behind this conversation was reset, so it starts from the summary.');
  return { head, tone: r?.unchanged ? undefined : 'ok', summaryLines: lines.slice(0, max), more: Math.max(0, lines.length - max), allLines: lines, notes, basisLines: toolBasisLines(r?.tool_activity) };
}

/**
 * The server's recorded tool activity per compacted turn -> lines. Read from the stored turns, never
 * from the model, so any action the summary names can be checked here. No row is "none recorded",
 * not "none ran": only some paths record tool activity.
 */
export function toolBasisLines(activity) {
  if (!Array.isArray(activity)) return ['The server sent no tool activity record for this compaction.'];
  if (!activity.length) return ['No turns were compacted, so there is no tool activity.'];
  return activity.map((t) => {
    const tools = (Array.isArray(t?.tools) ? t.tools : []).map(x => `${x?.name || '?'} ${x?.status || '?'}`);
    if (Number(t?.more) > 0) tools.push(`and ${Number(t.more)} more`);
    return `turn ${t?.turn ?? '?'}: ${tools.length ? tools.join(', ') : 'no tools recorded'}`;
  });
}

/** /compact show: the whole summary, then the recorded tool activity it was made from. */
export function compactShowLines(v) {
  const basis = Array.isArray(v?.basisLines) ? v.basisLines : toolBasisLines(undefined);
  return [
    { kind: 'plain', text: `Summary (${v.allLines.length} lines)` },
    ...v.allLines.map(t => ({ kind: 'dim', text: t || ' ' })),
    { kind: 'plain', text: 'Recorded tool activity (from the stored turns, not the model)' },
    ...basis.map(t => ({ kind: 'dim', text: t })),
  ];
}

/** A refused or failed compaction -> one honest line. */
export function compactError(e) {
  const code = e?.code || e?.body?.error || null;
  const msg = e?.body?.message || null;
  if (e?.status === 409) {
    if (code === 'turn_running') return 'A turn is still running in this conversation. Compact after it finishes.';
    if (code === 'compact_in_progress') return 'A compaction of this conversation is already running.';
    if (code === 'transcripts_disabled') return msg || 'Transcript storage is off for this org, so no summary can be stored.';
    return msg || 'The server refused to compact right now (409).';
  }
  if (e?.status === 403 && code === 'ai_consent_required') return 'Compacting sends this conversation to your AI provider, and you have not given AI processing consent. /consent grant gives it (Settings > Privacy in the dashboard does too).';
  if (e?.status === 403) return 'Not allowed to compact this conversation (403).';
  if (e?.status === 404) return 'The server has no stored turns for this conversation (expired after 7 days, or nothing sent yet).';
  if (e?.status === 502) return 'The model call failed; nothing was changed. Try /compact again.';
  if (e?.status === 503 && code === 'no_provider') return 'No AI provider is configured for this org, so nothing can summarise it. /connect openai';
  if (e?.status === 500 && code === 'summary_not_stored') return 'The summary was made but could not be stored; nothing was changed.';
  if (e?.status === 404 || e?.status === 405) return 'This server cannot compact conversations yet.';
  return `compact failed: ${e?.status ? `HTTP ${e.status} ` : ''}${e?.message || 'failed'}`.trim();
}

/** GET .../context -> the /context rows' facts. */
export function contextFacts(c) {
  if (!c || typeof c !== 'object') return null;
  const t = c.tokens || {};
  const how = t.source === 'cli_session_usage' ? 'from the CLI session usage' : t.source === 'chars_div_4' ? 'estimated from stored text (chars / 4)' : t.source ? `source ${t.source}` : 'source not given';
  return {
    tokens: t.estimate,
    tokensText: `${kTokens(t.estimate)} tokens${t.context_window ? ` of ${kTokens(t.context_window)}` : ''}, ${how}`,
    turns: c.turns,
    turnsText: c.turns == null ? null : c.summary_present ? `${c.turns} turn${c.turns === 1 ? '' : 's'} since the summary` : `${c.turns} stored turn${c.turns === 1 ? '' : 's'}`,
    summaryText: c.summary_present ? `yes, ${c.compacted_turns ?? '?'} turns folded in${c.summary_at ? ` (${String(c.summary_at).slice(0, 16).replace('T', ' ')} UTC)` : ''}` : 'none yet (/compact)'
  };
}
