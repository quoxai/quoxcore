/**
 * w9: non-blocking Go live warning when nobody would be alerted about handoffs
 * and leads (notification settings null/empty, or no enabled event with a
 * delivery channel). Mirrors the Widget Room banner's rule.
 */
export const ALERTS_NOT_CONFIGURED = {
  id: 'alerts_not_configured',
  message: 'Handoffs and leads land in the inbox but nobody is alerted: set up alerts.',
  fix: 'Open the Availability tab and add an email or webhook for "Human handoff requested" and "New conversation".',
};

export function alertsConfigured(raw) {
  let cfg = raw;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
  if (!cfg || typeof cfg !== 'object') return false;
  return Object.values(cfg).some((e) => e && e.enabled === true
    && Array.isArray(e.channels) && e.channels.some((c) => c && (c.to || c.recipient || c.url)));
}

export function goLiveWarnings(widgetRow) {
  return alertsConfigured(widgetRow?.notification_settings_json) ? [] : [ALERTS_NOT_CONFIGURED];
}

// Non-blocking Go live warning: knowledge sources the admin has not resolved.
// Flag lives in widget_knowledge_sources.config_json: `suggest_superseded: true`
// (possibly outdated, set at upload, cleared by PATCH superseded) and
// `quarantined: true` (injection scan, excluded from answers).
export function knowledgeSourceWarnings(rows) {
  const out = [];
  const names = (pred) => (rows || []).filter((r) => {
    let cfg = r?.config_json;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
    return cfg && typeof cfg === 'object' && pred(cfg);
  }).map((r) => r.name);
  const outdated = names((c) => c.suggest_superseded === true && c.superseded !== true);
  if (outdated.length > 0) {
    out.push({
      id: 'knowledge_possibly_outdated',
      message: `${outdated.length} knowledge ${outdated.length === 1 ? 'source is' : 'sources are'} flagged "possibly outdated" and still being used to answer: ${outdated.slice(0, 5).join(', ')}.`,
      fix: 'Open Knowledge and either keep each one or mark it "Treat as reference only".',
    });
  }
  const auto = names((c) => c.auto_superseded === true && c.superseded === true);
  if (auto.length > 0) {
    out.push({
      id: 'knowledge_auto_reference_only',
      message: `${auto.length} knowledge ${auto.length === 1 ? 'source was' : 'sources were'} set to reference only automatically (looks archived or old) and ${auto.length === 1 ? 'is' : 'are'} not used to answer visitors: ${auto.slice(0, 5).join(', ')}.`,
      fix: 'Open Knowledge and use "Undo" on any that should still be used to answer.',
    });
  }
  const quarantined = names((c) => c.quarantined === true);
  if (quarantined.length > 0) {
    out.push({
      id: 'knowledge_quarantined',
      message: `${quarantined.length} knowledge ${quarantined.length === 1 ? 'source is' : 'sources are'} quarantined (excluded from answers): ${quarantined.slice(0, 5).join(', ')}.`,
      fix: 'Open Knowledge, review the quarantined source and remove or replace it.',
    });
  }
  return out;
}
