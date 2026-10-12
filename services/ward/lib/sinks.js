/**
 * WARD-EXT-1: Pluggable Sink Registry
 *
 * Central registry for external tip publication backends.
 * Each sink is a module in ./sinks/ with { type, publish(tip, config), verify(sink_ref) }.
 *
 * Default configuration: RFC 3161 TSA is always enabled (zero-config).
 * Additional sinks (webhook, gitea) are enabled via environment variables.
 *
 * SPEC §12.3 — sink_ref format: <type>:<identifier>#<tip_seq>
 */

// ── Built-in sinks ──
import * as tsaSink from './sinks/tsa.js';
import * as giteaSink from './sinks/gitea.js';
import * as webhookSink from './sinks/webhook.js';
import * as githubSink from './sinks/github.js';
import * as gitlabSink from './sinks/gitlab.js';
import * as s3Sink from './sinks/s3.js';
import * as quoxVerifiedSink from './sinks/quox-verified.js';
import { getDb, updateTipReceipt } from './store.js';
import { resolveSinkCredential } from './sinkCredentials.js';
import { getInstanceNumber } from './configResolver.js';

// ── Registry ──
const sinkRegistry = new Map();
sinkRegistry.set('tsa', tsaSink);
sinkRegistry.set('gitea', giteaSink);
sinkRegistry.set('webhook', webhookSink);
sinkRegistry.set('github', githubSink);
sinkRegistry.set('gitlab', gitlabSink);
sinkRegistry.set('s3', s3Sink);
// LICENSE-LAUNCH LL-9i2 (Quox Verified): countersigns tip digests via the
// quox.ai control plane. Opt-in, default OFF until the service is live.
sinkRegistry.set('quox-verified', quoxVerifiedSink);

// ── G3d: external-sink circuit breaker + active-sink cache ──
// Tip publication is fire-and-forget I/O, not the CPU DoS (that was the unbounded
// verify). But with NO backoff, a down/429-ing external sink (countersign, TSA)
// was retried on EVERY tip: log-spam, wasted external calls, and a per-tip auth
// hit via resolveEnabled that piled onto the collector when it was already busy.
// This applies the loop-hygiene triad (failure accounting, backoff, retirement).

// clock indirection so tests can inject time; falls back to real time in prod.
let _now = () => Date.now();
export function __setSinkClock(fn) { _now = fn || (() => Date.now()); }

const CB_FAILURE_THRESHOLD = 3;     // consecutive failures before opening
const CB_BASE_COOLDOWN_MS = 30_000; // first cooldown; doubles per extra failure
const CB_MAX_COOLDOWN_MS = 10 * 60_000;
const sinkHealth = new Map(); // type -> { failures, cooldownUntil, loggedOpen }

export function sinkInCooldown(type) {
  const h = sinkHealth.get(type);
  return !!(h && h.cooldownUntil && _now() < h.cooldownUntil);
}
export function recordSinkOutcome(type, success) {
  let h = sinkHealth.get(type);
  if (!h) { h = { failures: 0, cooldownUntil: 0, loggedOpen: false }; sinkHealth.set(type, h); }
  if (success) {
    if (h.failures > 0 || h.cooldownUntil) console.log(`[WARD] sink ${type} recovered, circuit closed`);
    h.failures = 0; h.cooldownUntil = 0; h.loggedOpen = false;
    return;
  }
  h.failures += 1;
  if (h.failures >= CB_FAILURE_THRESHOLD) {
    const extra = h.failures - CB_FAILURE_THRESHOLD;
    const cooldown = Math.min(CB_BASE_COOLDOWN_MS * (2 ** extra), CB_MAX_COOLDOWN_MS);
    h.cooldownUntil = _now() + cooldown;
    if (!h.loggedOpen) {
      console.warn(`[WARD] sink ${type} failed ${h.failures}x, circuit OPEN for ${Math.round(cooldown / 1000)}s (suppressing per-tip retries)`);
      h.loggedOpen = true;
    }
  }
}
export function __resetSinkHealth() { sinkHealth.clear(); }

/**
 * Register a custom sink.
 * @param {string} type - Unique sink type identifier
 * @param {{ publish: Function, verify?: Function }} handler
 */
export function registerSink(type, handler) {
  if (!handler.publish) throw new Error(`Sink ${type} must have a publish() function`);
  sinkRegistry.set(type, { type, ...handler });
}

