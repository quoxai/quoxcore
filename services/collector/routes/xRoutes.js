/**
 * X-PLUGIN P3 — dashboard read routes for the X plugin.
 *
 * Mounted at /x (server.js, behind requireServiceOrUserAuth()). Four GETs:
 *
 *   GET /x/media     — list the calling org's uploaded media files from the
 *                      org media root (/var/lib/quox/x-media/<org_id>), for
 *                      the Compose tab's image picker. Filenames returned are
 *                      RELATIVE to the org root — exactly the shape x_post's
 *                      image_path input expects (xPostingStore.resolveOrgMediaPath
 *                      re-resolves + containment-checks them at draft and at
 *                      approval time, so this route never hands out absolute
 *                      paths).
 *   GET /x/media/file — serve one of those filenames' raw image bytes (with
 *                      a Content-Type header), so the Compose media library's
 *                      thumbnail grid can build an object URL via authFetch
 *                      instead of an unauthenticated <img src>.
 *   GET /x/activity  — recent x_post_claims + x_post_ledger rows for the org,
 *                      plus the live budget (xPostingStore.getBudgetStatus),
 *                      for the Activity and Budget tabs.
 *   GET /x/account   — the org's connected X identity (cached from the last
 *                      successful verify) plus whether a twitter credential is
 *                      configured in the vault. Free: never calls api.x.com.
 *
 * Org scoping: the JWT's org_id (req.user.org_id) is the only accepted org
 * for user callers — never a query param, so one org can never read another
 * org's claims or media listing. Internal service callers (req.service, set
 * by requireServiceOrUserAuth for INTERNAL_SERVICE_KEY) must name the org
 * explicitly via ?org_id=.
 *
 * NOTE (from the agh-chain leaderboard review): do NOT read req.auth here —
 * nothing in the collector populates it. req.user / req.service are the
 * fields utils/httpAuth.js actually sets.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Router } = require('express');
const multer = require('multer');
const xPostingStore = require('../lib/xPostingStore.js');
const xScheduledPublish = require('../lib/xScheduledPublish.js');
const { mediaLimitBytes } = require('../lib/xMediaUpload.js');
const platformSettingsStore = require('../lib/platformSettingsStore.js');
const { requireAdminRole, requireHumanAdmin } = require('../utils/httpAuth.js');
const bridge = require('../lib/connectors/bridge.js');

const router = Router();

// Injected by server.js via init() once voltDb is available. mediaRoot is
// injectable for tests only; production always uses xPostingStore.CONFIG.
// verifyOrgMembership(req, orgId) -> Promise<role|null>: proves the USER caller
// is an active member of orgId (used only for #605 cross-org media preview).
// Injected by server.js; null in tests that do not exercise the cross-org path.
let deps = { voltDb: null, mediaRoot: xPostingStore.CONFIG.mediaRoot, verifyOrgMembership: null };

function init(injected) {
  deps = { ...deps, ...injected };
}

// Media listing is a picker for x_post/x_thread, so only list what the
// upload tool can attach (still images, GIF, and since phase 10 slice A, MP4).
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4']);

/**
 * Resolve the calling org. JWT org wins; a service caller names it in the
 * query. Returns null (and writes the response) on failure.
 */
function requireOrgId(req, res) {
  const orgId = req.user?.org_id || (req.service === true ? req.query.org_id : null);
  if (!orgId) {
    res.status(403).json({ success: false, error: 'org_id required' });
    return null;
  }
  // The org id becomes a path segment under the media root; a JWT is signed
  // but its org claim is still data, not a path. Same containment posture as
  // xPostingStore.resolveOrgMediaPath.
  if (typeof orgId !== 'string' || orgId.includes('/') || orgId.includes('\\') || orgId.includes('..')) {
    res.status(400).json({ success: false, error: 'invalid org_id' });
    return null;
  }
  return orgId;
}

