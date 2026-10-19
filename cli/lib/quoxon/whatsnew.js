/**
 * "What's new" (QUOXON-FW16, derived in QUOXON-WHATSNEW3). Curated entries live in whatsnew.jsonl: append-only, one
 * JSON object per line, added by the commit that ships the change (see whatsnew.md). ENTRIES is sorted newest first.
 * With no curated source (a dev checkout without the file) entries are derived from git: commits on the CLI tree with
 * a `Whatsnew: <title> | <command>` trailer or a `[whatsnew]` subject tag.
 * Last-seen state is kept on the CLI profile (quoxon.whatsNew = { build, id, date }): the build the user last ran and
 * the newest entry they have been shown.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const byDateDesc = (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);

/** whatsnew.jsonl text -> entries newest first. Blank or unparsable lines are skipped. */
export function parseEntries(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { const e = JSON.parse(t); if (e && e.id && e.title) out.push(e); } catch { /* skip a broken line */ }
  }
  return out.sort(byDateDesc);
}

// %x1f between fields, %x1e between commits; the trailer value is "title | command" (command optional).
export const GIT_LOG_FORMAT = '%h%x1f%cI%x1f%s%x1f%(trailers:key=Whatsnew,valueonly,separator=%x20)%x1e';

/** git log output (GIT_LOG_FORMAT) -> entries, keeping only commits marked user-facing. */
export function gitEntries(log) {
  const out = [];
  for (const rec of String(log || '').split('\x1e')) {
    const [sha, date, subject = '', trailer = ''] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha) continue;
    const tv = trailer.trim();
    let title = '', cmd = '';
    if (tv && tv.toLowerCase() !== 'none') [title, cmd = ''] = tv.split('|').map(x => x.trim());
    else if (/\[whatsnew\]/i.test(subject)) title = subject.replace(/\[[^\]]*\]\s*/g, '').trim();
    if (!title) continue;
    out.push({ id: `git-${sha}`, date: (date || '').trim(), title, text: title, ...(cmd ? (cmd.startsWith('/') ? { try: cmd } : { shell: cmd }) : {}), sha });
  }
  return out.sort(byDateDesc);
}

/** Curated file first; git only when the file is missing or empty. Never throws. */
export function loadEntries({ readCurated, readGit }) {
  let curated = [];
  try { curated = parseEntries(readCurated()); } catch { /* no curated source */ }
  if (curated.length) return curated;
  try { return gitEntries(readGit()); } catch { return []; }
}

/**
 * Curated text: whatsnew.jsonl in this repo; the public mirror export ships the same entries as a whatsnew.json array
 * (scripts/release/public-mirror/export.js), which is turned back into one JSON object per line here.
 */
export function readCuratedText(read) {
  try { return read('./whatsnew.jsonl'); } catch { /* not here: try the exported array */ }
  const arr = JSON.parse(read('./whatsnew.json'));
  return Array.isArray(arr) ? arr.map(e => JSON.stringify(e)).join('\n') : '';
}

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const ENTRIES = loadEntries({
  readCurated: () => readCuratedText(f => readFileSync(new URL(f, import.meta.url), 'utf8')),
  readGit: () => execFileSync('git', ['-C', CLI_ROOT, 'log', '-n', '300', `--format=${GIT_LOG_FORMAT}`, '--', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }),
});

/** Entries newer than the last one shown: by id, else by date (the id is unknown after a source switch). */
export function unseenEntries(last, entries = ENTRIES) {
  if (!last || typeof last !== 'object' || (!last.id && !last.date)) return entries;
  const at = last.id ? entries.findIndex(e => e.id === last.id) : -1;
  if (at >= 0) return entries.slice(0, at);
  const t = Date.parse(last.date);
  return Number.isFinite(t) ? entries.filter(e => Date.parse(e.date) > t) : entries;
}

/** The profile record after showing: build + newest entry. */
export const seenRecord = (build, entries = ENTRIES) => ({ build: String(build || ''), id: entries[0]?.id, date: entries[0]?.date });

/** The command to try for an entry: a slash command, else a shell command. */
export const tryText = (e) => e.try || e.shell || '';

export const BOX_MAX = 5;
export const LIST_DEFAULT = 10;

export const tryCommand = (e) => String(e.try || '').trim().split(/\s+/)[0];

/** Startup decision. -> { show: entries[], more: n, record: {build,id} | null }. Nothing recorded when there are no entries. */
export function startupWhatsNew({ build, last, entries = ENTRIES }) {
  const newest = entries[0]?.id;
  if (!newest) return { show: [], more: 0, record: null };
  const record = { build: String(build || ''), id: newest };
  if (!last || typeof last !== 'object' || !last.id) return { show: [], more: 0, record }; // first ever run: record silently
  if (last.build === record.build) return { show: [], more: 0, record: last.id === newest ? null : record };
  const at = entries.findIndex(e => e.id === last.id);
  const unseen = at < 0 ? entries : entries.slice(0, at); // unknown last id (e.g. a rollback): treat all as unseen
  return { show: unseen.slice(0, BOX_MAX), more: Math.max(0, unseen.length - BOX_MAX), record };
}

/** /whatsnew [all]. -> { entries, more } */
export function listWhatsNew(arg = '', entries = ENTRIES) {
  const all = String(arg).trim().toLowerCase() === 'all';
  const shown = all ? entries : entries.slice(0, LIST_DEFAULT);
  return { entries: shown, more: entries.length - shown.length };
}

// ---- New commands (QUOXON-WHATSNEW2) -------------------------------------------------------------------------------
// Per-profile record of registry command ids the user has already been shown: quoxon.whatsNewSeen = [id...].
// Startup preference: quoxon.whatsNewStartup = 'on' | 'off' (default on). Both live in the synced profile settings.
export const startupEnabled = (settings) => String(settings?.whatsNewStartup || 'on').toLowerCase() !== 'off';

const activeCommands = (registry) => registry.filter(e => e.kind === 'command' && e.status === 'active');

/**
 * Commands the user has not been shown, newest first (registry is oldest first, so reversed). With no record yet
 * (first run, or an install that predates this) only entries flagged `new: true` count, so nobody gets a wall of
 * every command. all=true ignores the record.
 */
export function unseenCommands({ registry, seen, all = false }) {
  const cmds = activeCommands(registry);
  const pool = all ? cmds : Array.isArray(seen) ? cmds.filter(e => !seen.includes(e.id)) : cmds.filter(e => e.new);
  return [...pool].reverse();
}

/** The ids to store after showing: everything currently active (so later additions show as new). */
export const seenAfter = (registry) => activeCommands(registry).map(e => e.id);

/** One compact startup line, or null. e.g. "6 new commands (/mind, /ask, /page, ...) · /whatsnew for more". */
export function startupCommandLine(list, max = 3) {
  if (!list.length) return null;
  const names = list.slice(0, max).map(e => '/' + e.id).join(', ') + (list.length > max ? ', ...' : '');
  return `${list.length} new command${list.length === 1 ? '' : 's'} (${names}) \u00b7 /whatsnew for more`;
}

/** /whatsnew on|off. -> 'on' | 'off' | null */
export const toggleArg = (arg) => { const a = String(arg).trim().toLowerCase(); return a === 'on' || a === 'off' ? a : null; };
