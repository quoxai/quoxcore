/**
 * KEEPER-REEXEC: which quox build is installed, read from files only (cheap enough to check on
 * every keeper control poll, no git or child process). A git checkout (the dev box runs quox from
 * a detached worktree) reports its HEAD sha; an npm install reports `v<version>`. null = unknown,
 * and an unknown build never triggers a re-exec or a takeover.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40,64}$/;
const read = (p) => { try { return readFileSync(p, 'utf-8').trim(); } catch { return null; } };

function gitDirFor(root) {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return null;
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(read(dotGit) || '');
  if (!m) return null;
  return isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
}

function resolveRef(gitDir, ref) {
  const loose = read(join(gitDir, ref));
  if (loose && SHA_RE.test(loose)) return loose;
  const commonRel = read(join(gitDir, 'commondir'));
  const common = commonRel ? (isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel)) : null;
  if (common) {
    const c = read(join(common, ref));
    if (c && SHA_RE.test(c)) return c;
  }
  for (const d of [gitDir, common].filter(Boolean)) {
    const packed = read(join(d, 'packed-refs')) || '';
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && SHA_RE.test(sha)) return sha;
    }
  }
  return null;
}

/** cliDir = the CLI package dir (holds package.json); its parent may be the git root. */
export function readInstalledBuild(cliDir) {
  try {
    for (const root of [cliDir, dirname(cliDir)]) {
      const gd = gitDirFor(root);
      if (!gd) continue;
      const head = read(join(gd, 'HEAD'));
      if (!head) continue;
      if (SHA_RE.test(head)) return head;
      const m = /^ref:\s*(\S+)$/.exec(head);
      if (m) { const sha = resolveRef(gd, m[1]); if (sha) return sha; }
    }
    const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf-8'));
    return pkg && pkg.version ? `v${pkg.version}` : null;
  } catch { return null; }
}

/** The CLI package this module was loaded from (cli/lib/core -> cli). */
export const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
