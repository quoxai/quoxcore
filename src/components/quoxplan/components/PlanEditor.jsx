import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Full-width markdown editor: textarea left, live preview right (stacked on
 * narrow viewports via CSS), monospace, autosizing. Guards navigation away
 * while dirty with a confirm() prompt (window unload guard included).
 *
 * SPA route changes cannot be blocked without a data router, so dirty
 * drafts are additionally preserved in an in-memory module store keyed by
 * stream id: navigate away and back within the session and the draft is
 * restored instead of lost. Intentionally NOT browser storage.
 */
const draftStore = new Map();

export function peekDraft(draftKey) {
  return draftStore.get(draftKey);
}

export default function PlanEditor({ initialBody, saving, onSave, onCancel, draftKey }) {
  const [body, setBody] = useState(() => draftStore.get(draftKey) ?? (initialBody || ''));
  const [dirty, setDirty] = useState(() => draftStore.has(draftKey));
  const textareaRef = useRef(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.max(320, el.scrollHeight)}px`;
    }
  }, [body]);

  useEffect(() => {
    function onBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function handleCancel() {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    if (draftKey) draftStore.delete(draftKey);
    onCancel();
  }

  return (
    <div className="qx-card qxp-plan-editor">
      <div className="qxp-plan-editor__panes">
        <textarea
          ref={textareaRef}
          className="qx-textarea qx-textarea--mono qxp-plan-editor__textarea"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
            if (draftKey) draftStore.set(draftKey, e.target.value);
          }}
          placeholder="Write the plan in markdown…"
        />
        <div className="qxp-plan-editor__preview qxp-plan-body">
          {body.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          ) : (
            <span className="qx-hint">Preview appears as you type.</span>
          )}
        </div>
      </div>
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={handleCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          disabled={saving}
          onClick={() =>
            onSave(body)
              .then(() => {
                setDirty(false);
                if (draftKey) draftStore.delete(draftKey);
              })
              .catch(() => {
                // Failure already surfaced via toast upstream; stay dirty so
                // nothing is lost and the user can retry.
              })
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
