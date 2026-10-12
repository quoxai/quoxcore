/**
 * WARD-EXT: GitLab Sink
 *
 * Creates a tag in a GitLab repository for each tip.
 * Uses the GitLab REST API (works with gitlab.com and self-hosted).
 *
 * sink_ref format: gitlab:<project_id>#ward-tip/<chainSlug>/<tip_seq>
 *
 * Requires: WARD_GITLAB_TOKEN (personal/project access token with api scope)
 * Optional: WARD_GITLAB_URL (default: https://gitlab.com), WARD_GITLAB_PROJECT_ID
 */

const DEFAULT_URL = 'https://gitlab.com';

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { gitlab_token, project_id, gitlab_url }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
export async function publish(tip, config = {}) {
  const { gitlab_token, project_id, gitlab_url } = config;

  if (!gitlab_token || !project_id) {
    return { success: false, sink_ref: null, error: 'GitLab config incomplete (need gitlab_token, project_id)' };
  }

  const baseUrl = gitlab_url || DEFAULT_URL;
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
    // GitLab create tag API — simpler than GitHub (one call)
    const encodedProject = encodeURIComponent(project_id);
    const url = `${baseUrl}/api/v4/projects/${encodedProject}/repository/tags`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': gitlab_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag_name: tagName,
        ref: 'main',
        message
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text();
      // 400 with "already exists" = idempotent success
      if (res.status === 400 && body.includes('already exists')) {
        const sinkRef = `gitlab:${project_id}#${tagName}`;
        return { success: true, sink_ref: sinkRef, error: null };
      }
      return { success: false, sink_ref: null, error: `GitLab API ${res.status}: ${body.slice(0, 200)}` };
    }

    const sinkRef = `gitlab:${project_id}#${tagName}`;
    return { success: true, sink_ref: sinkRef, error: null };
  } catch (err) {
    return { success: false, sink_ref: null, error: err.message };
  }
}

export function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('gitlab:');
}

export const type = 'gitlab';
