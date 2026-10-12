/**
 * WARD API bridge — CommonJS wrapper for collector HTTP endpoints.
 * Lazy-imports ESM WARD service to serve chain/entry/stats/verify data.
 */

let _ward = null;
let _initPromise = null;

async function getWard() {
  if (_ward) return _ward;
  if (_initPromise) return _initPromise;
  _initPromise = import('./index.js').then(m => { _ward = m; return m; });
  return _initPromise;
}

// WARD-HARDEN: Load the collector's standard dual auth (service key or user
// JWT) middleware. Candidate paths mirror the resolution strategy server.js
// already uses for this module (loadOptionalModule): in the Docker image
// ward is copied/mounted to /app/ward and collector's utils/ live at
// /app/utils, so '../utils/httpAuth' resolves; in the source tree
// (services/ward/api-cjs.cjs) '../collector/utils/httpAuth' resolves to
// services/collector/utils/httpAuth.js. Fails closed (503) if neither loads.
let _requireServiceOrUserAuth = null;
for (const candidate of ['../utils/httpAuth', '../collector/utils/httpAuth']) {
  try {
    ({ requireServiceOrUserAuth: _requireServiceOrUserAuth } = require(candidate));
    if (_requireServiceOrUserAuth) break;
  } catch (err) {
    // try next candidate
  }
}
if (!_requireServiceOrUserAuth) {
  console.warn('[WARD] Could not load requireServiceOrUserAuth — /ward/* routes will fail closed (503)');
}

function wardAuthGuard(req, res, next) {
  if (!_requireServiceOrUserAuth) {
    return res.status(503).json({ ok: false, error: 'ward_auth_unavailable' });
  }
  return _requireServiceOrUserAuth()(req, res, next);
}

// Module-level flag surfaced via getWardApiMountStatus() so collector /health
// can report ward_api: 'mounted' | 'degraded' without importing route internals.
let _wardApiMounted = false;
function getWardApiMountStatus() {
  return _wardApiMounted;
}

/**
 * Mount WARD API routes on an Express router.
 * All /ward/* routes require authentication (service key or user JWT) —
 * same dual-auth guard the sibling /governance/* and /aee/* collector routes
 * use. /public/verify/ward/:chainId stays intentionally unauthenticated
 * (WARD-EXT-3 public verification endpoint) and is NOT covered by this guard.
 * @param {import('express').Router} router
 */
// Short TTL cache for the status-bar probes (incident 2026-10-06). Inline so
// this module keeps no dependency on the collector's lib/.
const wardStatusCache = (() => {
  const m = new Map();
  return {
    get(key, compute, ttlMs = 30000) {
      const now = Date.now(); const hit = m.get(key);
      if (hit && hit.exp > now) return hit.v;
      const v = compute(); m.set(key, { v, exp: now + ttlMs });
      if (m.size > 200) m.delete(m.keys().next().value);
      return v;
    },
  };
})();