/**
 * VAULT-INTEG P3 — resolve a single secret field for a sink, vault-first
 * (INSTANCE scope, via sinkCredentials.resolveSinkCredential), env-last.
 * A lease-blocked vault credential is treated the same as "no vault
 * credential" here (never throws — see sinkCredentials.js) so a sink with a
 * plain env var configured keeps working even under lease enforcement.
 *
 * @param {string} toolType - integration_type ('github' | 'gitlab' | 'aws_s3' | 'gitea')
 * @param {string} field - field name on the decrypted vault credential (e.g. 'token')
 * @param {string} envVarName - env var to fall back to (e.g. 'WARD_GITHUB_TOKEN')
 * @param {object} [deps] - injectable deps for testing (see sinkCredentials.js)
 * @returns {Promise<string>} the resolved secret, or '' if neither source has it
 */
export async function resolveSinkSecret(toolType, field, envVarName, deps) {
  const resolved = await resolveSinkCredential(toolType, deps);
  const vaultValue = resolved && !resolved.leaseBlocked && resolved.credentials && resolved.credentials[field];
  if (vaultValue) return vaultValue;

  const envValue = process.env[envVarName] || '';
  if (envValue) {
    console.warn(`[WARD] ${toolType} sink: no vault credential for '${field}' — using ${envVarName} env fallback`);
  }
  return envValue;
}

// getActiveSinks() runs on every evidence publish; cache the ward_webhook
// lookup for 60s so a tip does not cost a vault round trip (a rotated header
// applies within a minute).
const WARD_WEBHOOK_TTL_MS = 60_000;
let _wardWebhookCache = null; // { at, value }
export function __resetWardWebhookCache() { _wardWebhookCache = null; }
async function resolveWardWebhook() {
  if (_wardWebhookCache && _now() - _wardWebhookCache.at < WARD_WEBHOOK_TTL_MS) return _wardWebhookCache.value;
  const resolved = await resolveSinkCredential('ward_webhook');
  const creds = resolved && !resolved.leaseBlocked && resolved.credentials ? resolved.credentials : {};
  let url = creds.url || '';
  let authHeader = creds.auth_header || '';
  if (!url && process.env.WARD_WEBHOOK_URL) url = process.env.WARD_WEBHOOK_URL;
  if (!authHeader && process.env.WARD_WEBHOOK_AUTH_HEADER) {
    authHeader = process.env.WARD_WEBHOOK_AUTH_HEADER;
    console.warn("[WARD] ward_webhook sink: no vault credential for 'auth_header', using WARD_WEBHOOK_AUTH_HEADER env fallback (move it to the vault)");
  }
  const value = { url, authHeader };
  _wardWebhookCache = { at: _now(), value };
  return value;
}

/**
 * Get all registered sink types.
 */
export function getSinkTypes() {
  return Array.from(sinkRegistry.keys());
}

/**
 * Get active sink configurations.
 * Returns array of { type, config } for sinks that are configured.
 *
 * TSA is always active (default). Others require env vars. The quox-verified
 * sink is resolved from a server-side instance_config value (with the env flag
 * as the fallback default) — see quoxVerifiedSink.resolveEnabled — so this
 * function is async.
 *
 * @returns {Promise<Array<{ type: string, config: object }>>}
 */
