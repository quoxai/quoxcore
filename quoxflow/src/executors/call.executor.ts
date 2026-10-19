/**
 * Call Executor
 *
 * Handles HTTP calls to external services with evidence collection.
 * This single executor replaces 400+ n8n integration nodes.
 */

import { ulid } from 'ulid';
import { promises as dns } from 'node:dns';
import { NodeExecutor, ExecutorResult, AmbiguousDispatchError } from './executor.interface.js';
import { Node, CallNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { captureToolArgs, captureToolResult } from './lib/tool-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';
import type { EvidenceStore } from '../evidence/types.js';

// SSRF protection: block requests to private/internal networks unless
// the operator explicitly allowlists a CIDR range via
// QUOXFLOW_ALLOWED_PRIVATE (comma-separated, e.g.
// "192.168.1.0/24,10.0.0.0/8"). Loopback (127/8 + ::1) is always blocked
// — there's no legitimate workflow reason to call back into the QuoxFlow
// container. The allowlist is the same pattern screencap uses
// (SCREENCAP_ALLOWED_PRIVATE).
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::1]']);

// STABILITY-AUDITS: retry.attempts was user-controlled and unbounded, and
// retries with no explicit backoff.delay fired back-to-back (setTimeout
// coerces an undefined/NaN delay to 0ms) — a hostile or misconfigured
// workflow could hammer an upstream indefinitely. Clamp attempts and always
// apply a backoff delay between retries.
const MAX_RETRY_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 1000;

// QUOXTRUST-B5 audit finding: an ambiguous transport failure (the request
// send phase completed, or could not be ruled out, before the connection
// dropped) was retried unconditionally, re-sending a non-idempotent request
// and risking a duplicate consequential effect (e.g. a double charge). Only
// methods that are safe to repeat by nature are treated as idempotent here.
// DELETE is deliberately NOT included: while idempotent by HTTP spec
// (repeat deletes leave the same end state), many real upstreams treat a
// second DELETE as a distinct, billable, or logged event, so it is treated
// as non-idempotent unless the caller supplies an idempotency key.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'OPTIONS']);
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

function hasIdempotencyKey(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() === IDEMPOTENCY_KEY_HEADER);
}

/**
 * True when a transient failure on this request is always safe to retry,
 * regardless of what phase the failure happened in, because either the
 * method itself is idempotent (repeating it is a no-op) or the caller has
 * supplied an idempotency key the upstream can use to de-duplicate a
 * re-sent request.
 */
function isSafeToRetryRegardlessOfPhase(method: string, headers: Record<string, string>): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase()) || hasIdempotencyKey(headers);
}

/**
 * True only for failures where the request definitely never reached the
 * upstream, so a non-idempotent retry cannot duplicate an effect. Kept
 * deliberately narrow (DNS/connect-refused only): anything else, including
 * a timeout, is treated as ambiguous per the conservative default below.
 */
function isDefinitelyNotSent(error: Error): boolean {
  const directCode = (error as Error & { code?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeObj = (cause && typeof cause === 'object') ? cause as Record<string, unknown> : null;
  const causeCode = causeObj && typeof causeObj.code === 'string' ? causeObj.code : undefined;
  const code = typeof directCode === 'string' ? directCode : causeCode;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED';
}

// TRUST-PROOF audit finding (HIGH): fetch() was called with the default
// redirect-following behaviour and validateUrl() was only ever checked
// against the ORIGINAL url — a 3xx response pointing at a private/
// link-local/metadata target was followed with no re-validation.
// executeWithRetry now fetches with `redirect: 'manual'` and re-runs
// validateUrl() on every hop, capped here.
const MAX_REDIRECT_HOPS = 5;

// STABILITY-AUDITS: response bodies were read fully into memory via
// response.json()/text()/arrayBuffer() with no size limit — a large or
// hostile upstream response could OOM the process. Cap it.
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // 25MB

// QUOXTRUST F13 (engagement c4): the evidence store previously persisted request
// headers VERBATIM, leaking Authorization / API keys / Cookie / custom secret
// headers as plaintext into durable evidence (T-CONF). Redact header VALUES for
// the evidence copy by a SAFE-NAME ALLOWLIST — an allowlist, not a denylist,
// because an oddly-named secret header (X-Company-Api-Thing) slips a denylist
// (the 2026-08-09 env-dump lesson). Header NAMES are kept (evidence still shows
// which headers were sent); the actual outbound request is unaffected.
const EVIDENCE_SAFE_HEADER_NAMES = new Set([
  'accept', 'accept-encoding', 'accept-language', 'accept-charset',
  'content-type', 'content-length', 'content-encoding', 'content-language',
  'cache-control', 'user-agent', 'host', 'connection', 'date',
  'origin', 'referer', 'pragma', 'expect', 'te', 'trailer', 'via',
]);

/**
 * Redact header values for evidence persistence. Non-allowlisted header values
 * become "[REDACTED]"; names are preserved. Returns a NEW object; the input
 * (the real outbound headers) is never mutated.
 */
export function redactHeadersForEvidence(headers: unknown): Record<string, unknown> | unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k] = EVIDENCE_SAFE_HEADER_NAMES.has(k.toLowerCase()) ? v : '[REDACTED]';
  }
  return out;
}

