/**
 * `quox x` — X (Twitter) posting commands, X-PLUGIN P2 CLI verbs.
 *
 * quox x post "<text>" [--reply-to <tweet_id>]
 * quox x thread <file.md>
 * quox x delete <tweet_id>
 * quox x like <tweet_id>
 * quox x repost <tweet_id>
 * quox x status
 * quox x read <tweet_id>
 * quox x timeline [--count <n>]
 * quox x search <query> [--count <n>]
 * quox x mentions [--since <tweet_id>]
 *
 * Every write verb here executes the collector's natively-registered
 * governed tools (x_post, x_thread, x_delete — services/collector/lib/
 * xTools.js) via the same governed path every other agent tool call takes:
 * POST /api/v1/tools/execute (see cli/lib/commands/nucleus.js for the same
 * pattern with codebase_query). None of these tools ever post directly —
 * each files an owner approval card in HITL Inbox and returns immediately with
 * { success:true, status:'awaiting_approval', inbox_item_id }. The actual X
 * API write only happens once the owner approves via the dashboard inbox or
 * `quox inbox respond <id> --action approved`.
 *
 * `quox x status` runs the read-only x_budget_status tool (no gating) plus
 * the twitter connector's verify_credentials tool (exposed as the
 * connector-prefixed tool name twitter_verify_credentials, see
 * lib/connectors/types/twitter.js + agentTools.js's parseConnectorTool).
 *
 * X-PLUGIN P5 (image attachments) — `quox x post --image <path>` (repeatable,
 * up to 4) and `!image: <path>` lines inside a `quox x thread` block attach
 * images. Neither verb copies the file anywhere: the CLI runs on the same
 * box as the collector, so it passes the path straight through and the
 * SERVER validates it resolves inside the caller's org X media root
 * (xPostingStore.resolveOrgMediaPath) — the same as every other draft-time
 * check, fail at draft, not at approval. `quox x media-root` prints where
 * that root is.
 */

import { formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

const MAX_POST_CHARS = 280;
const MAX_IMAGES_PER_POST = 4;
// X-PLUGIN P5: mirrors the server-side default (xPostingStore.js CONFIG.mediaRoot).
// There is no live lookup endpoint for this constant, so if a collector
// operator overrides it, this printed value goes stale — a real gap, not
// hidden here.
const DEFAULT_MEDIA_ROOT = '/var/lib/quox/x-media';

/** Strip `!image: <path>` lines out of a thread block, collecting the paths
 * (up to 4) — those lines are consumed, never posted as text. Exported for
 * testing. */
export function extractImagesFromBlock(block) {
  const imagePaths = [];
  const text = String(block)
    .replace(/^!image:\s*(.+)$/gm, (_match, p) => {
      imagePaths.push(p.trim());
      return '';
    })
    .replace(/\n{2,}/g, '\n')
    .trim();
  return { text, image_paths: imagePaths };
}

/**
 * Split thread source text into posts on blank-line-separated blocks.
 * Exported for testing. Trims each block; drops blocks that are empty after
 * trimming (e.g. a trailing blank line at end of file).
 */
export function splitThreadBlocks(source) {
  return String(source)
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Client-side friendly validation before ever reaching the network — the
 * server (xTools.js's validatePostText) still enforces this too, so this is
 * a fail-fast convenience, not the source of truth.
 */
export function validateThreadBlocks(blocks) {
  if (blocks.length === 0) {
    throw new Error('No posts found. The file must contain at least one non-empty, blank-line-separated block of text.');
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].length > MAX_POST_CHARS) {
      throw new Error(
        `Post ${i + 1} of ${blocks.length} is ${blocks[i].length} characters, over the ${MAX_POST_CHARS} character limit. `
        + 'Split it into shorter blank-line-separated blocks.'
      );
    }
  }
  return blocks;
}

/**
 * Execute one native/connector tool via the governed collector endpoint.
 * Throws naming the endpoint and status on an HTTP-level failure (the
 * client already carries status via QuoxApiError); a 200 tool-level
 * { success:false } is surfaced as a plain Error naming the endpoint too,
 * since that failure never carried an HTTP status of its own.
 */
async function executeXTool({ client, auth, program }, toolName, input) {
  auth.requireAuth();
  const orgId = resolveOrgId(auth, program);
  const ep = resolveEndpoint('v1.tools.execute');
  const body = { tool_name: toolName, input, org_id: orgId };
  const data = await client.post(ep.path, { service: ep.service, body });
  if (data && data.success === false) {
    throw new Error(`${toolName} via POST ${ep.path} returned success:false: ${data.error || 'unknown error'}`);
  }
  return data;
}

function printAwaitingApproval(action, data) {
  printSuccess(`${action} queued for owner approval — inbox item ${data.inbox_item_id} (awaiting approval).`);
  printInfo(`Review and approve: quox inbox get ${data.inbox_item_id}  (or: quox inbox respond ${data.inbox_item_id} --action approve)`);
}

/** One tweet as two terminal lines: id + date + metrics, then the text. */
function printTweetLine(t) {
  const m = t.public_metrics || {};
  const metrics = `♥ ${m.like_count ?? 0} · ⟲ ${m.retweet_count ?? 0} · ↩ ${m.reply_count ?? 0}`;
  console.log(`${t.id}  ${t.created_at || ''}  ${metrics}`);
  console.log(`  ${String(t.text || '').replace(/\n/g, '\n  ')}`);
}

/** Reads cost real money (X pay-per-use, roughly $0.005 per call). Every
 * read verb below states that in its description and makes exactly ONE
 * call per invocation. */
const READ_COST_NOTE = 'One paid X API read per run (roughly $0.005).';

export function registerXCommands(program, ctx) {
  const { client, auth } = ctx;

  const x = program
    .command('x')
    .description('X (Twitter) posting: governed, HITL-approved via HITL Inbox');

  // ── x post ──────────────────────────────────────────────────────────────

  x
    .command('post')
    .description('Draft a post to X. Files an owner approval card and returns immediately; never posts directly.')
    .argument('<text>', `post text, max ${MAX_POST_CHARS} characters`)
    .option('--reply-to <tweet_id>', 'id of an existing tweet this post replies to')
    .option(
      '--image <path>',
      `attach an image (repeatable, up to ${MAX_IMAGES_PER_POST}); png/jpg/webp/gif, max 5MB. The file must live under the X media root (run \`quox x media-root\`) inside your org's subdirectory — the server validates the path.`,
      (val, prev) => prev.concat([val]),
      []
    )
    .action(async (text, options) => {
      if (text.length > MAX_POST_CHARS) {
        throw new Error(`Text is ${text.length} characters, over the ${MAX_POST_CHARS} character limit.`);
      }
      if (options.image.length > MAX_IMAGES_PER_POST) {
        throw new Error(`${options.image.length} images given, over the ${MAX_IMAGES_PER_POST} image limit per post.`);
      }
      const input = { text };
      if (options.replyTo) input.reply_to_tweet_id = options.replyTo;
      if (options.image.length) input.image_paths = options.image;

      const data = await executeXTool({ client, auth, program }, 'x_post', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Post', data);
    });

  // ── x thread ────────────────────────────────────────────────────────────

  x
    .command('thread')
    .description(
      'Draft a thread from a file, split on blank-line-separated blocks. Files one owner approval card for the whole thread. '
      + `A line of the form "!image: <path>" inside a block attaches that image (up to ${MAX_IMAGES_PER_POST} per block, consumed — never posted as text); `
      + 'the path must live under the X media root (run `quox x media-root`) inside your org\'s subdirectory.'
    )
    .argument('<file>', 'path to a markdown/text file; each blank-line-separated block becomes one post')
    .action(async (file) => {
      const { readFile } = await import('node:fs/promises');
      let source;
      try {
        source = await readFile(file, 'utf-8');
      } catch (err) {
        throw new Error(`Could not read ${file}: ${err.message}`);
      }

      const rawBlocks = splitThreadBlocks(source);
      const items = rawBlocks.map((block) => extractImagesFromBlock(block));
      validateThreadBlocks(items.map((it) => it.text));
      for (let i = 0; i < items.length; i++) {
        if (items[i].image_paths.length > MAX_IMAGES_PER_POST) {
          throw new Error(`Post ${i + 1} of ${items.length} has ${items[i].image_paths.length} "!image:" lines, over the ${MAX_IMAGES_PER_POST} image limit per post.`);
        }
      }

      const hasImages = items.some((it) => it.image_paths.length > 0);
      const input = hasImages ? { posts: items } : { texts: items.map((it) => it.text) };
      const data = await executeXTool({ client, auth, program }, 'x_thread', input);

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printInfo(`${items.length} post(s) parsed from ${file}.`);
      printAwaitingApproval('Thread', data);
    });

  // ── x delete ────────────────────────────────────────────────────────────

  x
    .command('delete')
    .description('Delete an existing X post. Files an owner approval card and returns immediately; never deletes directly.')
    .argument('<tweet_id>', 'id of the tweet to delete')
    .action(async (tweetId) => {
      const data = await executeXTool({ client, auth, program }, 'x_delete', { tweet_id: tweetId });

      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Delete', data);
    });

  // ── x like / x repost (P10 slice B engagement writes, HITL like all writes) ──

  x
    .command('like')
    .description('Like a tweet as the org account. Files an owner approval card and returns immediately; never likes directly. Capped by the daily engagement budget.')
    .argument('<tweet_id>', 'id of the tweet to like')
    .action(async (tweetId) => {
      const data = await executeXTool({ client, auth, program }, 'x_like', { tweet_id: tweetId });
      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Like', data);
    });

  x
    .command('repost')
    .description('Repost (retweet) a tweet as the org account. Files an owner approval card and returns immediately; never reposts directly. Capped by the daily engagement budget.')
    .argument('<tweet_id>', 'id of the tweet to repost')
    .action(async (tweetId) => {
      const data = await executeXTool({ client, auth, program }, 'x_repost', { tweet_id: tweetId });
      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
        return;
      }
      printAwaitingApproval('Repost', data);
    });

  // ── read verbs (P10 parity: the connector read tools, one paid call each) ──

  x
    .command('read')
    .description(`Read one tweet by id, with public metrics. ${READ_COST_NOTE}`)
    .argument('<tweet_id>', 'id of the tweet to read')
    .action(async (tweetId) => {
      const data = await executeXTool({ client, auth, program }, 'twitter_get_tweet', { tweet_id: tweetId });
      const tweet = data?.result || data;
      if (program.opts().output === 'json') {
        formatDetail(tweet, { format: 'json' });
        return;
      }
      printTweetLine(tweet);
    });

  x
    .command('timeline')
    .description(`Read recent posts from the connected account's timeline. ${READ_COST_NOTE}`)
    .option('--count <n>', 'posts to return, 1-20 (default 10)')
    .option('--user <user_id>', 'read another user\'s timeline instead of the connected account')
    .action(async (options) => {
      const input = {};
      if (options.count) input.max_results = Number(options.count);
      if (options.user) input.user_id = options.user;
      const data = await executeXTool({ client, auth, program }, 'twitter_get_user_tweets', input);
      const result = data?.result || data;
      if (program.opts().output === 'json') {
        formatDetail(result, { format: 'json' });
        return;
      }
      const tweets = result?.tweets || [];
      printInfo(`${tweets.length} post(s) for user ${result?.user_id || '(connected account)'}:`);
      tweets.forEach(printTweetLine);
    });

  x
    .command('search')
    .description(`Search recent tweets (last ~7 days, X search operators supported). ${READ_COST_NOTE}`)
    .argument('<query>', 'X search query')
    .option('--count <n>', 'results to return, 1-20 (default 10)')
    .action(async (query, options) => {
      const input = { query };
      if (options.count) input.max_results = Number(options.count);
      const data = await executeXTool({ client, auth, program }, 'twitter_search_recent', input);
      const result = data?.result || data;
      if (program.opts().output === 'json') {
        formatDetail(result, { format: 'json' });
        return;
      }
      const tweets = result?.tweets || [];
      printInfo(`${tweets.length} result(s) for "${query}":`);
      tweets.forEach(printTweetLine);
    });

  x
    .command('mentions')
    .description(`Read recent mentions of the connected account. ${READ_COST_NOTE} The mentions poller already covers this on a schedule when an org opts in; this verb is the on-demand check.`)
    .option('--since <tweet_id>', 'only mentions newer than this tweet id')
    .action(async (options) => {
      const input = {};
      if (options.since) input.since_id = options.since;
      const data = await executeXTool({ client, auth, program }, 'twitter_get_mentions', input);
      const result = data?.result || data;
      if (program.opts().output === 'json') {
        formatDetail(result, { format: 'json' });
        return;
      }
      const mentions = result?.mentions || [];
      printInfo(`${mentions.length} mention(s):`);
      mentions.forEach(printTweetLine);
    });

  // ── x status ────────────────────────────────────────────────────────────

  x
    .command('status')
    .description('Show current posting budget usage and X credential health')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('v1.tools.execute');

      const budgetData = await client.post(ep.path, {
        service: ep.service,
        body: { tool_name: 'x_budget_status', input: {}, org_id: orgId },
      });

      let credResult = null;
      let credError = null;
      try {
        const credData = await client.post(ep.path, {
          service: ep.service,
          body: { tool_name: 'twitter_verify_credentials', input: {}, org_id: orgId },
        });
        if (credData && credData.success === false) {
          credError = credData.error || 'unknown error';
        } else {
          credResult = credData && credData.result ? credData.result : credData;
        }
      } catch (err) {
        credError = err.message;
      }

      if (program.opts().output === 'json') {
        formatDetail({ budget: budgetData, credentials: credResult, credentials_error: credError }, { format: 'json' });
        return;
      }

      if (budgetData && budgetData.success === false) {
        printWarning(`Budget status unavailable: ${budgetData.error || 'unknown error'}`);
      } else {
        console.log(`Daily:   ${budgetData.daily_used}/${budgetData.daily_limit} posts (rolling 24h)`);
        console.log(`Monthly: ${budgetData.monthly_used}/${budgetData.monthly_limit} posts (rolling 30d)`);
      }

      if (credError) {
        printWarning(`X credential check failed (twitter_verify_credentials via POST ${ep.path}): ${credError}`);
      } else if (credResult) {
        printSuccess(`X credential OK — authenticated as @${credResult.username} (${credResult.name || credResult.id})`);
      }
    });

  // ── x media-root ────────────────────────────────────────────────────────

  x
    .command('media-root')
    .description('Print the X media root directory. Image files for `x post --image` / thread `!image:` lines must live under here, in your org\'s own subdirectory.')
    .action(async () => {
      if (program.opts().output === 'json') {
        formatDetail({ media_root: DEFAULT_MEDIA_ROOT }, { format: 'json' });
        return;
      }
      console.log(DEFAULT_MEDIA_ROOT);
      printInfo(`Place image files under ${DEFAULT_MEDIA_ROOT}/<your-org-id>/... — the server rejects any path that doesn't resolve inside your org's own subdirectory.`);
    });

  // ── x media upload ────────────────────────────────────────────────────────
  // quox#592: an agent/CLI could DRAFT a post with imagePaths but had no
  // governed way to GET the image into the org media root (it lives inside the
  // collector container). This uploads a LOCAL file through the SAME governed
  // endpoint the dashboard Compose UI uses (POST /x/media: entitlement-checked,
  // org-scoped, content-sniffed, size-capped, server writes to the org root),
  // then prints the relative name to pass to `x post --image`.
  const media = x.command('media').description('X media files for post attachments');
  media
    .command('upload <path>')
    .description('Upload a local image/GIF/MP4 into your org\'s X media root (governed: entitlement + org-scoped + content-validated server-side). Prints the relative name for `x post --image`.')
    .action(async (filePath) => {
      auth.requireAuth();
      // fleet #381: node:buffer exports Blob but NOT FormData (that is a
      // global from undici on Node >= 18). Import only Blob; use global FormData.
      const { Blob } = await import('node:buffer');
      const { readFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');

      const content = await readFile(filePath);
      if (!content.length) throw new Error(`refusing to upload an empty file: ${filePath}`);
      const formData = new FormData();
      // The route reads `mediaUpload.single('file')` — the field name is 'file'.
      formData.append('file', new Blob([content]), basename(filePath));

      const ep = resolveEndpoint('x.media.upload');
      const orgId = resolveOrgId(auth, program);
      const data = await client.post(ep.path, {
        service: ep.service,
        body: formData,
        ...(orgId ? { headers: { 'x-org-id': orgId } } : {}),
        timeout: 120000,
      });

      if (program.opts().output === 'json') { formatDetail(data, { format: 'json' }); return; }
      const name = data?.file?.name;
      if (!name) {
        throw new Error(`upload failed: server accepted the request but returned no file name (got: ${JSON.stringify(data).slice(0, 160)})`);
      }
      printSuccess(`Uploaded ${name} (${data.file.content_type}, ${data.file.size} bytes).`);
      printInfo(`Attach it: quox x post "<text>" --image ${name}`);
    });
}
