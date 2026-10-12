/**
 * InboxQRules — the Rules management surface (auto-sort control UI).
 *
 * Rules are the standing, server-side sort logic that decides where new mail
 * lands (move to a folder, screen it, or block it) before a human ever sees
 * it. Before this panel existed there was no way to see or change that logic
 * from inside the app at all (the "I can't control that in the app" gap).
 * This is a thin editor over the api client, never a cache: it loads fresh on
 * mount and after every write, same shape as SettingsPanel's watches list.
 *
 * A rule only ever affects NEW mail as it arrives. Running it against mail
 * already stored in InboxQ is a separate, human-triggered action ("Apply
 * rules to stored mail"), never automatic — the same "propose, never do it
 * for you without being asked" posture as the rest of InboxQ.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';

const MATCH_TYPES = [
  { value: 'from', label: 'From address', placeholder: 'billing@wordfence.com', hint: 'The exact sender email address.' },
  { value: 'domain', label: 'Domain', placeholder: 'wordfence.com', hint: 'The domain after the @, without the @.' },
  { value: 'name', label: 'Sender name contains', placeholder: 'Investor Brokers', hint: 'Text to match anywhere in the sender\'s display name.' },
  { value: 'subject', label: 'Subject contains', placeholder: 'invoice', hint: 'Text to match anywhere in the subject line.' },
  { value: 'tld', label: 'TLD', placeholder: 'guru', hint: 'Just the top-level domain, e.g. "guru", not ".guru".' },
];

const ACTIONS = [
  { value: 'move', label: 'Move to folder' },
  { value: 'screen', label: 'Screen' },
  { value: 'block', label: 'Block' },
];

const matchTypeMeta = (value) => MATCH_TYPES.find((m) => m.value === value) || MATCH_TYPES[0];

/** Reads a rule into one plain-language sentence, e.g. "Move mail from
 * domain wordfence.com to InboxQ/Wordfence" or "Block mail from .guru". */
function describeRule(rule) {
  const actionVerb = { move: 'Move', screen: 'Screen', block: 'Block' }[rule.action] || rule.action;
  let subject;
  switch (rule.matchType) {
    case 'from': subject = `mail from ${rule.matchValue}`; break;
    case 'domain': subject = `mail from domain ${rule.matchValue}`; break;
    case 'tld': subject = `mail from .${rule.matchValue}`; break;
    case 'name': subject = `mail whose name contains ${rule.matchValue}`; break;
    case 'subject': subject = `mail whose subject contains ${rule.matchValue}`; break;
    default: subject = `mail matching ${rule.matchValue}`;
  }
  const dest = rule.action === 'move' && rule.targetFolder ? ` to ${rule.targetFolder}` : '';
  return `${actionVerb} ${subject}${dest}`;
}

function formatApplyResult(result) {
  if (!result) return null;
  const moved = result.moved ?? 0;
  const screened = result.screened ?? 0;
  const blocked = result.blocked ?? 0;
  const total = result.applied ?? (moved + screened + blocked);
  if (total === 0) return 'No stored messages matched.';
  return `Moved ${moved}, screened ${screened}, blocked ${blocked}.`;
}

/** Add/edit rule form: a backed card, not a modal, so it sits inline above
 * the rules list the same way SettingsPanel's "Add a watch" form does. */
