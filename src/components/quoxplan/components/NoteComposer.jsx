import { forwardRef, useState } from 'react';

/**
 * Note composer shown above the notes timeline in edit mode. Also used by
 * the "Add note to <stream>" command palette verb via the forwarded ref
 * (focuses the textarea on navigation).
 */
const NoteComposer = forwardRef(function NoteComposer({ onSubmit, busy }, ref) {
  const [body, setBody] = useState('');

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed).then(() => setBody(''));
  }

  return (
    <div className="qx-stack qx-stack--tight">
      <textarea
        ref={ref}
        className="qx-textarea"
        placeholder="Add a note…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" style={{ alignSelf: 'flex-end' }} disabled={!body.trim() || busy} onClick={submit}>
        {busy ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
});

export default NoteComposer;
