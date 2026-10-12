/**
 * MON-GOV-INT Phase 1: Governance ticket dispatcher.
 *
 * Fire-and-forget orchestration of ticket creation for governance
 * incidents — mirrors governanceWebhookDispatcher.js one seam over:
 * matching → reserve-then-send dedup/rate guard → credential resolution
 * → format → adapter call → record. Never throws; every failure is
 * caught, recorded on the ticket row + config delivery state, and folded
 * into the circuit breaker.
 *
 * Storm-race note (plan §11.1): a burst of N *distinct* incidents means
 * N parallel dispatchIncidentTickets() calls. The incident-level dedup_key
 * upsert does NOT protect against this — only the reserve-then-send
 * transaction below does. The count-then-insert must happen inside a
 * single synchronous better-sqlite3 transaction (reserveTicketRow), never
 * as a separate SELECT then a later INSERT, or all N callers can read
 * "under limit" before any of them commits.
 */

const { getMatchingTicketConfigs, updateTicketConfig } = require('./governanceTicketConfig.js');
const { formatTicket } = require('./governanceTicketFormatter.js');
const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');
const jiraAdapter = require('./ticketing/jira.js');

const AUTH_HOST = process.env.AUTH_HOST || 'auth';
const AUTH_PORT = process.env.AUTH_PORT || '3101';
const AUTH_BASE_URL = `http://${AUTH_HOST}:${AUTH_PORT}`;

// Mirrors governanceWebhookDispatcher.js's CIRCUIT_BREAKER_THRESHOLD.
const CIRCUIT_BREAKER_THRESHOLD = 10;
const DEFAULT_ENVELOPE_LIMIT = 50;
const DEFAULT_CREDENTIAL_TIMEOUT_MS = 5000;

const ADAPTERS = {
  jira: jiraAdapter,
};

/**
 * Schema for the delivery-record table this dispatcher writes to. Also
 * owned by migrations/volt/001-governance-ticketing.sql — this call is the
 * same idempotent redundant-safety-net pattern used elsewhere for voltDb
 * tables (see server.js's initGovernanceIncidents / initGovernanceWebhookConfig
 * comments), and lets tests stand up the table without running the full
 * migration runner.
 */
function initGovernanceIncidentTickets(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_incident_tickets (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      ticket_ref TEXT,
      ticket_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_tickets_dedup
      ON governance_incident_tickets(incident_id, config_id);
    CREATE INDEX IF NOT EXISTS idx_incident_tickets_incident ON governance_incident_tickets(incident_id);
    CREATE INDEX IF NOT EXISTS idx_incident_tickets_config_created
      ON governance_incident_tickets(config_id, created_at);
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function generateTicketRowId() {
  return `TKR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Resolve the ticket config's vault credential, org-scoped. Reuses
 * GET /api/setup/internal/credential-decrypt/:id?org_id=<orgId> — the
 * existing internal endpoint already relied on by screencap — which
 * enforces the credential's org_id === the caller-supplied org_id
 * server-side (VAULT-AUDIT P5.A1 / F12) and returns 404 (indistinguishable
 * from "not found") on mismatch. This gives the org-scoping the plan's
 * risk #3 calls for without any auth-service change: a ticket config
 * pointed at another org's credential simply cannot resolve it.
 */
async function resolveCredential(credentialId, orgId, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CREDENTIAL_TIMEOUT_MS } = {}) {
  if (!credentialId || !orgId) return { error: 'missing_credential_id_or_org' };
  try {
    const url = `${AUTH_BASE_URL}/api/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: buildInternalServiceHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return { error: resp.status === 404 ? 'credentials_missing' : `credential_resolve_failed:${resp.status}` };
    }
    const data = await resp.json();
    if (!data || !data.credentials || typeof data.credentials !== 'object') {
      return { error: 'credentials_missing' };
    }
    return { fields: data.credentials };
  } catch (err) {
    return { error: `credential_resolve_error:${err?.message || 'unknown'}` };
  }
}

function envelopesForIncident(aeeDb, incident, limit = DEFAULT_ENVELOPE_LIMIT) {
  if (!aeeDb || !incident?.corr) return [];
  try {
    return aeeDb
      .prepare('SELECT id, ts, type, "from", "to", intent FROM envelopes WHERE corr = ? ORDER BY ts ASC LIMIT ?')
      .all(incident.corr, limit);
  } catch (err) {
    // Non-fatal — mirrors server.js:12743's envelope-lookup-failure pattern.
    // The ticket still ships without a timeline.
    console.warn('[MON-GOV-INT] envelope lookup failed (non-fatal):', err.message);
    return [];
  }
}

