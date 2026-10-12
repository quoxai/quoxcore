/**
 * `quox linkedin` — LinkedIn plugin verbs, LI-OVERHAUL P9 (X CLI parity).
 *
 * quox linkedin post "<text>" --as <author_urn> [--visibility PUBLIC|CONNECTIONS] [--link <url>] [--image-url <https url>]
 * quox linkedin comment <post_urn> "<text>" --as <actor_urn>
 * quox linkedin posts <author_urn> [--count <n>]
 * quox linkedin org <org_id>
 *
 * Both write verbs execute the linkedin connector tools through the governed
 * collector endpoint (POST /api/v1/tools/execute -> connector bridge). The
 * bridge gates them on their requiresApproval flag: each files an owner
 * approval card and returns immediately with
 * { pending:true, status:'awaiting_approval', approvalId, inbox_item_id }.
 * The actual LinkedIn API write only happens once the owner approves via the
 * dashboard inbox or `quox inbox respond <id> --action approve`. Reads
 * (posts, org) execute directly; LinkedIn reads carry no per-call dollar
 * cost (unlike X), only LinkedIn's own daily program quotas.
 *
 * URNs are explicit by design: LinkedIn addresses everything by URN
 * (urn:li:person:xxx member, urn:li:organization:12345 org page) and the
 * CLI has no org-scoped plugin-config lookup yet, so --as is required on
 * writes rather than silently guessed.
 */

import { formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

const MAX_POST_CHARS = 3000;

/**
 * Execute one linkedin connector tool via the governed collector endpoint.
 * A pending-approval response is a SUCCESS shape here (the card was filed);
 * only a non-pending success:false is an error.
 */
async function executeLinkedInTool({ client, auth, program }, toolName, input) {
  auth.requireAuth();
  const orgId = resolveOrgId(auth, program);
  const ep = resolveEndpoint('v1.tools.execute');
  const body = { tool_name: toolName, input, org_id: orgId };
  const data = await client.post(ep.path, { service: ep.service, body });
  if (data && data.success === false && !data.pending) {
    throw new Error(`${toolName} via POST ${ep.path} returned success:false: ${data.error || 'unknown error'}`);
  }
  return data;
}

function printAwaitingApproval(action, data) {
  const itemRef = data.inbox_item_id || data.approvalId || 'unknown';
  printSuccess(`${action} filed for owner approval — inbox item ${itemRef} (awaiting approval). Nothing publishes until an approver says yes.`);
  if (data.inbox_item_id) {
    printInfo(`Review and approve: quox inbox get ${data.inbox_item_id}  (or: quox inbox respond ${data.inbox_item_id} --action approve)`);
  }
}

export function registerLinkedInCommands(program, ctx) {
  const { client, auth } = ctx;

  const linkedin = program
    .command('linkedin')
    .description('LinkedIn publishing: governed, HITL-approved via HITL Inbox');

  // ── linkedin post ────────────────────────────────────────────────────────

  linkedin
    .command('post')
    .description('Draft a LinkedIn post. Files an owner approval card and returns immediately; never posts directly.')
    .argument('<text>', `post text, max ${MAX_POST_CHARS} characters`)
    .requiredOption('--as <author_urn>', 'author URN (urn:li:person:xxx or urn:li:organization:12345)')
    .option('--visibility <visibility>', 'PUBLIC or CONNECTIONS', 'PUBLIC')
    .option('--link <url>', 'attach a link/article URL')
    .option('--image-url <url>', 'attach an image from an https URL (max 10MB); uploaded to LinkedIn server-side before the card is filed, so the approver sees the finished attachment')
    .action(async (text, options) => {
      if (text.length > MAX_POST_CHARS) {
        throw new Error(`Text is ${text.length} characters, over the ${MAX_POST_CHARS} character limit.`);
      }
      if (!['PUBLIC', 'CONNECTIONS'].includes(options.visibility)) {
        throw new Error(`--visibility must be PUBLIC or CONNECTIONS, got ${options.visibility}`);
      }

      const input = { author: options.as, text, visibility: options.visibility };
      if (options.link) input.link_url = options.link;

      if (options.imageUrl) {
        const media = await executeLinkedInTool({ client, auth, program }, 'linkedin_upload_media', {
          owner: options.as,
          image_url: options.imageUrl,
        });
        const urn = media?.result?.image_urn;
        if (!urn) {
          throw new Error(`Image upload did not return an image URN: ${JSON.stringify(media).slice(0, 200)}`);
        }
        printInfo(`Image uploaded (${media.result.bytes} bytes) — ${urn}`);
        input.media_id = urn;
      }

      const data = await executeLinkedInTool({ client, auth, program }, 'linkedin_publish_post', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Post', data);
    });

  // ── linkedin comment ─────────────────────────────────────────────────────

  linkedin
    .command('comment')
    .description('Draft a comment on a LinkedIn post. Files an owner approval card and returns immediately; never comments directly.')
    .argument('<post_urn>', 'URN of the post to comment on (e.g. urn:li:share:12345)')
    .argument('<text>', 'comment text')
    .requiredOption('--as <actor_urn>', 'actor URN posting the comment (person or organisation)')
    .action(async (postUrn, text, options) => {
      const data = await executeLinkedInTool({ client, auth, program }, 'linkedin_create_comment', {
        post_urn: postUrn,
        actor: options.as,
        text,
      });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Comment', data);
    });

  // ── linkedin posts (read) ────────────────────────────────────────────────

  linkedin
    .command('posts')
    .description('List recent posts for a member or organisation (read-only, no approval needed).')
    .argument('<author_urn>', 'author URN (person or organisation)')
    .option('--count <n>', 'number of posts (max 50)', '20')
    .action(async (authorUrn, options) => {
      const count = Math.min(parseInt(options.count, 10) || 20, 50);
      const data = await executeLinkedInTool({ client, auth, program }, 'linkedin_get_posts', {
        author: authorUrn,
        count,
      });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const posts = data.result || [];
      if (posts.length === 0) {
        printInfo('No posts returned.');
        return;
      }
      for (const p of posts) {
        console.log(`${p.id}  ${p.created_at || ''}  ${p.lifecycle_state || ''}`);
        console.log(`  ${String(p.text || '').replace(/\n/g, '\n  ')}`);
      }
    });

  // ── linkedin org (read) ──────────────────────────────────────────────────

  linkedin
    .command('org')
    .description('Show a LinkedIn organisation page: name, follower count, website (read-only). Also the cheapest live credential check.')
    .argument('<org_id>', 'numeric organisation id (e.g. 12345)')
    .action(async (orgId) => {
      const data = await executeLinkedInTool({ client, auth, program }, 'linkedin_get_org_info', { org_id: orgId });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const org = data.result || {};
      printSuccess(`${org.name || 'Unknown'} (urn:li:organization:${org.id})`);
      if (org.vanity_name) printInfo(`linkedin.com/company/${org.vanity_name}`);
      // followers can be null when networkSizes is unavailable — say unknown,
      // never a fake 0.
      printInfo(`Followers: ${org.followers == null ? 'unknown' : org.followers.toLocaleString()}`);
      if (org.website) printInfo(`Website: ${org.website}`);
    });
}
