/**
 * CRP-QXFY-2: AUDITUS Compliance Tools
 *
 * 16 tool handlers for the AUDITUS governance intelligence agent.
 * Each tool wraps existing collector endpoints via internal HTTP fetch.
 * Read-only except for report generation and job scheduling.
 * No direct DB access — uses the collector's own REST API.
 */

const { buildInternalServiceHeaders } = require('./internalServiceHeaders');
const { EXPECTED_LAYERS } = require('./aoclPipeline');
const { sha256 } = require('./voltEmitter');

const COLLECTOR_BASE = `http://127.0.0.1:${process.env.COLLECTOR_PORT || 9848}`;
const WARD_BASE = `http://127.0.0.1:${process.env.WARD_PORT || 3104}`;
// AUDITUS-HONESTY-1: must match the default chain_id the collector's WARD
// hooks actually witness against (server.js ~:20807 — initWardHooks({
// chainId: WARD_CHAIN_ID })). Used as the fallback when a caller omits
// chain_id so /ward/verify never 400s and always checks the real chain.
const DEFAULT_WARD_CHAIN_ID = process.env.WARD_CHAIN_ID || 'ward:org/quox/env/production';

// AUDITUS-AUTH: these self-fetches call collector routes that are now gated
// behind requireServiceOrUserAuth() (e.g. /compliance/reports, /volt/stats,
// /aee/query — AEE-ORG-1 and the org-scoping work that added org_id to
// compliance_reports/volt_runs). Previously these calls carried NO auth
// header at all, so a service-key-gated route returned 401 and the tool
// silently got empty data back (feedback_silent_success_cross_service).
// Fix: send X-Service-Key like every other internal collector self-call
// (lib/internalServiceHeaders.js — same helper used by imageStore.js,
// entityToolLoader.js, quoxchatMcpTools.js, etc).
//
// A service-key alone authenticates the CALL but carries no org_id (there's
// no req.user on the service-key path — see requireServiceOrUserAuth()), so
// org-scoped routes would still return an honest empty/zero result for a
// bare service-key caller. To get REAL org-scoped data back, the caller's
// org (ctx.orgId, threaded in from tool.execute(input, ctx) in agentTools.js)
// is passed as an explicit `org_id` query param / body field — the same
// override those routes already accept for internal callers
// (req.query.org_id || req.user?.org_id, precedent:
// /api/v1/compliance/monitor/posture). No orgId available -> omitted, and
// the route falls back to its own honest empty/zero result (never a
// fabricated org).
function withOrgParam(path, orgId) {
  if (!orgId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}org_id=${encodeURIComponent(orgId)}`;
}

async function collectorGet(path, orgId) {
  const res = await fetch(`${COLLECTOR_BASE}${withOrgParam(path, orgId)}`, {
    headers: buildInternalServiceHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function collectorPost(path, body, orgId) {
  const res = await fetch(`${COLLECTOR_BASE}${path}`, {
    method: 'POST',
    headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(orgId ? { ...body, org_id: orgId } : body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function collectorDelete(path) {
  const res = await fetch(`${COLLECTOR_BASE}${path}`, {
    method: 'DELETE',
    headers: buildInternalServiceHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function wardGet(path) {
  const res = await fetch(`${WARD_BASE}${path}`);
  if (!res.ok) throw new Error(`WARD ${res.status} ${res.statusText}`);
  return res.json();
}

// AUDITUS-HONESTY-1: single source of truth for real WARD chain verification.
// The real /ward/verify response shape (services/ward/api-cjs.cjs:238-248)
// is `{ ok: true, result: { status: 'INTACT'|'BROKEN'|'PARTIAL', reason?, ... } }`
// (services/ward/lib/verify.js:16-150) — NOT `{ valid: boolean }`. `chain_id`
// is REQUIRED by the route (400 if omitted, api-cjs.cjs:242) so we default it
// to the collector's real deployment chain (DEFAULT_WARD_CHAIN_ID) rather
// than letting the call 400 into a fabricated pass. If WARD is unreachable
// or returns an error, this reports an honest unknown — never a pass.
async function verifyWardChain(chainId) {
  const resolvedChainId = chainId || DEFAULT_WARD_CHAIN_ID;

  let stats = {};
  let witness = {};
  try {
    const statsData = await wardGet('/ward/stats');
    stats = statsData.stats || {};
    witness = statsData.witness || {};
  } catch (err) {
    return { ok: false, chain_id: resolvedChainId, error: `WARD stats unreachable: ${err.message}` };
  }

  let verifyResult = null;
  let verifyError = null;
  try {
    const verifyRes = await fetch(`${WARD_BASE}/ward/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain_id: resolvedChainId }),
    });
    const verifyData = await verifyRes.json().catch(() => null);
    if (!verifyRes.ok || !verifyData || verifyData.ok === false) {
      verifyError = verifyData?.error || `WARD verify HTTP ${verifyRes.status}`;
    } else {
      verifyResult = verifyData.result || null;
    }
  } catch (err) {
    verifyError = err.message;
  }

  if (verifyError || !verifyResult) {
    // Honest unknown — NEVER default to intact/verified when the real
    // verify call failed or is unreachable.
    return {
      ok: true,
      chain_id: resolvedChainId,
      stats,
      witness,
      chainIntact: null,
      status: null,
      reason: null,
      confidence: 'UNKNOWN',
      error: verifyError || 'no result returned from /ward/verify',
    };
  }

  const status = verifyResult.status; // 'INTACT' | 'BROKEN' | 'PARTIAL'
  const chainIntact = status === 'INTACT';
  return {
    ok: true,
    chain_id: resolvedChainId,
    stats,
    witness,
    chainIntact,
    status,
    reason: verifyResult.reason || null,
    confidence: chainIntact ? 'VERIFIED' : status, // BROKEN or PARTIAL, never fabricated
    error: null,
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const COMPLIANCE_TOOLS = {

  // ═══ Overview ═══════════════════════════════════════════════════════════════

  compliance_posture: {
    name: 'compliance_posture',
    description: 'Get the current compliance posture — overall score, protocol health (AEE/AOCL/VOLT/WARD), active risks, and framework coverage. Use this as a starting point for any compliance question.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    execute: async (input, ctx) => {
      try {
        const orgId = ctx?.orgId || null;
        const [aeeStats, voltStats, wardVerify, reports, aoclProbe] = await Promise.all([
          collectorGet('/aee/stats').catch(() => ({})),
          collectorGet('/volt/stats', orgId).catch(() => ({})),
          verifyWardChain(null).catch((err) => ({ ok: false, error: err.message })),
          collectorGet('/compliance/reports?limit=10', orgId).catch(() => ({ reports: [] })),
          // AUDITUS-HONESTY-2: probe real AOCL activity (recent aocl.* envelopes)
          // instead of asserting 'active' as a literal constant. null on failure
          // -> reported as 'unknown', never a fabricated 'active'.
          collectorGet('/aee/query?intent=aocl.&limit=1', orgId).catch(() => null),
        ]);

        const wardData = wardVerify.ok ? (wardVerify.stats || {}) : {};
        const witnessData = wardVerify.ok ? (wardVerify.witness || {}) : {};
        const aoclStatus = aoclProbe === null
          ? 'unknown'
          : ((aoclProbe.envelopes || []).length > 0 ? 'active' : 'inactive');

        // Compute score from latest reports
        const latestByFormat = {};
        for (const r of (reports.reports || [])) {
          if (!latestByFormat[r.format]) {
            const score = r.summary?.overallScore ?? r.summary?.coveragePercent ?? null;
            if (score !== null) latestByFormat[r.format] = score;
          }
        }
        const scores = Object.values(latestByFormat);
        const overallScore = scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null;

        return {
          success: true,
          overallScore,
          frameworkScores: latestByFormat,
          protocols: {
            AEE: { status: (aeeStats.total_envelopes || 0) > 0 ? 'active' : 'inactive', envelopes: aeeStats.total_envelopes || 0 },
            AOCL: { status: aoclStatus, layersActive: EXPECTED_LAYERS.length },
            VOLT: { status: (voltStats.runs || 0) > 0 ? 'active' : 'inactive', runs: voltStats.runs || 0, events: voltStats.events || 0 },
            WARD: { status: witnessData.enabled ? 'active' : 'inactive', entries: wardData.entries || 0, tips: wardData.tips || 0 },
          },
          // Real verify result — null (honest unknown) when WARD was unreachable,
          // never a hardcoded true.
          wardChainIntact: wardVerify.ok ? wardVerify.chainIntact : null,
          evidenceCount: wardData.entries || 0,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ═══ Compliance Reports ════════════════════════════════════════════════════

  compliance_generate_report: {
    name: 'compliance_generate_report',
    description: 'Generate a compliance report for a specific regulatory framework. Returns the report with scores, sections, and evidence.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['soc2', 'hipaa', 'gdpr', 'iso27001', 'euAiAct', 'iso42001', 'nistAiRmf', 'json'], description: 'Compliance framework to report on' },
        period_days: { type: 'number', description: 'Report period in days (default 30)' },
        include_evidence: { type: 'boolean', description: 'Include sample evidence traces (default true)' },
        sample_size: { type: 'number', description: 'Number of sample traces (default 50)' },
      },
      required: ['format'],
    },
    execute: async (input, ctx) => {
      try {
        // Generate via the compliance exporter endpoint
        const report = await collectorPost('/compliance/reports', {
          format: input.format,
          period_days: input.period_days || 30,
          include_evidence: input.include_evidence !== false,
          sample_size: input.sample_size || 50,
        }, ctx?.orgId || null);
        return { success: true, report_id: report.report_id, summary: report.summary || 'Report generated' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_get_reports: {
    name: 'compliance_get_reports',
    description: 'Get compliance report history. Returns list of previously generated reports with their scores and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'Filter by framework (soc2, hipaa, gdpr, iso27001, euAiAct, iso42001, nistAiRmf)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        if (input.format) params.set('format', input.format);
        params.set('limit', String(input.limit || 10));
        const data = await collectorGet(`/compliance/reports?${params}`, ctx?.orgId || null);
        return { success: true, reports: data.reports || [], total: (data.reports || []).length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_schedule_job: {
    name: 'compliance_schedule_job',
    description: 'Schedule a recurring compliance report. Runs server-side even when no browser is open.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['soc2', 'hipaa', 'gdpr', 'iso27001', 'euAiAct', 'iso42001', 'nistAiRmf'], description: 'Framework to report on' },
        interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to generate' },
        day_of_week: { type: 'number', description: 'Day of week for weekly (0=Sun, 1=Mon, ..., 6=Sat)' },
        day_of_month: { type: 'number', description: 'Day of month for monthly (1-28)' },
      },
      required: ['format', 'interval'],
    },
    execute: async (input) => {
      try {
        const data = await collectorPost('/compliance/jobs', {
          format: input.format,
          schedule_interval: input.interval,
          day_of_week: input.day_of_week,
          day_of_month: input.day_of_month,
        });
        return { success: true, job: data.job || data, message: `Scheduled ${input.interval} ${input.format} report` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_list_jobs: {
    name: 'compliance_list_jobs',
    description: 'List all scheduled compliance report jobs.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'error'], description: 'Filter by job status' },
      },
    },
    execute: async (input) => {
      try {
        const data = await collectorGet('/compliance/jobs');
        let jobs = data.jobs || [];
        if (input.status) jobs = jobs.filter(j => j.status === input.status);
        return { success: true, jobs, total: jobs.length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_cancel_job: {
    name: 'compliance_cancel_job',
    description: 'Cancel a scheduled compliance report job.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'ID of the job to cancel' },
      },
      required: ['job_id'],
    },
    execute: async (input) => {
      try {
        await collectorDelete(`/compliance/jobs/${input.job_id}`);
        return { success: true, message: `Job ${input.job_id} cancelled` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ═══ VOLT Evidence ═════════════════════════════════════════════════════════

  volt_list_runs: {
    name: 'volt_list_runs',
    description: 'List VOLT evidence runs. Each run is a cryptographically linked chain of execution events.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'failed'], description: 'Filter by run status' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
    execute: async (input) => {
      try {
        const params = new URLSearchParams();
        if (input.status) params.set('status', input.status);
        params.set('limit', String(input.limit || 10));
        const data = await collectorGet(`/volt/runs?${params}`);
        return { success: true, runs: data.runs || [], total: data.total || (data.runs || []).length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  volt_verify_run: {
    name: 'volt_verify_run',
    description: 'Verify the hash chain integrity of a VOLT run. Checks that every event links correctly to the previous one via prev_hash.',
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'VOLT run ID to verify. Use "latest" for the most recent completed run.' },
      },
      required: ['run_id'],
    },
    execute: async (input) => {
      try {
        let runId = input.run_id;
        if (runId === 'latest') {
          const runs = await collectorGet('/volt/runs?status=completed&limit=1');
          if (!runs.runs?.length) return { success: true, intact: false, message: 'No completed VOLT runs found' };
          runId = runs.runs[0].run_id;
        }

        const eventsData = await collectorGet(`/volt/runs/${runId}/events`);
        const events = eventsData.events || [];
        if (events.length === 0) return { success: true, run_id: runId, intact: true, events: 0, message: 'Run has no events' };

        // AUDITUS-HONESTY-3: `GET /volt/runs/:runId/events` returns raw
        // volt_events rows `{ event_id, run_id, event_type, ts, seq, data, stored_at }`
        // (migrations/volt/000-baseline.sql:41-49) where `data` is the FULL
        // event object the writer hashed, hash/prev_hash included
        // (voltEmitter.js emit(), ~:167-187). There is NO top-level
        // events[i].hash / events[i].prev_hash — those only exist at
        // events[i].data.hash / events[i].data.prev_hash. The previous
        // linkage check read the wrong (always-undefined) path, so it never
        // actually detected a broken chain. Fixed here, plus recompute each
        // event's content hash with the SAME canonicalJSON/sha256 helpers
        // the writer used (voltEmitter.js) so a tampered event body with a
        // still-consistent prev_hash chain no longer passes as VERIFIED.
        let gaps = 0;
        let contentMismatches = 0;
        let prevChainHash = null;
        for (let i = 0; i < events.length; i++) {
          const data = events[i].data || {};
          const { hash: storedHash, ...unhashedEvent } = data;
          const recomputedHash = storedHash ? sha256(unhashedEvent) : null;
          if (!storedHash || recomputedHash !== storedHash) {
            contentMismatches++;
          }
          if (i > 0 && data.prev_hash !== prevChainHash) {
            gaps++;
          }
          prevChainHash = storedHash;
        }

        const intact = gaps === 0 && contentMismatches === 0;
        return {
          success: true,
          run_id: runId,
          intact,
          events: events.length,
          gaps,
          contentMismatches,
          confidence: intact ? 'VERIFIED' : 'TAMPERED',
          message: intact
            ? `Chain intact — ${events.length} events, 0 gaps, 0 content mismatches (content hashes + linkage verified)`
            : `Chain BROKEN — ${gaps} linkage gap(s), ${contentMismatches} content hash mismatch(es) in ${events.length} events`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  volt_certify_run: {
    name: 'volt_certify_run',
    description: 'Run a VOLT certification assessment against a run. Evaluates which tier (Bronze/Silver/Gold/Platinum) the evidence meets.',
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'VOLT run ID to certify' },
      },
      required: ['run_id'],
    },
    execute: async (input) => {
      try {
        const data = await collectorPost('/volt/certify', { run_id: input.run_id });
        return { success: true, cert_id: data.cert_id, tier: data.tier, result: data.result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  volt_create_bundle: {
    name: 'volt_create_bundle',
    description: 'Create a portable evidence bundle from a VOLT run. The bundle contains the manifest, events, and can be independently verified.',
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'VOLT run ID to bundle' },
        redact: { type: 'boolean', description: 'Redact sensitive content from the bundle (default false)' },
      },
      required: ['run_id'],
    },
    execute: async (input) => {
      try {
        const data = await collectorPost('/volt/bundles/create', {
          run_id: input.run_id,
          redact: input.redact || false,
        });
        return {
          success: true,
          bundle_id: data.bundle_id,
          event_count: data.event_count,
          download_url: `/volt/bundles/${data.bundle_id}/download`,
          message: `Bundle created with ${data.event_count} events`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ═══ WARD Witness Chain ════════════════════════════════════════════════════

  ward_verify_chain: {
    name: 'ward_verify_chain',
    description: 'Verify WARD witness chain integrity. Checks the append-only receipt digest chain for gaps or tampering.',
    input_schema: {
      type: 'object',
      properties: {
        chain_id: { type: 'string', description: 'Specific chain to verify (omit for default chain)' },
      },
    },
    execute: async (input) => {
      try {
        const result = await verifyWardChain(input.chain_id);
        if (!result.ok) return { success: false, error: result.error };

        const { chain_id, stats, witness, chainIntact, status, reason, confidence, error } = result;

        if (chainIntact === null) {
          // WARD verify was unreachable/errored — report an honest unknown,
          // never a fabricated pass.
          return {
            success: true,
            chain_id,
            totalEntries: stats.entries || 0,
            signedTips: stats.tips || 0,
            chainIntact: null,
            witnessEnabled: witness.enabled || false,
            confidence: 'UNKNOWN',
            message: `WARD verify unavailable (${error}) — cannot confirm chain integrity. Entries/tips reported from stats only.`,
          };
        }

        return {
          success: true,
          chain_id,
          totalEntries: stats.entries || 0,
          signedTips: stats.tips || 0,
          chainIntact,
          witnessEnabled: witness.enabled || false,
          confidence,
          message: chainIntact
            ? `WARD chain INTACT — ${stats.entries || 0} entries, ${stats.tips || 0} signed tips.`
            : `WARD chain ${status}${reason ? ` (${reason})` : ''} — ${stats.entries || 0} entries, ${stats.tips || 0} signed tips.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  ward_query_entries: {
    name: 'ward_query_entries',
    description: 'Query WARD witness entries with filters. Returns individual receipt digests from the append-only chain.',
    input_schema: {
      type: 'object',
      properties: {
        source_kind: { type: 'string', enum: ['AEE', 'AOCL', 'VOLT'], description: 'Filter by source protocol' },
        since: { type: 'string', description: 'ISO date — entries after this time' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    execute: async (input) => {
      try {
        const params = new URLSearchParams();
        if (input.source_kind) params.set('source_kind', input.source_kind);
        if (input.since) params.set('since', input.since);
        params.set('limit', String(input.limit || 20));
        const data = await wardGet(`/ward/entries?${params}`);
        return { success: true, entries: data.entries || [], total: data.total || (data.entries || []).length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  ward_source_breakdown: {
    name: 'ward_source_breakdown',
    description: 'Get the WARD source breakdown — how many witness entries come from AEE, AOCL, and VOLT.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const data = await wardGet('/ward/source-breakdown');
        const breakdown = {};
        for (const item of (data.breakdown || [])) {
          breakdown[item.source_kind] = item.count;
        }
        return { success: true, breakdown, total: Object.values(breakdown).reduce((a, b) => a + b, 0) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ═══ AEE Audit Trail ══════════════════════════════════════════════════════

  aee_query_envelopes: {
    name: 'aee_query_envelopes',
    description: 'Query AEE envelopes — the audit trail of all agent and human interactions. Supports filtering by intent, sender, time range.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Filter by intent prefix (e.g. "aocl.", "quox.chat.", "quox.tool.")' },
        from: { type: 'string', description: 'Filter by sender (e.g. "human.user", "agent.sentinel")' },
        to: { type: 'string', description: 'Filter by recipient' },
        since: { type: 'string', description: 'ISO date — envelopes after this time' },
        before: { type: 'string', description: 'ISO date — envelopes before this time' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        if (input.intent) params.set('intent', input.intent);
        if (input.from) params.set('from', input.from);
        if (input.to) params.set('to', input.to);
        if (input.since) params.set('after', input.since);
        if (input.before) params.set('before', input.before);
        params.set('limit', String(input.limit || 20));
        const data = await collectorGet(`/aee/query?${params}`, ctx?.orgId || null);
        return { success: true, envelopes: data.envelopes || [], total: (data.envelopes || []).length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  aee_get_stats: {
    name: 'aee_get_stats',
    description: 'Get AEE aggregate statistics — total envelopes, conversations, date range.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      try {
        const data = await collectorGet('/aee/stats');
        return {
          success: true,
          total_envelopes: data.total_envelopes || 0,
          total_conversations: data.total_conversations || 0,
          oldest: data.oldest_ts,
          newest: data.newest_ts,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  // ═══ AOCL Policy Decisions ════════════════════════════════════════════════

  aocl_get_decisions: {
    name: 'aocl_get_decisions',
    description: 'Query AOCL policy enforcement decisions. Shows which layers fired, what was enforced or allowed.',
    input_schema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Filter by AOCL layer (e.g. "L3", "L8")' },
        since: { type: 'string', description: 'ISO date — decisions after this time' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    execute: async (input, ctx) => {
      try {
        const params = new URLSearchParams();
        params.set('intent', input.layer ? `aocl.layer.${input.layer.toLowerCase()}` : 'aocl.');
        if (input.since) params.set('after', input.since);
        params.set('limit', String(input.limit || 20));
        const data = await collectorGet(`/aee/query?${params}`, ctx?.orgId || null);
        const decisions = (data.envelopes || []).map(e => ({
          id: e.id,
          layer: e.intent?.replace('aocl.layer.complete.', '') || e.intent,
          timestamp: e.ts,
          from: e.from,
          outcome: e.payload?.outcome || e.payload?.action || 'unknown',
        }));
        return { success: true, decisions, total: decisions.length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

module.exports = { COMPLIANCE_TOOLS };
