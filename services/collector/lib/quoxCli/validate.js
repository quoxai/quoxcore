'use strict';
/**
 * QUOXON-ASK lane J: turn a quox_cli tool input into an argv array, validated against
 * the CLI's real command tree (config/cliLeafTree.json). Never a shell string.
 *
 * Input: { path: ['inbox','list'], args: { status: 'pending', limit: 5 }, positional: [...] }
 *  - path must name an invocable leaf exactly (a leading 'quox' is dropped);
 *  - every args key must be a long option that leaf declares; identity, transport,
 *    credential and filesystem options are refused by name;
 *  - values ride as --flag=value (one argv element, so a value can never become a flag);
 *  - positionals ride after '--', count-checked against the leaf's declared arguments.
 * The caller adds the forced globals (--json, and --yes for an approved write).
 */

const MAX_VALUE = 8000;
const MAX_POSITIONAL = 32;
const MAX_ARGV_BYTES = 32 * 1024;
const WORD_RE = /^[a-z][a-z0-9-]{0,40}$/;

// The tool runs as the caller in the caller's org: these flags would change who or where.
const IDENTITY_OPTIONS = new Set(['--org', '--org-id', '--orgs', '--exec-org', '--connector-org', '--as', '--profile', '--resident', '--resident-profile', '--website-profile', '--insecure', '--debug', '--help', '--version']);
// Word parts that mark a credential option (a secret in argv would be witnessed).
const CREDENTIAL_WORDS = new Set(['pass', 'password', 'passwd', 'secret', 'token', 'key', 'keys', 'cert', 'credential', 'credentials', 'stdin']);
// Last word parts that mark an option naming a path on the server's disk.
const FS_LAST_WORDS = new Set(['file', 'files', 'dir', 'dirs', 'directory', 'path', 'paths', 'out', 'outdir', 'root', 'roots']);
const FS_ARG_RE = /(file|path|dir|directory)/i;

// Leaves where `--key` names a non-secret identifier, each verified against cli/lib/commands.
// Everywhere else --key stays refused as a credential (vault, apikey, setup config, volt...).
// `contacts facts` / `contacts propose-fact` are listed because a fact's key is a fact name;
// both are still never-class or agent-tool-only today, so this changes nothing for them.
const KEY_NAME_LEAVES = {
  'contacts facts': 'a fact name (e.g. favourite-colour), not a secret',
  'contacts propose-fact': 'a fact name (e.g. favourite-colour), not a secret',
  'settings history': 'filters to one platform setting name',
  'qlarity read': 'the storage key the storage inspector reads from the page',
  'sso providers create': 'the unique provider key (e.g. okta), not a secret',
};
// Values that look like a credential: refused even for an allowlisted --key.
const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\./,
  /(?:pass(?:word|wd)?|secret|token|api[_-]?key|bearer)\s*[=:]/i,
  /^bearer\s+\S+/i,
  /[A-Fa-f0-9]{32,}/,
  /[A-Za-z0-9+/_-]{40,}={0,2}/,
];
function looksLikeSecret(v) { return SECRET_VALUE_RES.some((re) => re.test(String(v))); }

function refusedOption(long, pathKey) {
  if (long === '--key' && pathKey && KEY_NAME_LEAVES[pathKey]) return null;
  if (IDENTITY_OPTIONS.has(long)) return `${long} is not allowed: quox_cli always runs as you, in this organization`;
  const words = long.replace(/^--(no-)?/, '').split('-');
  if (words.some((w) => CREDENTIAL_WORDS.has(w))) return `${long} carries a credential, which never goes through a conversation`;
  if (FS_LAST_WORDS.has(words[words.length - 1])) return `${long} names a path on the server filesystem, which quox_cli does not touch`;
  return null;
}

function cleanString(v, label) {
  const s = String(v);
  if (s.length > MAX_VALUE) return { error: `${label} is longer than ${MAX_VALUE} characters` };
  // Newlines and tabs are fine (a note body); other control characters are not.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return { error: `${label} contains a control character` };
  return { value: s };
}