function dashboardUrlFor(incident) {
  const base = process.env.QUOX_PUBLIC_URL || '';
  return `${base}/compliance?incident=${incident.id}`;
}

/**
 * Reserve-then-send: inside ONE synchronous better-sqlite3 transaction,
 * check the rate limit and insert a 'pending' ticket row BEFORE any
 * network call. The UNIQUE(incident_id, config_id) index inside the same
 * transaction collapses concurrent dispatch of the same incident into a
 * single winner (the loser sees a constraint violation, not an error).
 *
 * Returns { row, skipped, reason }. `row` is non-null only when this
 * caller won the reservation and must proceed to send.
 */
function reserveTicketRow(db, cfg, incident) {
  const reserve = db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM governance_incident_tickets WHERE incident_id = ? AND config_id = ?')
      .get(incident.id, cfg.id);
    if (existing) return { row: existing, skipped: true, reason: 'already_ticketed' };

    // Count 'pending' AND 'created' rows — not just 'created'. This is the
    // load-bearing fix from the plan's adversarial second pass (§11.1): a
    // storm of N *distinct* incidents fires N concurrent dispatch calls,
    // each of which reserves synchronously but finalizes only after an
    // async network round trip. If the count only looked at 'created' rows,
    // every reservation in the initial synchronous burst would see the
    // limit as unreached (nothing has finalized yet) and all N would pass.
    // Counting 'pending' rows too makes the reservation itself count
    // toward the limit the instant it lands, closing that race.
    const windowStart = new Date(Date.now() - (cfg.rate_limit_window_s || 300) * 1000).toISOString();
    const { n: count } = db
      .prepare(`
        SELECT COUNT(*) AS n FROM governance_incident_tickets
        WHERE config_id = ? AND status IN ('pending', 'created') AND created_at > ?
      `)
      .get(cfg.id, windowStart);

    if (count >= (cfg.rate_limit_max || 10)) {
      db.prepare(`
        UPDATE governance_ticket_config
        SET suppressed_count = suppressed_count + 1, last_error = 'rate_limited', updated_at = ?
        WHERE id = ?
      `).run(nowIso(), cfg.id);
      return { row: null, skipped: true, reason: 'rate_limited' };
    }

    const id = generateTicketRowId();
    const ts = nowIso();
    const row = {
      id,
      incident_id: incident.id,
      config_id: cfg.id,
      org_id: cfg.org_id,
      provider: cfg.provider,
      ticket_ref: null,
      ticket_url: null,
      status: 'pending',
      error: null,
      created_at: ts,
      updated_at: ts,
    };

    try {
      db.prepare(`
        INSERT INTO governance_incident_tickets (
          id, incident_id, config_id, org_id, provider,
          ticket_ref, ticket_url, status, error, created_at, updated_at
        ) VALUES (
          @id, @incident_id, @config_id, @org_id, @provider,
          @ticket_ref, @ticket_url, @status, @error, @created_at, @updated_at
        )
      `).run(row);
    } catch (err) {
      // Concurrent dispatch of the same (incident, config) — the UNIQUE
      // index caught the race. Whoever landed first wins; we defer to it.
      if (/UNIQUE/i.test(err.message)) {
        const winner = db
          .prepare('SELECT * FROM governance_incident_tickets WHERE incident_id = ? AND config_id = ?')
          .get(incident.id, cfg.id);
        return { row: winner, skipped: true, reason: 'already_ticketed' };
      }
      throw err;
    }

    return { row, skipped: false, reason: null };
  });

  return reserve();
}

function finalizeTicketRow(db, rowId, patch) {
  const setClauses = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    setClauses.push(`${key} = ?`);
    params.push(value);
  }
  setClauses.push('updated_at = ?');
  params.push(nowIso());
  db.prepare(`UPDATE governance_incident_tickets SET ${setClauses.join(', ')} WHERE id = ?`).run(...params, rowId);
}

/**
 * Stamp delivery state on the config row + fold into the circuit breaker.
 * Mirrors governanceWebhookDispatcher.js's recordDelivery().
 */
