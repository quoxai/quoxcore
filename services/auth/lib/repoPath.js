// Repo-relative path normaliser (see cli/lib/core/repoPath.js; kept identical, a test asserts it).
export function toRepoRelative(p) {
    let s = String(p ?? '').trim().replace(/\\/g, '/');
    s = s.replace(/^(?:.*?\/)?quox-dashboard(?:-wt-[^/]+)?\//, '');
    s = s.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    return s;
}