export async function getActiveSinks() {
  const active = [];

  // TSA: always on unless explicitly disabled
  if (process.env.WARD_TSA_DISABLED !== '1') {
    active.push({
      type: 'tsa',
      config: { tsa_url: process.env.WARD_TSA_URL || process.env.VOLT_TSA_URL || 'https://freetsa.org/tsr' }
    });
  }

  // Webhook (SETEC S4, 2026-10-09): vault-first from the dedicated
  // 'ward_webhook' credential type (url + auth_header, the header is sent as
  // Authorization), WARD_WEBHOOK_URL / WARD_WEBHOOK_AUTH_HEADER env last. A
  // dedicated type, NOT the generic notification 'webhook' type: reusing that
  // would start streaming evidence to whatever chat webhook an instance has.
  const wardWebhook = await resolveWardWebhook();
  if (wardWebhook.url) {
    active.push({
      type: 'webhook',
      config: { webhook_url: wardWebhook.url, auth_header: wardWebhook.authHeader || null }
    });
  }

  // Gitea: enabled if URL configured and a token resolves (vault-first,
  // WARD_GITEA_TOKEN env last — VAULT-INTEG P3).
  if (process.env.WARD_GITEA_URL) {
    const token = await resolveSinkSecret('gitea', 'token', 'WARD_GITEA_TOKEN');
    if (token) {
      active.push({
        type: 'gitea',
        config: {
          gitea_url: process.env.WARD_GITEA_URL,
          owner: process.env.WARD_GITEA_OWNER || 'quox',
          repo: process.env.WARD_GITEA_REPO || 'ward-evidence',
          token,
          target: process.env.WARD_GITEA_TARGET || ''
        }
      });
    }
  }

  // GitHub: enabled if owner + repo configured and a token resolves
  // (vault-first, WARD_GITHUB_TOKEN env last — VAULT-INTEG P3).
  if (process.env.WARD_GITHUB_OWNER && process.env.WARD_GITHUB_REPO) {
    const token = await resolveSinkSecret('github', 'token', 'WARD_GITHUB_TOKEN');
    if (token) {
      active.push({
        type: 'github',
        config: {
          github_token: token,
          owner: process.env.WARD_GITHUB_OWNER,
          repo: process.env.WARD_GITHUB_REPO,
          api_url: process.env.WARD_GITHUB_API || undefined
        }
      });
    }
  }

  // GitLab: enabled if project ID configured and a token resolves
  // (vault-first 'private_token' field, WARD_GITLAB_TOKEN env last —
  // VAULT-INTEG P3).
  if (process.env.WARD_GITLAB_PROJECT_ID) {
    const token = await resolveSinkSecret('gitlab', 'private_token', 'WARD_GITLAB_TOKEN');
    if (token) {
      active.push({
        type: 'gitlab',
        config: {
          gitlab_token: token,
          project_id: process.env.WARD_GITLAB_PROJECT_ID,
          gitlab_url: process.env.WARD_GITLAB_URL || undefined
        }
      });
    }
  }

  // S3 Object Lock: enabled if bucket configured. Access/secret key resolve
  // vault-first (aws_s3 credential), WARD_S3_ACCESS_KEY/SECRET_KEY env last
  // — VAULT-INTEG P3. Unlike the sinks above, S3 can run on ambient/default
  // AWS credentials with neither source set, so a missing key never disables
  // the sink — only the bucket gates activation.
  if (process.env.WARD_S3_BUCKET) {
    const [accessKey, secretKey] = await Promise.all([
      resolveSinkSecret('aws_s3', 'access_key_id', 'WARD_S3_ACCESS_KEY'),
      resolveSinkSecret('aws_s3', 'secret_access_key', 'WARD_S3_SECRET_KEY'),
    ]);
    active.push({
      type: 's3',
      config: {
        bucket: process.env.WARD_S3_BUCKET,
        region: process.env.WARD_S3_REGION || 'us-east-1',
        access_key: accessKey || undefined,
        secret_key: secretKey || undefined,
        // SETEC S3: stored WARD_S3_RETENTION_DAYS setting wins over env/365
        retention_days: await getInstanceNumber('WARD_S3_RETENTION_DAYS', parseInt(process.env.WARD_S3_RETENTION_DAYS, 10) || 365)
      }
    });
  }

  // Quox Verified: countersign tip digests via the quox.ai control plane.
  // NO-ENV-ONLY-CONFIG (LL-9i3): the switch is a server-side instance_config
  // value the dashboard reads and writes (licensing.quox_verified.enabled),
  // resolved by quoxVerifiedSink.resolveEnabled with the env flag
  // WARD_QUOX_VERIFIED_ENABLED as the fallback default; the instance_config
  // value wins when set. The countersign is an ADDITION to local evidence,
  // never a gate, so a disabled or failing sink never affects other sinks.
  //   - control_plane_url: where /api/verified/countersign lives (api.quox.ai),
  //     resolved the same way licenseClient.js resolves it (QUOX_LICENSE_SERVER).
  //   - auth_base_url + service_key: the internal accessor channel.
  const quoxVerifiedConfig = {
    control_plane_url: process.env.QUOX_LICENSE_SERVER || 'https://api.quox.ai',
    auth_base_url: process.env.AUTH_SERVICE_URL || 'http://auth:3101',
    service_key: process.env.INTERNAL_SERVICE_KEY || null,
  };
  if (await quoxVerifiedSink.resolveEnabled(quoxVerifiedConfig)) {
    active.push({ type: 'quox-verified', config: quoxVerifiedConfig });
  }

  return active;
}

