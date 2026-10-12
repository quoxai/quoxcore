-- ONE-BRAIN CX1 (2026-10-09 dry-run audit finding 2): Dream retires a note
-- after repeated extraction failures, keyed on note id. An edit (new body)
-- must clear that record so the fixed note is extracted again; an unchanged
-- re-push keeps it retired. A trigger covers every write path (feeds, capture,
-- NotesQ edits) without each one having to remember.
CREATE TRIGGER IF NOT EXISTS trg_dream_failures_reset_on_edit
AFTER UPDATE OF body ON notes
WHEN old.body IS NOT new.body
BEGIN
  DELETE FROM dream_note_failures WHERE note_id = new.id;
END;
