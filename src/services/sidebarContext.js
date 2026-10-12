function formatSummaryLine(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return `- ${entry}`;
  const { label, value } = entry;
  if (!label || value == null || value === '') return null;
  return `- **${label}:** ${value}`;
}

function formatEvidenceLine(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return `- ${entry}`;

  const { label, text } = entry;
  if (!label && !text) return null;
  if (!label) return `- ${text}`;
  if (!text) return `- **${label}**`;
  return `- **${label}** — ${text}`;
}

function truncateText(value, maxLength = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function summarizeEnvelopeForSidebar(envelope, { maxLength = 220 } = {}) {
  if (!envelope) return null;

  const timestamp = envelope.ts
    ? new Date(envelope.ts).toLocaleString()
    : 'Unknown time';
  const actor = envelope.from || envelope.to || envelope.type || 'system';
  const intent = envelope.intent ? ` • ${envelope.intent}` : '';
  const payload = envelope.payload || {};

  let content = payload.text || payload.content || payload.command || payload.error_message || payload.status || '';

  if (!content && envelope.intent?.startsWith('aocl.')) {
    content = [payload.layer, payload.status, payload.reason].filter(Boolean).join(' • ');
  }

  if (!content && Object.keys(payload).length > 0) {
    content = JSON.stringify(payload);
  }

  return {
    label: `${timestamp} • ${actor}${intent}`,
    text: truncateText(content || '(no text payload)', maxLength),
  };
}

export function buildSidebarContextDocument({
  surface = 'sidebar',
  page,
  panel,
  focus,
  summary = [],
  evidenceTitle,
  evidence = [],
  instructions = [],
}) {
  const lines = ['## Interface Context'];

  if (surface) {
    const surfaceLabel = surface === 'sidebar'
      ? 'Sidebar chat'
      : surface.replace(/_/g, ' ');
    lines.push(`- **Mode:** ${surfaceLabel}`);
  }
  if (page) lines.push(`- **Page:** ${page}`);
  if (panel) lines.push(`- **Panel:** ${panel}`);

  if (focus?.label || focus?.id || focus?.type) {
    lines.push('');
    lines.push('### Current Focus');
    if (focus.type) lines.push(`- **Type:** ${focus.type}`);
    if (focus.label) lines.push(`- **Label:** ${focus.label}`);
    if (focus.id) lines.push(`- **ID:** ${focus.id}`);
    if (focus.detail) lines.push(`- **Detail:** ${focus.detail}`);
  }

  const summaryLines = summary.map(formatSummaryLine).filter(Boolean);
  if (summaryLines.length > 0) {
    lines.push('');
    lines.push('### Page State');
    lines.push(...summaryLines);
  }

  const evidenceLines = evidence.map(formatEvidenceLine).filter(Boolean);
  if (evidenceLines.length > 0) {
    lines.push('');
    lines.push(`### ${evidenceTitle || 'Evidence'}`);
    lines.push(...evidenceLines);
  }

  if (instructions.length > 0) {
    lines.push('');
    lines.push(...instructions.filter(Boolean));
  }

  return lines.join('\n');
}

export function renderContextDocument(context) {
  if (!context) return '';
  if (typeof context === 'string') return context;
  return buildSidebarContextDocument(context);
}
