/**
 * WARD-EXT: GitHub Sink
 *
 * Creates a lightweight tag in a GitHub repository for each tip.
 * Uses the GitHub REST API (works with github.com and GitHub Enterprise).
 *
 * sink_ref format: github:<owner>/<repo>#ward-tip/<chainSlug>/<tip_seq>
 *
 * Requires: WARD_GITHUB_TOKEN (personal access token or fine-grained token with tags:write)
 * Optional: WARD_GITHUB_OWNER, WARD_GITHUB_REPO, WARD_GITHUB_API (for GHE)
 */

const DEFAULT_API = 'https://api.github.com';

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { github_token, owner, repo, api_url }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
export async function publish(tip, config = {}) {
  const { github_token, owner, repo, api_url } = config;

  if (!github_token || !owner || !repo) {
    return { success: false, sink_ref: null, error: 'GitHub config incomplete (need github_token, owner, repo)' };
  }

  const api = api_url || DEFAULT_API;
  const chainSlug = tip.chain_id.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const tagName = `ward-tip/${chainSlug}/${tip.tip_seq}`;

  const message = JSON.stringify({
    tip_id: tip.tip_id,
    chain_id: tip.chain_id,
    tip_seq: tip.tip_seq,
    tip_chain_hash: tip.tip_chain_hash,
    entry_count: tip.entry_count,
    created_at: tip.created_at,
    sig: tip.sig,
    key_id: tip.key_id,
    published_at: new Date().toISOString()
  }, null, 2);

  try {
    // Step 1: Get the default branch SHA (needed for tag target)
    const repoRes = await fetch(`${api}/repos/${owner}/${repo}`, {
      headers: {
        'Authorization': `Bearer ${github_token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!repoRes.ok) {
      return { success: false, sink_ref: null, error: `GitHub repo lookup failed: ${repoRes.status}` };
    }

    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    // Step 2: Get the SHA of the default branch HEAD
    const refRes = await fetch(`${api}/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, {
      headers: {
        'Authorization': `Bearer ${github_token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!refRes.ok) {
      return { success: false, sink_ref: null, error: `GitHub ref lookup failed: ${refRes.status}` };
    }

    const refData = await refRes.json();
    const sha = refData.object?.sha;
    if (!sha) {
      return { success: false, sink_ref: null, error: 'Could not determine HEAD SHA' };
    }

    // Step 3: Create annotated tag object
    const tagObjRes = await fetch(`${api}/repos/${owner}/${repo}/git/tags`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${github_token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        tag: tagName,
        message,
        object: sha,
        type: 'commit',
        tagger: {
          name: 'WARD Evidence Publisher',
          email: 'ward@example.com',
          date: new Date().toISOString()
        }
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!tagObjRes.ok) {
      const body = await tagObjRes.text();
      return { success: false, sink_ref: null, error: `GitHub tag create failed: ${tagObjRes.status}: ${body.slice(0, 200)}` };
    }

    const tagObj = await tagObjRes.json();

    // Step 4: Create ref pointing to the tag object
    const refCreateRes = await fetch(`${api}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${github_token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: `refs/tags/${tagName}`,
        sha: tagObj.sha
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!refCreateRes.ok) {
      const body = await refCreateRes.text();
      // 422 = tag already exists (idempotent)
      if (refCreateRes.status === 422) {
        const sinkRef = `github:${owner}/${repo}#${tagName}`;
        return { success: true, sink_ref: sinkRef, error: null };
      }
      return { success: false, sink_ref: null, error: `GitHub ref create failed: ${refCreateRes.status}: ${body.slice(0, 200)}` };
    }

    const sinkRef = `github:${owner}/${repo}#${tagName}`;
    return { success: true, sink_ref: sinkRef, error: null };
  } catch (err) {
    return { success: false, sink_ref: null, error: err.message };
  }
}

export function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('github:');
}

export const type = 'github';
