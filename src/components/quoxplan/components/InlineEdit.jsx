import { useEffect, useRef, useState } from 'react';

/**
 * Click-to-edit text (name) or textarea (summary). Enter saves (Shift+Enter
 * inserts a newline when multiline), Escape cancels and reverts. Read mode
 * never renders this — callers only mount it when edit mode is on.
 */
export default function InlineEdit({ value, onSave, placeholder, multiline = false, tag: Tag = 'span', className, style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? '');
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [editing, value]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== (value ?? '')) onSave(trimmed);
  }

  function cancel() {
    setDraft(value ?? '');
    setEditing(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  if (!editing) {
    return (
      <Tag
        className={`qxp-inline-edit${className ? ` ${className}` : ''}`}
        style={style}
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setEditing(true);
        }}
        title="Click to edit"
      >
        {value || <span className="qx-hint">{placeholder}</span>}
      </Tag>
    );
  }

  return multiline ? (
    <textarea
      ref={inputRef}
      className="qx-textarea qxp-inline-edit__input"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  ) : (
    <input
      ref={inputRef}
      className="qx-input qxp-inline-edit__input"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}
