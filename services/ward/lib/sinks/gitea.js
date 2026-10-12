/**
 * WARD-EXT-1: Gitea Sink (moved from sinks.js)
 *
 * Publishes signed tip as a Gitea tag.
 * sink_ref format: gitea:<owner>/<repo>#ward-tip/<chain_slug>/<tip_seq>
 */

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { gitea_url, owner, repo, token, target }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
async function publish(tip, config = {}) {
  const { gitea_url, owner, repo, token, target } = config;

  if (!gitea_url || !owner || !repo || !token) {
    return { success: false, sink_ref: null, error: 'Gitea config incomplete (need gitea_url, owner, repo, token)' };
  }

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
    key_id: tip.key_id
  }, null, 2);

  const url = `${gitea_url}/api/v1/repos/${owner}/${repo}/tags`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `token ${token}`
      },
      body: JSON.stringify({ tag_name: tagName, message, target: target || '' })
    });

    if (!res.ok) {
      const body = await res.text();
      return { success: false, sink_ref: null, error: `Gitea API ${res.status}: ${body}` };
    }

    const sinkRef = `gitea:${owner}/${repo}#${tagName}`;
    return { success: true, sink_ref: sinkRef, error: null };
  } catch (err) {
    return { success: false, sink_ref: null, error: err.message };
  }
}

function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('gitea:');
}

export { publish, verify };
export const type = 'gitea';