interface CidrRange {
  network: number;  // 32-bit unsigned
  mask: number;     // bitmask for the prefix
}

function parseCidr(cidr: string): CidrRange | null {
  const [addr, prefixStr] = cidr.split('/');
  if (!addr || !prefixStr) return null;
  const prefix = Number.parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  // eslint-disable-next-line no-bitwise
  const network = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  // eslint-disable-next-line no-bitwise
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // eslint-disable-next-line no-bitwise
  return { network: (network & mask) >>> 0, mask };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  // eslint-disable-next-line no-bitwise
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function getAllowedRanges(): CidrRange[] {
  const raw = process.env.QUOXFLOW_ALLOWED_PRIVATE || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((r): r is CidrRange => r !== null);
}

function isAllowlisted(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const ranges = getAllowedRanges();
  // `>>> 0` coerces back to unsigned — without it, bitwise AND on values
  // ≥ 0x80000000 (i.e. any IP starting 128.x.x.x or higher) returns a
  // signed-negative number that never equals the unsigned r.network.
  // eslint-disable-next-line no-bitwise
  return ranges.some(r => ((ipInt & r.mask) >>> 0) === r.network);
}

function isLoopback(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts[0] === 127) return true;
  if (ip === '::1' || ip === '::') return true;
  return false;
}

function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 127) return true;                           // 127.0.0.0/8
    if (parts[0] === 10) return true;                            // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;  // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;      // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;      // 169.254.0.0/16
    if (parts[0] === 0) return true;                             // 0.0.0.0/8
  }
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  return false;
}

// TRUST-PROOF audit finding (HIGH): isPrivateIP() above only recognises
// IPv4 private ranges plus the two IPv6 loopback spellings. A DNS-resolved
// AAAA record landing in fe80::/10 (link-local) or fc00::/7 (unique-local,
// the IPv6 analogue of RFC1918) would previously pass straight through.
function isPrivateOrLinkLocalIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // Unique-local: fc00::/7 (first hex nibble c or d)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // Link-local (includes the 169.254.0.0/16 equivalent + metadata scope):
  // fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and check the embedded IPv4.
  const v4Mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped) return isPrivateIP(v4Mapped[1]);
  return false;
}

/**
 * Checks a single resolved address (from DNS or a redirect target) against
 * the same block rules as the literal-hostname path, honouring the
 * QUOXFLOW_ALLOWED_PRIVATE allowlist for IPv4. Returns a block reason, or
 * null if the address is allowed.
 */
function checkResolvedAddress(address: string): string | null {
  if (isLoopback(address)) {
    return `Loopback not allowed: ${address}`;
  }
  const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
  if (isIPv4) {
    if (isPrivateIP(address) && !isAllowlisted(address)) {
      return `Private IP not allowed: ${address} (set QUOXFLOW_ALLOWED_PRIVATE to allowlist a CIDR range)`;
    }
    return null;
  }
  // IPv6
  if (isPrivateOrLinkLocalIPv6(address)) {
    return `Private/link-local IPv6 address not allowed: ${address}`;
  }
  return null;
}

