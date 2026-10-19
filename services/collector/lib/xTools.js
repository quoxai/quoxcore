/**
 * X (Twitter) Agent Tools — X-PLUGIN P2, governed posting.
 *
 * x_post / x_thread / x_delete are the natively-registered write tools that
 * connectors/types/twitter.js's header comment reserves for this file (that
 * connector stays read-only: verify_credentials only). None of these tools
 * ever posts directly — each validates input, checks the durable posting
 * budget (xPostingStore.js), then FILES an HITL Inbox approval card and returns
 * immediately with { success:true, status:'awaiting_approval', inbox_item_id }.
 * The actual X API write only happens once the owner approves, via
 * executeXDecision() below, called from the collector's
 * POST /api/internal/x/approvals/decide handler (server.js) — mirrors the
 * QuoxPlan (quoxplanTools.js pushQuoxplanApproval / quoxplan_request_complete)
 * and Wazuh (server.js pushWazuhApproval) HITL precedent exactly.
 *
 * SECRET HYGIENE HARD RULE: action_params (the approval card payload) carries
 * ONLY draft text/ids/org_id/action/credential_id — NEVER credentials,
 * tokens, or OAuth signatures. credential_id is an opaque vault row id, not a
 * secret. The twitter credential quad is resolved server-side, at execution
 * time, inside executeXDecision — never before, never stored on the inbox
 * item.
 *
 * Budget: xPostingStore.js is the durable, org-scoped ledger (X free-tier
 * caps: 17 posts/24h, 500 posts/30d, see xPostingStore.CONFIG). Filing checks
 * remaining budget but NEVER consumes it. Execution reserves budget
 * atomically via xPostingStore.claimForApproval() before ever calling the X
 * API, and only records the ledger row (the durable "consumed" state) once a
 * publish is confirmed.
 *
 * X-PLUGIN P2 HARDENING (adversarial review, 2026-09-11) — this file fixes:
 *  1. BLOCKER — the mint side now stamps `action` INSIDE action_params (the
 *     auth service's approvalCallback.js dispatcher only ever forwards
 *     action_params, never payload.action, to the decide endpoint).
 *  2. BLOCKER — credential field-name mismatch (snake_case vault fields vs
 *     camelCase buildOAuth1Header params) fixed via mapVaultCredsToOAuth(),
 *     the one place that mapping happens.
 *  3/4. MAJOR — atomic budget reservation + a durable claim row (see
 *     xPostingStore.claimForApproval/appendClaimTweetId/markClaimPosted/
 *     markClaimFailed) closes the TOCTOU budget-overrun gap, doubles as the
 *     replay guard (a second decide for the same inbox_item_id returns the
 *     recorded outcome instead of posting again), and durably records
 *     thread partial progress before a crash can lose it.
 *  5. MAJOR — verifyApprovalAuthenticity() cross-checks the decide body
 *     against the REAL stored inbox item (via the auth service's new
 *     internal single-item GET) before executing: existence, kind, source,
 *     matching action_params fields, and already-resolved status.
 *  6. MAJOR — credential binding: mint time stamps the resolved
 *     credentialId into action_params; decide time re-resolves that EXACT
 *     credential (never a fresh org-default lookup) and refuses if it no
 *     longer exists.
 *  7. MAJOR — 429 handling now reads Retry-After/x-rate-limit-reset honestly
 *     (cap 60s total wait, else fail naming the reset time) instead of
 *     capping at 30s / defaulting absent values to 1s.
 *
 * X-PLUGIN P5 (image attachments, 2026-09-11) — x_post/x_thread accept
 * optional images. Every image path is validated and containment-checked
 * (xPostingStore.resolveOrgMediaPath) at DRAFT time — a bad file refuses the
 * draft, it never surfaces as a late failure at approval. Only the validated
 * path RELATIVE to the org's media root is ever stamped into action_params
 * (never the absolute filesystem path, and never file contents/credentials).
 * On approve, executeXDecision uploads every image first (collecting
 * media_ids) and only then creates the tweet with those media_ids attached;
 * an upload failure marks the claim failed and posts nothing — no
 * text-only fallback, the human approved a post WITH images.
 */

const path = require('node:path');
const xPostingStore = require('./xPostingStore');
const { resolveConnectorCredentials } = require('./connectors/bridge');
const { buildOAuth1Header } = require('./connectors/oauth1.js');
const { uploadImage, validateImageForUpload, validateAltText } = require('./xMediaUpload.js');

const MAX_POST_CHARS = 280;
const MAX_IMAGES_PER_POST = 4;
const TWITTER_API = 'https://api.x.com/2';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// Wired from server.js init (mirrors lib/selfLogStore.js's setDatabase seam):
// initXPostingStore(voltDb) + setDatabase(voltDb) so the ledger survives a
// collector restart, same as every other durable collector table.
let _db = null;
function setDatabase(db) {
  _db = db;
  xPostingStore.initXPostingStore(db);
}
function getDatabase() { return _db; }

// QUOXTRUST C2/WP2 — cross-domain durable-intent handle (the aee.db
// execution_intents table), wired from server.js boot beside setDatabase.
// X is a selfLedgers DOMAIN (xPostingStore claims are the durable, replay-
// protected pre-dispatch gate); these intent rows add the platform-wide
// crash-outcome semantics (outcome_unknown, partial) + the /health and
// WP4-reconciler join that xPostingStore does not carry. Unwired => proceed
// (the domain claim still gates); wired-but-broken => refuse (C2 rule 1).
let _executionLedgerDb = null;
function setExecutionLedgerDb(db) { _executionLedgerDb = db || null; }

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** Validates one post's text. Returns an error string, or null if valid. */
function validatePostText(text) {
  if (typeof text !== 'string' || !text.trim()) return 'text is required and must be non-empty';
  if (text.length > MAX_POST_CHARS) {
    return `text exceeds ${MAX_POST_CHARS} characters (got ${text.length})`;
  }
  return null;
}

/** DRAFT-TIME image validation. Resolves and containment-checks every path
 * (xPostingStore.resolveOrgMediaPath) and re-runs the same type/size check
 * uploadImage will run later, so a bad file refuses the draft rather than
 * failing after the owner has already approved it. `imagePaths` may be
 * undefined/null/empty (no images attached — the common case), in which
 * case this returns an empty image list without touching the filesystem.
 * On success, each returned image carries `relativePath` (org-root-relative,
 * the only form ever safe to persist in an approval card) and `filename`
 * (for the card body). */
function validateAndResolveImages(orgId, imagePaths, imageObjects) {
  if (imageObjects !== undefined && imagePaths !== undefined) return { ok: false, error: 'images is an alternative to image_paths; supply only one' };
  if (imageObjects !== undefined) {
    if (!Array.isArray(imageObjects) || imageObjects.some(img => !img || typeof img !== 'object' || typeof img.path !== 'string')) return { ok: false, error: 'images must be an array of {path, alt_text?} objects' };
    imagePaths = imageObjects.map(img => img.path);
  }
  if (imagePaths === undefined || imagePaths === null) return { ok: true, images: [] };
  if (!Array.isArray(imagePaths)) return { ok: false, error: 'image_paths must be an array of file paths' };
  if (imagePaths.length === 0) return { ok: true, images: [] };
  if (imagePaths.length > MAX_IMAGES_PER_POST) {
    return { ok: false, error: `too many images (${imagePaths.length}); X allows at most ${MAX_IMAGES_PER_POST} per post` };
  }

  // #1080: name EVERY entry that is not in the org's media store, not just the first, so one
  // refusal shows all the typos instead of one per retry.
  let noStore = false;
  const unresolved = imagePaths.filter((p) => {
    const r = xPostingStore.resolveOrgMediaPath(orgId, p);
    if (!r.ok && /^media directory for this org does not exist/.test(r.error || '')) { noStore = true; return true; }
    return !r.ok && /^image file not found/.test(r.error || '');
  }).map(String);
  if (noStore) {
    return { ok: false, unresolved: imagePaths.map(String), error: `this org has no X media store yet, so none of these images resolve: ${imagePaths.join(', ')}. Upload the images first. Nothing was filed.` };
  }
  if (unresolved.length) {
    return { ok: false, unresolved, error: `image file not found in this org's X media store: ${unresolved.join(', ')}. Nothing was filed; correct the name${unresolved.length > 1 ? 's' : ''} and draft again.` };
  }

  const images = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const inputPath = imagePaths[i];
    const resolved = xPostingStore.resolveOrgMediaPath(orgId, inputPath);
    if (!resolved.ok) {
      return { ok: false, error: `image ${i + 1} of ${imagePaths.length} ("${inputPath}"): ${resolved.error}` };
    }
    const validated = validateImageForUpload(resolved.absolutePath);
    if (!validated.ok) {
      return { ok: false, error: `image ${i + 1} of ${imagePaths.length} ("${inputPath}"): ${validated.error}` };
    }
    const altText = imageObjects?.[i]?.alt_text;
    const altError = validateAltText(altText, validated.mimeType);
    if (altError) return { ok: false, error: `image ${i + 1}: ${altError}` };
    if (imagePaths.length > 1 && validated.mediaCategory !== 'tweet_image') return { ok: false, error: 'Attach a single GIF or video alone, or up to 4 still images' };
    images.push({
      ...(altText !== undefined ? { alt_text: altText } : {}),
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      mimeType: validated.mimeType,
      size: validated.size,
      filename: path.basename(resolved.absolutePath),
    });
  }
  return { ok: true, images };
}

