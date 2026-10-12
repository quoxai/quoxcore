/**
 * `quox tiktok` — TikTok plugin verbs, TT-4 (instagram CLI parity).
 *
 * quox tiktok publish "<title>" --file <path-in-media-root> [--privacy SELF_ONLY|MUTUAL_FOLLOW_FRIENDS|PUBLIC_TO_EVERYONE] [--no-duet] [--no-comment] [--no-stitch]
 * quox tiktok draft "<title>" --file <path-in-media-root>
 * quox tiktok profile
 * quox tiktok videos [--limit <n>]
 * quox tiktok stats --ids <id,id,...>
 * quox tiktok status --publish-id <id>
 *
 * The write verbs (publish, draft) execute the tiktok connector tool through
 * the governed collector endpoint (POST /api/v1/tools/execute -> connector
 * bridge). The bridge gates both on requiresApproval: it files an owner
 * approval card and returns immediately with { pending:true,
 * status:'awaiting_approval', approvalId, inbox_item_id }. The actual TikTok
 * API write (video/init -> upload -> publish, or the inbox/draft init ->
 * upload) only happens once the owner approves via the dashboard inbox or
 * `quox inbox respond <id> --action approve`.
 *
 * TikTok has its OWN dedicated vaulted credential; there is no shared
 * credential with any other plugin. Two hard truths this CLI states
 * honestly: an unaudited TikTok app is restricted to posting private
 * (SELF_ONLY) content regardless of the privacy level requested, until
 * TikTok approves the app audit; and access tokens live 24 hours with no
 * automatic refresh built yet.
 */

import { formatDetail, printSuccess, printInfo, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

const PRIVACY_LEVELS = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE'];

/**
 * Execute one tiktok connector tool via the governed collector endpoint.
 * A pending-approval response is a SUCCESS shape here (the card was filed);
 * only a non-pending success:false is an error.
 */
async function executeTikTokTool({ client, auth, program }, toolName, input) {
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

export function registerTikTokCommands(program, ctx) {
  const { client, auth } = ctx;

  const tiktok = program
    .command('tiktok')
    .description('TikTok video publishing and draft uploads: governed, HITL-approved via HITL Inbox, on your own dedicated TikTok credential');

  // ── tiktok publish ────────────────────────────────────────────────────

  tiktok
    .command('publish')
    .description('Publish a video from a file under the org TikTok media root. Files an owner approval card and returns immediately; never publishes directly.')
    .argument('<title>', 'video title/caption')
    .requiredOption('--file <path>', 'video file path, relative to the org TikTok media root')
    .option('--privacy <level>', `privacy level: ${PRIVACY_LEVELS.join('|')} (default SELF_ONLY)`, 'SELF_ONLY')
    .option('--no-duet', 'disable duets on this video')
    .option('--no-comment', 'disable comments on this video')
    .option('--no-stitch', 'disable stitching on this video')
    .action(async (title, options) => {
      const privacy = options.privacy || 'SELF_ONLY';
      if (!PRIVACY_LEVELS.includes(privacy)) {
        throw new Error(`--privacy must be one of ${PRIVACY_LEVELS.join(', ')} (got ${privacy})`);
      }

      const input = {
        title,
        video_path: options.file,
        privacy_level: privacy,
        disable_duet: !options.duet,
        disable_comment: !options.comment,
        disable_stitch: !options.stitch,
      };

      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_publish_video', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Publish', data);
      if (privacy !== 'SELF_ONLY') {
        printWarning(`Requested privacy_level=${privacy} is sent to TikTok exactly as asked, but an unaudited TikTok app is restricted to private (SELF_ONLY) viewing until TikTok approves the app audit. Check the outcome with: quox tiktok status --publish-id <id>`);
      }
    });

  // ── tiktok draft ──────────────────────────────────────────────────────

  tiktok
    .command('draft')
    .description('Upload a video to the account\'s TikTok inbox as a draft, finished manually in the TikTok app. Files an owner approval card and returns immediately; never uploads directly.')
    .argument('<title>', 'working title for the draft (display only)')
    .requiredOption('--file <path>', 'video file path, relative to the org TikTok media root')
    .action(async (title, options) => {
      const input = { title, video_path: options.file };
      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_upload_draft', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Draft upload', data);
    });

  // ── tiktok profile (read; cheapest live credential check) ──────────────

  tiktok
    .command('profile')
    .description('Show the connected TikTok profile (also the cheapest live credential check).')
    .action(async () => {
      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_get_profile', {});

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const result = data.result || {};
      if (!result.open_id && !result.display_name) {
        printInfo('No profile returned.');
        return;
      }
      console.log(`${result.display_name || 'unknown'}  (${result.open_id || 'unknown'})`);
      console.log(`  followers: ${result.followers ?? 'unknown'}  following: ${result.following ?? 'unknown'}  likes: ${result.likes ?? 'unknown'}  videos: ${result.videos ?? 'unknown'}`);
    });

  // ── tiktok videos (read) ────────────────────────────────────────────────

  tiktok
    .command('videos')
    .description('List the connected account\'s recent videos (read-only, no approval needed).')
    .option('--limit <n>', 'max videos to return (max 20)', '10')
    .action(async (options) => {
      const maxCount = Math.min(parseInt(options.limit, 10) || 10, 20);
      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_list_videos', { max_count: maxCount });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const videos = data.result?.videos || [];
      if (videos.length === 0) {
        printInfo('No videos returned.');
        return;
      }
      for (const v of videos) {
        console.log(`${v.id}  ${v.title || '(no title)'}`);
        console.log(`  views: ${v.views ?? 0}  likes: ${v.likes ?? 0}  comments: ${v.comments ?? 0}  shares: ${v.shares ?? 0}`);
      }
    });

  // ── tiktok stats (read) ──────────────────────────────────────────────────

  tiktok
    .command('stats')
    .description('Show engagement stats for specific videos by id.')
    .requiredOption('--ids <ids>', 'comma-separated TikTok video IDs')
    .action(async (options) => {
      const videoIds = options.ids.split(',').map((s) => s.trim()).filter(Boolean);
      if (videoIds.length === 0) {
        throw new Error('tiktok stats requires at least one id in --ids');
      }
      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_get_video_stats', { video_ids: videoIds });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const videos = data.result || [];
      if (videos.length === 0) {
        printInfo('No stats returned.');
        return;
      }
      for (const v of videos) {
        console.log(`${v.id}  ${v.title || '(no title)'}`);
        console.log(`  views: ${v.views ?? 0}  likes: ${v.likes ?? 0}  comments: ${v.comments ?? 0}  shares: ${v.shares ?? 0}`);
      }
    });

  // ── tiktok status (read) ─────────────────────────────────────────────────

  tiktok
    .command('status')
    .description('Check the status of a video publish or draft upload by publish_id.')
    .requiredOption('--publish-id <id>', 'the publish_id returned by publish or draft')
    .action(async (options) => {
      const data = await executeTikTokTool({ client, auth, program }, 'tiktok_get_publish_status', { publish_id: options.publishId });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      const result = data.result || {};
      if (!result.status) {
        printInfo('No status returned.');
        return;
      }
      console.log(`${result.publish_id}  status: ${result.status}`);
      if (result.fail_reason) console.log(`  fail_reason: ${result.fail_reason}`);
      if (result.publicly_available_post_ids) console.log(`  publicly_available_post_ids: ${result.publicly_available_post_ids}`);
    });
}
