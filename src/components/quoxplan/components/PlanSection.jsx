import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api.js';
import { toastApiError } from '../lib/toastBus.js';
import { relativeTime } from '../lib/format.js';
import PlanEditor from './PlanEditor.jsx';
import PortalMenu from './PortalMenu.jsx';

/**
 * The Plan card, in both its read (P1) and edit (P2) forms: rendered
 * markdown + "Edit plan" button + a "v{n}" version-history badge. Selecting
 * an older version shows it read-only with a "Restore this version" button
 * (which saves it as a brand-new version via PUT, never mutates history).
 */
export default function PlanSection({ streamId, plan, editMode, onSaved }) {
  const [mode, setMode] = useState('read'); // 'read' | 'edit' | 'version'
  const [saving, setSaving] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [viewingVersion, setViewingVersion] = useState(null);
  const badgeRef = useRef(null);

  async function openVersions() {
    setVersionsOpen((o) => !o);
    if (!versions) {
      try {
        const data = await api.getPlanVersions(streamId);
        setVersions(data.versions || data || []);
      } catch (err) {
        toastApiError(err, 'Could not load plan history');
      }
    }
  }

  async function selectVersion(v) {
    setVersionsOpen(false);
    try {
      const data = await api.getPlanVersion(streamId, v);
      setViewingVersion(data.plan || data);
      setMode('version');
    } catch (err) {
      toastApiError(err, 'Could not load that version');
    }
  }

  async function save(body) {
    setSaving(true);
    try {
      await api.putPlan(streamId, body);
      setMode('read');
      setVersions(null);
      await onSaved();
    } catch (err) {
      toastApiError(err, 'Plan save failed');
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function restoreVersion() {
    if (!viewingVersion) return;
    // save() already toasts on failure; swallow here so the rejection does
    // not surface as unhandled from the button handler.
    await save(viewingVersion.body).catch(() => {});
  }

  if (mode === 'edit') {
    return <PlanEditor initialBody={plan?.body} saving={saving} onSave={save} onCancel={() => setMode('read')} draftKey={streamId} />;
  }

  if (mode === 'version' && viewingVersion) {
    return (
      <div className="qx-card qxp-stream-plan">
        <div className="qx-row qx-row--apart">
          <h3 style={{ margin: 0 }}>Plan · v{viewingVersion.version} (viewing history)</h3>
          <div className="qx-row qx-row--tight">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setMode('read')}>
              Back to current
            </button>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={restoreVersion} disabled={saving}>
              {saving ? 'Restoring…' : 'Restore this version'}
            </button>
          </div>
        </div>
        <div className="qxp-plan-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{viewingVersion.body}</ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="qx-card qxp-stream-plan">
      <div className="qx-row qx-row--apart">
        <h3 style={{ margin: 0 }}>Plan</h3>
        {editMode && (
          <div className="qx-row qx-row--tight">
            {plan?.version != null && (
              <div className="qxp-menu-anchor" ref={badgeRef}>
                <button type="button" className="qx-pill qx-pill--sm qx-pill--ghost" onClick={openVersions}>
                  v{plan.version} ▾
                </button>
                <PortalMenu open={versionsOpen} onClose={() => setVersionsOpen(false)} anchorRef={badgeRef} minWidth={200}>
                  {versions == null && <div className="qx-menu__item" style={{ cursor: 'default' }}>Loading…</div>}
                  {versions?.length === 0 && <div className="qx-menu__item" style={{ cursor: 'default' }}>No prior versions</div>}
                  {versions?.map((v) => (
                    <button key={v.version} type="button" className="qx-menu__item" onClick={() => selectVersion(v.version)}>
                      <span style={{ flex: 1, textAlign: 'left' }}>v{v.version}</span>
                      <span className="qx-hint qx-hint--sm">{relativeTime(v.updated_at)}</span>
                    </button>
                  ))}
                </PortalMenu>
              </div>
            )}
            <button type="button" className="qx-btn qx-btn--sm" onClick={() => setMode('edit')}>
              Edit plan
            </button>
          </div>
        )}
      </div>
      {plan?.body ? (
        <>
          <div className="qxp-plan-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.body}</ReactMarkdown>
          </div>
          <p className="qx-hint qx-hint--sm">
            v{plan.version} · updated by {plan.updated_by} · {relativeTime(plan.updated_at)}
          </p>
        </>
      ) : (
        <span className="qx-hint">No plan written yet.</span>
      )}
    </div>
  );
}
