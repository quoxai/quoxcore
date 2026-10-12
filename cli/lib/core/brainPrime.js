/**
 * ONE-BRAIN CX4 (attach-time prime) and CX3 (handoff-to-note) helpers.
 *
 * Both are best effort by design: neither may ever fail an attach or a detach.
 * Endpoints reused: brain.context.pack (`quox brain context`) and
 * brain.capture.create (`quox brain add` / `decide`).
 */
import { execFileSync } from 'node:child_process';
import { resolveEndpoint } from '../api/endpoints.js';

export const PRIME_TIMEOUT_MS = 5000;
export const PRIME_TOKEN_BUDGET = 1200;
export const PRIME_SNIPPET_CHARS = 300;

function gitOut(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** Does this attach kit's resolved tool list carry the brain_context tool? */
export function kitHasBrainContext(kit) {
  return Array.isArray(kit?.tools) && kit.tools.includes('brain_context');
}

/** Query text from the working context: repo, branch, advisory stream, last 3 commit subjects. */
export function buildPrimeQuery({ git = gitOut, env = process.env } = {}) {
  const top = git(['rev-parse', '--show-toplevel']);
  const repo = top ? top.split('/').pop() : '';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const subjects = git(['log', '-3', '--pretty=%s']).split('\n').map((s) => s.trim()).filter(Boolean);
  const parts = [];
  if (repo) parts.push(`repo ${repo}`);
  if (branch && branch !== 'HEAD') parts.push(`branch ${branch}`);
  if (env.QUOX_STREAM) parts.push(`stream ${env.QUOX_STREAM} (advisory)`);
  if (subjects.length) parts.push(`recent work: ${subjects.join('; ')}`);
  return parts.join(', ');
}

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** Returns the "## Brain primer" markdown section. Never throws. */
export async function buildBrainPrimer(client, { query, timeoutMs = PRIME_TIMEOUT_MS } = {}) {
  const head = '## Brain primer';
  try {
    const q = query ?? buildPrimeQuery();
    if (!q) return `${head}\n\nNo primer: the brain returned nothing relevant\n`;
    const ep = resolveEndpoint('brain.context.pack');
    const data = await withTimeout(
      Promise.resolve().then(() => client.post(ep.path, { service: ep.service, body: { query: q, tokenBudget: PRIME_TOKEN_BUDGET } })),
      timeoutMs,
    );
    const passages = Array.isArray(data?.passages) ? data.passages : [];
    const insufficient = data?.insufficient === true || data?.relevance?.insufficient === true || passages.length === 0;
    if (insufficient) return `${head}\n\nNo primer: the brain returned nothing relevant\n`;
    const lines = passages.map((p) => {
      const c = p.citation || {};
      const text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, PRIME_SNIPPET_CHARS);
      return `- ${c.title || 'Untitled'} (${p.noteId || c.noteId || '?'}): ${text}`;
    });
    return `${head}\n\nQuery (stream is advisory): ${q}\n\n${lines.join('\n')}\n`;
  } catch (err) {
    return `${head}\n\nNo primer: brain unreachable (${err?.message || 'unknown error'})\n`;
  }
}

/** Save a handoff to the knowledge brain as a private note. Returns { ok, noteId?, error? }; never throws. */
export async function saveHandoffNote(client, { agentId, content, prov = {}, sessionName, now = new Date() }) {
  try {
    const ep = resolveEndpoint('brain.capture.create');
    const iso = now.toISOString();
    const provLines = [
      `Agent: ${agentId}`,
      prov.repo ? `Repo: ${prov.repo}` : null,
      prov.commit ? `Commit: ${prov.commit}` : null,
      sessionName ? `Session: ${sessionName}` : null,
      `At: ${iso}`,
    ].filter(Boolean);
    const text = `${content}\n\n## Provenance\n\n${provLines.map((l) => `- ${l}`).join('\n')}\n`;
    const data = await client.post(ep.path, {
      service: ep.service,
      body: { title: `Handoff: ${agentId} ${iso}`, text, tags: ['handoff', agentId], scope: 'user' },
    });
    return { ok: true, noteId: data?.noteId };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown error' };
  }
}
