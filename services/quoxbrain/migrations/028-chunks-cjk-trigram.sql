-- 028-chunks-cjk-trigram.sql — BRAIN2-V2 V2-9
--
-- unicode61 cannot segment Chinese/Japanese/Korean (a CJK run is ONE token),
-- so CJK queries fell back to a substring scan over every chunk. This adds a
-- second FTS5 index using the built-in `trigram` tokenizer (substring match
-- on any 3+ character fragment) that holds ONLY chunks containing a CJK
-- character (Han, Kana, Hangul), so Latin-only instances pay nothing.
--
-- EXTERNAL-CONTENT (content='note_chunks'): no text is duplicated. Sync is by
-- trigger and the guard predicate is IDENTICAL on insert/delete/update, which
-- external-content FTS5 requires (a 'delete' for a row that was never indexed
-- would corrupt the index). Predicate: text GLOB '*[<ranges>]*' with
-- U+3040-30FF (kana), U+3400-4DBF + U+4E00-9FFF (Han), U+AC00-D7AF (Hangul).
--
-- Backfill is ONE sequential scan with the same predicate, inside the
-- migration runner's single transaction (atomic; a failure leaves no table).
-- Only CJK chunks are written, so cost scales with CJK content, not the corpus.

DROP TRIGGER IF EXISTS note_chunks_cjk_ai;
DROP TRIGGER IF EXISTS note_chunks_cjk_ad;
DROP TRIGGER IF EXISTS note_chunks_cjk_au;
DROP TABLE IF EXISTS note_chunks_cjk_fts;

CREATE VIRTUAL TABLE note_chunks_cjk_fts USING fts5(text, content='note_chunks', content_rowid='rowid', tokenize='trigram');

INSERT INTO note_chunks_cjk_fts(rowid, text)
  SELECT rowid, text FROM note_chunks WHERE text GLOB '*[぀-ヿ㐀-䶿一-鿿가-힯]*';

CREATE TRIGGER note_chunks_cjk_ai AFTER INSERT ON note_chunks
WHEN new.text GLOB '*[぀-ヿ㐀-䶿一-鿿가-힯]*' BEGIN
  INSERT INTO note_chunks_cjk_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER note_chunks_cjk_ad AFTER DELETE ON note_chunks
WHEN old.text GLOB '*[぀-ヿ㐀-䶿一-鿿가-힯]*' BEGIN
  INSERT INTO note_chunks_cjk_fts(note_chunks_cjk_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER note_chunks_cjk_au AFTER UPDATE ON note_chunks BEGIN
  INSERT INTO note_chunks_cjk_fts(note_chunks_cjk_fts, rowid, text)
    SELECT 'delete', old.rowid, old.text WHERE old.text GLOB '*[぀-ヿ㐀-䶿一-鿿가-힯]*';
  INSERT INTO note_chunks_cjk_fts(rowid, text)
    SELECT new.rowid, new.text WHERE new.text GLOB '*[぀-ヿ㐀-䶿一-鿿가-힯]*';
END;
