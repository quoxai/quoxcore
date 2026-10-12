/**
 * QCX-5j: Pure helpers for AnalyticsTab.
 */

const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/** Date range for a preset id. `now` arg overrideable for tests. */
export function dateRangeFor(rangeId, now) {
  const t = typeof now === 'number' ? now : Date.now();
  if (rangeId === 'all') return { from: '', to: '' };
  const days = PRESET_DAYS[rangeId] ?? PRESET_DAYS['30d'];
  const to = new Date(t).toISOString();
  const from = new Date(t - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/** Equally-long previous period (for compare-to-previous metrics). */
export function shiftRangeBack({ from, to }) {
  if (!from || !to) return { from: '', to: '' };
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { from: '', to: '' };
  const span = toMs - fromMs;
  return {
    from: new Date(fromMs - span).toISOString(),
    to: new Date(toMs - span).toISOString(),
  };
}

/** Percent change rounded to the nearest integer. Null when undefined. */
export function computePctChange(curr, prev) {
  if (typeof curr !== 'number' || typeof prev !== 'number') return null;
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
}

/** Minimum sample size before a ratio stat is considered meaningful. */
export const MIN_VOTE_SAMPLE = 5

/**
 * Ratio display for small-sample-sensitive stats (e.g. thumbs up ratio).
 * Below `min` samples the ratio is not meaningful, so we show a neutral
 * "not enough data" message instead of a percentage that reads as good
 * or bad news it isn't earning yet.
 */
export function ratioDisplay(ratio, sampleCount, { min = MIN_VOTE_SAMPLE, goodThreshold = 0.7 } = {}) {
  const count = typeof sampleCount === 'number' && Number.isFinite(sampleCount) ? sampleCount : 0
  if (count < min) {
    return { value: 'Not enough ratings yet', color: 'rgba(255,255,255,0.5)', suppressed: true }
  }
  const pct = Math.round((ratio || 0) * 100)
  return { value: `${pct}%`, color: (ratio || 0) >= goodThreshold ? '#30ff90' : '#f59e0b', suppressed: false }
}

/** Count of conversations carrying a visitor rating (thumbs up or down). */
export function countRatedConversations(conversations) {
  return (conversations || []).filter((c) => c?.visitor_rating !== undefined && c?.visitor_rating !== null).length
}

/**
 * Knowledge coverage tone. Coverage of 0% on a fresh widget with no
 * sources or chunks yet is informational, not a failure, so it renders
 * neutral. Red is reserved for a real (non-empty) knowledge base that
 * still scores low.
 */
export function coverageDisplay(coverage, hasKnowledge) {
  if (!hasKnowledge) {
    return { color: 'rgba(255,255,255,0.5)', neutral: true }
  }
  return { color: coverage >= 70 ? '#30ff90' : coverage >= 40 ? '#f59e0b' : '#ef4444', neutral: false }
}

const QUESTION_WORDS = ['what', 'how', 'why', 'when', 'where', 'who', 'can', 'does', 'is', 'are', 'do']

/** True when a string reads as a question (ends with "?" or opens with a question word). */
export function isInterrogative(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('?')) return true
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, '')
  return QUESTION_WORDS.includes(firstWord)
}

/** Filter a top-questions list down to items that actually read as questions. */
export function filterInterrogatives(items) {
  return (items || []).filter((item) => isInterrogative(item?.question))
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV with one header row + one data row. */
export function serializeStatsCsv(stats, meta) {
  const headers = ['range', 'from', 'to', 'total_conversations', 'total_messages', 'handed_off', 'satisfaction_pct', 'avg_messages'];
  const row = [
    meta?.rangeLabel || '',
    meta?.from || '',
    meta?.to || '',
    stats?.totalConversations || 0,
    stats?.totalMessages || 0,
    stats?.handedOffCount || 0,
    Math.round(((stats?.satisfactionRatio) || 0) * 100),
    stats?.avgMessages || 0,
  ];
  return `${headers.map(csvField).join(',')}\n${row.map(csvField).join(',')}\n`;
}

/** Wave 5: map the server summary to the stat shape the tab renders. */
export function statsFromSummary(sum) {
  const rated = sum?.rating?.rated || 0
  const up = sum?.rating?.thumbs_up || 0
  return {
    totalConversations: sum?.total_conversations || 0,
    totalMessages: sum?.total_messages || 0,
    handedOffCount: sum?.handed_off || 0,
    closedCount: sum?.closed || 0,
    activeCount: sum?.active || 0,
    satisfactionRatio: rated > 0 ? Math.round((up / rated) * 100) / 100 : 0,
    avgMessages: sum?.avg_messages || 0,
  }
}

export const UNANSWERED_REASON_LABELS = {
  no_knowledge: 'No matching knowledge',
  low_confidence: 'Weak match',
  stripped: 'Reply stripped',
  withheld: 'Reply withheld',
  answer_corrected: 'Answer was corrected',
  figure_gate: 'Figure removed by the gate',
  possible_wrong_abstain: 'Possible wrong abstain',
}

/**
 * Answer quality = share of assessed answers backed by strong knowledge,
 * from each answer's stored grounding verdict (never a chunk-count formula).
 * Answers with no stored verdict (older rows, blocked turns) are not assessed
 * and are stated as such rather than counted either way.
 */
export function answerQualityDisplay(q) {
  if (!q || !q.assessed) {
    return {
      percent: 0,
      valueLabel: 'n/a',
      color: 'rgba(255,255,255,0.5)',
      detail: q && q.unassessed
        ? `No assessed answers in this range (${q.unassessed} older or unscored)`
        : 'No assessed answers in this range yet',
    }
  }
  const rate = q.answered_rate ?? q.answered / q.assessed
  const percent = Math.round(rate * 100)
  const parts = []
  if (q.no_knowledge) parts.push(`${q.no_knowledge} no match`)
  if (q.low_confidence) parts.push(`${q.low_confidence} weak match`)
  if (q.stripped) parts.push(`${q.stripped} stripped`)
  if (q.withheld) parts.push(`${q.withheld} withheld`)
  return {
    percent,
    valueLabel: `${percent}%`,
    color: percent >= 70 ? '#30ff90' : percent >= 40 ? '#f59e0b' : '#ef4444',
    detail: `${q.answered} of ${q.assessed} answers backed by strong knowledge${parts.length ? ` · ${parts.join(' · ')}` : ''}${q.unassessed ? ` · ${q.unassessed} not scored` : ''}`,
  }
}
