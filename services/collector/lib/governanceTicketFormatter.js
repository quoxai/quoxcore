/**
 * MON-GOV-INT Phase 1: Governance ticket formatter.
 *
 * Pure functions — no I/O, no database, no config lookup. Mirrors the
 * MON-GOV-3 SIEM formatter (governanceEventFormatter.js) one seam over:
 * takes an incident row + its corr-linked envelope timeline + a resolved
 * dashboard URL + the ticket config's per-provider settings, and returns a
 * provider-shaped ticket payload ready for the adapter layer.
 *
 * Phase 1 implements 'jira' only. PagerDuty / ServiceNow are valid provider
 * enum values elsewhere in the stream but their formatters ship in later
 * phases — calling formatTicket() with them throws a clear "not yet
 * implemented" error rather than silently emitting a wrong shape.
 */

const SUPPORTED_PROVIDERS = ['jira'];

// Jira priority names, keyed by Quox incident severity (§4.4 of the plan).
const SEVERITY_TO_JIRA_PRIORITY = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Lowest',
};

const JIRA_SUMMARY_MAX = 255;
const ENVELOPE_TIMELINE_LIMIT = 50;

function isoOrNow(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/**
 * Jira labels only accept a restricted charset (no spaces). Framework
 * mapping entries like "gdpr:Art.32" get lowercased + non-alnum runs
 * collapsed to a single hyphen.
 */
function sanitizeLabel(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildEnvelopeTimeline(envelopes, limit = ENVELOPE_TIMELINE_LIMIT) {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return [];
  return envelopes.slice(0, limit).map((e) => {
    const from = e.from || e.From || '?';
    const to = e.to || e.To || '?';
    return `${isoOrNow(e.ts)}  ${e.intent || '(no intent)'}  ${from} -> ${to}`;
  });
}

/**
 * Shared plain-text ticket body — used as the Jira description (wrapped
 * into a single ADF paragraph by the existing connector's create_issue
 * builder; we do not build ADF ourselves).
 */
function buildTicketBody(incident, { envelopes = [], dashboardUrl } = {}) {
  const lines = [];
  lines.push(`Quox governance incident: ${incident.id}`);
  lines.push(`Correlation: ${incident.corr || ''}`);
  lines.push(`Incident type: ${incident.incident_type || ''}`);
  if (incident.layer) lines.push(`Layer: ${incident.layer}`);
  if (incident.policy_id) lines.push(`Policy: ${incident.policy_name || incident.policy_id} (${incident.policy_id})`);
  const frameworks = Array.isArray(incident.framework_mapping) ? incident.framework_mapping : [];
  if (frameworks.length > 0) lines.push(`Frameworks: ${frameworks.join(', ')}`);
  if (incident.agent_id) lines.push(`Agent: ${incident.agent_id}`);
  if (incident.user_id) lines.push(`User: ${incident.user_id}`);
  lines.push(`Created: ${isoOrNow(incident.created_at)}`);
  lines.push('');
  lines.push(incident.description || '(no description)');

  const timeline = buildEnvelopeTimeline(envelopes);
  if (timeline.length > 0) {
    lines.push('');
    lines.push('Envelope timeline:');
    lines.push(...timeline);
  }

  if (dashboardUrl) {
    lines.push('');
    lines.push(`Dashboard: ${dashboardUrl}`);
  }

  return lines.join('\n');
}

/**
 * formatTicket('jira', incident, { envelopes, dashboardUrl, settings })
 * → { project_key, summary, description, issue_type, priority, labels }
 * — the exact shape lib/ticketing/jira.js hands to create_issue.
 */
function formatJiraTicket(incident, { envelopes = [], dashboardUrl, settings = {} } = {}) {
  const severity = incident.severity || 'medium';
  const summary = truncate(`[Quox ${severity}] ${incident.title || 'Governance incident'}`, JIRA_SUMMARY_MAX);
  const description = buildTicketBody(incident, { envelopes, dashboardUrl });

  const labels = ['quox-incident'];
  const frameworks = Array.isArray(incident.framework_mapping) ? incident.framework_mapping : [];
  for (const f of frameworks) {
    const label = sanitizeLabel(f);
    if (label) labels.push(label);
  }
  if (Array.isArray(settings.labels)) {
    for (const l of settings.labels) {
      const label = sanitizeLabel(l);
      if (label) labels.push(label);
    }
  }

  return {
    project_key: settings.project_key,
    summary,
    description,
    issue_type: settings.issue_type || 'Task',
    priority: SEVERITY_TO_JIRA_PRIORITY[severity] || 'Medium',
    labels: [...new Set(labels)],
  };
}

const FORMATTERS = {
  jira: formatJiraTicket,
};

/**
 * formatTicket(provider, incident, { envelopes, dashboardUrl, settings })
 * → provider-shaped payload. Pure — no I/O.
 */
function formatTicket(provider, incident, options = {}) {
  if (!incident || typeof incident !== 'object') throw new Error('incident is required');
  const fn = FORMATTERS[provider];
  if (!fn) {
    if (SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`Ticket formatter for '${provider}' is misconfigured`);
    }
    throw new Error(`Ticket formatter for '${provider}' is not yet implemented (Phase 2/3)`);
  }
  return fn(incident, options);
}

module.exports = {
  SUPPORTED_PROVIDERS,
  SEVERITY_TO_JIRA_PRIORITY,
  JIRA_SUMMARY_MAX,
  ENVELOPE_TIMELINE_LIMIT,
  formatTicket,
  formatJiraTicket,
  buildTicketBody,
  buildEnvelopeTimeline,
  sanitizeLabel,
};