// GET /x/media — org-scoped media listing for the compose image picker.
router.get('/media', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const orgRoot = path.join(deps.mediaRoot, orgId);
    let entries = [];
    try {
      entries = fs.readdirSync(orgRoot, { withFileTypes: true });
    } catch {
      // No uploads yet — an empty picker, not an error.
      return res.json({ success: true, org_id: orgId, files: [] });
    }

    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(orgRoot, entry.name));
      } catch {
        continue; // deleted between readdir and stat
      }
      files.push({
        name: entry.name, // relative to the org root — feed straight to x_post image_path
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
      });
    }
    files.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));

    return res.json({ success: true, org_id: orgId, files });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/* ─── GET /x/media/file — serve one image's bytes for the Compose media
 * library's thumbnail grid (X-PLUGIN phase 13) ────────────────────────────
 *
 * GET /x/media above lists filenames only; this route is the only way to
 * turn one of those names into pixels. A plain <img src> cannot carry the
 * bearer token every other collector call needs, so the Compose picker
 * fetches these bytes with authFetch and builds an object URL from them
 * itself, instead of the browser making its own unauthenticated request.
 *
 * Containment posture: the org comes from requireOrgId, exactly as every
 * other route here, JWT org_id for a user caller and ?org_id= only for a
 * service caller, never a value the client names for itself. The filename
 * is resolved against deps.mediaRoot/<org_id> with path.resolve, then proved
 * to still sit inside that org root by a startsWith check against the
 * resolved root plus a trailing separator, so "../", an absolute path, a
 * nested "a/../../escape" and a null byte are all refused with 400 before
 * any fs.readFileSync runs against the escaped target.
 *
 * This is the same containment SHAPE as resolveOrgMediaTarget above, done
 * inline rather than by calling xPostingStore.resolveOrgMediaPath, because
 * that helper is hardwired to xPostingStore's own CONFIG.mediaRoot with no
 * opts.mediaRoot override, so it cannot honour the deps.mediaRoot every
 * other route in this file is injected with for tests.
 *
 * The extension allowlist (IMAGE_EXTENSIONS, the same set /x/media already
 * filters listings to) is re-checked here too, so a name that survives
 * containment still cannot turn this into a general file-read primitive.
 */
const MEDIA_FILE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