function recordConfigDelivery(db, cfg, { ok, error }) {
  const nextConsecutive = ok ? 0 : (cfg.consecutive_failures || 0) + 1;

  const patch = {
    last_delivery_at: nowIso(),
    last_status: ok ? 1 : 0,
    last_error: ok ? null : error,
    consecutive_failures: nextConsecutive,
  };

  if (!ok && nextConsecutive >= CIRCUIT_BREAKER_THRESHOLD) {
    patch.enabled = false;
    patch.last_error = `${error} (circuit breaker opened at ${nextConsecutive} consecutive failures)`;
  }

  try {
    updateTicketConfig(db, cfg.id, patch);
  } catch (err) {
    console.warn('[MON-GOV-INT] ticket config state update failed:', err.message);
  }
}

/**
 * Create (or skip) a ticket for a single (incident, config) pair. Never
 * throws — every failure path returns a result object instead.
 */
async function dispatchOneTicket({ voltDb, aeeDb }, incident, cfg, options = {}) {
  let reserved;
  try {
    reserved = reserveTicketRow(voltDb, cfg, incident);
  } catch (err) {
    return { config_id: cfg.id, ok: false, error: err?.message || 'reserve_failed' };
  }

  if (reserved.skipped) {
    return { config_id: cfg.id, ok: false, skipped: true, reason: reserved.reason };
  }

  const row = reserved.row;

  try {
    const credResult = await resolveCredential(cfg.credential_id, cfg.org_id, options);
    if (credResult.error) {
      finalizeTicketRow(voltDb, row.id, { status: 'failed', error: credResult.error });
      recordConfigDelivery(voltDb, cfg, { ok: false, error: credResult.error });
      return { config_id: cfg.id, ok: false, error: credResult.error };
    }

    const adapter = ADAPTERS[cfg.provider];
    if (!adapter) {
      const error = `unsupported_provider:${cfg.provider}`;
      finalizeTicketRow(voltDb, row.id, { status: 'failed', error });
      recordConfigDelivery(voltDb, cfg, { ok: false, error });
      return { config_id: cfg.id, ok: false, error };
    }

    const envelopes = envelopesForIncident(aeeDb, incident);
    const dashboardUrl = dashboardUrlFor(incident);
    const settings = cfg.settings_json && typeof cfg.settings_json === 'object' ? cfg.settings_json : {};
    const formatted = formatTicket(cfg.provider, incident, { envelopes, dashboardUrl, settings });

    const credentials = typeof adapter.aliasCredentials === 'function'
      ? adapter.aliasCredentials(credResult.fields)
      : credResult.fields;

    const result = await adapter.createTicket(credentials, settings, formatted, options);

    finalizeTicketRow(voltDb, row.id, {
      status: 'created',
      ticket_ref: result?.ref || null,
      ticket_url: result?.url || null,
      error: null,
    });
    recordConfigDelivery(voltDb, cfg, { ok: true });
    return { config_id: cfg.id, ok: true, ref: result?.ref || null, url: result?.url || null };
  } catch (err) {
    const error = err?.message || 'ticket_creation_failed';
    try {
      finalizeTicketRow(voltDb, row.id, { status: 'failed', error });
    } catch (finalizeErr) {
      console.warn('[MON-GOV-INT] ticket row finalize failed (non-fatal):', finalizeErr.message);
    }
    recordConfigDelivery(voltDb, cfg, { ok: false, error });
    return { config_id: cfg.id, ok: false, error };
  }
}

/**
 * Fan out a single incident to every matching + enabled ticket config.
 * Fully fire-and-forget — never rejects, never throws. Returns an array
 * of per-config results (mirrors dispatchIncident() in
 * governanceWebhookDispatcher.js).
 */
async function dispatchIncidentTickets(dbs, incident, options = {}) {
  const { voltDb } = dbs || {};
  if (!voltDb || !incident) return [];

  let matches = [];
  try {
    matches = getMatchingTicketConfigs(voltDb, incident);
  } catch (err) {
    console.warn('[MON-GOV-INT] getMatchingTicketConfigs failed (non-fatal):', err.message);
    return [];
  }
  if (matches.length === 0) return [];

  return Promise.all(
    matches.map((cfg) =>
      dispatchOneTicket(dbs, incident, cfg, options).catch((err) => ({
        config_id: cfg.id,
        ok: false,
        error: err?.message || 'dispatch_failed',
      }))
    )
  );
}

module.exports = {
  CIRCUIT_BREAKER_THRESHOLD,
  initGovernanceIncidentTickets,
  dispatchIncidentTickets,
  dispatchOneTicket,
  reserveTicketRow,
  resolveCredential,
  recordConfigDelivery,
};
