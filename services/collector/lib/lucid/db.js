/**
 * LUCID's own SQLite file. It used to live in aee.db (7+ GB, shared with the AEE and WARD writers),
 * where its many small writes contended with theirs and showed up as collector freezes (VULCAN
 * profile 2026-10-11). A small dedicated file keeps LUCID's writes cheap and isolated.
 *
 * On first open, existing LUCID tables are copied once from aee.db so no history is lost.
 */
const fs = require('fs');
const path = require('path');

const TABLES = ['aware_journal', 'aware_subjects', 'aware_feeds', 'aware_cursors', 'aware_expected_feeds',
  'aware_lessons', 'aware_herald_settings', 'aware_escalations', 'aware_herald_meta', 'aware_briefings'];

function openLucidDb(Database, aeeDbPath, journal) {
  const file = path.join(path.dirname(aeeDbPath), 'lucid.db');
  const fresh = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  journal.ensure(db);
  if (fresh && fs.existsSync(aeeDbPath)) migrateFrom(db, aeeDbPath);
  return db;
}

function migrateFrom(db, aeeDbPath) {
  const copied = {};
  db.prepare('ATTACH DATABASE ? AS aee').run(aeeDbPath);
  try {
    db.transaction(() => {
      for (const t of TABLES) {
        const exists = db.prepare("SELECT name FROM aee.sqlite_master WHERE type = 'table' AND name = ?").get(t);
        if (!exists) continue;
        const mine = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name);
        const theirs = new Set(db.prepare(`PRAGMA aee.table_info(${t})`).all().map((c) => c.name));
        const cols = mine.filter((c) => theirs.has(c)).map((c) => `"${c}"`).join(', ');
        if (!cols) continue;
        const info = db.prepare(`INSERT OR IGNORE INTO main.${t} (${cols}) SELECT ${cols} FROM aee.${t}`).run();
        copied[t] = info.changes;
      }
    })();
  } finally {
    db.prepare('DETACH DATABASE aee').run();
  }
  console.log('[LUCID] moved to its own lucid.db; copied from aee.db:', JSON.stringify(copied));
  return copied;
}

module.exports = { openLucidDb, migrateFrom, TABLES };