router.get('/media/file', async (req, res) => {
  try {
    const activeOrg = requireOrgId(req, res);
    if (!activeOrg) return;

    // #605: an approval card's media lives under the org that FILED it
    // (inbox_items.org_id == action_params.org_id == the media org). Card
    // visibility is org-MEMBERSHIP based, not active-org, so an approver
    // viewing an agent-filed card from a DIFFERENT active org would 404 here
    // (the media resolves under their active org, not the card's). Allow an
    // explicit ?org_id=<cardOrg>, but ONLY after proving the USER is an active
    // member of that org — a client-named org served unchecked would be a
    // cross-tenant read primitive.
    let orgId = activeOrg;
    const requestedOrg = req.query.org_id;
    if (requestedOrg && requestedOrg !== activeOrg) {
      if (typeof requestedOrg !== 'string' || requestedOrg.includes('/') || requestedOrg.includes('\\') || requestedOrg.includes('..')) {
        return res.status(400).json({ success: false, error: 'invalid org_id' });
      }
      // The membership gate is for USER callers. A service caller names its org
      // through requireOrgId already (so it never reaches here mismatching);
      // if one does, refuse rather than trust it.
      if (req.service === true) {
        return res.status(403).json({ success: false, error: 'cross-org media access is not available to service callers' });
      }
      if (typeof deps.verifyOrgMembership !== 'function') {
        return res.status(403).json({ success: false, error: 'cross-org media access is unavailable' });
      }
      const role = await deps.verifyOrgMembership(req, requestedOrg);
      if (!role) {
        return res.status(403).json({ success: false, error: 'not authorized for the requested org' });
      }
      orgId = requestedOrg;
    }

    const name = req.query.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    // A null byte truncates whatever a filesystem call sees after it, so this
    // is refused before the name ever reaches path.resolve.
    if (name.includes('\0')) {
      return res.status(400).json({ success: false, error: 'invalid name' });
    }

    const ext = path.extname(name).toLowerCase();
    const contentType = MEDIA_FILE_CONTENT_TYPES[ext];
    if (!IMAGE_EXTENSIONS.has(ext) || !contentType) {
      return res.status(400).json({ success: false, error: 'name must be an image file' });
    }

    const orgRoot = path.resolve(deps.mediaRoot, orgId);
    const candidate = path.resolve(orgRoot, name);
    const withinRoot = candidate === orgRoot || candidate.startsWith(orgRoot + path.sep);
    if (!withinRoot) {
      return res.status(400).json({ success: false, error: 'name escapes the org media root' });
    }

    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      return res.status(404).json({ success: false, error: 'file not found' });
    }
    if (!stat.isFile()) {
      return res.status(404).json({ success: false, error: 'file not found' });
    }

    // Second containment pass, AFTER symlinks are resolved. The check above
    // proves the NAME stays inside the org root; this proves the FILE does.
    // A symlink planted inside an org root pointing at /etc/passwd would pass
    // the first check and fail this one. Uploads never create symlinks, so
    // nothing legitimate is refused here.
    try {
      const realRoot = fs.realpathSync(orgRoot);
      const realFile = fs.realpathSync(candidate);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        return res.status(400).json({ success: false, error: 'name escapes the org media root' });
      }
    } catch {
      return res.status(404).json({ success: false, error: 'file not found' });
    }

    const buffer = fs.readFileSync(candidate);
    res.status(200);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Length', String(buffer.length));
    return res.end(buffer);
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// GET /x/activity — recent claims + published ledger + live budget, org-scoped.
router.get('/activity', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X posting store is not initialized' });

    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const claims = db.prepare(`
      SELECT inbox_item_id, action, status, posts_reserved, tweet_ids, error, claimed_at, updated_at,
             text_preview, author
      FROM x_post_claims
      WHERE org_id = ?
      ORDER BY claimed_at DESC
      LIMIT ?
    `).all(orgId, limit).map((row) => {
      let tweetIds = [];
      try {
        const parsed = JSON.parse(row.tweet_ids);
        if (Array.isArray(parsed)) tweetIds = parsed;
      } catch { /* leave [] */ }
      // The UI reads `text` and `author`; the column is named text_preview to
      // keep it honest about being a preview rather than the full post.
      return { ...row, tweet_ids: tweetIds, text: row.text_preview || null, author: row.author || null };
    });

    const ledger = db.prepare(`
      SELECT id, tweet_id, kind, posted_at
      FROM x_post_ledger
      WHERE org_id = ?
      ORDER BY posted_at DESC
      LIMIT ?
    `).all(orgId, limit);

    // getBudgetStatus (not the x_budget_status tool shape): the store's
    // camelCase shape carries dailyRemaining/monthlyRemaining, which the
    // Budget tab renders and the tool drops.
    const budget = xPostingStore.getBudgetStatus(db, orgId);

    return res.json({ success: true, org_id: orgId, claims, ledger, budget });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/**
 * GET /x/account — who is this org connected to X as, and is it configured?
 *
 * FREE. This route must never reach api.x.com. X's API is pay-per-use, so the
 * dashboard is not allowed to buy a handle just to paint a header on mount;
 * `account` is served from the x_account cache written by a previous successful
 * verify_credentials call (connectors/types/twitter.js).
 *
 * `credential.configured` answers a separate question — "does this org hold a
 * usable twitter credential in the vault" — with a vault lookup only. It is the
 * SERVER-SIDE answer to "is X set up", replacing a localStorage flag that made
 * a fully-configured org look unconfigured in any browser that had not
 * personally run the setup wizard.
 *
 * Credential VALUES resolved here are never returned; only the boolean and the
 * human label the vault already exposes.
 */
router.get('/account', async (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const account = xPostingStore.getAccountIdentity(deps.voltDb, orgId);

    let credential = { configured: false, label: null, error: null };
    try {
      const resolved = await bridge.resolveConnectorCredentials(orgId, 'twitter');
      if (resolved?.error) {
        credential = { configured: false, label: null, error: resolved.error };
      } else {
        credential = {
          configured: true,
          label: resolved?.credentialLabel || null,
          error: null,
        };
      }
    } catch (e) {
      // A vault outage is not "no credential" — say which it was.
      credential = { configured: false, label: null, error: String(e?.message || e) };
    }

    return res.json({ success: true, org_id: orgId, account, credential });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/* ─── POST /x/media — browser image upload (X-PLUGIN phase 11) ────────────
 *
 * Before this, an image could only reach an X post by being placed on the
 * collector's filesystem out of band, which made the compose panel's image
 * picker a feature only someone with a shell could use.
 *
 * The file is held in memory (multer memoryStorage, hard 5MB cap enforced by
 * multer AND rechecked below) and written only once the destination has been
 * resolved and containment-proved by xPostingStore.resolveOrgMediaTarget.
 * The org comes from req.user.org_id for user callers and is never read from
 * the body, so an authenticated caller cannot write into another org's root.
 *
 * The response returns the org-root-RELATIVE filename, which is exactly what
 * x_post's image_paths input expects and the only form safe to persist in an
 * approval card.
 */
// The multer bound is the LARGEST cap any accepted type allows (video); the
// real per-type limit is enforced below once the content has been sniffed,
// so a 40MB "png" is still refused even though it fits under this bound.
const MAX_ANY_UPLOAD_BYTES = Math.max(
  xPostingStore.MAX_UPLOAD_BYTES,
  xPostingStore.CONFIG.maxGifBytes,
  xPostingStore.CONFIG.maxVideoBytes
);
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ANY_UPLOAD_BYTES, files: 1 },
});

// Content sniffing: the declared mimetype is a client claim. These are the
// magic bytes for the formats the allowlist accepts, checked so a .png
// upload that is really something else is refused before it is written.
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // ISO BMFF: a size box then 'ftyp'. Covers every MP4 brand X accepts.
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  return null;
}

