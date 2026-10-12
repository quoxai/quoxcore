import { useState } from 'react';

/**
 * Tag chips with per-chip remove (x) plus a trailing "add tag" input, shown
 * in the stream header meta row when edit mode is on.
 */
export default function TagEditor({ tags, onChange }) {
  const [draft, setDraft] = useState('');

  function addTag() {
    const value = draft.trim();
    setDraft('');
    if (!value || tags.includes(value)) return;
    onChange([...tags, value]);
  }

  function removeTag(tag) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div className="qx-row qx-row--wrap qx-row--tight">
      {tags.map((t) => (
        <span key={t} className="qx-chip qx-chip--xs qxp-tag-chip">
          {t}
          <button type="button" className="qxp-tag-chip__remove" onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="qx-input qxp-tag-input"
        placeholder="Add tag…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag();
          }
        }}
        onBlur={addTag}
      />
    </div>
  );
}