function RuleForm({ rule, accountId, folders, onSaved, onCancel }) {
  const isEdit = !!rule;
  const [matchType, setMatchType] = useState(rule?.matchType || 'domain');
  const [matchValue, setMatchValue] = useState(rule?.matchValue || '');
  const [action, setAction] = useState(rule?.action || 'move');
  const [targetFolder, setTargetFolder] = useState(rule?.targetFolder || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);

  // Any field change invalidates a previous preview so a stale count can
  // never be read as still describing the current form values.
  const clearPreview = useCallback(() => {
    setPreviewResult(null);
    setPreviewError(null);
  }, []);

  const handlePreview = useCallback(async () => {
    if (!matchValue.trim()) {
      setPreviewError('Enter a value to match first.');
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const data = await api.previewRule({ accountId, matchType, matchValue: matchValue.trim() });
      setPreviewResult({ matchCount: data?.matchCount ?? 0, sample: Array.isArray(data?.sample) ? data.sample : [] });
    } catch (err) {
      setPreviewError(err?.body?.error || err.message || 'Could not preview this rule.');
    } finally {
      setPreviewLoading(false);
    }
  }, [accountId, matchType, matchValue]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!matchValue.trim()) {
      setError('Enter a value to match.');
      return;
    }
    if (action === 'move' && !targetFolder) {
      setError('Choose a folder to move matching mail to.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fields = {
        matchType,
        matchValue: matchValue.trim(),
        action,
        targetFolder: action === 'move' ? targetFolder : null,
      };
      if (isEdit) {
        await api.updateRule(rule.id, fields);
      } else {
        await api.createRule({ accountId, ...fields });
      }
      onSaved();
    } catch (err) {
      setError(err?.body?.error || err.message || 'Could not save this rule.');
    } finally {
      setSaving(false);
    }
  }, [accountId, matchType, matchValue, action, targetFolder, isEdit, rule, onSaved]);

  const meta = matchTypeMeta(matchType);

  return (
    <form
      className="qx-card qx-surface--backed qx-stack qx-stack--tight"
      onSubmit={handleSubmit}
      data-testid="inboxq-rule-form"
    >
      <span className="qx-section-title" style={{ fontSize: 13 }}>{isEdit ? 'Edit rule' : 'Add a rule'}</span>
      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      <div className="qx-row qx-row--wrap" style={{ gap: 10 }}>
        <div className="qx-field">
          <label htmlFor="inboxq-rule-matchtype" className="qx-hint qx-hint--sm" style={{ display: 'block', marginBottom: 4 }}>
            Match on
          </label>
          <select
            id="inboxq-rule-matchtype"
            className="qx-select"
            value={matchType}
            onChange={(e) => { setMatchType(e.target.value); clearPreview(); }}
            style={{ minWidth: 200 }}
          >
            {MATCH_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        <div className="qx-field" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="inboxq-rule-value" className="qx-hint qx-hint--sm" style={{ display: 'block', marginBottom: 4 }}>
            Value
          </label>
          <input
            id="inboxq-rule-value"
            type="text"
            className="qx-input"
            placeholder={meta.placeholder}
            value={matchValue}
            onChange={(e) => { setMatchValue(e.target.value); clearPreview(); }}
          />
        </div>

        <div className="qx-field">
          <label htmlFor="inboxq-rule-action" className="qx-hint qx-hint--sm" style={{ display: 'block', marginBottom: 4 }}>
            Then
          </label>
          <select
            id="inboxq-rule-action"
            className="qx-select"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            style={{ minWidth: 160 }}
          >
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>

        {action === 'move' && (
          <div className="qx-field">
            <label htmlFor="inboxq-rule-folder" className="qx-hint qx-hint--sm" style={{ display: 'block', marginBottom: 4 }}>
              Folder
            </label>
            <select
              id="inboxq-rule-folder"
              className="qx-select"
              value={targetFolder}
              onChange={(e) => setTargetFolder(e.target.value)}
              style={{ minWidth: 180 }}
              disabled={folders.length === 0}
            >
              <option value="">{folders.length === 0 ? 'No synced folders' : 'Choose a folder...'}</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        )}
      </div>

      <span className="qx-hint qx-hint--sm">{meta.hint}</span>

      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={handlePreview} disabled={previewLoading}>
          {previewLoading ? 'Checking…' : 'Preview matches'}
        </button>
        <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Save rule' : 'Add rule')}
        </button>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>

      {previewError && <div className="qx-banner qx-banner--error">{previewError}</div>}
      {previewResult && (
        <div className="qx-card qx-stack qx-stack--tight" data-testid="inboxq-rule-preview">
          <strong>
            This would match {previewResult.matchCount} stored message{previewResult.matchCount === 1 ? '' : 's'}.
          </strong>
          {previewResult.sample.length > 0 && (
            <div className="qx-stack qx-stack--tight">
              {previewResult.sample.slice(0, 5).map((m, i) => (
                <div key={m.id || i} className="qx-hint qx-hint--sm" style={{ wordBreak: 'break-all' }}>
                  {(m.fromName || m.fromAddr || 'Unknown sender')} · {m.subject || '(no subject)'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </form>
  );
}

/** One rule row: the plain-language sentence, an enable/disable toggle, and
 * the row actions (apply just this rule, edit, delete). */
function RuleRow({ rule, onToggle, onEdit, onDelete, onApply, busyId, applyingId }) {
  const toggling = busyId === rule.id;
  const deleting = busyId === `delete:${rule.id}`;
  const applying = applyingId === rule.id;

  const handleDelete = useCallback(() => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete this rule? "${describeRule(rule)}" will stop running on new mail.`)) return;
    onDelete(rule.id);
  }, [rule, onDelete]);

  return (
    <div className="qx-card qx-surface--backed qx-row qx-row--apart" style={{ alignItems: 'center' }} data-testid="inboxq-rule-row">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center', minWidth: 0 }}>
        <label className="qx-toggle" style={{ cursor: toggling ? 'wait' : 'pointer', flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={!!rule.enabled}
            disabled={toggling}
            onChange={(e) => onToggle(rule.id, e.target.checked)}
            aria-label={`Enabled: ${describeRule(rule)}`}
          />
          <span className="qx-toggle__track" />
        </label>
        <span style={{ wordBreak: 'break-word' }}>{describeRule(rule)}</span>
        {!rule.enabled && <span className="qx-chip qx-chip--xs">Disabled</span>}
      </div>
      <div className="qx-row qx-row--tight" style={{ flexShrink: 0 }}>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          onClick={() => onApply(rule.id)}
          disabled={applying}
          title="Run this rule against mail already stored in InboxQ"
        >
          {applying ? 'Applying…' : 'Apply to stored mail'}
        </button>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => onEdit(rule)}>
          Edit
        </button>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--danger" onClick={handleDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/** The Rules panel: everything the owner needs to see and control InboxQ's
 * standing auto-sort logic, in the app, without going near a server console. */
export default function InboxQRulesPanel({ accountId, folders, onClose }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState(null);

  const [busyId, setBusyId] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [applyError, setApplyError] = useState(null);

  const load = useCallback(() => {
    if (!accountId) { setRules([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    api.listRules({ accountId })
      .then((d) => setRules(Array.isArray(d?.rules) ? d.rules : []))
      .catch((e) => setError(e?.body?.error || e.message || 'Could not load rules.'))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const openNewForm = useCallback(() => {
    setEditingRule(null);
    setShowForm(true);
  }, []);

  const openEditForm = useCallback((rule) => {
    setEditingRule(rule);
    setShowForm(true);
  }, []);

  const handleSaved = useCallback(() => {
    setShowForm(false);
    setEditingRule(null);
    load();
  }, [load]);

  const handleToggle = useCallback(async (id, enabled) => {
    setBusyId(id);
    try {
      await api.setRuleEnabled(id, enabled);
      load();
    } catch {
      // the toggle stays as it was; nothing changed server-side
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const handleDelete = useCallback(async (id) => {
    setBusyId(`delete:${id}`);
    try {
      await api.deleteRule(id);
      load();
    } catch {
      // the rule stays in the list; nothing changed server-side
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const handleApplyRule = useCallback(async (ruleId) => {
    if (!accountId) return;
    setApplyingId(ruleId);
    setApplyError(null);
    setApplyResult(null);
    try {
      const data = await api.applyRules({ accountId, ruleId });
      setApplyResult(data);
    } catch (err) {
      setApplyError(err?.body?.error || err.message || 'Could not apply this rule.');
    } finally {
      setApplyingId(null);
    }
  }, [accountId]);

  const handleApplyAll = useCallback(async () => {
    if (!accountId) return;
    setApplyingId('__all__');
    setApplyError(null);
    setApplyResult(null);
    try {
      const data = await api.applyRules({ accountId });
      setApplyResult(data);
    } catch (err) {
      setApplyError(err?.body?.error || err.message || 'Could not apply rules.');
    } finally {
      setApplyingId(null);
    }
  }, [accountId]);

  return (
    <div className="qx-stack" data-testid="inboxq-rules-panel">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <span className="qx-section-title">Rules</span>
        <div className="qx-row qx-row--tight">
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={openNewForm}>
            + New rule
          </button>
          {onClose && (
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose}>
              Back to Overview
            </button>
          )}
        </div>
      </div>

      <span className="qx-hint qx-hint--sm">
        Rules run automatically on new mail as it arrives, deciding whether to move it to a folder,
        screen it, or block it, before it reaches your zones. They never touch mail already stored
        in InboxQ on their own; use "Apply rules to stored mail" below to run them against your
        backlog on demand.
      </span>

      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          onClick={handleApplyAll}
          disabled={!accountId || rules.length === 0 || applyingId === '__all__'}
          title="Moves, screens, or blocks mail already in your account that matches any enabled rule"
        >
          {applyingId === '__all__' ? 'Applying…' : 'Apply rules to stored mail'}
        </button>
        <span className="qx-hint qx-hint--sm">
          Runs every enabled rule against mail already in your account.
        </span>
      </div>

      {applyError && <div className="qx-banner qx-banner--error">{applyError}</div>}
      {applyResult && (
        <div className="qx-banner qx-banner--success" data-testid="inboxq-rules-apply-result">
          {formatApplyResult(applyResult)}
        </div>
      )}

      {showForm && (
        <RuleForm
          rule={editingRule}
          accountId={accountId}
          folders={folders}
          onSaved={handleSaved}
          onCancel={() => { setShowForm(false); setEditingRule(null); }}
        />
      )}

      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      {loading ? (
        <div className="qx-skeleton" style={{ height: 100 }} />
      ) : rules.length === 0 ? (
        <div className="qx-empty">
          <div className="qx-empty__title">No rules yet</div>
          <div className="qx-empty__body">
            A rule sorts new mail automatically, for example moving everything from a domain into a
            folder, or blocking a whole top-level domain. Add one above.
          </div>
        </div>
      ) : (
        <div className="qx-stack qx-stack--tight">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onToggle={handleToggle}
              onEdit={openEditForm}
              onDelete={handleDelete}
              onApply={handleApplyRule}
              busyId={busyId}
              applyingId={applyingId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