/**
 * Publish a tip to ALL active sinks. Non-blocking, never throws.
 * Returns array of results: [{ type, success, sink_ref, error }]
 *
 * @param {object} tip - Signed WARD tip
 * @returns {Promise<Array<{type: string, success: boolean, sink_ref: string|null, error: string|null}>>}
 */
export async function publishToAllSinks(tip) {
  const activeSinks = await getActiveSinks();
  const results = [];

  if (activeSinks.length === 0) {
    console.warn('[WARD] No sinks configured, tip will not be published externally');
    return [{ type: 'none', success: false, sink_ref: null, error: 'No sinks configured' }];
  }

  for (const { type, config } of activeSinks) {
    const sink = sinkRegistry.get(type);
    if (!sink) {
      results.push({ type, success: false, sink_ref: null, error: `Unknown sink type: ${type}` });
      continue;
    }

    // G3d: if this sink's circuit is open, skip it WITHOUT the network call. A
    // down external endpoint does not get hammered once per tip.
    if (sinkInCooldown(type)) {
      results.push({ type, success: false, sink_ref: null, error: 'circuit_open', skipped: true });
      continue;
    }

    try {
      const result = await sink.publish(tip, config);
      results.push({ type, ...result });
      recordSinkOutcome(type, !!result.success);
      if (result.success) {
        console.log(`[WARD] Tip ${tip.tip_seq} published to ${type}: ${result.sink_ref}`);
      } else if (!sinkInCooldown(type)) {
        // Only log the first failures; once the circuit opens, recordSinkOutcome
        // has already logged it and we stop the per-tip spam.
        console.warn(`[WARD] Tip ${tip.tip_seq} failed to publish to ${type}: ${result.error}`);
      }
    } catch (err) {
      recordSinkOutcome(type, false);
      if (!sinkInCooldown(type)) {
        console.warn(`[WARD] Tip ${tip.tip_seq} sink ${type} error:`, err.message);
      }
      results.push({ type, success: false, sink_ref: null, error: err.message });
    }
  }

  return results;
}

/**
 * Legacy export — kept for backward compatibility with api-cjs.cjs
 */
export async function publishTipToGitea(tip, opts) {
  return giteaSink.publish(tip, {
    gitea_url: opts.giteaUrl,
    owner: opts.owner,
    repo: opts.repo,
    token: opts.token,
    target: opts.target
  });
}

export async function createAndPublishTip(createTipFn, chainId, opts) {
  const tip = createTipFn(chainId, {
    notes: opts.notes,
    keypair: opts.keypair
  });

  if (!tip) return { tip: null, published: false, sink_ref: null, error: 'No tip created' };

  // Publish to all active sinks
  const results = await publishToAllSinks(tip);
  const firstSuccess = results.find(r => r.success);

  // Store all successful sink_refs on the tip
  if (firstSuccess) {
    try {
      const allRefs = results.filter(r => r.success).map(r => r.sink_ref).join(',');
      getDb().prepare('UPDATE ward_tips SET sink_ref = ? WHERE tip_id = ?')
        .run(allRefs, tip.tip_id);
      tip.sink_ref = allRefs;
    } catch {
      // Non-fatal
    }
  }

  // AUDIT-REAL #3: persist the RFC 3161 receipt DER from the `tsa` sink
  // (previously discarded — see hooks.js publishTipToSinks for the same fix
  // on the primary auto-tip path).
  const tsaResult = results.find(r => r.type === 'tsa' && r.success && r.tsr_base64);
  if (tsaResult) {
    try {
      updateTipReceipt(tip.tip_id, tsaResult.tsr_base64);
      tip.tsr = tsaResult.tsr_base64;
    } catch {
      // Non-fatal
    }
  }

  return {
    tip,
    published: !!firstSuccess,
    sink_ref: firstSuccess?.sink_ref || null,
    results,
    error: firstSuccess ? null : results.map(r => r.error).filter(Boolean).join('; ')
  };
}