// Optional compose data is validated before budget checks or card creation.
const COMPOSE_PROPERTIES = {
  images: { type: 'array', maxItems: 4, description: 'Alternative to image_paths, with optional image/GIF alt text. One GIF or MP4, or up to four still images.', items: { type: 'object', properties: { path: { type: 'string' }, alt_text: { type: 'string', maxLength: 1000 } }, required: ['path'] } },
  quote_tweet_id: { type: 'string', pattern: '^[0-9]{1,19}$', description: 'Tweet id to quote' },
  poll: { type: 'object', properties: { options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 25 } }, duration_minutes: { type: 'integer', minimum: 5, maximum: 10080 } }, required: ['options', 'duration_minutes'] },
  reply_settings: { type: 'string', enum: ['everyone', 'mentionedUsers', 'following'], description: 'Who may reply; everyone is the default' },
};

function validateCompose(input, hasMedia) {
  const params = {};
  if (input.quote_tweet_id !== undefined) {
    if (typeof input.quote_tweet_id !== 'string' || !/^[0-9]{1,19}$/.test(input.quote_tweet_id)) return { ok: false, error: 'quote_tweet_id must be a string of 1-19 digits' };
    params.quote_tweet_id = input.quote_tweet_id;
  }
  if (input.reply_settings !== undefined) {
    if (!['everyone', 'mentionedUsers', 'following'].includes(input.reply_settings)) return { ok: false, error: 'reply_settings must be everyone, mentionedUsers or following' };
    if (input.reply_settings !== 'everyone') params.reply_settings = input.reply_settings;
  }
  if (input.poll !== undefined) {
    const poll = input.poll;
    if (!poll || !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 4) return { ok: false, error: 'poll options must contain 2-4 strings' };
    if (poll.options.some(option => typeof option !== 'string' || !option.trim() || Array.from(option).length > 25)) return { ok: false, error: 'poll options must be non-empty strings of at most 25 characters' };
    if (!Number.isInteger(poll.duration_minutes) || poll.duration_minutes < 5 || poll.duration_minutes > 10080) return { ok: false, error: 'poll duration_minutes must be an integer from 5 to 10080' };
    if (hasMedia) return { ok: false, error: 'poll and media cannot be combined' };
    params.poll = { options: [...poll.options], duration_minutes: poll.duration_minutes };
  }
  return { ok: true, params };
}

function attachmentParams(images, useObjects) {
  if (!images.length) return {};
  return useObjects
    ? { images: images.map(img => ({ path: img.relativePath, ...(img.alt_text !== undefined ? { alt_text: img.alt_text } : {}) })) }
    : { image_paths: images.map(img => img.relativePath) };
}

function composePreview(params) {
  return [
    params.quote_tweet_id ? `Quote tweet: ${params.quote_tweet_id}` : '',
    params.poll ? `Poll (${params.poll.duration_minutes} minutes): ${params.poll.options.join(' / ')}` : '',
    params.reply_settings ? `Who can reply: ${params.reply_settings === 'following' ? 'People you follow' : 'Only people mentioned'}` : '',
  ].filter(Boolean).join('\n');
}

function addComposeToBody(body, params) {
  for (const field of ['quote_tweet_id', 'poll', 'reply_settings']) {
    if (params[field] !== undefined && !(field === 'reply_settings' && params[field] === 'everyone')) body[field] = params[field];
  }
}

/** FINDING 6 (mint side): resolve the org's twitter credential id at draft
 * time so the approval card can be bound to the EXACT credential the owner
 * is approving posting-as. Never fails the mint — an unresolvable credential
 * still files the card (credential_id: null) with an honest note, and
 * decide-time falls back to a fresh org-default resolution for that case
 * (there is nothing to pin). */
async function resolveCredentialIdForMint(orgId) {
  try {
    const resolved = await resolveConnectorCredentials(orgId, 'twitter');
    if (resolved.error) return { credentialId: null, error: resolved.error };
    return { credentialId: resolved.credentialId || null, error: null };
  } catch (err) {
    return { credentialId: null, error: err.message };
  }
}

/** Push an X posting approval card to HITL Inbox. Mirrors pushQuoxplanApproval's
 * shape (lib/quoxplanTools.js) / pushWazuhApproval's shape (server.js
 * ~:10086): POST to the auth service's internal inbox endpoint with the
 * service key, kind='approval', and a payload carrying action +
 * action_params + callback_url the collector's decide endpoint expects, plus
 * custom_actions so the inbox renders "Post"/"Discard" instead of the
 * generic Approve/Deny labels (mapped to the SAME approved/denied action
 * strings isDenyAction() recognises, so the generic respond bridge needs no
 * changes). Returns { ok, itemId, error }. */
