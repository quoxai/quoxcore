/**
 * MON-GOV-3: Governance event formatter for SIEM outbound.
 *
 * Pure functions. Each format takes an incident row (as returned by
 * governanceIncidents.createIncident) and produces a JSON-serialisable
 * object ready to POST to the target SIEM.
 *
 * No network, no database, no config lookup — that's the dispatcher's job.
 */

const SUPPORTED_FORMATS = [
  'generic_json',
  'splunk_hec',
  'sentinel_json',
  'wazuh_json',
  'generic_cef',
];

const CEF_SEVERITY_MAP = {
  critical: 10,
  high: 8,
  medium: 5,
  low: 3,
  info: 1,
};

function isoOrNow(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function epochMillis(value) {
  const parsed = value ? new Date(value) : new Date();
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? Date.now() : ms;
}

function baseFields(incident) {
  return {
    source: 'quox',
    timestamp: isoOrNow(incident.created_at),
    quox_incident_id: incident.id,
    quox_corr: incident.corr,
    org_id: incident.org_id,
    incident_type: incident.incident_type,
    severity: incident.severity,
    status: incident.status,
    layer: incident.layer || null,
    policy_id: incident.policy_id || null,
    policy_name: incident.policy_name || null,
    framework_mapping: Array.isArray(incident.framework_mapping) ? incident.framework_mapping : [],
    agent_id: incident.agent_id || null,
    user_id: incident.user_id || null,
    title: incident.title,
    description: incident.description || '',
  };
}

// ─── generic_json ────────────────────────────────────────────────────────
// The safest lowest-common-denominator payload — straight mirror of the
// base fields. Suitable for anything that accepts JSON over HTTP.

function formatGenericJson(incident) {
  return baseFields(incident);
}

// ─── splunk_hec ──────────────────────────────────────────────────────────
// Splunk HTTP Event Collector envelope: top-level `event` object, `time`
// as epoch seconds, `sourcetype`, `source`, `host`.
// Docs: https://docs.splunk.com/Documentation/Splunk/latest/Data/FormateventsforHTTPEventCollector

function formatSplunkHec(incident) {
  return {
    time: Math.floor(epochMillis(incident.created_at) / 1000),
    host: 'quox',
    source: 'quox:governance',
    sourcetype: 'quox:governance:incident',
    event: baseFields(incident),
  };
}

// ─── sentinel_json ───────────────────────────────────────────────────────
// Microsoft Sentinel / Azure Log Analytics: flat JSON with TimeGenerated
// column for the ingestion API.

function formatSentinelJson(incident) {
  return {
    TimeGenerated: isoOrNow(incident.created_at),
    SourceSystem: 'quox',
    Severity: (incident.severity || 'medium').toUpperCase(),
    IncidentId: incident.id,
    CorrelationId: incident.corr,
    OrgId: incident.org_id,
    IncidentType: incident.incident_type,
    Status: incident.status,
    Layer: incident.layer || null,
    PolicyId: incident.policy_id || null,
    PolicyName: incident.policy_name || null,
    FrameworkMapping: Array.isArray(incident.framework_mapping)
      ? incident.framework_mapping.join(',')
      : '',
    AgentId: incident.agent_id || null,
    UserId: incident.user_id || null,
    Title: incident.title,
    Description: incident.description || '',
  };
}

// ─── wazuh_json ──────────────────────────────────────────────────────────
// Wazuh agent-ingested JSON: nested `rule` + `data`. `rule.level` 0-15
// derived from severity; `rule.description` = title.

function severityToWazuhLevel(severity) {
  switch (severity) {
    case 'critical': return 14;
    case 'high':     return 12;
    case 'medium':   return 8;
    case 'low':      return 5;
    default:         return 3;
  }
}

function formatWazuhJson(incident) {
  return {
    timestamp: isoOrNow(incident.created_at),
    rule: {
      id: incident.policy_id || `quox.${incident.incident_type}`,
      level: severityToWazuhLevel(incident.severity),
      description: incident.title,
      groups: ['quox', 'governance', incident.incident_type],
    },
    agent: { id: incident.agent_id || 'unknown', name: incident.agent_id || 'unknown' },
    data: baseFields(incident),
  };
}

// ─── generic_cef ─────────────────────────────────────────────────────────
// Common Event Format v0, pipe-separated prefix + key=value extension.
// https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors/AS_CEF_WP.pdf

function cefEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '\\n');
}

function formatGenericCef(incident) {
  const headerFields = [
    'CEF:0',
    cefEscape('Quox'),                                    // Device Vendor
    cefEscape('Governance'),                              // Device Product
    cefEscape('1.0'),                                     // Device Version
    cefEscape(incident.incident_type),                    // Signature ID
    cefEscape(incident.title),                            // Name
    cefEscape(CEF_SEVERITY_MAP[incident.severity] ?? 5),  // Severity (0-10)
  ];

  const extension = {
    rt: epochMillis(incident.created_at),
    externalId: incident.id,
    cs1Label: 'corr',
    cs1: incident.corr || '',
    cs2Label: 'layer',
    cs2: incident.layer || '',
    cs3Label: 'policy_id',
    cs3: incident.policy_id || '',
    cs4Label: 'framework_mapping',
    cs4: Array.isArray(incident.framework_mapping) ? incident.framework_mapping.join(',') : '',
    suser: incident.user_id || '',
    sproc: incident.agent_id || '',
    msg: incident.description || '',
    act: incident.status || 'open',
  };

  const extStr = Object.entries(extension)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${cefEscape(v)}`)
    .join(' ');

  return { cef: `${headerFields.join('|')}|${extStr}`.trim() };
}

// ─── Dispatch table + hints ──────────────────────────────────────────────

const FORMATTERS = {
  generic_json: formatGenericJson,
  splunk_hec: formatSplunkHec,
  sentinel_json: formatSentinelJson,
  wazuh_json: formatWazuhJson,
  generic_cef: formatGenericCef,
};

function formatIncident(format, incident) {
  const fn = FORMATTERS[format];
  if (!fn) throw new Error(`Unsupported SIEM format: ${format}`);
  if (!incident || typeof incident !== 'object') throw new Error('incident is required');
  return fn(incident);
}

/**
 * Each format defines the content type + a textual body. For CEF the body
 * is a single line; for the others it is JSON. Callers use this so the
 * dispatcher doesn't need to know format specifics.
 */
function bodyFor(format, incident) {
  const payload = formatIncident(format, incident);
  if (format === 'generic_cef') {
    return {
      contentType: 'text/plain',
      body: payload.cef,
    };
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify(payload),
  };
}

module.exports = {
  SUPPORTED_FORMATS,
  formatIncident,
  bodyFor,
  // Exported for test granularity
  formatGenericJson,
  formatSplunkHec,
  formatSentinelJson,
  formatWazuhJson,
  formatGenericCef,
  severityToWazuhLevel,
  CEF_SEVERITY_MAP,
};
