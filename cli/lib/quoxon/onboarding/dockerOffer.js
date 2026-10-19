/**
 * FIRSTRUN (2026-10-19): the guide OFFERS to fix Docker instead of saying "install Docker, then press r".
 *
 *   install   Docker missing (Linux): Docker's official script, then add this user to the docker group
 *   group     Docker installed, this user not in the docker group: add them
 *   relaunch  in the group, but this terminal started before that: nothing to run with sudo
 *
 * A yes leaves the Ink view (the journey is saved at preflight), runs the command with the real terminal
 * attached so sudo can ask for a password, then starts quox again under `sg docker`, so the new group applies
 * without logging out. The relaunched quox picks up where the guide left off.
 */
import { spawnSync } from 'node:child_process';
import { askText } from '../ask.js';
import * as T from './copy.js';

export const DOCKER_INSTALL_CMD = 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"';
export const DOCKER_GROUP_CMD = 'sudo usermod -aG docker "$USER"';
const COMMANDS = { install: DOCKER_INSTALL_CMD, group: DOCKER_GROUP_CMD, relaunch: null };

/** rows -> { kind, command, ask } for the first row the guide can fix, or null. */
export function dockerOffer(rows) {
  const r = (rows || []).find(x => x?.status === 'fail' && x.offer && x.offer in COMMANDS);
  if (!r) return null;
  const kind = r.offer;
  const command = COMMANDS[kind];
  const q = T.DOCKER_OFFER_QUESTION[kind];
  const action = command ? `run: ${command}  then start quox again with the docker group` : 'start quox again with the docker group (sg docker), no sudo';
  return { kind, command, ask: askText(q, { keys: 'y/N', who: 'Quox', action }) };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Runs the offer with the terminal attached. -> { action: 'exit', status } */
export function runDockerOffer(kind, { spawn = spawnSync, out = (s) => process.stdout.write(s), node = process.execPath, bin } = {}) {
  const command = COMMANDS[kind];
  if (command) {
    out(`\n${T.DOCKER_OFFER_RUNNING}\n  ${command}\n\n`);
    const r = spawn('sh', ['-c', command], { stdio: 'inherit' });
    if (r?.status !== 0) { out(`\n${T.DOCKER_OFFER_FAILED}\n`); return { action: 'exit', status: r?.status ?? 1 }; }
  }
  out(`\n${T.DOCKER_OFFER_RELAUNCH}\n`);
  const again = spawn('sg', ['docker', '-c', `exec ${shq(node)} ${shq(bin)}`], { stdio: 'inherit' });
  if (again?.error) { out(`${T.CHECK.docker.permStaleFix}\n`); return { action: 'exit', status: 1 }; }
  return { action: 'exit', status: again?.status ?? 0 };
}