router.post('/media', (req, res) => {
  mediaUpload.single('file')(req, res, (uploadErr) => {
    try {
      if (uploadErr) {
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          error: tooBig
            ? `File is larger than the ${Math.round(MAX_ANY_UPLOAD_BYTES / (1024 * 1024))}MB limit any media type accepts.`
            : String(uploadErr.message || uploadErr),
        });
      }

      const orgId = requireOrgId(req, res);
      if (!orgId) return;

      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ success: false, error: 'no file uploaded (expected a multipart field named "file")' });
      }
      if (file.buffer.length === 0) {
        return res.status(400).json({ success: false, error: 'uploaded file is empty' });
      }
      const sniffed = sniffImageType(file.buffer);
      if (!sniffed) {
        return res.status(400).json({
          success: false,
          error: 'file content is not a png, jpg, webp or gif image, or an mp4 video',
        });
      }
      if (!xPostingStore.UPLOAD_EXTENSIONS.has(sniffed)) {
        return res.status(400).json({ success: false, error: `unsupported media type: ${sniffed}` });
      }

      // Per-type cap, checked against the SNIFFED type so renaming a video
      // to .png cannot borrow the wrong limit. mediaLimitBytes clamps the
      // configurable GIF/video caps to X's own hard ceilings.
      const typeLimit = mediaLimitBytes(sniffed);
      if (file.buffer.length > typeLimit) {
        const label = sniffed === 'video/mp4' ? 'video' : sniffed === 'image/gif' ? 'GIF' : 'image';
        return res.status(413).json({
          success: false,
          error: `${label} exceeds the ${Math.round(typeLimit / (1024 * 1024))}MB limit`,
        });
      }

      // The SNIFFED type decides the extension, not the client's claim.
      const target = xPostingStore.resolveOrgMediaTarget(orgId, file.originalname, sniffed, { mediaRoot: deps.mediaRoot });
      if (!target.ok) {
        return res.status(400).json({ success: false, error: target.error });
      }

      fs.writeFileSync(target.absolutePath, file.buffer, { mode: 0o640 });

      return res.status(201).json({
        success: true,
        org_id: orgId,
        file: {
          name: target.relativePath,
          size: file.buffer.length,
          content_type: sniffed,
          modified_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });
});