async function pushXApproval({ orgId, userId, title, bodyMd, action, actionParams, actingAgentId }) {
  if (!INTERNAL_SERVICE_KEY) {
    console.error('[X HITL] INTERNAL_SERVICE_KEY not set — cannot push inbox approval');
    return { ok: false, itemId: null, error: 'INTERNAL_SERVICE_KEY not configured' };
  }
  const org = orgId || 'system';
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/internal/orgs/${encodeURIComponent(org)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        title,
        body_md: bodyMd,
        kind: 'approval',
        priority: 'normal',
        // quox#638: stamp the filing identity so it can resolve the returned
        // inbox_item_id via `quox inbox get` and see the card in its list. The
        // auth route validates org membership and drops an unknown id to NULL;
        // it never changes who the card is ASSIGNED to (owners/admins).
        created_by_user_id: userId || null,
        payload: {
          source: 'x-plugin',
          what: { action: `X ${String(action || 'post').replace(/^x\./, '').replace(/[._]/g, ' ')}`, target: 'the connected X account', summary: `${String(title || '').replace(/^X:\s*/, '').replace(/\s+/g, ' ').slice(0, 200)} on the connected X account` },
          action,
          // QUOXHAT #657 P-C.5: stamp the ACTING AGENT onto the card so the
          // decide→publish callback can revalidate the hat's authorization for
          // this agent at publish time — a grant/hat change between draft and
          // the owner's tap must deny the publish (an approval of CONTENT is not
          // a re-grant of AUTHORITY).
          action_params: { ...actionParams, acting_agent_id: actingAgentId || actionParams.acting_agent_id || null },
          callback_url: '/api/internal/x/approvals/decide',
          custom_actions: [
            { action: 'approved', label: 'Post', style: 'primary' },
            { action: 'denied', label: 'Discard', style: 'secondary' },
          ],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, itemId: null, error: `Inbox API error ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    const body = await res.json();
    const itemId = body.item?.id || body.id || body.existing_item_id || null;
    return { ok: true, itemId, error: null };
  } catch (err) {
    return { ok: false, itemId: null, error: err.message };
  }
}

const X_TOOLS = {
  x_post: {
    name: 'x_post',
    description: 'Draft a post to X (Twitter). Never posts directly — files an owner approval card (HITL Inbox) and returns immediately with awaiting_approval; the post is only published once the owner approves. Max 280 characters. Optionally reply to an existing tweet. Optionally attach up to 4 still images (5MB each), one GIF (15MB default) or one MP4 (64MB default); every path must resolve inside the org\'s X media root.',
    input_schema: {
      type: 'object',
      properties: {
        ...COMPOSE_PROPERTIES,
        text: { type: 'string', description: 'Post text, max 280 characters' },
        reply_to_tweet_id: { type: 'string', description: 'Optional: id of an existing tweet this post replies to' },
        image_paths: {
          type: 'array',
          description: 'Optional: up to 4 still image paths (5MB each), one GIF (15MB default) or one MP4 (64MB default) to attach. Each path must resolve inside the org\'s X media root.',
          items: { type: 'string' },
        },
      },
      required: ['text'],
    },
    execute: async ({ text, reply_to_tweet_id, image_paths, images: imageObjects, ...compose } = {}, ctx = {}) => {
      // #1080: an argument x_post does not know (image, image_path, media...) used to be dropped
      // silently, so the card was filed image-less with success:true. Refuse it and name the valid ones.
      const unknownArgs = Object.keys(compose).filter((k) => !k.startsWith('_') && !(k in COMPOSE_PROPERTIES));
      if (unknownArgs.length) {
        const valid = ['text', 'reply_to_tweet_id', 'image_paths', ...Object.keys(COMPOSE_PROPERTIES)];
        return { success: false, error: `unknown argument(s) ${unknownArgs.join(', ')} for x_post; valid arguments: ${valid.join(', ')}. Attach media with image_paths (or images with alt_text). Nothing was filed.` };
      }
      const validationError = validatePostText(text);
      if (validationError) return { success: false, error: validationError };

      const orgId = ctx.orgId || null;

      // Fail at draft time, not at approval — a bad image path never becomes
      // a surprise the owner discovers only after approving the post.
      const imageResolution = validateAndResolveImages(orgId, image_paths, imageObjects);
      if (!imageResolution.ok) return { success: false, error: imageResolution.error, ...(imageResolution.unresolved ? { unresolved: imageResolution.unresolved } : {}) };
      const composition = validateCompose(compose, imageResolution.images.length > 0);
      if (!composition.ok) return { success: false, error: composition.error };

      const db = getDatabase();
      const budget = db ? xPostingStore.getBudgetStatus(db, orgId) : null;
      if (budget && budget.dailyRemaining <= 0) {
        return { success: false, error: `Daily X posting budget exhausted (${budget.dailyUsed}/${budget.dailyLimit} in the last 24h). Try again later.` };
      }
      if (budget && budget.monthlyRemaining <= 0) {
        return { success: false, error: `Monthly X posting budget exhausted (${budget.monthlyUsed}/${budget.monthlyLimit} in the last 30 days).` };
      }

      const credResolution = await resolveCredentialIdForMint(orgId);

      const preview = truncate(text, 100);
      const images = imageResolution.images;
      const bodyMd = [
        '**X Post Approval**',
        composePreview(composition.params),
        '',
        `> ${text}`,
        '',
        reply_to_tweet_id ? `Replying to tweet \`${reply_to_tweet_id}\`.` : 'New standalone post.',
        images.length ? `\n**Images (${images.length}):** ${images.map((img) => img.filename).join(', ')}` : '',
        budget ? `\nBudget after posting: ${budget.dailyUsed + 1}/${budget.dailyLimit} today, ${budget.monthlyUsed + 1}/${budget.monthlyLimit} this month.` : '',
        credResolution.error ? `\n⚠ Credential could not be resolved at draft time (${credResolution.error}); it will be re-resolved at approval.` : '',
      ].join('\n');

      const actionParams = {
        action: 'x.post',
        ...composition.params,
        ...attachmentParams(images, imageObjects !== undefined),
        text,
        reply_to_tweet_id: reply_to_tweet_id || null,
        org_id: orgId,
        credential_id: credResolution.credentialId,
        acting_agent_id: ctx.agentId || null, // P-C.5: revalidated at publish time
      };
      // Only ever the org-root-relative path — never the absolute filesystem
      // path — and only stamped in when images were actually attached, so
      // the no-images case keeps the exact action_params shape it always had.


      const approval = await pushXApproval({
        orgId,
        userId: ctx.userId || null,
        title: `X: Post "${preview}"`,
        bodyMd,
        action: 'x.post',
        actionParams,
        actingAgentId: ctx.agentId || null, // P-C.5: revalidated at publish
      });

      if (!approval.ok) return { success: false, error: `Failed to queue approval: ${approval.error}` };

      return {
        success: true,
        status: 'awaiting_approval',
        inbox_item_id: approval.itemId,
        // X-PLUGIN phase 12: the params EXACTLY as they were stamped onto the
        // approval card, so a caller that goes on to schedule this publish
        // schedules provably the same content the card shows, rather than
        // re-deriving it client-side where the two could diverge. Carries
        // nothing credential-shaped: credential_id is an opaque reference and
        // is re-resolved from the vault at publish time.
        action_params: actionParams,
        message: `Post queued for owner approval (inbox item ${approval.itemId}).`,
      };
    },
  },

  x_thread: {
    name: 'x_thread',
    description: 'Draft a thread (sequence of posts, each replying to the last) on X (Twitter). Never posts directly — files an owner approval card and returns awaiting_approval; refuses up front if the thread would exceed the remaining posting budget. Each post max 280 characters. Use `texts` for plain text-only threads, or `posts` (an array of {text, image_paths?}) to attach up to 4 images per post.',
    input_schema: {
      type: 'object',
      properties: {
        texts: {
          type: 'array',
          description: 'Ordered post texts making up the thread, no images (first post standalone, each subsequent post replies to the previous). Use `posts` instead if any post needs image attachments.',
          items: { type: 'string' },
        },
        posts: {
          type: 'array',
          description: 'Alternative to `texts`: ordered posts, each optionally carrying image_paths or images with alt_text (up to 4 still images at 5MB each, one GIF at 15MB or one MP4 at 64MB by default, must resolve inside the org\'s X media root).',
          items: {
            type: 'object',
            properties: {
              ...COMPOSE_PROPERTIES,
              text: { type: 'string' },
              image_paths: { type: 'array', items: { type: 'string' } },
            },
            required: ['text'],
          },
        },
      },
      required: [],
    },
    execute: async ({ texts, posts } = {}, ctx = {}) => {
      let items;
      if (Array.isArray(posts) && posts.length > 0) {
        items = posts.map((p) => p || {});
      } else if (Array.isArray(texts) && texts.length > 0) {
        items = texts.map((t) => ({ text: t, image_paths: [] }));
      } else {
        return { success: false, error: 'texts is required and must be a non-empty array' };
      }

      for (let i = 0; i < items.length; i++) {
        const err = validatePostText(items[i].text);
        if (err) return { success: false, error: `post ${i + 1} of ${items.length}: ${err}` };
      }

      const orgId = ctx.orgId || null;

      // Fail at draft time — resolve/containment-check every post's images
      // before ever checking budget or filing the approval.
      const resolvedItems = [];
      for (let i = 0; i < items.length; i++) {
        const imageResolution = validateAndResolveImages(orgId, items[i].image_paths, items[i].images);
        if (!imageResolution.ok) return { success: false, error: `post ${i + 1} of ${items.length}: ${imageResolution.error}` };
        const composition = validateCompose(items[i], imageResolution.images.length > 0);
        if (!composition.ok) return { success: false, error: `post ${i + 1} of ${items.length}: ${composition.error}` };
        resolvedItems.push({ text: items[i].text, images: imageResolution.images, params: { ...composition.params, ...attachmentParams(imageResolution.images, items[i].images !== undefined) } });
      }

      const db = getDatabase();
      if (db) {
        const budget = xPostingStore.getBudgetStatus(db, orgId);
        const remaining = Math.min(budget.dailyRemaining, budget.monthlyRemaining);
        if (items.length > remaining) {
          return {
            success: false,
            error: `Thread has ${items.length} posts but only ${remaining} remain in the posting budget (daily ${budget.dailyUsed}/${budget.dailyLimit}, monthly ${budget.monthlyUsed}/${budget.monthlyLimit}).`,
          };
        }
      }

      const credResolution = await resolveCredentialIdForMint(orgId);

      const hasAnyImages = resolvedItems.some((it) => Object.keys(it.params).length > 0);
      const preview = truncate(resolvedItems[0].text, 100);
      const bodyMd = [
        '**X Thread Approval**',
        '',
        `${resolvedItems.length} posts:`,
        ...resolvedItems.map((it, i) => {
          const imgSuffix = it.images.length
            ? ` (${it.images.length} image${it.images.length > 1 ? 's' : ''}: ${it.images.map((img) => img.filename).join(', ')})`
            : '';
          return `${i + 1}. ${it.text}${imgSuffix}\n${composePreview(it.params)}`;
        }),
        credResolution.error ? `\n⚠ Credential could not be resolved at draft time (${credResolution.error}); it will be re-resolved at approval.` : '',
      ].join('\n');

      const actionParams = {
        action: 'x.thread',
        org_id: orgId,
        credential_id: credResolution.credentialId,
      };
      // No images anywhere in the thread: keep the original plain `texts`
      // shape exactly (back-compat for every existing consumer/card reader).
      // Any post carrying images: switch to the `posts` shape end to end.
      if (hasAnyImages) {
        // Threads composed purely of texts + image_paths keep the exact
        // pre-slice-A posts shape (image_paths always present, empty when a
        // post has none) so every existing card reader sees what it always
        // saw. Any compose param or the images object form uses the new
        // shape, where absent params are absent keys.
        const legacyShape = items.every((p) => p.images === undefined && p.poll === undefined
          && p.quote_tweet_id === undefined && p.reply_settings === undefined);
        actionParams.posts = legacyShape
          ? resolvedItems.map((it) => ({ text: it.text, image_paths: it.params.image_paths || [] }))
          : resolvedItems.map((it) => ({ text: it.text, ...it.params }));
      } else {
        actionParams.texts = resolvedItems.map((it) => it.text);
      }

      const approval = await pushXApproval({
        orgId,
        userId: ctx.userId || null,
        title: `X: Thread (${resolvedItems.length} posts) "${preview}"`,
        bodyMd,
        action: 'x.thread',
        actionParams,
        actingAgentId: ctx.agentId || null, // P-C.5: revalidated at publish
      });

      if (!approval.ok) return { success: false, error: `Failed to queue approval: ${approval.error}` };

      return {
        success: true,
        status: 'awaiting_approval',
        inbox_item_id: approval.itemId,
        // X-PLUGIN phase 12: see the note on x_post. Returned so a scheduled
        // publish carries provably the same params the card shows.
        action_params: actionParams,
        message: `Thread of ${resolvedItems.length} posts queued for owner approval (inbox item ${approval.itemId}).`,
      };
    },
  },

  x_budget_status: {
    name: 'x_budget_status',
    description: 'Read-only: current X (Twitter) posting budget usage. Never gates or consumes budget — just reports where the org stands against the free-tier caps (17 posts/24h, 500 posts/30d).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (_input = {}, ctx = {}) => {
      const orgId = ctx.orgId || null;
      const db = getDatabase();
      if (!db) return { success: false, error: 'X posting budget store is not initialized' };

      const budget = xPostingStore.getBudgetStatus(db, orgId);
      return {
        success: true,
        daily_used: budget.dailyUsed,
        daily_limit: budget.dailyLimit,
        monthly_used: budget.monthlyUsed,
        monthly_limit: budget.monthlyLimit,
        org_id: orgId,
      };
    },
  },

  x_delete: {
    name: 'x_delete',
    description: 'Delete an existing post on X (Twitter). Never deletes directly — files an owner approval card and returns awaiting_approval; the delete only happens once the owner approves.',
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: { type: 'string', description: 'Id of the tweet to delete' },
      },
      required: ['tweet_id'],
    },
    execute: async ({ tweet_id } = {}, ctx = {}) => {
      if (!tweet_id || !String(tweet_id).trim()) {
        return { success: false, error: 'tweet_id is required' };
      }
      const orgId = ctx.orgId || null;
      const credResolution = await resolveCredentialIdForMint(orgId);

      const approval = await pushXApproval({
        orgId,
        userId: ctx.userId || null,
        title: `X: Delete tweet ${tweet_id}`,
        bodyMd: [
          `Delete request for tweet \`${tweet_id}\`. This cannot be undone once approved.`,
          credResolution.error ? `\n⚠ Credential could not be resolved at draft time (${credResolution.error}); it will be re-resolved at approval.` : '',
        ].join('\n'),
        action: 'x.delete',
        actingAgentId: ctx.agentId || null, // P-C.5: revalidated at publish
        actionParams: {
          action: 'x.delete',
          tweet_id: String(tweet_id),
          org_id: orgId,
          credential_id: credResolution.credentialId,
        },
      });

      if (!approval.ok) return { success: false, error: `Failed to queue approval: ${approval.error}` };

      return {
        success: true,
        status: 'awaiting_approval',
        inbox_item_id: approval.itemId,
        message: `Delete request queued for owner approval (inbox item ${approval.itemId}).`,
      };
    },
  },
};

