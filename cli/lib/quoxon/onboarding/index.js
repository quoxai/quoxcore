/**
 * Entry for Getting started (main.js calls this when no server is configured, or for --demo-onboarding).
 * Runs the Ink view, then performs what it asked for: exit, or hand off to the existing `quox login` flow for
 * `/connect server <url>`.
 */
import React from 'react';
import { render } from 'ink';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GettingStarted } from './view.js';
import { inkStdout } from '../term.js';
import { createCredentialBroker, createRequestCredential } from './credential.js';
import { createDryRunRunner } from './runner.js';
import { createInstallRunner, defaultInstallDir, probeAuthHealth } from './installRunner.js';
import { createFinisher } from './finish.js';
import { journeyPath as defaultJourneyPath, clearJourney, loadJourney } from './journey.js';
import * as T from './copy.js';

const QUOX_BIN = fileURLToPath(new URL('../../../bin/quox.js', import.meta.url));

/** The real install: get.quox.ai -> scripts/setup.sh, health = the new instance's auth service on loopback. */
export async function realInstall({ env = process.env } = {}) {
  // The CLI's own service resolution (honours the per-service overrides); with no server configured
  // yet it derives auth on loopback 127.0.0.1:3101, where the new instance's auth service listens.
  const { loadConfig } = await import('../../core/config.js');
  const authUrl = loadConfig().getServiceUrl('auth');
  const saved = loadJourney();
  return {
    runner: createInstallRunner({ env, installDir: saved?.installDir || defaultInstallDir(), probeHealth: () => probeAuthHealth(authUrl) }),
    finisher: await createFinisher()
  };
}

/** -> { action: 'exit' } | { action: 'connected', replay? } | { action: 'connect-failed' } */
export async function runGettingStarted({ version, cwd, welcome = false, earlyInput = null, demo = false, stdout = process.stdout } = {}) {
  const broker = createCredentialBroker();
  const requestCredential = createRequestCredential(broker);
  let result = { action: 'exit' };
  const real = demo ? { runner: createDryRunRunner(), finisher: null } : await realInstall();
  const props = {
    version, cwd, welcome, earlyInput, broker, requestCredential,
    dryRun: demo,
    runner: real.runner,
    finisher: real.finisher, // owner account, vault, one-time link (C2c); none in the dry run
    journeyPath: demo ? null : defaultJourneyPath(), // the demo never leaves state behind
    onExit: (r) => { result = r || result; app.unmount(); }
  };
  const app = render(React.createElement(GettingStarted, props), { exitOnCtrlC: false, stdout: inkStdout(stdout) });
  await app.waitUntilExit();
  broker.cancel();
  if (result.action === 'connect') return connectServer(result.url, { demo });
  return result;
}

/** /connect server <url>: point the active profile at it and run the existing login. Restores the URL on failure. */
export async function connectServer(url, { demo = false, spawn = spawnSync, out = (s) => process.stdout.write(s) } = {}) {
  if (demo) { out(`${T.connectHandoff(url)}\n(demo: not connecting)\n`); return { action: 'exit' }; }
  const { loadConfig } = await import('../../core/config.js');
  const config = loadConfig();
  const prev = config.getActiveProfile()?.url || null;
  config.setProfileConnection({ url });
  const r = spawn(process.execPath, [QUOX_BIN, 'login'], { stdio: 'inherit' });
  if (r.status === 0) { clearJourney(); out(`${T.CONNECT_DONE}\n`); return { action: 'connected' }; }
  if (prev) loadConfig().setProfileConnection({ url: prev });
  out(`${T.connectFailed(url)}\n`);
  return { action: 'connect-failed' };
}
