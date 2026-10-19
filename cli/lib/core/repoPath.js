// Repo-relative path normaliser for loosening asks. Keep in step with services/auth/lib/repoPath.js and
// scripts/guards/check-test-loosening.mjs (cli/test/core/repoPath.test.js asserts all three agree).
// "<anywhere>/quox-dashboard-wt-x/cli/a.test.js" -> "cli/a.test.js"; "./cli/a.test.js" -> "cli/a.test.js".
export function toRepoRelative(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  s = s.replace(/^(?:.*?\/)?quox-dashboard(?:-wt-[^/]+)?\//, '');
  s = s.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  return s;
}

export const LOOSENING_HINT = 'quox ask loosening --paths <repo-relative test files...> --justify "<why it is safe, plain words>"';