/* ── Phase 10 slice B: budgeted engagement writes (like / repost) ──────────
 * Same governed shape as every other X write: the tool only ever MINTS an
 * approval card; the action happens at decide time through executeXDecision.
 * Bookmarks are deliberately absent: X's v2 bookmark endpoints accept only
 * OAuth 2.0 user context, which this plugin does not hold until P6.
 * Cost honesty: X's pay-per-use pricing applies; the exact engagement price
 * has not been verified against the live pricing page, so the description
 * states pay-per-use and the daily engagement budget caps the count. */
function makeEngagementTool({ name, action, verb, pastVerb }) {
  return {
    name,
    description: `${verb} a tweet on X (Twitter) as the org's account. Never acts directly — files an owner approval card and returns awaiting_approval; the ${verb.toLowerCase()} only happens once the owner approves. Pay-per-use API pricing applies; capped by the daily engagement budget.`,
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: { type: 'string', pattern: '^[0-9]{1,19}$', description: `Id of the tweet to ${verb.toLowerCase()}` },
      },
      required: ['tweet_id'],
    },
    execute: async ({ tweet_id } = {}, ctx = {}) => {
      if (typeof tweet_id !== 'string' || !/^[0-9]{1,19}$/.test(tweet_id)) {
        return { success: false, error: 'tweet_id must be a string of 1-19 digits' };
      }
      const orgId = ctx.orgId || null;
      const db = getDatabase();

      // The v2 like/repost endpoints are addressed by the ACTING user's id,
      // which is only known after a live verify has stored the org's account
      // identity. Refusing here is honest; failing at publish time would
      // waste the approver's tap.
      const identity = db ? xPostingStore.getAccountIdentity(db, orgId) : null;
      if (!identity?.userId) {
        return { success: false, error: 'No stored X account identity for this org. Run verify_credentials (Health tab or CLI) once so the account identity is known, then retry.' };
      }

      // Advisory pre-check; claimForApproval re-enforces inside its
      // transaction at decide time.
      if (db) {
        const engagement = xPostingStore.getEngagementBudgetStatus(db, orgId);
        if (engagement.remaining <= 0) {
          return { success: false, error: `Daily X engagement budget exhausted (${engagement.used}/${engagement.limit}). It frees as actions age past 24h.` };
        }
      }

      const credResolution = await resolveCredentialIdForMint(orgId);
      const approval = await pushXApproval({
        orgId,
        userId: ctx.userId || null,
        title: `X: ${verb} tweet ${tweet_id}`,
        bodyMd: [
          `${verb} request for tweet \`${tweet_id}\` as @${identity.username || 'the org account'}.`,
          credResolution.error ? `\n⚠ Credential could not be resolved at draft time (${credResolution.error}); it will be re-resolved at approval.` : '',
        ].join('\n'),
        action,
        actingAgentId: ctx.agentId || null, // P-C.5: revalidated at publish
        actionParams: {
          action,
          tweet_id,
          org_id: orgId,
          credential_id: credResolution.credentialId,
        },
      });
      if (!approval.ok) return { success: false, error: `Failed to queue approval: ${approval.error}` };
      return {
        success: true,
        status: 'awaiting_approval',
        inbox_item_id: approval.itemId,
        message: `${verb} request queued for owner approval (inbox item ${approval.itemId}). Once approved it will be ${pastVerb}.`,
      };
    },
  };
}

