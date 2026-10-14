/**
 * First-run notice for bare `quox`: who we are, legal, docs. Pure model + a tiny "seen" marker kept in the
 * CLI's existing config dir (~/.config/quox, same place as config.json). Links live ONLY here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DOCS_URL = 'https://github.com/quoxai/quoxcore'; // will become https://cli.quox.ai
export const TERMS_URL = 'https://quox.ai/terms';
export const PRIVACY_URL = 'https://quox.ai/privacy';
export const LICENCE = 'Quox Community Source Licence 1.0 (source-available)';
export const WELCOME_VERSION = 1;

export function packageVersion() {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.1.0'; } catch { return '0.1.0'; }
}

/** [{ kind: 'title'|'sub'|'rule'|'field'|'para'|'gap'|'hint', ... }] */
export function welcomeModel(version = packageVersion()) {
  return [
    { kind: 'title', text: 'Welcome to Quox' },
    { kind: 'sub', text: `Quox CLI ${version}` },
    { kind: 'para', text: 'The main front door to Quox, your self-hosted control plane for AI agents.' },
    { kind: 'rule' },
    { kind: 'field', label: 'Docs', value: DOCS_URL, link: true },
    { kind: 'field', label: 'Terms', value: TERMS_URL, link: true },
    { kind: 'field', label: 'Privacy', value: PRIVACY_URL, link: true },
    { kind: 'field', label: 'Licence', value: LICENCE },
    { kind: 'rule' },
    { kind: 'para', text: 'Your prompts go to your own QuoxCORE server and to the AI provider you connect to it.' },
    { kind: 'para', text: 'Risky actions ask you first, and the actions Quox takes leave receipts you can verify.' },
    { kind: 'para', text: 'This CLI sends no telemetry to Quox.' },
    { kind: 'para', text: 'By using Quox CLI you agree to the Terms.' },
    { kind: 'hint', text: 'Enter to continue · /about to see this again' }
  ];
}

export const welcomeStatePath = () => join(homedir(), '.config', 'quox', 'welcome.json');

export function welcomeSeen(path = welcomeStatePath()) {
  try { return (JSON.parse(readFileSync(path, 'utf8')).version || 0) >= WELCOME_VERSION; } catch { return false; }
}
export function markWelcomeSeen(path = welcomeStatePath()) {
  try { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify({ version: WELCOME_VERSION, seenAt: new Date().toISOString() }) + '\n'); return true; } catch { return false; }
}

/** First interactive launch only: a TTY, not suppressed, not seen at this notice version. */
export function shouldShowWelcome({ env = process.env, isTTY = process.stdout.isTTY && process.stdin.isTTY, print = false, path } = {}) {
  if (print || !isTTY || env.QUOX_NO_WELCOME === '1') return false;
  return !welcomeSeen(path);
}