function fail(error) { return { ok: false, error }; }
const SHELL_RE = /["'`;&|<>$(){}[\]\\*?~!\n\r]/;
const ARGV_SHAPE = 'pass the command as an argv array, not a shell string: e.g. {"path":["vm","cluster"]}, flags as args {"limit":5}, values as positional ["101"]';

/**
 * -> { ok:true, pathKey, leaf, leafArgv } | { ok:false, error }
 */
function buildCall(input, { tree }) {
  if (!input || typeof input !== 'object') return fail('input must be an object with a path array');
  // quox#882: models send the path as one string ("engagement list") or as one array element
  // with spaces about as often as a word array; all three mean the same command. Words past
  // the leaf ("quoxchat conversations w1") are that leaf's positionals.
  // SITE-CLI 2026-10-19: one plain string (path, args or positional) is argv split on whitespace, never a shell;
  // a string carrying quotes or shell syntax is refused with the expected shape.
  let p = input.path;
  for (const field of ['path', 'args', 'positional']) {
    const v = input[field];
    if (typeof v !== 'string') continue;
    if (SHELL_RE.test(v)) return fail(`${field} holds quotes or shell syntax; ${ARGV_SHAPE}`);
    const words = v.trim().split(/\s+/).filter(Boolean);
    if (field === 'path') p = words;
    else if (field === 'positional') input = { ...input, positional: words };
    else {
      // the whole command sent as args: its words extend the path; a flag in it cannot be placed safely
      if (words.some((w) => w.startsWith('-'))) return fail(`flags go in args as an object, e.g. {"node":"hyp-01"}; ${ARGV_SHAPE}`);
      p = [...(Array.isArray(p) ? p : typeof p === 'string' ? [p] : []), ...words];
      input = { ...input, args: {} };
    }
  }
  if (typeof p === 'string') p = [p];
  if (!Array.isArray(p) || p.length === 0) return fail('path must be the command words, e.g. ["inbox","list"]');
  p = p.flatMap((w) => String(w).trim().split(/\s+/)).filter(Boolean);
  if (p[0] && p[0].toLowerCase() === 'quox') p = p.slice(1);
  let extra = [];
  let n = 0;
  for (let i = Math.min(p.length, 6); i > 0; i--) {
    const key = p.slice(0, i).map((w) => w.toLowerCase()).join(' ');
    if (p.slice(0, i).every((w) => WORD_RE.test(w.toLowerCase())) && tree.leaves[key]) { n = i; break; }
  }
  if (n > 0) { extra = p.slice(n); p = p.slice(0, n); }
  p = p.map((w) => w.toLowerCase());
  if (p.length === 0 || p.length > 6 || !p.every((w) => WORD_RE.test(w))) return fail('path words must be plain command names (put flags in args and values in positional)');
  const pathKey = p.join(' ');
  const leaf = tree.leaves[pathKey];
  if (!leaf) return fail(`unknown command: quox ${pathKey} (no such leaf in the CLI command tree)`);
  if (extra.length) {
    if (extra.some((w) => w.startsWith('-') && w !== '--help' && w !== '-h')) return fail(`quox ${pathKey}: put flags in args, not in path`);
    if (input.positional != null && !Array.isArray(input.positional)) return fail('positional must be an array');
    input = { ...input, positional: [...extra.filter((w) => w !== '--help' && w !== '-h'), ...(input.positional || [])] };
  }

  // --help / -h: a READ of the leaf's own help, only when it is the whole call (path + the flag).
  const helpWords = (w) => w === '--help' || w === '-h';
  const argKeys = input.args == null ? [] : Object.keys(input.args && typeof input.args === 'object' ? input.args : {});
  const helpViaArgs = argKeys.length === 1 && ['help', '-h', '--help', 'h'].includes(String(argKeys[0]).trim()) && input.args[argKeys[0]] === true;
  const helpViaPath = (extra.length === 1 && helpWords(extra[0]));
  const wantsHelp = helpViaPath || helpViaArgs;
  if (wantsHelp || extra.some(helpWords) || argKeys.some((k) => ['help', '-h', '--help', 'h'].includes(String(k).trim()))) {
    const bare = (input.positional == null || (Array.isArray(input.positional) && input.positional.length === 0));
    const onlyHelp = (helpViaPath && argKeys.length === 0) || (helpViaArgs && extra.length === 0);
    if (!wantsHelp || !onlyHelp || !bare) return fail(`--help is allowed only on its own: path ["${p.join('","')}"] plus args {"help":true}, with no other flags or arguments`);
    return { ok: true, pathKey, leaf, leafArgv: [...p, '--help'], help: true };
  }

  const argv = [...p];
  const byLong = new Map(leaf.options.filter((o) => o.long).map((o) => [o.long, o]));
  const given = new Set();
  const args = input.args == null ? {} : input.args;
  if (typeof args !== 'object' || Array.isArray(args)) return fail('args must be an object of named flags');
  for (const [rawKey, val] of Object.entries(args)) {
    const key = String(rawKey).trim().replace(/^-+/, '');
    const long = `--${key}`;
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/i.test(key)) return fail(`bad option name: ${rawKey}`);
    const refused = refusedOption(long, pathKey);
    if (refused) return fail(refused);
    const opt = byLong.get(long);
    if (!opt) {
      // name the valid options, so the retry is informed rather than a guess (2026-10-19, contacts list --relationship)
      const valid = [...byLong.keys()].filter((l) => !refusedOption(l, pathKey));
      return fail(`unknown option ${long} for quox ${pathKey}; ${valid.length ? `valid options: ${valid.join(', ')}` : 'it takes no options'}`);
    }
    given.add(long);
    if (opt.value === 'none') {
      if (val === true) argv.push(long);
      else if (val === false || val == null) { /* omitted */ } else return fail(`${long} is a flag: pass true or false`);
      continue;
    }
    const values = Array.isArray(val) ? val : [val];
    if (Array.isArray(val) && !opt.variadic) return fail(`${long} takes one value`);
    for (const v of values) {
      if (opt.value === 'optional' && v === true) { argv.push(long); continue; }
      if (v == null || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) return fail(`${long} needs a text or number value`);
      const c = cleanString(v, long);
      if (c.error) return fail(c.error);
      if (long === '--key' && looksLikeSecret(c.value)) return fail(`${long} looks like a credential value, which never goes through a conversation`);
      argv.push(`${long}=${c.value}`);
    }
  }
  for (const o of leaf.options) if (o.mandatory && !given.has(o.long)) return fail(`quox ${pathKey} needs ${o.long}`);

  const pos = input.positional == null ? [] : input.positional;
  if (!Array.isArray(pos)) return fail('positional must be an array');
  if (pos.length > MAX_POSITIONAL) return fail('too many positional arguments');
  const declared = leaf.args || [];
  for (const a of declared) if (FS_ARG_RE.test(a.name)) return fail(`quox ${pathKey} takes a path on the server filesystem (<${a.name}>), which quox_cli does not touch`);
  const required = declared.filter((a) => a.required).length;
  const variadic = declared.some((a) => a.variadic);
  if (pos.length < required) {
    const missing = declared.filter((a) => a.required).slice(pos.length).map((a) => `<${a.name}>`).join(' ');
    return fail(`quox ${pathKey} needs ${missing}`);
  }
  if (!variadic && pos.length > declared.length) return fail(`quox ${pathKey} takes at most ${declared.length} positional argument(s)`);
  if (pos.length) {
    argv.push('--');
    for (const v of pos) {
      if (v == null || (typeof v !== 'string' && typeof v !== 'number')) return fail('positional arguments must be text or numbers');
      const c = cleanString(v, 'a positional argument');
      if (c.error) return fail(c.error);
      argv.push(c.value);
    }
  }
  if (Buffer.byteLength(argv.join('\0')) > MAX_ARGV_BYTES) return fail('the command line is too long');
  return { ok: true, pathKey, leaf, leafArgv: argv };
}

/** The command line as a person reads it (each argv element JSON-quoted when needed). */
function displayCommand(argv) {
  return ['quox', ...argv.map((a) => (/^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : JSON.stringify(a)))].join(' ');
}

module.exports = { buildCall, displayCommand, refusedOption, IDENTITY_OPTIONS };
