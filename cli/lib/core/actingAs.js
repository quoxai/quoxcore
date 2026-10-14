/**
 * actingAs.js — `--as <agent>` / QUOX_AS (quox#772).
 *
 * Opt-in: when set, every platform request the CLI client makes carries the
 * named agent's stored ATTACH token as the bearer instead of the profile /
 * resident token, so evidence credits the agent and its grant scope governs
 * the verb. Never falls back to the human identity when it was requested.
 *
 * `--as` is stripped from argv BEFORE commander parses (it is not a commander
 * option) because linkedin/claude already own a `--as` of their own and a root
 * declaration would shadow theirs (required options would then fail).
 */
import { readFileSync } from 'node:fs';
import { QuoxError } from './errors.js';

// Commands whose own `--as` means something else.
const OWNS_AS = new Set(['linkedin', 'claude']);

/**
 * @returns {{name: string|null, argv: string[]}} acting agent (flag beats env)
 *   and argv with the global --as removed.
 */
export function extractActingAs(argv, env = process.env) {
  const first = argv.find((a) => !a.startsWith('-'));
  const envName = (env.QUOX_AS || '').trim() || null;
  if (first && OWNS_AS.has(first)) return { name: envName, argv };
  const out = [];
  let name = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.push(...argv.slice(i)); break; }
    if (a === '--as' && argv[i + 1] && !argv[i + 1].startsWith('-')) { name = argv[++i]; continue; }
    if (a.startsWith('--as=') && a.length > 5) { name = a.slice(5); continue; }
    out.push(a);
  }
  return { name: (name || '').trim() || envName, argv: out };
}

/** The EXPLICIT acting agent (QUOX_AS; bin/quox.js folds --as into it). May be 'self'. */
export function actingAsName(env = process.env) {
  return (env.QUOX_AS || '').trim() || null;
}

// Verbs that manage the attach itself (or must run as the human) never get the
// implicit attached-session default. Explicit --as / QUOX_AS still applies.
const EXEMPT_TOP = new Set(['login', 'logout', 'whoami', 'slot', 'memory']);
const EXEMPT_AGENT_SUB = new Set([
  'attach', 'detach', 'keep', 'attach-status', 'attach-heartbeat', 'exec',
  'bind-slot', 'unbind-slot', 'grant-attach', 'grant-attach-all',
  'revoke-attach-all', 'revoke-attach', 'list-grants',
]);
const VALUE_FLAGS = new Set(['-o', '--output', '--org', '-p', '--profile']);

/** First two positional words of argv, skipping global flags (and their values). */
function leadingWords(argv) {
  const words = [];
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    words.push(a);
  }
  return words;
}

export function isDefaultExempt(argv) {
  const [top, sub] = leadingWords(argv);
  if (!top) return true;
  if (EXEMPT_TOP.has(top)) return true;
  return top === 'agent' && EXEMPT_AGENT_SUB.has(sub);
}

/** Did the command line (or QUOX_PROFILE) name a profile explicitly? */
export function hasExplicitProfile(argv, env = process.env) {
  if ((env.QUOX_PROFILE || '').trim()) return true;
  return argv.some((a) => a === '-p' || a === '--profile' || a.startsWith('--profile=') || /^-p.+/.test(a));
}

/**
 * The single place that decides who plain verbs act as.
 * Order: --as, QUOX_AS ('self' = own identity), explicit -p/--profile, the
 * session's sole attach (implicit default), else the profile identity.
 * @returns {{name: string|null, source: 'flag'|'env'|'self'|'profile'|'default'|null}}
 */
export async function resolveActing({ argv = process.argv.slice(2), env = process.env, resolveAttach, explicitProfile = false } = {}) {
  const explicit = actingAsName(env);
  if (explicit) {
    const source = env.QUOX_AS_FLAG === '1' ? 'flag' : 'env';
    if (explicit.toLowerCase() === 'self') return { name: null, source: 'self', via: source };
    return { name: explicit, source };
  }
  if (explicitProfile || hasExplicitProfile(argv, env)) return { name: null, source: 'profile' };
  if (isDefaultExempt(argv)) return { name: null, source: null };
  const mine = resolveAttach ? resolveAttach() : (await import('../commands/agentAttach.js')).resolveMyAttach();
  if (mine?.agentId) return { name: mine.agentId, source: 'default' };
  return { name: null, source: null };
}


/**
 * Resolve the attach token for `agentId` in this session's scope, refreshing
 * via the existing attach heartbeat when near expiry. Throws if not attached.
 * `heartbeatClient` must NOT itself act-as (it authenticates as the holder).
 */
export async function resolveActingToken(agentId, heartbeatClient, { implicit = false } = {}) {
  const { tokenPath, ensureFreshAttachToken } = await import('../commands/agentAttach.js');
  let present = false;
  try { present = Boolean(readFileSync(tokenPath(agentId), 'utf-8').trim()); } catch { /* absent */ }
  if (!present) {
    throw new QuoxError(
      `--as/QUOX_AS requested agent "${agentId}" but this session has no attach token for it. `
      + `Run \`quox agent attach ${agentId}\` first (refusing to fall back to your own identity).`,
      3,
    );
  }
  const token = await ensureFreshAttachToken(heartbeatClient, agentId);
  if (implicit) {
    const exp = jwtExp(token);
    if (exp && exp <= Math.floor(Date.now() / 1000)) {
      throw new QuoxError(
        `This session is attached as "${agentId}" and plain quox verbs act as it by default, but the attach lease expired and could not be renewed. `
        + `Re-attach with \`quox agent attach ${agentId}\`, or act as yourself with \`--as self\` (or \`-p <profile>\`). `
        + 'Refusing to fall back to your own identity silently.',
        3,
      );
    }
  }
  return token;
}

function jwtExp(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).exp || null;
  } catch { return null; }
}