X_TOOLS.x_like = makeEngagementTool({ name: 'x_like', action: 'x.like', verb: 'Like', pastVerb: 'liked' });
X_TOOLS.x_repost = makeEngagementTool({ name: 'x_repost', action: 'x.repost', verb: 'Repost', pastVerb: 'reposted' });

// ── Decide-time execution (approved side only — deny never reaches here) ──

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FINDING 2 fix (BLOCKER): the vault/bridge layer hands back a snake_case
 * credential quad (api_key/api_secret/access_token/access_secret — the same
 * shape CONNECTOR_REGISTRY.twitter.requiredFields uses), but
 * buildOAuth1Header (connectors/oauth1.js) destructures camelCase
 * {apiKey, apiSecret, accessToken, accessSecret}. Passing the raw vault
 * object straight through silently produced
 * oauth_consumer_key="undefined" and a signing key of "undefined&undefined"
 * — a request that LOOKS signed but authenticates as nobody. This is the
 * ONE place that mapping happens, for both credential-resolution paths
 * (by-id and org-default) below. */
function mapVaultCredsToOAuth(vaultCreds = {}) {
  return {
    apiKey: vaultCreds.api_key,
    apiSecret: vaultCreds.api_secret,
    accessToken: vaultCreds.access_token,
    accessSecret: vaultCreds.access_secret,
  };
}

/** FINDING 6 (decide side): resolve a specific credential by its vault id —
 * the exact credential that was bound at mint time — via the auth service's
 * existing resolve-by-id endpoint (the same one connectors/bridge.js uses
 * for multi-field connectors). Returns the raw (snake_case) credential
 * fields; callers map via mapVaultCredsToOAuth. */
async function resolveCredentialById(credentialId, orgId) {
  if (!INTERNAL_SERVICE_KEY) {
    return { error: 'INTERNAL_SERVICE_KEY not configured — cannot resolve credential by id' };
  }
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/setup/internal/resolve-by-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ credential_id: credentialId, org_id: orgId || null }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { error: `credential ${credentialId} could not be resolved (resolve-by-id returned ${res.status})` };
    }
    const data = await res.json();
    return { credentials: data.fields || {} };
  } catch (err) {
    return { error: err.message };
  }
}

/** Resolve the credentials to sign with for a decide-time execution.
 * FINDING 6: if the card was bound to a specific credential_id at mint time,
 * re-resolve that EXACT credential — never a fresh org-default lookup — and
 * refuse if it no longer exists (rotated/deleted since approval). Only when
 * mint-time resolution itself failed (credential_id is null, nothing to
 * pin) does this fall back to a fresh org-default resolution, same as the
 * pre-hardening behaviour. Always returns camelCase, oauth1-ready
 * credentials via mapVaultCredsToOAuth (FINDING 2). */
async function resolveExecutionCredentials(orgId, credentialId) {
  if (credentialId) {
    const byId = await resolveCredentialById(credentialId, orgId);
    if (byId.error) {
      return { error: `credential changed since approval, re-approve (${byId.error})` };
    }
    return { credentials: mapVaultCredsToOAuth(byId.credentials) };
  }
  const resolved = await resolveConnectorCredentials(orgId, 'twitter');
  if (resolved.error) return { error: resolved.error };
  return { credentials: mapVaultCredsToOAuth(resolved.credentials) };
}

/** FINDING 7: honest 429 handling. Reads Retry-After (seconds) and
 * x-rate-limit-reset (epoch seconds) — whichever gives a usable wait — and:
 *   - wait <= 60s: sleep, then retry ONCE (fresh nonce/timestamp per attempt
 *     — see xFetchWithRetry below).
 *   - wait > 60s, or neither header present/parseable: refuse honestly,
 *     naming the reset time, rather than sleeping past a sane request
 *     lifetime or guessing a default. Never sleeps more than 60s total.
 * @returns {{ shouldRetry: boolean, waitMs: number, message: string|null }}
 */
function compute429Wait(resp) {
  const getHeader = (name) => (resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get(name) : null);
  const retryAfterRaw = getHeader('retry-after');
  const resetRaw = getHeader('x-rate-limit-reset');

  let waitSeconds = null;
  let resetDate = null;

  if (retryAfterRaw !== null && retryAfterRaw !== undefined && retryAfterRaw !== '') {
    const n = Number(retryAfterRaw);
    if (Number.isFinite(n) && n >= 0) waitSeconds = n;
  }
  if (waitSeconds === null && resetRaw !== null && resetRaw !== undefined && resetRaw !== '') {
    const epochSeconds = Number(resetRaw);
    if (Number.isFinite(epochSeconds)) {
      resetDate = new Date(epochSeconds * 1000);
      waitSeconds = Math.max(0, epochSeconds - Math.floor(Date.now() / 1000));
    }
  }

  if (waitSeconds === null) {
    return { shouldRetry: false, waitMs: 0, message: 'X API rate limited (429) with no usable Retry-After or x-rate-limit-reset header — refusing rather than guessing a wait.' };
  }
  if (waitSeconds > 60) {
    const resetLabel = resetDate ? resetDate.toISOString() : `${waitSeconds}s from now`;
    return { shouldRetry: false, waitMs: 0, message: `X API rate limited (429); reset is not until ${resetLabel}, which exceeds the 60s retry cap — refusing rather than blocking this long.` };
  }
  return { shouldRetry: true, waitMs: waitSeconds * 1000, message: null };
}

/** One signed X API request, with exactly one 429 retry (fresh OAuth1 nonce
 * on the retry — a reused nonce/timestamp is itself a real reason X could
 * reject the retry, so the header is rebuilt per attempt, never cached).
 * `credentials` here is ALWAYS the camelCase oauth1 shape — callers must
 * have already run mapVaultCredsToOAuth (see resolveExecutionCredentials). */
async function xFetchWithRetry(url, method, credentials, jsonBody, sleep = defaultSleep) {
  const attempt = async () => {
    const authHeader = buildOAuth1Header({ method, url }, credentials);
    return fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  };

  let resp = await attempt();
  if (resp.status === 429) {
    const { shouldRetry, waitMs, message } = compute429Wait(resp);
    if (!shouldRetry) {
      throw new Error(message);
    }
    await sleep(waitMs);
    resp = await attempt(); // ONE retry only — whatever happens next is surfaced honestly.
  }
  return resp;
}

async function safeErrorBody(resp) {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** FINDING 3/4: turn a claim row already marked 'posted' back into the same
 * result shape executeXDecision would have returned the first time — the
 * replay guard's job is to make a second decide for an already-decided item
 * a no-op that still answers honestly, never a second X API call. */
function replayOutcomeFromClaim(claim, action, actionParams) {
  if (!claim) {
    return { success: false, error: 'This approval was already decided but its execution record could not be found.' };
  }
  if (claim.status === 'pending') {
    return { success: false, error: 'This approval is already being executed; try again shortly.' };
  }
  if (claim.status === 'failed') {
    return { success: false, error: claim.error || 'This approval already failed on a previous attempt and was not retried.' };
  }
  // status === 'posted'
  if (action === 'x.thread') {
    return { success: true, action: 'x.thread', tweet_ids: claim.tweet_ids, posted: claim.tweet_ids.length };
  }
  if (action === 'x.delete') {
    return { success: true, action: 'x.delete', deleted: true, tweet_id: claim.tweet_ids[0] || actionParams?.tweet_id || null };
  }
  if (action === 'x.like' || action === 'x.repost') {
    return { success: true, action, tweet_id: claim.tweet_ids[0] || actionParams?.tweet_id || null };
  }
  return { success: true, action: 'x.post', tweet_id: claim.tweet_ids[0] || null, posted: 1 };
}

/** Re-resolve every image path (already validated at draft time, but the
 * file on disk can change between a draft and a much-later approval, hence
 * the re-check here) and upload each one, in order, collecting media_ids.
 * On the FIRST failure, stops immediately and returns an error naming which
 * image failed and why — the caller must post nothing on this branch, no
 * partial text-only fallback, the human approved a post WITH images. */
async function uploadImagesForPost(orgId, credentials, imagePaths, imageObjects) {
  const checked = validateAndResolveImages(orgId, imagePaths, imageObjects);
  if (!checked.ok) return { ok: false, error: `${checked.error} (could not be resolved at publish time)` };
  imagePaths = checked.images.map(img => img.relativePath);
  const mediaIds = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const relPath = imagePaths[i];
    const resolved = xPostingStore.resolveOrgMediaPath(orgId, relPath);
    if (!resolved.ok) {
      return { ok: false, error: `image ${i + 1} of ${imagePaths.length} ("${relPath}") could not be resolved: ${resolved.error}` };
    }
    const uploadResult = await uploadImage(credentials, { imagePath: resolved.absolutePath, alt_text: checked.images[i].alt_text });
    if (!uploadResult.ok) {
      return { ok: false, error: `image ${i + 1} of ${imagePaths.length} ("${relPath}") failed to upload: ${uploadResult.error}` };
    }
    mediaIds.push(uploadResult.mediaId);
  }
  return { ok: true, mediaIds };
}

