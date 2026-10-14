/**
 * Journey state for Getting started: ~/.config/quox/onboarding.json, so an interrupted journey resumes.
 * ALLOWLIST ONLY: the file holds exactly the fields named here (never a key, token or password), whatever the
 * caller passes in.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const JOURNEY_VERSION = 1;
export const STEPS = ['ask', 'offer', 'declined', 'preflight', 'credential', 'install', 'owner', 'finishing', 'finale'];
// installStage = the last install stage that COMPLETED (installRunner.js decides what re-running means).
const FIELDS = ['step', 'intent', 'request', 'provider', 'installStage', 'installDir', 'dashboardUrl', 'ownerEmail', 'ollamaUrl', 'startedAt', 'updatedAt'];
const INSTALL_STAGES = ['fetch', 'configure', 'build', 'start', 'health'];
const MAX = { request: 500, installDir: 300, dashboardUrl: 300, ownerEmail: 254, ollamaUrl: 200 };

export const journeyPath = () => join(homedir(), '.config', 'quox', 'onboarding.json');

export function sanitize(state) {
  const out = { version: JOURNEY_VERSION };
  for (const k of FIELDS) {
    const v = state?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') continue;
    out[k] = v.slice(0, MAX[k] || 64);
  }
  if (out.installStage && !INSTALL_STAGES.includes(out.installStage)) delete out.installStage;
  if (out.dashboardUrl && !/^https?:\/\/[^\s]+$/.test(out.dashboardUrl)) delete out.dashboardUrl;
  if (out.installDir && !out.installDir.startsWith('/')) delete out.installDir;
  if (out.step && !STEPS.includes(out.step)) delete out.step;
  if (out.provider && !['chatgpt', 'openai', 'anthropic', 'ollama', 'skip'].includes(out.provider)) delete out.provider;
  if (out.ollamaUrl !== undefined && (typeof out.ollamaUrl !== 'string' || !/^https?:\/\//.test(out.ollamaUrl))) delete out.ollamaUrl; // B3: a URL, never a secret
  return out;
}

export function loadJourney(path = journeyPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || raw.version !== JOURNEY_VERSION) return null;
    const s = sanitize(raw);
    return s.step ? s : null;
  } catch { return null; }
}

export function saveJourney(state, path = journeyPath(), now = () => new Date().toISOString()) {
  if (!path) return false;
  try {
    const prev = loadJourney(path);
    const t = now();
    const next = sanitize({ ...state, startedAt: prev?.startedAt || state.startedAt || t, updatedAt: t });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

export function clearJourney(path = journeyPath()) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* nothing to clear */ }
}

/**
 * Where a resumed journey starts. The AI key only ever lived in memory, so anything past the credential
 * step goes back through preflight (cheap, and the machine may have changed) and asks for the key again.
 */
export function resumeStep(saved) {
  if (!saved?.step) return null;
  if (saved.step === 'ask' || saved.step === 'finale') return null;
  if (saved.step === 'offer' || saved.step === 'declined') return 'offer';
  return 'preflight';
}
