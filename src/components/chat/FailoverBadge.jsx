import { MODEL_CATALOG } from '../../config/modelCatalog';
import './FailoverBadge.css';

/**
 * LLM-FAILOVER: shared "a fallback model answered this turn" badge.
 *
 * The collector has always been honest about failover — every chat response
 * carries `execution.failover` with the full attempt chain, the error class
 * that killed the primary, and the cooldown window. ChatTab rendered it;
 * every ChatEngine-driven surface (ROADY's rail and the other agent
 * sidebars) dropped it on the floor, so the model could change underneath
 * the user with nothing shown. These helpers live here rather than inside
 * ChatTab so both families render one implementation.
 */

// Resolve a provider/model pair to display names.
export function resolveProviderModelLabel(provider, model) {
  const providerConfig = MODEL_CATALOG[provider];
  const providerName = providerConfig?.name || provider || 'unknown';
  const modelName = providerConfig?.models?.find(mod => mod.id === model)?.name || model || 'unknown';
  return `${providerName}/${modelName}`;
}

// Compact badge text when a fallback provider was used.
export function formatFailoverBadge(failover) {
  const active = failover?.active;
  if (!active?.provider && !active?.model) return 'Fallback used';
  return `Fallback: ${resolveProviderModelLabel(active.provider, active.model)}`;
}

// Tooltip detail listing the attempted provider chain.
export function formatFailoverTitle(failover) {
  if (!failover) return '';
  const lines = ['Primary model failed, switched to a fallback.'];
  (failover.attempted || []).forEach((hop, idx) => {
    const outcome = hop?.outcome || 'unknown';
    const detail = hop?.error_class ? ` (${hop.error_class})` : (hop?.reason ? ` (${hop.reason})` : '');
    lines.push(`${idx + 1}. ${resolveProviderModelLabel(hop?.provider, hop?.model)}: ${outcome}${detail}`);
  });
  if (failover.active?.provider || failover.active?.model) {
    lines.push(`Active: ${resolveProviderModelLabel(failover.active?.provider, failover.active?.model)}`);
  }
  const cooldown = (failover.attempted || []).map(hop => hop?.cooldown_until).filter(Boolean).sort().pop();
  if (cooldown) {
    const parsed = new Date(cooldown);
    if (!Number.isNaN(parsed.getTime())) {
      lines.push(`Primary retries after ${parsed.toISOString().slice(11, 16)} UTC`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders nothing unless a fallback actually served the turn, so surfaces can
 * drop it in unconditionally next to a message.
 */
export default function FailoverBadge({ execution, onOpenSettings }) {
  const failover = execution?.failover;
  if (!failover?.used_fallback) return null;

  const icon = (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  );

  if (!onOpenSettings) {
    return (
      <span className="message-badge message-badge--failover failover-badge" title={formatFailoverTitle(failover)}>
        {icon}
        {formatFailoverBadge(failover)}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="message-badge message-badge--failover failover-badge"
      title={formatFailoverTitle(failover)}
      aria-label="Fallback provider was used. Open Execution Policy settings"
      onClick={onOpenSettings}
      style={{ cursor: 'pointer', fontFamily: 'inherit' }}
    >
      {icon}
      {formatFailoverBadge(failover)}
    </button>
  );
}