/**
 * Execute the deferred X API write for an approved x.post / x.thread /
 * x.delete action. Resolves the twitter credential quad server-side (never
 * before this point), signs each request fresh, and — ONLY on a confirmed
 * successful publish — records the post in the durable budget ledger.
 *
 * FINDING 3/4: reserves budget atomically (xPostingStore.claimForApproval)
 * BEFORE calling the X API, keyed by inboxItemId — the replay guard AND the
 * durable publish-intent record. A second call for the same inboxItemId
 * never reaches the X API; it returns the claim's recorded outcome.
 *
 * @param {{action: string, actionParams: object, orgId: string, inboxItemId: string}} params
 * @param {{sleep?: Function}} [opts] injectable sleep for deterministic tests
 * @returns {Promise<object>} { success, ... } — never throws; caller (the
 *   decide handler) wraps this in its own try/catch as defense-in-depth, but
 *   every expected failure path here already returns { success: false, error }.
 */
async function executeXDecision({ action, actionParams, orgId, inboxItemId }, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const db = getDatabase();

  if (!inboxItemId) {
    return { success: false, error: 'inbox_item_id is required to execute an X decision' };
  }

  const postsNeeded = action === 'x.thread'
    ? (Array.isArray(actionParams.posts)
      ? actionParams.posts.length
      : (Array.isArray(actionParams.texts) ? actionParams.texts.length : 0))
    : (action === 'x.post' ? 1 : 0); // x.delete reserves no posting budget

  // X-PLUGIN phase 12: the scheduled-publish path already took the claim when
  // the human approved (the whole point of pre-authorising is that the slot is
  // reserved from that moment). It passes claimHeld so this does not try to
  // claim a second time and then mistake its OWN row for a replay, which would
  // silently never publish. Everything after this block is identical for both
  // paths on purpose: credential binding, image upload, 429 handling, the
  // ledger write and the evidence are the same code, not a parallel copy.
  if (db && !opts.claimHeld) {
    // X-PLUGIN phase 11: stamp a short preview and the approver onto the claim
    // so the Activity tab can say WHAT was posted and WHO initiated it. The
    // full text lives in the inbox card on the auth service; this ledger keeps
    // a preview only, deliberately, since it is a budget record and not a
    // content store. Never carries anything credential-shaped.
    const claimResult = xPostingStore.claimForApproval(db, {
      orgId,
      inboxItemId,
      action,
      postsNeeded,
      textPreview: xPostingStore.buildTextPreview(actionParams),
      author: opts.approver || actionParams.approver || null,
    });
    if (claimResult.replay) {
      return replayOutcomeFromClaim(claimResult.claim, action, actionParams);
    }
    if (!claimResult.claimed) {
      return { success: false, error: claimResult.error };
    }
  }

  const credResolution = await resolveExecutionCredentials(orgId, actionParams.credential_id || null);
  if (credResolution.error) {
    if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, credResolution.error);
    return { success: false, error: credResolution.error };
  }
  const credentials = credResolution.credentials;

  // QUOXTRUST C2/WP2 — cross-domain intent: claim + dispatch stamp before the
  // first outward call (media upload / tweet POST follows immediately).
  const _ledger = require('./executionLedger');
  let _intentId = null;
  if (_executionLedgerDb) {
    try {
      const { buildCanonicalAction, actionEvidenceCommitment } = require('./canonicalAction');
      const _toolName = String(action || 'x.unknown').replace(/\./g, '_');
      const _canonicalAction = buildCanonicalAction(_toolName, actionParams || {}, { orgId });
      _intentId = _ledger.claim(_executionLedgerDb, {
        orgId,
        tool: _toolName,
        actionDigest: _canonicalAction.effect_id,
        corr: inboxItemId,
      });
      _ledger.markDispatched(_executionLedgerDb, _intentId);
      // WP4.2: this cross-domain path runs its own claim/resolve outside the
      // choke, so it never got the choke's WP4.1b obligation write — invisible
      // to the reconciler's completeness join on intent_id. Mirror it here,
      // best-effort (a missing obligation degrades to the reconciler's
      // completeness check; it must never block a decision already claimed).
      try {
        _ledger.recordObligation(_executionLedgerDb, _intentId, {
          orgId,
          tool: _toolName,
          corr: inboxItemId,
          ctx: { orgId, evidenceSource: 'x_decide' },
          actionCommit: actionEvidenceCommitment(_canonicalAction),
        });
      } catch (obErr) {
        console.warn(`[xTools] WP4.2 obligation record failed for ${_toolName} (${_intentId}): ${obErr.message}`);
      }
    } catch (e) {
      if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, `execution_ledger_unavailable: ${e.message}`);
      return { success: false, error: `execution_ledger_unavailable: durable intent claim failed: ${e.message}` };
    }
  }

  const _result = await (async () => {
  try {
    if (action === 'x.post') {
      let mediaIds = [];
      if (actionParams.image_paths?.length || actionParams.images?.length) {
        const uploadResult = await uploadImagesForPost(orgId, credentials, actionParams.image_paths, actionParams.images);
        if (!uploadResult.ok) {
          if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, uploadResult.error);
          return { success: false, error: uploadResult.error };
        }
        mediaIds = uploadResult.mediaIds;
      }

      const body = actionParams.reply_to_tweet_id
        ? { text: actionParams.text, reply: { in_reply_to_tweet_id: actionParams.reply_to_tweet_id } }
        : { text: actionParams.text };
      addComposeToBody(body, actionParams);
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      const resp = await xFetchWithRetry(`${TWITTER_API}/tweets`, 'POST', credentials, body, sleep);
      if (!resp.ok) {
        const error = `X API ${resp.status}: ${await safeErrorBody(resp)}`;
        if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
        return { success: false, error };
      }
      const data = await resp.json();
      const tweetId = data?.data?.id || null;
      if (db) {
        xPostingStore.recordPost(db, { orgId, tweetId, kind: 'post' });
        xPostingStore.appendClaimTweetId(db, orgId, inboxItemId, tweetId);
        xPostingStore.markClaimPosted(db, orgId, inboxItemId);
      }
      return { success: true, action: 'x.post', tweet_id: tweetId, posted: 1 };
    }

    if (action === 'x.thread') {
      // `posts` (X-PLUGIN P5, per-post images) and plain `texts` (back-compat,
      // no images anywhere) are normalised to the same shape here so the
      // publish loop below never branches on which one minted the card.
      const items = Array.isArray(actionParams.posts)
        ? actionParams.posts
        : actionParams.texts.map((text) => ({ text, image_paths: [] }));

      const posted = [];
      let replyTo = null;
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];

        let mediaIds = [];
        if (item.image_paths?.length || item.images?.length) {
          const uploadResult = await uploadImagesForPost(orgId, credentials, item.image_paths, item.images);
          if (!uploadResult.ok) {
            const error = `post ${idx + 1} of ${items.length}: ${uploadResult.error}`;
            if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
            return { success: false, error, posted_tweet_ids: posted };
          }
          mediaIds = uploadResult.mediaIds;
        }

        const body = replyTo ? { text: item.text, reply: { in_reply_to_tweet_id: replyTo } } : { text: item.text };
        addComposeToBody(body, item);
        if (mediaIds.length) body.media = { media_ids: mediaIds };
        const resp = await xFetchWithRetry(`${TWITTER_API}/tweets`, 'POST', credentials, body, sleep);
        if (!resp.ok) {
          const error = `X API ${resp.status} on post ${posted.length + 1} of ${items.length}: ${await safeErrorBody(resp)}`;
          if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
          return { success: false, error, posted_tweet_ids: posted };
        }
        const data = await resp.json();
        const tweetId = data?.data?.id || null;
        if (db) {
          xPostingStore.recordPost(db, { orgId, tweetId, kind: 'thread_post' });
          xPostingStore.appendClaimTweetId(db, orgId, inboxItemId, tweetId);
        }
        posted.push(tweetId);
        replyTo = tweetId;
      }
      if (db) xPostingStore.markClaimPosted(db, orgId, inboxItemId);
      return { success: true, action: 'x.thread', tweet_ids: posted, posted: posted.length };
    }

    if (action === 'x.delete') {
      const url = `${TWITTER_API}/tweets/${encodeURIComponent(actionParams.tweet_id)}`;
      const resp = await xFetchWithRetry(url, 'DELETE', credentials, undefined, sleep);
      if (!resp.ok) {
        const error = `X API ${resp.status}: ${await safeErrorBody(resp)}`;
        if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
        return { success: false, error };
      }
      if (db) {
        xPostingStore.appendClaimTweetId(db, orgId, inboxItemId, actionParams.tweet_id);
        xPostingStore.markClaimPosted(db, orgId, inboxItemId);
      }
      return { success: true, action: 'x.delete', deleted: true, tweet_id: actionParams.tweet_id };
    }

    if (action === 'x.like' || action === 'x.repost') {
      const identity = db ? xPostingStore.getAccountIdentity(db, orgId) : null;
      if (!identity?.userId) {
        const error = 'No stored X account identity for this org; cannot address the like/repost endpoint. Run verify_credentials once, then re-approve.';
        if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
        return { success: false, error };
      }
      const endpoint = action === 'x.like' ? 'likes' : 'retweets';
      const url = `${TWITTER_API}/users/${encodeURIComponent(identity.userId)}/${endpoint}`;
      const resp = await xFetchWithRetry(url, 'POST', credentials, { tweet_id: actionParams.tweet_id }, sleep);
      if (!resp.ok) {
        const error = `X API ${resp.status}: ${await safeErrorBody(resp)}`;
        if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
        return { success: false, error };
      }
      if (db) {
        xPostingStore.appendClaimTweetId(db, orgId, inboxItemId, actionParams.tweet_id);
        xPostingStore.markClaimPosted(db, orgId, inboxItemId);
      }
      return { success: true, action, tweet_id: actionParams.tweet_id };
    }

    const error = `Unknown X action: ${action}`;
    if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, error);
    return { success: false, error };
  } catch (err) {
    if (db) xPostingStore.markClaimFailed(db, orgId, inboxItemId, err.message);
    // NOTE (C2/M7): the domain claim says 'failed' here, but a THROW after the
    // dispatch stamp may have landed posts — the cross-domain intent below
    // settles outcome_unknown, never a blind-retry-inviting 'failed'.
    return { success: false, error: err.message, _threw: true };
  }
  })();

  // QUOXTRUST C2 — settle the cross-domain intent on every exit.
  if (_intentId && _executionLedgerDb) {
    try {
      if (_result && _result._threw) {
        _ledger.resolveThrow(_executionLedgerDb, _intentId, _result.error);
      } else if (_result && _result.success === false && Array.isArray(_result.posted_tweet_ids) && _result.posted_tweet_ids.length > 0) {
        _ledger.resolvePartial(_executionLedgerDb, _intentId, `${_result.posted_tweet_ids.length} posted before failure: ${_result.error}`);
      } else {
        const _ok = _result?.success === true;
        _ledger.resolve(_executionLedgerDb, _intentId, _ok, _ok ? null : new Error(String(_result?.error || 'x decision failed')));
        // WP4.2: settle the obligation on the SAME confirmed exit; no envelope
        // id captured at this site (the reconciler handles delivered-without-
        // envelope-id).
        if (_ok) { try { _ledger.markObligationDelivered(_executionLedgerDb, _intentId, null); } catch { /* stays owed; boot re-emit surfaces it */ } }
      }
    } catch { /* reconcileOnBoot surfaces unsettled intents */ }
  }
  if (_result && _result._threw) delete _result._threw;
  return _result;
}