/* ─── GET /x/overview — the landing tab's stats (X-PLUGIN phase 11) ───────
 *
 * FREE, and required to stay free: this is what the view loads on mount, so a
 * single paid X call in here would charge the org for opening a page. Every
 * number below comes from the collector's own tables (x_post_ledger,
 * x_post_claims, x_read_ledger, x_account) or from the vault lookup that
 * GET /x/account already does.
 *
 * Aggregation is server-side rather than derived in the browser so the numbers
 * survive a fresh browser with an empty cache, and so the 30-day sparkline is
 * not capped by whatever page size the Activity tab happened to ask for.
 */
router.get('/overview', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X posting store is not initialized' });

    const days = 7;
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Posting sparkline: one bucket per calendar day (UTC), oldest first, with
    // zero-posting days present as real zeroes rather than gaps.
    const rows = db.prepare(`
      SELECT substr(posted_at, 1, 10) AS day, COUNT(*) AS n
      FROM x_post_ledger
      WHERE org_id = ? AND posted_at >= ?
      GROUP BY day
    `).all(orgId, sinceIso);
    const byDay = new Map(rows.map((r) => [r.day, r.n]));
    const sparkline = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      sparkline.push({ day, posts: byDay.get(day) || 0 });
    }

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS published,
        SUM(CASE WHEN kind = 'reply'  THEN 1 ELSE 0 END) AS replies,
        SUM(CASE WHEN kind = 'thread' THEN 1 ELSE 0 END) AS thread_posts
      FROM x_post_ledger WHERE org_id = ?
    `).get(orgId) || {};

    const claimTotals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'posted'  THEN 1 ELSE 0 END) AS posted,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN action = 'x.delete' OR action = 'x_delete' THEN 1 ELSE 0 END) AS deletes
      FROM x_post_claims WHERE org_id = ?
    `).get(orgId) || {};

    const recent = db.prepare(`
      SELECT inbox_item_id, action, status, posts_reserved, tweet_ids, claimed_at, text_preview, author
      FROM x_post_claims WHERE org_id = ?
      ORDER BY claimed_at DESC LIMIT 8
    `).all(orgId).map((row) => {
      let tweetIds = [];
      try {
        const parsed = JSON.parse(row.tweet_ids);
        if (Array.isArray(parsed)) tweetIds = parsed;
      } catch { /* leave [] */ }
      return { ...row, tweet_ids: tweetIds, text: row.text_preview || null, author: row.author || null };
    });

    const firstPost = db.prepare(`SELECT MIN(posted_at) AS first FROM x_post_ledger WHERE org_id = ?`).get(orgId);
    const lastPost = db.prepare(`SELECT MAX(posted_at) AS last FROM x_post_ledger WHERE org_id = ?`).get(orgId);

    return res.json({
      success: true,
      org_id: orgId,
      account: xPostingStore.getAccountIdentity(db, orgId),
      budget: xPostingStore.getBudgetStatus(db, orgId),
      reads: xPostingStore.getReadBudgetStatus(db, orgId),
      poll: xPostingStore.getOrgPollSettings(db, orgId),
      totals: {
        published: totals.published || 0,
        replies: totals.replies || 0,
        thread_posts: totals.thread_posts || 0,
        approvals_filed: claimTotals.total || 0,
        approvals_posted: claimTotals.posted || 0,
        approvals_pending: claimTotals.pending || 0,
        approvals_failed: claimTotals.failed || 0,
        deletes: claimTotals.deletes || 0,
        first_post_at: firstPost?.first || null,
        last_post_at: lastPost?.last || null,
      },
      sparkline,
      recent,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/* ─── GET/PUT /x/settings — org-adjustable caps and polling ───────────────
 *
 * The write side is ADMIN-ONLY (requireAdminRole: owner/admin, or an internal
 * service caller). Raising a cap raises what the org can spend on X's
 * pay-per-use API, so it is not a per-user preference.
 *
 * Validation is NOT re-implemented here. platformSettingsStore.setOrgSetting
 * checks the value against the capability entry's declared type, min and max
 * before anything is persisted or audited, and that same declaration is where
 * the hard ceilings live — so there is exactly one place a ceiling can be
 * wrong, and the audit row is written by the same call that stores the value.
 */
const X_SETTING_KEYS = [
  'X_DAILY_POST_LIMIT',
  'X_MONTHLY_POST_LIMIT',
  'X_DAILY_READ_LIMIT',
  'X_MENTIONS_POLL_ENABLED',
  'X_MENTIONS_POLL_INTERVAL',
];

router.get('/settings', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X settings store is not initialized' });

    const all = platformSettingsStore.listEffectiveFlags(db, orgId);
    const settings = X_SETTING_KEYS
      .map((key) => all.find((entry) => entry.key === key))
      .filter(Boolean);

    return res.json({
      success: true,
      org_id: orgId,
      settings,
      effective: xPostingStore.getOrgLimits(db, orgId),
      poll: xPostingStore.getOrgPollSettings(db, orgId),
      // Whether this deployment permits mention polling AT ALL. An org toggle
      // that is on while this is false must be shown as "on, but the
      // deployment kill switch is off" rather than as working.
      poll_enabled_globally: String(process.env.X_INBOUND_POLL_ENABLED || '').toLowerCase() === 'true',
      // Honest gap, not a setting that does nothing.
      follower_monitoring: { available: false, note: 'Follower-difference monitoring is not implemented yet (phase 10).' },
      can_edit: req.service === true || ['owner', 'admin'].includes(req.user?.dashboardRole),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

router.put('/settings', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    if (!requireAdminRole(req, res, 'Only an org owner or admin can change X limits')) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X settings store is not initialized' });

    const body = req.body || {};
    const updates = Object.keys(body).filter((k) => X_SETTING_KEYS.includes(k));
    const rejected = Object.keys(body).filter((k) => !X_SETTING_KEYS.includes(k));
    if (rejected.length) {
      return res.status(400).json({ success: false, error: `not an X setting: ${rejected.join(', ')}` });
    }
    if (!updates.length) {
      return res.status(400).json({ success: false, error: `no X settings in the request body (expected one of: ${X_SETTING_KEYS.join(', ')})` });
    }

    // req.user.id, NOT req.user.sub: utils/httpAuth.js maps the JWT's `sub`
    // claim onto `id` when it populates req.user. Reading `sub` here stamped
    // every audit row 'unknown', which quietly removes the only thing a
    // budget-change audit trail is for — knowing who raised the cap.
    const actor = {
      actorId: req.user?.id || (req.service === true ? 'internal-service' : 'unknown'),
      actorLabel: req.user?.email || null,
      actorSource: 'x-plugin-settings',
    };

    // setOrgSetting validates against the capability's declared type and
    // ceiling and throws WITHOUT writing when a value is out of range — but a
    // plain loop would still leave key 1 applied when key 3 is rejected, and a
    // half-applied budget change is exactly the kind of partial state a
    // governance surface must not produce. The whole set lands or none of it
    // does, audit rows included.
    const applyAll = db.transaction(() => {
      const applied = [];
      for (const key of updates) {
        platformSettingsStore.setOrgSetting(db, orgId, key, String(body[key]), actor);
        applied.push(key);
      }
      return applied;
    });

    let applied;
    try {
      applied = applyAll();
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: String(err?.message || err),
        applied: [],
      });
    }

    return res.json({
      success: true,
      org_id: orgId,
      applied,
      effective: xPostingStore.getOrgLimits(db, orgId),
      poll: xPostingStore.getOrgPollSettings(db, orgId),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

/* ─── Scheduled publishing (X-PLUGIN phase 12) ────────────────────────────
 *
 * Owner decision 2026-09-12: "approve then schedule! trigger time is not
 * delayed". The approver's tap IS the approval; the chosen time delays only
 * the publish. No second tap, no fresh card at fire time.
 *
 * SCOPE GUARD, and the reason these routes use requireHumanAdmin rather than
 * requireAdminRole: this is the ONLY way into the pre-authorised lane, and it
 * must be a HUMAN approver. requireHumanAdmin refuses a service-key caller and
 * refuses an agent-operated session (agent_id / agent_ops) outright, so an
 * agent can never pre-authorise its own future publish. Agent-initiated
 * x_post/x_thread keep full HITL exactly as before and cannot reach here.
 *
 * The budget claim is taken HERE, at approval time, because the human
 * committed to the post now. The scheduler fires with claimHeld so the slot is
 * never claimed twice.
 */

router.post('/schedule', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    if (!requireHumanAdmin(req, res, 'Only a human org owner or admin can schedule an approved post')) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X posting store is not initialized' });

    const { inbox_item_id: inboxItemId, action, action_params: actionParams, scheduled_publish_at: scheduledPublishAt } = req.body || {};
    if (!inboxItemId) return res.status(400).json({ success: false, error: 'inbox_item_id is required' });
    if (!action || !String(action).startsWith('x.')) return res.status(400).json({ success: false, error: 'a valid x.* action is required' });
    if (!actionParams || typeof actionParams !== 'object') return res.status(400).json({ success: false, error: 'action_params is required' });
    if (!scheduledPublishAt) return res.status(400).json({ success: false, error: 'scheduled_publish_at is required' });

    const approver = req.user?.email || req.user?.id || 'unknown';

    const postsNeeded = action === 'x.thread'
      ? (Array.isArray(actionParams.posts) ? actionParams.posts.length
        : Array.isArray(actionParams.texts) ? actionParams.texts.length : 0)
      : (action === 'x.post' ? 1 : 0);

    // Claim the budget NOW. Pre-authorising means the slot is committed from
    // the moment the human approves, not from the moment it fires, otherwise
    // an org could approve twenty scheduled posts against a budget of
    // seventeen and only discover the problem overnight.
    const claim = xPostingStore.claimForApproval(db, {
      orgId,
      inboxItemId,
      action,
      postsNeeded,
      textPreview: xPostingStore.buildTextPreview(actionParams),
      author: approver,
    });
    if (claim.replay) {
      return res.status(409).json({ success: false, error: 'this approval has already been decided' });
    }
    if (!claim.claimed) {
      return res.status(409).json({ success: false, error: claim.error });
    }

    const out = xScheduledPublish.scheduleApprovedPublish(db, {
      orgId, inboxItemId, action, actionParams, approver, scheduledPublishAt,
    });
    if (!out.ok) {
      // Do not keep a reservation for a schedule that was refused.
      xPostingStore.markClaimFailed(db, orgId, inboxItemId, `scheduling refused: ${out.error}`);
      return res.status(400).json({ success: false, error: out.error });
    }

    return res.status(201).json({ success: true, org_id: orgId, scheduled: out.scheduled });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// GET /x/schedule — what this org has queued. Readable by any member; only the
// write paths are gated.
router.get('/schedule', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X posting store is not initialized' });

    const pendingOnly = String(req.query.pending || '') === 'true';
    return res.json({
      success: true,
      org_id: orgId,
      scheduled: xScheduledPublish.listForOrg(db, orgId, { pendingOnly }),
      can_cancel: req.user ? ['owner', 'admin'].includes(req.user.dashboardRole) : false,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// POST /x/schedule/:inboxItemId/cancel — stop a pending publish before it
// fires, and hand the reserved budget slot back.
router.post('/schedule/:inboxItemId/cancel', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    if (!requireHumanAdmin(req, res, 'Only a human org owner or admin can cancel a scheduled post')) return;

    const db = deps.voltDb;
    if (!db) return res.status(503).json({ success: false, error: 'X posting store is not initialized' });

    const inboxItemId = req.params.inboxItemId;
    const cancelledBy = req.user?.email || req.user?.id || 'unknown';

    const out = xScheduledPublish.cancelScheduledPublish(db, { orgId, inboxItemId, cancelledBy });
    if (!out.ok) return res.status(409).json({ success: false, error: out.error, scheduled: out.scheduled || null });

    // Release the slot this publish was holding, or the org loses it forever.
    try {
      xPostingStore.markClaimFailed(db, orgId, inboxItemId, `scheduled publish cancelled by ${cancelledBy}`);
    } catch { /* the schedule is cancelled either way; never fail the cancel on this */ }

    return res.json({
      success: true,
      org_id: orgId,
      scheduled: out.scheduled,
      budget: xPostingStore.getBudgetStatus(db, orgId),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

module.exports = { router, init };