export async function validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF_BLOCKED: Invalid URL: ${url}`);
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF_BLOCKED: Protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Block known internal hostnames (loopback aliases — never allowlistable)
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`SSRF_BLOCKED: Hostname not allowed: ${hostname}`);
  }

  // Loopback is always blocked — even allowlisted CIDRs cannot include it.
  if (isLoopback(hostname)) {
    throw new Error(`SSRF_BLOCKED: Loopback not allowed: ${hostname}`);
  }

  // Block private IPs UNLESS operator-allowlisted via QUOXFLOW_ALLOWED_PRIVATE.
  // Typical fleet operations (Prometheus, internal APIs on the LAN) need
  // this — the user sets QUOXFLOW_ALLOWED_PRIVATE=192.168.x.0/24,... and
  // those ranges escape the block.
  if (isPrivateIP(hostname) && !isAllowlisted(hostname)) {
    throw new Error(`SSRF_BLOCKED: Private IP not allowed: ${hostname} (set QUOXFLOW_ALLOWED_PRIVATE to allowlist a CIDR range)`);
  }

  // TRUST-PROOF audit finding (HIGH): the checks above only string-parse
  // the literal hostname. A hostname that RESOLVES to a private/loopback/
  // link-local/metadata address (DNS rebinding, or a public-looking name
  // deliberately pointed at 169.254.169.254 / 127.0.0.1 in DNS) sailed
  // straight through. Resolve and check every returned address. Literal
  // IP hostnames are skipped here — they were already fully checked above,
  // and a redundant lookup on a literal IP can fail in restricted-DNS
  // environments.
  const isLiteralIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const isLiteralIPv6 = hostname.includes(':');
  if (!isLiteralIPv4 && !isLiteralIPv6) {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      // A hostname that fails to resolve at all (ENOTFOUND/ENODATA/etc.) is
      // not an SSRF vector — there's no address to reach. Let it through
      // here; the actual fetch() will hit the identical DNS failure and
      // the executor's existing ENOTFOUND handling produces the
      // user-facing "DNS resolution failed... use a fully-qualified DNS
      // name" message. Blocking here would just replace that friendly
      // message with a confusing SSRF one for an unrelated failure mode.
      return;
    }
    for (const { address } of addresses) {
      const blockReason = checkResolvedAddress(address);
      if (blockReason) {
        throw new Error(`SSRF_BLOCKED: Hostname "${hostname}" resolves to a blocked address — ${blockReason}`);
      }
    }
  }
}

interface CallConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout: number;
  evidence: boolean;
  retry?: {
    attempts: number;
    backoff: 'fixed' | 'exponential';
    delay: number;
  };
  /** AEE-FULL Gap 4: workflow-level cancellation signal */
  cancellationSignal?: AbortSignal;
}

interface CallExecutorOptions {
  evidenceStore?: EvidenceStore;
  inlineMaxBytes?: number;
  binaryMaxBytes?: number;
}

export class CallExecutor implements NodeExecutor {
  readonly nodeTypes = ['call'];
  readonly hasExternalEffect = true;
  private evidenceStore?: EvidenceStore;
  private inlineMaxBytes?: number;
  private binaryMaxBytes?: number;

  constructor(options?: CallExecutorOptions) {
    this.evidenceStore = options?.evidenceStore;
    this.inlineMaxBytes = options?.inlineMaxBytes;
    this.binaryMaxBytes = options?.binaryMaxBytes;
  }

  /** AEE-FULL-P2: post-construction wiring for the singleton export (server.ts). */
  setEvidenceStore(store: EvidenceStore): void {
    this.evidenceStore = store;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const callNode = node as CallNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Process config with expressions. validateUrl() inside processConfig
    // throws on SSRF block — surface that as a structured CALL_FAILED
    // result rather than letting it bubble as an uncaught exception, so
    // executors-as-pure-functions invariants hold and tests/pipelines see
    // a consistent shape.
    const exprContext = context.createExpressionContext(node.id, input);
    let config: CallConfig;
    try {
      config = await this.processConfig(callNode.config, exprContext);
      // AEE-FULL Gap 4: thread workflow-level cancellation signal
      config.cancellationSignal = context.cancellationSignal;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        error: { code: 'CALL_FAILED', message },
        envelopes: [],
      };
    }

    // Emit task envelope
    const taskEnvelope = factory.task(
      `external.${new URL(config.url).hostname}`,
      Intents.NODE.STARTED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        url: config.url,
        method: config.method,
      },
      {
        requires: config.evidence ? { evidence: true, timeout_ms: config.timeout } : undefined,
      }
    );
    emitted.push(taskEnvelope);

    // Build capture context for tool.* envelopes
    const captureCtx = {
      evidenceStore: this.evidenceStore,
      correlationId: context.correlationId,
      envelopeId: ulid(), // placeholder; updated per envelope below
      workflowId: context.workflow.id,
      executionId: context.id,
      nodeId: node.id,
      orgId: context.orgId, // QF-MT WP5: the run's org
      caps: { inlineMaxBytes: this.inlineMaxBytes, binaryMaxBytes: this.binaryMaxBytes },
    };

    const toolName = node.type; // 'call'
    const toolArgs = { url: config.url, method: config.method, body: config.body };
    const startedAt = new Date().toISOString();

    // Emit tool.invoked (additional envelope — NODE.STARTED already emitted above)
    const invokedEnvelopeId = ulid();
    const argsCaptured = await captureToolArgs(toolArgs, { ...captureCtx, envelopeId: invokedEnvelopeId });
    const invokedEnvelope = factory.event(
      'quox.flow.tool.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        tool: toolName,
        args: argsCaptured.value,
        args_truncated: argsCaptured.truncated,
        args_size_bytes: argsCaptured.size_bytes,
        ...(argsCaptured.full_sha256 !== undefined ? { args_full_sha256: argsCaptured.full_sha256 } : {}),
        startedAt,
      }
    );
    emitted.push(invokedEnvelope);

    try {
      // Execute HTTP call with retry logic
      const response = await this.executeWithRetry(config);

      // Store evidence reference if enabled — persist the full request/
      // response exchange via the injected EvidenceStore so an
      // `evidence:<id>` ref (if attached) resolves to a real, hash-chained
      // record. Previously this minted a ulid and attached it as
      // `evidence:${ulid()}` WITHOUT ever calling evidenceStore.store() — a
      // phantom pointer an auditor could never dereference. If no store is
      // injected, or the write fails, we do NOT attach a ref: an empty
      // evidenceRefs array is honest, a ref to nothing is not.
      const evidenceRefs: string[] = [];
      if (config.evidence && this.evidenceStore) {
        try {
          const record = await this.evidenceStore.store({
            correlationId: context.correlationId,
            envelopeId: taskEnvelope.id,
            workflowId: context.workflow.id,
            executionId: context.id,
            nodeId: node.id,
            type: 'http_response',
            contentType: 'application/json',
            content: JSON.stringify({
              // QUOXTRUST F13: redact secret header values before durable persistence.
              request: { method: config.method, url: config.url, headers: redactHeadersForEvidence(config.headers), body: config.body },
              response: { status: response.status, statusText: response.statusText, body: response.body },
            }),
            orgId: context.orgId,
          });
          evidenceRefs.push(`evidence:${record.id}`);
        } catch (err) {
          // Non-fatal: evidence capture must never break the workflow run.
          console.warn('[call] evidenceStore.store() failed (non-fatal):', err);
        }
      }

      const durationMs = Date.now() - new Date(startedAt).getTime();

      // Capture result for tool.completed
      const completedEnvelopeId = ulid();
      const resultRaw = response.body;
      const resultCaptured = await captureToolResult(resultRaw, { ...captureCtx, envelopeId: completedEnvelopeId });

      // Emit tool.completed (additional envelope — NODE.COMPLETED below)
      const toolCompletedEnvelope = factory.event(
        'quox.flow.tool.completed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          tool: toolName,
          toolSuccess: true,
          cost_usd_micro: 0,
          result: resultCaptured.value,
          result_truncated: resultCaptured.truncated,
          result_size_bytes: resultCaptured.size_bytes,
          result_type: resultCaptured.type,
          ...(resultCaptured.full_sha256 !== undefined ? { result_full_sha256: resultCaptured.full_sha256 } : {}),
          ...(resultCaptured.too_large ? { result_too_large: true } : {}),
          duration_ms: durationMs,
        }
      );
      emitted.push(toolCompletedEnvelope);

      // Emit result envelope (NODE.COMPLETED)
      const resultEnvelope = factory.result(
        taskEnvelope,
        Intents.NODE.COMPLETED,
        {
          nodeId: node.id,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          bodySize: typeof response.body === 'string' ? response.body.length : JSON.stringify(response.body).length,
        },
        evidenceRefs.length > 0 ? evidenceRefs : undefined
      );
      emitted.push(resultEnvelope);

      return {
        success: true,
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data: response.body,
        },
        envelopes: emitted,
        evidenceRefs,
      };
    } catch (error) {
      // Node's fetch wraps the real error on `.cause` and only surfaces the
      // generic "fetch failed" string in `.message`. That left users staring
      // at CALL_FAILED with no idea whether it was DNS, port-not-listening,
      // TLS, or a timeout. Unwrap the cause and produce a self-explanatory
      // line. Most common after a workflow author writes a hostname like
      // `prometheus01` that doesn't resolve from inside the container.
      // QUOXTRUST-B5: an AmbiguousDispatchError means executeWithRetry
      // deliberately stopped retrying a non-idempotent request after a
      // transport failure it could not rule out as already-delivered. Mark
      // the result distinctly (error.code + ambiguous:true) instead of
      // reporting a plain CALL_FAILED, so the dispatch chokepoint in
      // control-pipeline.ts can settle it as outcome_unknown rather than a
      // clean failure.
      const isAmbiguous = error instanceof AmbiguousDispatchError;
      const errorCode = isAmbiguous ? 'CALL_AMBIGUOUS_DISPATCH' : 'CALL_FAILED';

      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
      const causeObj = (cause && typeof cause === 'object') ? cause as Record<string, unknown> : null;
      const causeCode = causeObj && typeof causeObj.code === 'string' ? causeObj.code : '';
      const causeHost = causeObj && typeof causeObj.hostname === 'string' ? causeObj.hostname : '';
      const baseMsg = error instanceof Error ? error.message : String(error);
      let detailedMessage = baseMsg;
      if (causeCode === 'ENOTFOUND') {
        detailedMessage = `DNS resolution failed for "${causeHost || config.url}" — the hostname is not reachable from the QuoxFlow container. Use a fully-qualified DNS name or a LAN IP (e.g. http://192.168.x.y:9090) instead of a short hostname.`;
      } else if (causeCode === 'ECONNREFUSED') {
        detailedMessage = `Connection refused at ${config.url} — the host is reachable but nothing is listening on that port.`;
      } else if (causeCode === 'ETIMEDOUT' || causeCode === 'UND_ERR_HEADERS_TIMEOUT') {
        detailedMessage = `Request timed out at ${config.url} (timeout ${config.timeout ?? 30000}ms).`;
      } else if (causeCode === 'CERT_HAS_EXPIRED' || causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        detailedMessage = `TLS verification failed at ${config.url} — certificate ${causeCode}.`;
      } else if (causeObj && typeof causeObj.message === 'string') {
        detailedMessage = `${baseMsg} (cause: ${causeObj.message})`;
      }

      // Emit tool.failed (additional envelope)
      const toolFailedEnvelope = factory.event(
        'quox.flow.tool.failed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          tool: toolName,
          error_code: errorCode,
          error_message: detailedMessage,
        }
      );
      emitted.push(toolFailedEnvelope);

      const errorEnvelope = factory.error(
        taskEnvelope,
        Intents.NODE.FAILED,
        {
          code: errorCode,
          message: detailedMessage,
          details: {
            url: config.url,
            method: config.method,
            ...(causeCode ? { cause_code: causeCode } : {}),
            ...(causeHost ? { hostname: causeHost } : {}),
          },
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: errorCode,
          message: detailedMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        ambiguous: isAmbiguous || undefined,
        envelopes: emitted,
      };
    }
  }

  private async processConfig(
    rawConfig: CallNode['config'],
    exprContext: Parameters<typeof processValue>[1]
  ): Promise<CallConfig> {
    let url = processValue(rawConfig.url, exprContext) as string;

    // The dashboard's NodeConfigDrawer surfaces a `params` field (object of
    // key→value pairs) and WEAVER reliably writes it for any query-style
    // call (Prometheus `?query=...`, search APIs, etc.). The engine
    // historically ignored the field, so the request shipped without a
    // query string and the upstream returned HTTP 400. Serialise here.
    const rawParams = (rawConfig as { params?: unknown }).params;
    if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
      const resolved = processValue(rawParams, exprContext) as Record<string, unknown>;
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(resolved)) {
        if (v === undefined || v === null) continue;
        search.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      const queryString = search.toString();
      if (queryString.length > 0) {
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
    }

    await validateUrl(url);
    return {
      url,
      method: rawConfig.method ?? 'GET',
      headers: rawConfig.headers
        ? processValue(rawConfig.headers, exprContext) as Record<string, string>
        : {},
      body: rawConfig.body ? processValue(rawConfig.body, exprContext) : undefined,
      timeout: rawConfig.timeout ?? 30000,
      evidence: rawConfig.evidence ?? false,
      retry: rawConfig.retry,
    };
  }

  private async executeWithRetry(config: CallConfig): Promise<{
    status: number;
    statusText: string;
    headers: Headers;
    body: unknown;
  }> {
    // Clamp: never allow more than MAX_RETRY_ATTEMPTS, and never fewer than 1.
    const requestedAttempts = config.retry?.attempts ?? 1;
    const maxAttempts = Math.min(Math.max(requestedAttempts, 1), MAX_RETRY_ATTEMPTS);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchFollowingRedirects(config);

        const contentType = response.headers.get('content-type') ?? '';
        const body = await readResponseBodyWithLimit(response, contentType, MAX_RESPONSE_BYTES);

        // Check for HTTP errors
        if (!response.ok) {
          throw new HttpError(response.status, response.statusText, body);
        }

        return {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on certain errors
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
          throw error;
        }

        // Don't retry an SSRF block — it's a permanent decision (bad
        // redirect target, DNS-resolved private address), not a transient
        // upstream failure, so retrying only burns the backoff delay for
        // no benefit and re-runs the same rejected redirect chain.
        if (error instanceof Error && error.message.startsWith('SSRF_BLOCKED:')) {
          throw error;
        }

        // QUOXTRUST-B5: an HttpError means a real HTTP response was
        // received in full (5xx here, since 4xx already threw above) — a
        // definite, known outcome, not an ambiguous one, so it keeps the
        // existing unconditional-retry behaviour regardless of method or
        // idempotency key. Only a transport-level failure below the HTTP
        // layer (the fetch() call itself threw, no response was ever
        // parsed) goes through the ambiguous-dispatch check: for a
        // non-idempotent request without an idempotency key, only a
        // failure that is DEFINITELY-NOT-SENT (the request never left) is
        // safe to retry. Anything else may have already reached the
        // upstream, so retrying risks a duplicate consequential effect.
        // Surface it distinctly instead of retrying, so the pipeline
        // settles this as outcome_unknown rather than a clean failure.
        if (
          !(error instanceof HttpError) &&
          !isSafeToRetryRegardlessOfPhase(config.method, config.headers) &&
          !isDefinitelyNotSent(lastError)
        ) {
          const rawCause = (lastError as Error & { cause?: unknown }).cause ?? lastError;
          throw new AmbiguousDispatchError(
            `Ambiguous dispatch outcome for ${config.method} ${config.url}: ${lastError.message}`,
            { cause: rawCause, method: config.method, url: config.url }
          );
        }

        // Wait before retry. Always back off between attempts — even when
        // config.retry.delay was left unset, which previously produced a
        // 0ms (immediate) retry.
        if (attempt < maxAttempts) {
          const baseDelay = config.retry?.delay ?? DEFAULT_RETRY_DELAY_MS;
          const delay = config.retry?.backoff === 'exponential'
            ? baseDelay * Math.pow(2, attempt - 1)
            : baseDelay;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Call failed after retries');
  }

  /**
   * TRUST-PROOF audit finding (HIGH): fetch() previously followed
   * redirects automatically, and validateUrl() was only ever checked
   * against the ORIGINAL url — a 3xx response pointing at a private/
   * link-local/metadata target (e.g. the cloud metadata IP or an internal
   * collector port) was followed with zero re-validation. This now fetches
   * with `redirect: 'manual'` and re-validates every Location target
   * before following it, up to MAX_REDIRECT_HOPS.
   */
  private async fetchFollowingRedirects(config: CallConfig): Promise<Response> {
    let currentUrl = config.url;
    let hops = 0;

    for (;;) {
      const response = await fetch(currentUrl, {
        method: config.method,
        headers: config.headers,
        body: config.body ? JSON.stringify(config.body) : undefined,
        redirect: 'manual',
        signal: combineAbortSignals(
          AbortSignal.timeout(config.timeout),
          config.cancellationSignal,
        ),
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = isRedirect ? response.headers.get('location') : null;

      if (!location) {
        // Not a redirect, or a redirect status with no Location header —
        // nothing to follow, hand the response back as-is.
        return response;
      }

      if (hops >= MAX_REDIRECT_HOPS) {
        throw new Error(`SSRF_BLOCKED: Maximum redirect depth (${MAX_REDIRECT_HOPS}) exceeded for ${config.url}`);
      }

      const nextUrl = new URL(location, currentUrl).toString();
      await validateUrl(nextUrl);
      currentUrl = nextUrl;
      hops += 1;
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const callNode = node as CallNode;
    const errors: string[] = [];

    if (!callNode.config.url) {
      errors.push('url is required');
    }

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (callNode.config.method && !validMethods.includes(callNode.config.method)) {
      errors.push(`method must be one of: ${validMethods.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Reads a fetch Response body with a hard byte cap, failing cleanly instead
 * of buffering an unbounded response into memory.
 *
 * Enforces the cap two ways:
 *  1. Declared Content-Length check up front (cheap, catches the honest case).
 *  2. A streamed read via response.body.getReader() with a running total,
 *     aborting the read the moment the cap is crossed — covers responses
 *     with no/incorrect Content-Length, and this is what native fetch
 *     (Node 18+ undici) responses use.
 *
 * Response test doubles that don't implement a streamable `.body` (common in
 * this repo's mocked-fetch unit tests) fall back to the original
 * json()/text()/arrayBuffer() calls unchanged, so existing test mocks keep
 * working as-is.
 */
async function readResponseBodyWithLimit(
  response: Response,
  contentType: string,
  maxBytes: number
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`RESPONSE_TOO_LARGE: response declared content-length of ${declared} bytes exceeds the ${maxBytes}-byte limit`);
    }
  }

  const streamBody = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
  if (streamBody && typeof streamBody.getReader === 'function') {
    const reader = streamBody.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`RESPONSE_TOO_LARGE: response body exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (contentType.includes('application/json')) {
      const text = Buffer.from(merged).toString('utf-8');
      return text.length > 0 ? JSON.parse(text) : null;
    } else if (contentType.includes('text/') || contentType.includes('xml') || contentType.includes('html')) {
      return Buffer.from(merged).toString('utf-8');
    }
    return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
  }

  // Fallback for Response objects without a streamable body (test doubles,
  // older runtimes). The Content-Length check above is the only pre-parse
  // size guard available in this path.
  if (contentType.includes('application/json')) {
    return await response.json();
  } else if (contentType.includes('text/') || contentType.includes('xml') || contentType.includes('html')) {
    return await response.text();
  }
  return await response.arrayBuffer();
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'HttpError';
  }
}

export const callExecutor = new CallExecutor();
