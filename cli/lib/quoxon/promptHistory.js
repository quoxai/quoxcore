/**
 * QUOXON-HISTORY: what the user typed, kept across quox runs so Up recalls it (most recent first), like a shell.
 * Local only (~/.quox/history.jsonl, mode 0600), capped. The caller never offers it anything that looks like a key:
 * keys, PINs and /connect secrets are refused before they reach history.
 */
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const HISTORY_CAP = 500;
export const defaultHistoryPath = (home = homedir()) => join(home, '.quox', 'history.jsonl');

/** -> { load(): string[] oldest first, add(text) } on the given file. Every failure is quiet: history is a convenience. */
export function fileHistory(path = defaultHistoryPath(), { cap = HISTORY_CAP } = {}) {
  const load = () => {
    try {
      const out = [];
      for (const ln of readFileSync(path, 'utf8').split('\n')) {
        if (!ln) continue;
        try { const t = JSON.parse(ln)?.t; if (typeof t === 'string' && t) out.push(t); } catch { /* a torn line */ }
      }
      return out.slice(-cap);
    } catch { return []; }
  };
  const add = (text) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, JSON.stringify({ t: text }) + '\n', { mode: 0o600 });
      if (statSync(path).size > cap * 400) { const keep = load(); writeFileSync(path, keep.map(t => JSON.stringify({ t })).join('\n') + '\n', { mode: 0o600 }); }
    } catch { /* read-only home: this run still has it in memory */ }
  };
  return { load, add };
}

/** Push onto the in-memory list, skipping an exact repeat of the last entry (shell ignoredups). -> true when added. */
export function pushHistory(list, text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (list.length && list[list.length - 1] === text) return false;
  list.push(text);
  return true;
}
