-- BRAIN2-V3 (2026-10-05): chunk visibility must follow its note. 312 Agent
-- Memory notes (scope 'org') kept chunks at scope 'user' under a stale owner
-- id after an earlier scope migration moved the notes but not their chunks.
-- Search filters on chunk scope, so those memories were hidden from every
-- other user in the org. Align every mismatched chunk with its note.
UPDATE note_chunks
SET scope = (SELECT n.scope FROM notes n WHERE n.id = note_chunks.note_id),
    owner_user_id = (SELECT n.owner_user_id FROM notes n WHERE n.id = note_chunks.note_id)
WHERE EXISTS (
  SELECT 1 FROM notes n
  WHERE n.id = note_chunks.note_id
    AND (n.scope IS NOT note_chunks.scope OR n.owner_user_id IS NOT note_chunks.owner_user_id)
);
