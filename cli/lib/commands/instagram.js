/**
 * `quox instagram` — Instagram plugin verbs, IG-3 (facebook CLI parity).
 *
 * quox instagram publish "<caption>" --account <ig_user_id> (--image <https url> | --video <https url>) [--reel]
 * quox instagram accounts [--page <page_id>]
 * quox instagram media --account <ig_user_id> [--limit <n>]
 * quox instagram insights (--media <media_id> | --account <ig_user_id>) [--metrics <a,b,c>] [--period <period>]
 * quox instagram comments --media <media_id> [--limit <n>]
 * quox instagram reply <comment_id> "<message>"
 * quox instagram quota --account <ig_user_id>
 *
 * The write verbs (publish, reply) execute the instagram connector tool
 * through the governed collector endpoint (POST /api/v1/tools/execute ->
 * connector bridge). The bridge gates them on requiresApproval: it files an
 * owner approval card and returns immediately with
 * { pending:true, status:'awaiting_approval', approvalId, inbox_item_id }.
 * The actual Meta Graph API write (create-container -> poll -> publish, or
 * the comment reply) only happens once the owner approves via the dashboard
 * inbox or `quox inbox respond <id> --action approve`.
 * Reads (accounts, media, insights, comments, quota) execute directly.
 *
 * Instagram is its own plugin on the SAME shared 'meta' vault credential as
 * facebook_pages; there is no separate Instagram credential to configure.
 */

import { formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

/**
 * Execute one instagram connector tool via the governed collector endpoint.
 * A pending-approval response is a SUCCESS shape here (the card was filed);
 * only a non-pending success:false is an error.
 */
async function executeInstagramTool({ client, auth, program }, toolName, input) {
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
  printSuccess(`${action} filed for owner approval - inbox item ${itemRef} (awaiting approval). Nothing publishes until an approver says yes.`);
  if (data.inbox_item_id) {
    printInfo(`Review and approve: quox inbox get ${data.inbox_item_id}  (or: quox inbox respond ${data.inbox_item_id} --action approve)`);
  }
}

export function registerInstagramCommands(program, ctx) {
  const { client, auth } = ctx;

  const instagram = program
    .command('instagram')
    .description('Instagram publishing and monitoring (organic): governed, HITL-approved via HITL Inbox, on the shared Meta credential');

  // ── instagram publish ────────────────────────────────────────────────────

  instagram
    .command('publish')
    .description('Publish a single image, video, or reel to an Instagram account. Files an owner approval card and returns immediately; never publishes directly.')
    .argument('[caption]', 'post caption (optional)')
    .requiredOption('--account <ig_user_id>', 'Instagram professional account ID (from `quox instagram accounts`)')
    .option('--image <url>', 'https URL of an image to publish (exactly one of --image/--video is required)')
    .option('--video <url>', 'https URL of a video to publish (exactly one of --image/--video is required)')
    .option('--reel', 'publish the video as a reel (only valid with --video)')
    .action(async (caption, options) => {
      if (!options.image && !options.video) {
        throw new Error('instagram publish requires exactly one of --image or --video');
      }
      if (options.image && options.video) {
        throw new Error('instagram publish accepts exactly one of --image or --video, not both');
      }
      if (options.reel && !options.video) {
        throw new Error('--reel is only valid with --video');
      }

      const input = { ig_user_id: options.account };
      if (caption) input.caption = caption;
      if (options.image) {
        input.image_url = options.image;
        input.media_type = 'IMAGE';
      } else {
        input.video_url = options.video;
        input.media_type = options.reel ? 'REELS' : 'VIDEO';
      }

      const data = await executeInstagramTool({ client, auth, program }, 'instagram_publish_media', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Publish', data);
    });

  // ── instagram accounts (discover, read) ──────────────────────────────────

  instagram
    .command('accounts')
    .description('Discover the Instagram professional account linked to a Facebook Page (read-only, no approval needed).')
    .option('--page <page_id>', 'Facebook Page ID to resolve (optional; checks every Page this token can manage when omitted)')
    .action(async (options) => {
      const input = {};
      if (options.page) input.page_id = options.page;
      const data = await executeInstagramTool({ client, auth, program }, 'instagram_discover_account', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const result = data.result || {};
      if (!result.ig_user_id) {
        printInfo('No Instagram account resolved.');
        return;
      }
      console.log(`${result.ig_user_id}  @${result.username || 'unknown'}  linked page: ${result.linked_page?.name || result.linked_page?.id || 'unknown'}`);
    });

  // ── instagram media (read) ───────────────────────────────────────────────

  instagram
    .command('media')
    .description('List recent media on an Instagram account (read-only, no approval needed).')
    .requiredOption('--account <ig_user_id>', 'Instagram professional account ID')
    .option('--limit <n>', 'max media items to return (max 50)', '10')
    .action(async (options) => {
      const limit = Math.min(parseInt(options.limit, 10) || 10, 50);
      const data = await executeInstagramTool({ client, auth, program }, 'instagram_list_media', {
        ig_user_id: options.account,
        limit,
      });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const media = data.result || [];
      if (media.length === 0) {
        printInfo('No media returned.');
        return;
      }
      for (const m of media) {
        console.log(`${m.id}  ${m.media_type || ''}  ${m.timestamp || ''}`);
        console.log(`  ${String(m.caption || '').replace(/\n/g, '\n  ')}`);
      }
    });

  // ── instagram insights (read) ────────────────────────────────────────────

  instagram
    .command('insights')
    .description('Show media or account insights (reach, saved, likes, comments, shares, views, follower_count).')
    .option('--media <media_id>', 'Instagram media ID (media-level insights)')
    .option('--account <ig_user_id>', 'Instagram professional account ID (account-level insights)')
    .option('--metrics <metrics>', 'comma-separated metric names')
    .option('--period <period>', 'day|week|days_28|lifetime (account-level only)')
    .action(async (options) => {
      if (!options.media && !options.account) {
        throw new Error('instagram insights requires exactly one of --media or --account');
      }
      if (options.media && options.account) {
        throw new Error('instagram insights accepts exactly one of --media or --account, not both');
      }

      let data;
      if (options.media) {
        const input = { media_id: options.media };
        if (options.metrics) input.metrics = options.metrics;
        data = await executeInstagramTool({ client, auth, program }, 'instagram_get_media_insights', input);
      } else {
        const input = { ig_user_id: options.account };
        if (options.metrics) input.metrics = options.metrics;
        if (options.period) input.period = options.period;
        data = await executeInstagramTool({ client, auth, program }, 'instagram_get_account_insights', input);
      }

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const series = data.result || [];
      if (series.length === 0) {
        printInfo('No insights returned.');
        return;
      }
      for (const m of series) {
        const latest = (m.values || [])[m.values.length - 1];
        console.log(`${m.title || m.name}: ${latest ? JSON.stringify(latest.value) : 'unknown'}`);
      }
    });

  // ── instagram comments (read) ────────────────────────────────────────────

  instagram
    .command('comments')
    .description('List comments on an Instagram media item.')
    .requiredOption('--media <media_id>', 'Instagram media ID')
    .option('--limit <n>', 'max comments to return (max 100)', '25')
    .action(async (options) => {
      const limit = Math.min(parseInt(options.limit, 10) || 25, 100);
      const data = await executeInstagramTool({ client, auth, program }, 'instagram_get_comments', {
        media_id: options.media,
        limit,
      });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const comments = data.result || [];
      if (comments.length === 0) {
        printInfo('No comments returned.');
        return;
      }
      for (const c of comments) {
        console.log(`${c.id}  ${c.username || 'unknown'}  ${c.timestamp || ''}`);
        console.log(`  ${String(c.text || '').replace(/\n/g, '\n  ')}`);
      }
    });

  // ── instagram reply ──────────────────────────────────────────────────────

  instagram
    .command('reply')
    .description('Reply to a comment on an Instagram media item. Files an owner approval card and returns immediately; never replies directly.')
    .argument('<comment_id>', 'Instagram comment ID to reply to')
    .argument('<message>', 'reply text')
    .action(async (commentId, message) => {
      const data = await executeInstagramTool({ client, auth, program }, 'instagram_reply_comment', { comment_id: commentId, message });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Reply', data);
    });

  // ── instagram quota (read) ───────────────────────────────────────────────

  instagram
    .command('quota')
    .description('Show the rolling 24-hour publishing quota for an Instagram account (hard cap: 100 API-published posts).')
    .requiredOption('--account <ig_user_id>', 'Instagram professional account ID')
    .action(async (options) => {
      const data = await executeInstagramTool({ client, auth, program }, 'instagram_get_publishing_limit', { ig_user_id: options.account });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const result = data.result || {};
      if (result.quota_usage == null) {
        printInfo('No quota data returned.');
        return;
      }
      console.log(`${result.quota_usage} / ${result.quota_total ?? 'unknown'} posts used (rolling ${result.quota_duration ? `${Math.round(result.quota_duration / 3600)}h` : '24h'} window)`);
    });
}