/** FINDING 5: verify the decide body against the REAL stored inbox item
 * before executing anything. Fetches the item by id from the auth service
 * (the new internal single-item GET — auth/routes/inbox.js) and confirms:
 * it exists, it is kind='approval', its payload.source is 'x-plugin', the
 * card's OWN action_params match the fields the decide body carries (so a
 * service-key holder cannot substitute different text/tweet_id at decide
 * time), and the item has already been decided (status is no longer
 * open/in_progress/waiting — inbox.js's /respond route resolves the item
 * BEFORE dispatching the callback, so a genuine approval is always already
 * 'resolved' by the time this runs). Refuses with a specific, honest error
 * otherwise — never falls through to executing on an unverifiable claim. */
async function verifyApprovalAuthenticity({ orgId, inboxItemId, xAction, actionParams }) {
  if (!INTERNAL_SERVICE_KEY) {
    return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured — cannot verify approval authenticity' };
  }
  if (!inboxItemId) {
    return { ok: false, error: 'inbox_item_id is required to verify approval authenticity' };
  }

  let res;
  try {
    res = await fetch(`${AUTH_SERVICE_URL}/api/internal/orgs/${encodeURIComponent(orgId || 'system')}/inbox/items/${encodeURIComponent(inboxItemId)}`, {
      headers: { 'x-service-key': INTERNAL_SERVICE_KEY },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, error: `Could not verify approval: ${err.message}` };
  }
  if (res.status === 404) {
    return { ok: false, error: 'Approval refused: inbox item not found' };
  }
  if (!res.ok) {
    return { ok: false, error: `Could not verify approval: inbox lookup returned ${res.status}` };
  }

  const body = await res.json().catch(() => null);
  const item = body && body.item;
  if (!item) {
    return { ok: false, error: 'Approval refused: inbox item not found' };
  }
  if (item.kind !== 'approval') {
    return { ok: false, error: 'Approval refused: inbox item is not an approval card' };
  }
  const cardPayload = item.payload || {};
  if (cardPayload.source !== 'x-plugin') {
    return { ok: false, error: 'Approval refused: inbox item was not filed by the X plugin' };
  }
  if (item.status !== 'resolved') {
    return { ok: false, error: `Approval refused: inbox item is not yet decided (status=${item.status})` };
  }

  // Quoxify audit 2026-09-12 (security): 'resolved' says a decision exists,
  // not WHICH decision. Without this check a service-key caller could re-POST
  // action:'approve' against a DENIED card and publish. The recorded decision
  // comes back in response_json via the internal GET. Deliberately stricter
  // than auth's isDenyAction (which treats not-deny as approve): executing a
  // publish requires an explicitly approve-shaped recorded action.
  const APPROVE_ACTIONS = new Set(['approve', 'approved', 'grant', 'granted']);
  const recordedAction = typeof item.response?.action === 'string'
    ? item.response.action.trim().toLowerCase()
    : null;
  if (!recordedAction) {
    return { ok: false, error: 'Approval refused: resolved item carries no recorded decision' };
  }
  if (!APPROVE_ACTIONS.has(recordedAction)) {
    return { ok: false, error: `Approval refused: the recorded decision was "${recordedAction}", not an approval` };
  }

  const cardParams = cardPayload.action_params || {};
  // X-PLUGIN P5: 'posts'/'image_paths' are compared too, alongside the
  // pre-existing text fields — otherwise a forged decide body could swap in
  // a different image set (or switch texts<->posts shape entirely) while
  // still matching on text alone, and this check would silently pass.
  const fieldsToCompare = xAction === 'x.delete' || xAction === 'x.like' || xAction === 'x.repost'
    ? ['tweet_id']
    : xAction === 'x.thread'
      ? ['texts', 'posts']
      : ['text', 'reply_to_tweet_id', 'image_paths', 'images', 'poll', 'quote_tweet_id', 'reply_settings'];
  for (const field of fieldsToCompare) {
    const cardVal = JSON.stringify(cardParams[field] ?? null);
    const bodyVal = JSON.stringify((actionParams || {})[field] ?? null);
    if (cardVal !== bodyVal) {
      return { ok: false, error: `Approval refused: ${field} does not match the approved card` };
    }
  }

  return { ok: true, item };
}

/**
 * Handle the full POST /api/internal/x/approvals/decide body. Extracted out
 * of server.js (unlike the Wazuh/QuoxPlan decide handlers, which keep this
 * logic inline in server.js) so it is directly unit-testable without
 * spinning up the full collector app via supertest — server.js has no
 * exported `app` and heavy side effects at require time, and no existing
 * decide handler is unit tested for that reason. The AEE emitter is injected
 * (mirrors lib/selfLogStore.js's setEnvelopeEmitter seam) so tests can assert
 * on emitted envelopes without needing the real storeAuditEnvelope/aeeDb.
 *
 * Mirrors the Wazuh (server.js ~:10931) / QuoxPlan (server.js ~:13072)
 * decide handlers' shape verbatim: AEE decision envelope unconditionally,
 * deny short-circuits, approve verifies authenticity (FINDING 5) then
 * executes and emits an outcome envelope.
 *
 * @returns {Promise<{status: number, body: object}>} caller does res.status(status).json(body)
 */
/**
 * QUOXHAT #657 P-C.5 — default hat revalidation for the X publish callback.
 * Re-runs the P-B authorization predicate (the acting agent's CURRENT grant
 * ceiling ∩ the current hat's mode) for the x_<verb> tool at PUBLISH time, so a
 * grant revocation or hat tightening between draft and the owner's tap denies
 * the publish. Mirrors the executeTool gate / resume revalidation; integrates
 * the SAME reference-monitor pieces (resolveHatForTurn + buildTurnManifest), no
 * competing system. Fail-closed for a known-enforcing org when resolve fails;
 * allow (legacy) for preview/unknown orgs so non-enforcing orgs are unchanged.
 */
async function defaultRevalidateHatForPublish({ orgId, agentId, toolName }) {
  const { resolveHatForTurn, buildTurnManifest, lastKnownEnforcement } = require('./hatManifest');
  const failClosedIfEnforcing = () =>
    lastKnownEnforcement(orgId) === 'enforce'
      ? { authorized: false, reason: 'hat_resolve_failed' }
      : { authorized: true, reason: 'not_enforcing' };
  let hatTurn;
  try {
    hatTurn = await resolveHatForTurn({ orgId, agent: agentId || null });
  } catch {
    return failClosedIfEnforcing();
  }
  if (!hatTurn) return failClosedIfEnforcing();
  if (hatTurn.enforcement !== 'enforce' || !hatTurn.hat) return { authorized: true, reason: 'not_enforcing' };
  const { getToolsWithConnectors } = require('./agentTools');
  const grant = await getToolsWithConnectors(agentId || 'quox', orgId);
  const manifest = buildTurnManifest({ agentTools: grant, hat: hatTurn.hat, loadedBundles: hatTurn.binding?.loaded_bundles || [], agent: agentId || 'quox' });
  if (!manifest) return { authorized: true, reason: 'no_hat_opinion' };
  return {
    authorized: manifest.authzToolNames.has(toolName),
    reason: manifest.grantToolNames.has(toolName) ? 'mode_forbidden' : 'not_granted',
  };
}

async function handleApprovalDecide(reqBody, { emitEnvelope, revalidateHatAuthorization, verifyAuthenticity, executeDecision } = {}) {
  const emit = typeof emitEnvelope === 'function' ? emitEnvelope : () => {};
  const revalidateHat = typeof revalidateHatAuthorization === 'function' ? revalidateHatAuthorization : defaultRevalidateHatForPublish;
  const verifyAuth = typeof verifyAuthenticity === 'function' ? verifyAuthenticity : verifyApprovalAuthenticity;
  const runDecision = typeof executeDecision === 'function' ? executeDecision : executeXDecision;
  const { inbox_item_id, action, approver, reason, action_params } = reqBody || {};

  if (!action || !['approve', 'deny'].includes(action)) {
    return { status: 400, body: { error: 'action must be "approve" or "deny"' } };
  }
  if (!action_params || !action_params.action) {
    return { status: 400, body: { error: 'action_params.action is required' } };
  }

  const xAction = action_params.action;
  const verb = xAction.startsWith('x.') ? xAction.slice(2) : xAction;
  const corrId = action_params.corr || `X_DECIDE_${Date.now()}`;
  const orgId = action_params.org_id || 'system';

  // Unconditional decision envelope — mirrors Wazuh/QuoxPlan (both branches land here).
  emit({
    type: 'event',
    from: approver ? `human.${approver}` : 'system.inbox',
    to: 'agent.xtwitter',
    intent: action === 'approve' ? `quox.channel.x.${verb}.approved` : `quox.channel.x.${verb}.denied`,
    corr: corrId,
    org_id: orgId,
    payload: { inbox_item_id, approver, reason, org_id: orgId },
  });

  if (action === 'deny') {
    return { status: 200, body: { denied: true, inbox_item_id } };
  }

  // FINDING 5: verify the decide body against the real stored inbox item
  // BEFORE executing anything — a valid service key alone is not proof this
  // approval was ever actually decided by a human.
  const authenticity = await verifyAuth({ orgId, inboxItemId: inbox_item_id, xAction, actionParams: action_params });
  if (!authenticity.ok) {
    emit({
      type: 'error',
      from: 'system.collector',
      to: 'agent.xtwitter',
      intent: `quox.channel.x.${verb}.failed`,
      corr: corrId,
      org_id: orgId,
      payload: { error: authenticity.error, org_id: orgId, inbox_item_id },
    });
    return { status: 403, body: { error: authenticity.error } };
  }

  // QUOXHAT #657 P-C.5: revalidate the hat at PUBLISH time. The owner approving
  // the CONTENT is not a re-grant of AUTHORITY — if the acting agent's grant was
  // revoked or the hat tightened between draft and tap, deny the publish. Keyed
  // on the acting agent stamped onto the card at draft time (falls back to the
  // orchestrator 'quox' for pre-P-C.5 cards, which is how the x CLI drafts).
  {
    const actingAgent = action_params.acting_agent_id || 'quox';
    const toolForAction = `x_${verb}`; // x.post→x_post, x.thread→x_thread, …
    let reval;
    try {
      reval = await revalidateHat({ orgId, agentId: actingAgent, toolName: toolForAction });
    } catch (revalErr) {
      reval = { authorized: false, reason: `revalidation_error:${revalErr?.message}` };
    }
    if (!reval?.authorized) {
      emit({
        type: 'error',
        from: 'system.collector',
        to: 'agent.xtwitter',
        intent: `quox.channel.x.${verb}.failed`,
        corr: corrId,
        org_id: orgId,
        payload: { error: `hat_denied (${reval?.reason || 'unauthorized'}): acting agent '${actingAgent}' not authorized for ${toolForAction} under the current hat`, org_id: orgId, inbox_item_id, hatDenied: true },
      });
      return { status: 403, body: { error: `Publish refused: the current hat no longer authorizes ${toolForAction} for '${actingAgent}'`, hatDenied: true, reason: reval?.reason || 'unauthorized' } };
    }
  }

  try {
    // `approver` is the human the auth service says tapped Post. Passed through
    // so the Activity tab's author column names who initiated the publish.
    const result = await runDecision(
      { action: xAction, actionParams: action_params, orgId, inboxItemId: inbox_item_id, corrId },
      { approver }
    );

    emit({
      type: result.success ? 'event' : 'error',
      from: 'system.collector',
      to: 'agent.xtwitter',
      intent: result.success ? `quox.channel.x.${verb}.outbound` : `quox.channel.x.${verb}.failed`,
      corr: corrId,
      org_id: orgId,
      payload: { ...result, org_id: orgId, inbox_item_id },
    });

    if (!result.success) {
      return { status: 502, body: { error: result.error } };
    }
    return { status: 200, body: { executed: true, result } };
  } catch (err) {
    emit({
      type: 'error',
      from: 'system.collector',
      to: 'agent.xtwitter',
      intent: `quox.channel.x.${verb}.failed`,
      corr: corrId,
      org_id: orgId,
      payload: { error: err.message, org_id: orgId, inbox_item_id },
    });
    return { status: 500, body: { error: err.message } };
  }
}

module.exports = {
  X_TOOLS,
  setDatabase,
  setExecutionLedgerDb,
  getDatabase,
  pushXApproval,
  validatePostText,
  executeXDecision,
  handleApprovalDecide,
  mapVaultCredsToOAuth,
  compute429Wait,
};