function mountWardRoutes(router) {
  router.use('/ward', wardAuthGuard);

  // GET /ward/stats — overview stats
  // ORG-VIEW-SCOPE: adds a per-org witnessed count as an ADDITIVE field
  // alongside the existing global chain/witness stats (response shape is
  // unchanged otherwise). WARD is mounted directly on the collector's
  // Express app (mountWardRoutes(app) in server.js) — there is no separate
  // HTTP proxy hop for /collector/ward/stats to cross. wardAuthGuard (this
  // module, line ~59) already runs requireServiceOrUserAuth() ahead of this
  // handler on the SAME req, so req.user.org_id (set from the verified JWT)
  // is already present here with zero extra plumbing. Service-key callers
  // (req.service) have no user/org context — org stays null, which is
  // correct: honest unknown, never fabricated. Only the verified req.user
  // identity is trusted for org resolution — a client-supplied org_id
  // query/header is intentionally NOT honoured here, to avoid letting an
  // authenticated caller enumerate another org's witnessed count.
  router.get('/ward/stats', async (req, res) => {
    try {
      const ward = await getWard();
      const orgId = req.user?.org_id || req.user?.orgId || null;
      // Incident 2026-10-06: polled every ~10s per status-bar client; each call
      // re-counted the whole chain synchronously. 30s cache, keyed per org.
      const body = wardStatusCache.get(`stats:${orgId || '-'}`, () => ({
        stats: ward.getStats(),
        witness: ward.getWitnessStats(),
        org: orgId ? { org_id: orgId, entries: ward.getEntryCountByOrg(orgId) } : null,
      }), 300000); // whole-chain counts: 5 min is fresh enough for a status bar
      res.json({ ok: true, ...body });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/chains — list all chains
  router.get('/ward/chains', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();
      const chains = wardStatusCache.get('chains', () => db.prepare('SELECT * FROM ward_chains ORDER BY created_at DESC').all(), 60000);
      res.json({ ok: true, chains });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/chains/:chainId — single chain descriptor
  router.get('/ward/chains/:chainId(*)', async (req, res) => {
    try {
      const ward = await getWard();
      const chain = ward.getChain(req.params.chainId);
      if (!chain) return res.status(404).json({ ok: false, error: 'Chain not found' });
      res.json({ ok: true, chain });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/entries?chain=...&limit=50&offset=0&source_kind=AEE
  router.get('/ward/entries', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();
      const chainId = req.query.chain;
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const offset = parseInt(req.query.offset) || 0;
      const sourceKind = req.query.source_kind;
      // AEE-ORG-1 (tenant isolation): a JWT user sees only their own org's
      // entries (plus untagged legacy rows); a trusted service caller (no user
      // org) keeps infra-wide oversight. org_id is a nullable tag here; the
      // hash chain itself remains global (per-org chains = WARD #494's
      // architectural residual, tracked separately). Only the verified req.user
      // identity is trusted — a client-supplied org_id is never honoured.
      const orgId = req.user?.org_id || req.user?.orgId || null;

      let sql = 'SELECT * FROM ward_entries';
      const params = [];
      const where = [];

      if (chainId) { where.push('chain_id = ?'); params.push(chainId); }
      if (sourceKind) { where.push('source_kind = ?'); params.push(sourceKind); }
      if (orgId) { where.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId); }

      if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY seq DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const entries = db.prepare(sql).all(...params);

      // Total count for pagination
      let countSql = 'SELECT COUNT(*) as total FROM ward_entries';
      if (where.length > 0) countSql += ' WHERE ' + where.join(' AND ');
      const total = db.prepare(countSql).get(...params.slice(0, where.length)).total;

      res.json({ ok: true, entries, total, limit, offset });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/entries/:id — single entry by ID
  router.get('/ward/entries/:id', async (req, res) => {
    try {
      const ward = await getWard();
      const entry = ward.getEntry(req.params.id);
      if (!entry) return res.status(404).json({ ok: false, error: 'Entry not found' });
      // AEE-ORG-1 (tenant isolation): a JWT user may read only their own org's
      // entry (untagged legacy rows stay visible); another org's tagged entry
      // reads as 404. Service callers (no user org) keep infra-wide oversight.
      const orgId = req.user?.org_id || req.user?.orgId || null;
      if (orgId && entry.org_id && entry.org_id !== orgId) {
        return res.status(404).json({ ok: false, error: 'Entry not found' });
      }
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/tips?chain=...
  router.get('/ward/tips', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();
      const chainId = req.query.chain;
      let tips;
      if (chainId) {
        tips = db.prepare('SELECT * FROM ward_tips WHERE chain_id = ? ORDER BY tip_seq DESC').all(chainId);
      } else {
        tips = db.prepare('SELECT * FROM ward_tips ORDER BY created_at DESC LIMIT 50').all();
      }
      res.json({ ok: true, tips });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /ward/tips/create — create a tip (optionally signed)
  router.post('/ward/tips/create', async (req, res) => {
    try {
      const ward = await getWard();
      const { chain_id, notes } = req.body;
      if (!chain_id) return res.status(400).json({ ok: false, error: 'chain_id required' });

      const keypair = ward.getHookKeypair();
      const tip = ward.createTip(chain_id, { notes, keypair });
      if (!tip) return res.status(404).json({ ok: false, error: 'Chain empty or not found' });

      // Auto-witness in meta-chain if configured
      const metaChainId = ward.getHookMetaChainId();
      let metaEntry = null;
      if (metaChainId) {
        metaEntry = ward.witnessTipInMetaChain(metaChainId, tip);
      }

      res.json({ ok: true, tip, signed: !!tip.sig, meta_witnessed: !!metaEntry });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /ward/tips/:tipId/publish — publish a tip to Gitea
  router.post('/ward/tips/:tipId/publish', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();
      const tip = db.prepare('SELECT * FROM ward_tips WHERE tip_id = ?').get(req.params.tipId);
      if (!tip) return res.status(404).json({ ok: false, error: 'Tip not found' });

      const { gitea_url, owner, repo, token, target } = req.body;
      if (!gitea_url || !token || !owner || !repo) {
        return res.status(400).json({ ok: false, error: 'gitea_url, owner, repo, and token required' });
      }

      const result = await ward.publishTipToGitea(tip, { giteaUrl: gitea_url, owner, repo, token, target });
      if (result.success) {
        db.prepare('UPDATE ward_tips SET sink_ref = ? WHERE tip_id = ?').run(result.sink_ref, tip.tip_id);
      }
      res.json({ ok: result.success, sink_ref: result.sink_ref, error: result.error || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/keypair — get public key info (never exposes private key)
  router.get('/ward/keypair', async (req, res) => {
    try {
      const ward = await getWard();
      const keypair = ward.getHookKeypair();
      if (!keypair) return res.json({ ok: true, configured: false });

      const pubPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
      res.json({ ok: true, configured: true, key_id: keypair.keyId, public_key_pem: pubPem });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /ward/verify — verify chain integrity
  router.post('/ward/verify', async (req, res) => {
    try {
      const ward = await getWard();
      const { chain_id } = req.body;
      if (!chain_id) return res.status(400).json({ ok: false, error: 'chain_id required' });
      // WARD-VERIFY-SIG: pass the server's WARD public key (same source as the
      // public /public/verify/ward/:chainId path) so tip signatures are actually
      // verified, and set requireSignatures so a signed-capable tip can never be
      // silently downgraded to INTACT. Unsigned chains still verify on hash
      // integrity alone.
      const keypair = ward.getHookKeypair();
      // G3d: bounded verify. fromSeq/upToSeq let an authenticated caller PAGE a
      // full verify of a very large chain without pegging the event loop; absent
      // them, verifyChain caps the walk at its safe default (DEFAULT_MAX_ENTRIES)
      // and returns PARTIAL/BOUNDED_LARGE_CHAIN rather than walking millions.
      const fromSeq = Number.isFinite(+req.body?.from_seq) ? +req.body.from_seq : undefined;
      const upToSeq = Number.isFinite(+req.body?.up_to_seq) ? +req.body.up_to_seq : undefined;
      const result = ward.verifyChain(chain_id, {
        publicKey: keypair?.publicKey || undefined,
        requireSignatures: true,
        fromSeq,
        upToSeq,
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /ward/verify-receipt — #622: prove ONE action's inclusion receipt.
  // Bounded (entry → covering signed tip only), so it is safe on the production
  // chain where a full /ward/verify is not. Auditor passes the source id (an
  // AEE envelope id from `quox aee get`); chain is resolved if omitted.
  router.post('/ward/verify-receipt', async (req, res) => {
    try {
      const ward = await getWard();
      const { source_id, source_kind, chain_id } = req.body || {};
      if (!source_id) return res.status(400).json({ ok: false, error: 'source_id required' });
      const keypair = ward.getHookKeypair();
      const result = ward.verifyReceipt({
        chainId: chain_id || undefined,
        sourceKind: source_kind || 'AEE',
        sourceId: source_id,
        publicKey: keypair?.publicKey || undefined,
        requireSignatures: true,
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /ward/source-breakdown?chain=... — count by source_kind
  router.get('/ward/source-breakdown', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();
      const chainId = req.query.chain;
      // AEE-ORG-1 (tenant isolation): scope the aggregate to the caller's org
      // (untagged rows included); service callers keep infra-wide oversight.
      const orgId = req.user?.org_id || req.user?.orgId || null;
      let sql = 'SELECT source_kind, COUNT(*) as count FROM ward_entries';
      const params = [];
      const where = [];
      if (chainId) { where.push('chain_id = ?'); params.push(chainId); }
      if (orgId) { where.push('(org_id = ? OR org_id IS NULL)'); params.push(orgId); }
      if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
      sql += ' GROUP BY source_kind ORDER BY count DESC';
      const breakdown = db.prepare(sql).all(...params);
      res.json({ ok: true, breakdown });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── WARD-EXT-3: Public verification endpoint (unauthenticated) ──

  // Simple rate limiting: 10 req/min per IP
  const verifyRateMap = new Map();
  setInterval(() => verifyRateMap.clear(), 60000); // Reset every minute

  // Shared rate limit for the public verify family: 10 req/min per IP.
  function publicVerifyRateLimited(req, res) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const count = (verifyRateMap.get(ip) || 0) + 1;
    verifyRateMap.set(ip, count);
    if (count > 10) {
      res.status(429).json({ error: 'Rate limit exceeded (10 req/min)' });
      return true;
    }
    return false;
  }

  // quox#637: real chain ids contain slashes (ward:org/quox/env/production),
  // which the path-param form only accepts URL-ENCODED — functional but
  // undiscoverable (a skeptic trying the obvious raw URL got a bare
  // Cannot GET and concluded the public surface was broken). This query form
  // has no encoding trap: GET /public/verify/ward?chain=<id>.
  router.get('/public/verify/ward', (req, res, next) => {
    if (!req.query.chain) {
      return res.status(400).json({ error: 'chain query parameter required', example: '/public/verify/ward?chain=ward:org/example/env/production' });
    }
    req.params.chainId = String(req.query.chain);
    return publicVerifyChain(req, res, next);
  });

  // quox#637: `(*)` so the param captures slash-bearing chain ids
  // (ward:org/quox/env/production) from the OBVIOUS raw URL, mirroring the
  // authed /ward/chains/:chainId(*) route. Without it, bare :chainId matches a
  // single path segment and the raw URL 404s — a skeptic trying the obvious
  // link concluded the public verify surface was broken. Encoded + the ?chain=
  // query form still work; this makes the un-encoded URL work too.
  router.get('/public/verify/ward/:chainId(*)', publicVerifyChain);

  async function publicVerifyChain(req, res) {
    if (publicVerifyRateLimited(req, res)) return;

    try {
      const ward = await getWard();
      const chainId = decodeURIComponent(req.params.chainId);
      const tipSeq = req.query.tip_seq ? parseInt(req.query.tip_seq, 10) : null;

      // Pass public key for signature verification
      const keypair = ward.getHookKeypair();
      // G3d: this endpoint is UNAUTHENTICATED, so it gets the tightest bound. An
      // external visitor can never trigger more than PUBLIC_MAX_ENTRIES synchronous
      // hashes regardless of chain size (the per-IP rate limit above is not enough
      // on its own: a handful of unbounded whole-chain verifies of a multi-million
      // -entry chain would still peg the collector). fromSeq lets a visitor page.
      const PUBLIC_MAX_ENTRIES = 5000;
      const fromSeq = req.query.from_seq ? parseInt(req.query.from_seq, 10) : undefined;
      const result = ward.verifyChain(chainId, {
        upToSeq: tipSeq || undefined,
        fromSeq: Number.isFinite(fromSeq) ? fromSeq : undefined,
        maxEntries: PUBLIC_MAX_ENTRIES,
        publicKey: keypair?.publicKey || undefined
      });
      if (!result || (!result.entry_count && result.status !== 'INTACT')) {
        return res.status(404).json({ error: 'Chain not found' });
      }

      // Get sink publication stats
      const db = ward.getDb();
      const tips = db.prepare('SELECT sink_ref FROM ward_tips WHERE chain_id = ?').all(chainId);
      const sinksPublished = { tsa: 0, webhook: 0, gitea: 0 };
      for (const tip of tips) {
        if (!tip.sink_ref) continue;
        for (const ref of tip.sink_ref.split(',')) {
          const type = ref.split(':')[0];
          if (sinksPublished[type] !== undefined) sinksPublished[type]++;
        }
      }

      // Get public key PEM
      let publicKeyPem = null;
      try {
        const keypair = ward.getHookKeypair();
        if (keypair) publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
      } catch {}

      res.json({
        status: result.status,
        chain_id: chainId,
        ward_version: result.ward_version || '1.0',
        entry_count: result.entry_count,
        head_seq: result.head_seq,
        head_chain_hash: result.head_chain_hash,
        genesis_verified: result.genesis_verified,
        tips_verified: result.tips_verified,
        signatures_verified: result.signatures_verified,
        sinks_published: sinksPublished,
        public_key_pem: publicKeyPem,
        verified_at: new Date().toISOString(),
        ...(result.warnings?.length > 0 && { warnings: result.warnings }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // QUOXTRUST D5 (quox#622 companion, shipped with the quox#637 fix): the
  // PUBLIC bounded single-receipt inclusion proof. This is the proof a
  // skeptic actually wants — "prove THIS action is committed under a signed
  // tip" — in O(tip_gap), not O(chain). Unauthenticated by the WARD-EXT-3
  // principle (evidence data only: ids, seqs, hashes, tip signature state);
  // same 10 req/min rate limit; source ids are unguessable ULIDs; and the
  // segment walk is REFUSED when the covering-tip gap exceeds the public
  // bound (tightest-bound rule G3d — a visitor can never trigger an
  // unbounded synchronous hash walk).
  router.get('/public/verify/receipt', async (req, res) => {
    if (publicVerifyRateLimited(req, res)) return;
    const sourceId = req.query.source_id ? String(req.query.source_id) : null;
    const sourceKind = req.query.source_kind ? String(req.query.source_kind).toUpperCase() : 'AEE';
    if (!sourceId) {
      return res.status(400).json({ error: 'source_id query parameter required', example: '/public/verify/receipt?source_id=<envelope id>' });
    }
    try {
      const ward = await getWard();
      const PUBLIC_MAX_SEGMENT = 5000;
      // Pre-check the segment size so the public surface stays bounded.
      const entry = ward.getEntryBySourceAnyChain(sourceKind, sourceId);
      if (entry) {
        const tip = ward.getCoveringTip(entry.chain_id, entry.seq);
        if (tip && (tip.tip_seq - entry.seq) > PUBLIC_MAX_SEGMENT) {
          return res.status(422).json({
            error: 'segment_too_large_for_public_verify',
            detail: `the covering signed tip is ${tip.tip_seq - entry.seq} entries ahead; the public route walks at most ${PUBLIC_MAX_SEGMENT}`,
            hint: 'use the authenticated /ward verify surface, or retry after the next signed tip',
          });
        }
      }
      const keypair = ward.getHookKeypair();
      const result = ward.verifyReceipt({
        sourceKind,
        sourceId,
        publicKey: keypair?.publicKey || undefined,
      });
      let publicKeyPem = null;
      try { if (keypair) publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' }); } catch { /* verdict stands without the PEM */ }
      res.json({ ...result, public_key_pem: publicKeyPem, verified_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── WARD-EXT: Publish all unpublished tips to active sinks ──

  router.post('/ward/tips/publish-all', async (req, res) => {
    try {
      const ward = await getWard();
      const db = ward.getDb();

      // Find tips with no sink_ref (filtered by chain if provided)
      const chainId = req.body?.chain_id || null;
      const unpublished = chainId
        ? db.prepare('SELECT * FROM ward_tips WHERE sink_ref IS NULL AND chain_id = ? ORDER BY tip_seq ASC LIMIT 500').all(chainId)
        : db.prepare('SELECT * FROM ward_tips WHERE sink_ref IS NULL ORDER BY tip_seq ASC LIMIT 500').all();
      if (unpublished.length === 0) {
        return res.json({ ok: true, published: 0, message: 'All tips already published' });
      }

      // Import sinks module
      const sinks = await import('./lib/sinks.js');
      let published = 0;
      const errors = [];

      for (const tip of unpublished) {
        try {
          const results = await sinks.publishToAllSinks(tip);
          const successRefs = results.filter(r => r.success).map(r => r.sink_ref);
          if (successRefs.length > 0) {
            db.prepare('UPDATE ward_tips SET sink_ref = ? WHERE tip_id = ?')
              .run(successRefs.join(','), tip.tip_id);
            published++;
          } else {
            errors.push({ tip_seq: tip.tip_seq, error: results.map(r => r.error).filter(Boolean).join('; ') });
          }
        } catch (err) {
          errors.push({ tip_seq: tip.tip_seq, error: err.message });
        }
      }

      res.json({
        ok: true,
        total_unpublished: unpublished.length,
        published,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Limit error list
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  _wardApiMounted = true;
}

module.exports = { mountWardRoutes, getWardService: getWard, getWardApiMountStatus };
