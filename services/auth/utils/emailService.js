/**
 * ET-1 — Email service. EMAIL-UNIFY P2: QuoxVault is the source of truth.
 *
 * Lazy nodemailer wrapper. The instance SMTP transport is resolved on first
 * send and cached until the auth process restarts (or the cache is reset via
 * resetSmtpConfigCache, which every write path calls).
 *
 * Resolution order (loadSmtpConfig):
 *   1. QuoxVault instance-scope `email_account` credential — where a Settings
 *      panel save lands (services/instanceEmailCredential.js).
 *   2. Legacy `instance_config` smtp_* rows — installs that predate P2 and
 *      have not run the boot migration yet. Purged the moment a vault copy
 *      exists, so the two stores can never drift.
 *
 * Dev mode (no SMTP configured): log to console + return
 * { delivered: false, reason: 'no_smtp' }. Production: deliver and
 * return { delivered: true, message_id }.
 *
 * This one config powers every send in the product: transactional mail
 * (verify/reset/invite), QuoxChat transcripts, and — via auth's
 * service-key-gated GET /api/setup/internal/smtp-config, which the collector
 * calls — HITL and notification email.
 */

import nodemailer from 'nodemailer';
import { getDb } from '../db/index.js';
import { encrypt, decrypt } from './encryption.js';
import { readInstanceSmtp, writeInstanceSmtp } from '../services/instanceEmailCredential.js';
import { resolveNotificationCredentials } from '../services/credentialResolver.js';

// Legacy credential rows, read as a fallback and purged on the first vault
// write. The smtp_last_test_* rows below are status, not credentials, and stay.
const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'];
const TEST_RESULT_KEYS = ['smtp_last_test_at', 'smtp_last_test_ok', 'smtp_last_test_detail'];

let cachedTransport  = null;
let cachedFrom       = null;
let cachedNoSmtp     = false;

function readCfg(db, key) {
    // Decrypt encrypted rows (smtp_pass is stored encrypted by both the
    // Setup wizard and upsertSmtpConfig below; before this decrypt path the
    // send transport was handed the raw ciphertext and auth always failed).
    const row = db.prepare('SELECT value, encrypted FROM instance_config WHERE key = ?').get(key);
    if (!row) return null;
    if (row.encrypted && row.value) {
        try { return decrypt(row.value); }
        catch { return null; }
    }
    return row.value;
}

/**
 * Resolve the instance SMTP transport, and say where it came from.
 * `source` is 'vault' | 'instance_config' | null.
 *
 * @param {import('better-sqlite3').Database} [db]
 * @returns {{ config: object|null, source: string|null }}
 */
export function resolveSmtpConfig(db = getDb()) {
    // 1. QuoxVault (canonical since EMAIL-UNIFY P2)
    let vault = null;
    try {
        vault = readInstanceSmtp({ db });
    } catch (err) {
        console.error('[EmailService] Vault SMTP lookup failed, falling back:', err.message);
    }
    if (vault) {
        return {
            source: 'vault',
            config: {
                host:   vault.host,
                port:   vault.port,
                secure: vault.secure,
                auth:   vault.user ? { user: vault.user, pass: vault.pass || '' } : undefined,
                from:   vault.from,
            },
        };
    }

    // 2. Legacy instance_config rows (pre-P2 installs, until the boot migration runs)
    const cfg = {};
    for (const key of SMTP_KEYS) {
        cfg[key] = readCfg(db, key);
    }
    if (!cfg.smtp_host || !cfg.smtp_from) {
        return { config: null, source: null };
    }
    return {
        source: 'instance_config',
        config: {
            host:   cfg.smtp_host,
            port:   cfg.smtp_port ? Number(cfg.smtp_port) : 587,
            secure: cfg.smtp_secure === 'true',
            auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
            from:   cfg.smtp_from,
        },
    };
}

export function loadSmtpConfig(db) {
    return resolveSmtpConfig(db || getDb()).config;
}

/**
 * Normalise an SMTP credential field map to one transport shape.
 *
 * Two field vocabularies exist in the vault and both are legitimate:
 *   - the `email_account` credential kind (smtp_host / username / password),
 *     which is what the instance credential and the vault UI use;
 *   - the flat channel shape (host / user / pass) written by the CoreComms
 *     localStorage migration (routes/integrations-migrate.js).
 * Callers should not have to know which one they got.
 *
 * @param {object|null} fields
 * @returns {{host: string, port: number, secure: boolean, user: string, pass: string, from: string}|null}
 */
export function normaliseSmtpFields(fields) {
    if (!fields) return null;
    const host = fields.smtp_host || fields.host || '';
    if (!host) return null;

    const rawPort = fields.smtp_port ?? fields.port;
    const port = rawPort ? Number(rawPort) : 587;
    const rawSecure = fields.smtp_secure ?? fields.secure;
    const secure = rawSecure === undefined || rawSecure === null
        ? port === 465
        : (rawSecure === true || rawSecure === 'true');
    const user = fields.username || fields.user || '';

    return {
        host,
        port,
        secure,
        user,
        pass: fields.password ?? fields.pass ?? '',
        // An org credential may carry no explicit envelope sender; the login
        // address is the only honest fallback.
        from: fields.from || user,
    };
}

/**
 * Resolve the SMTP transport that should be used on behalf of an org.
 *
 * Order (the EMAIL-UNIFY waterfall, same shape the collector uses):
 *   1. the org's own default vault SMTP credential — an explicit override
 *   2. the instance credential (vault, then legacy instance_config)
 *
 * @param {string|null} orgId
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {{ config: object|null, source: string|null }}
 */
export function resolveSmtpForOrg(orgId, { db: dbArg } = {}) {
    const db = dbArg || getDb();

    if (orgId) {
        try {
            const { credentials, source } = resolveNotificationCredentials(orgId, 'smtp');
            // Only a vault hit counts as an org override: the resolver's own
            // env fallback is instance-wide, and the instance path below owns
            // that decision.
            if (source === 'vault') {
                const normalised = normaliseSmtpFields(credentials);
                if (normalised) {
                    return {
                        source: 'org_vault',
                        config: {
                            host: normalised.host,
                            port: normalised.port,
                            secure: normalised.secure,
                            auth: normalised.user ? { user: normalised.user, pass: normalised.pass } : undefined,
                            from: normalised.from,
                        },
                    };
                }
            }
        } catch (err) {
            console.error('[EmailService] Org SMTP lookup failed, falling back to instance:', err.message);
        }
    }

    return resolveSmtpConfig(db);
}

// Domains that can never receive mail. RFC 6761 special-use TLDs (test,
// example, invalid, localhost), RFC 6762 mDNS (local), and RFC 2606 example
// second-level names. Handing any of these to the transport just produces a
// MAILER-DAEMON bounce back to our own postmaster — which is exactly how
// proof/demo signups minting `@quox.local` accounts flooded the CommanderQ
// inbox (2026-09-30). We refuse them at the choke point instead.
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

/**
 * True when `to` addresses a reserved / non-routable domain that no MTA can
 * deliver to. Field-shape validation (empty/non-string `to`) stays in
 * sendEmail; this only judges deliverability of a well-formed-ish address.
 *
 * @param {string} to
 * @returns {boolean}
 */
export function isUndeliverableRecipient(to) {
    if (!to || typeof to !== 'string') return false;
    const at = to.lastIndexOf('@');
    if (at < 0) return true; // no domain part at all
    const domain = to.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
    if (!domain) return true;
    if (RESERVED_DOMAINS.has(domain)) return true;
    if (!domain.includes('.')) return true; // bare host, no TLD (e.g. localhost)
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    return RESERVED_TLDS.has(tld);
}

/**
 * Send an email.
 *
 * @param {object} input
 * @param {string} input.to       Recipient email
 * @param {string} input.subject  Subject line
 * @param {string} [input.text]   Plain-text body (required if no html)
 * @param {string} [input.html]   HTML body (required if no text)
 * @param {string} [input.from]   Override default from
 *
 * @param {object} [opts]
 * @param {object} [opts.db]      Inject db (used in tests)
 *
 * @returns {Promise<{delivered: boolean, reason?: string, message_id?: string}>}
 */
export async function sendEmail(input, opts = {}) {
    const { to, subject, text, html, from } = input || {};
    if (!to || typeof to !== 'string') throw new Error('sendEmail: `to` is required');
    if (!subject || typeof subject !== 'string') throw new Error('sendEmail: `subject` is required');
    if (!text && !html) throw new Error('sendEmail: `text` or `html` is required');

    if (isUndeliverableRecipient(to)) {
        console.log(`[EMAIL] skipped undeliverable recipient domain — to=${to} subject=${subject}`);
        return { delivered: false, reason: 'undeliverable_domain' };
    }

    const db = opts.db || getDb();

    if (cachedNoSmtp) {
        console.log(`[EMAIL stub] to=${to} subject=${subject}`);
        return { delivered: false, reason: 'no_smtp' };
    }

    if (!cachedTransport) {
        const cfg = loadSmtpConfig(db);
        if (!cfg) {
            cachedNoSmtp = true;
            console.log(`[EMAIL stub] no smtp configured — to=${to} subject=${subject}`);
            return { delivered: false, reason: 'no_smtp' };
        }
        cachedTransport = nodemailer.createTransport({
            host:   cfg.host,
            port:   cfg.port,
            secure: cfg.secure,
            auth:   cfg.auth,
        });
        cachedFrom = cfg.from;
    }

    const info = await cachedTransport.sendMail({
        from:    from || cachedFrom,
        to,
        subject,
        text,
        html,
    });
    return { delivered: true, message_id: info.messageId };
}

/**
 * Reset the cached transport + config. Called whenever SMTP config changes
 * so a fresh setup takes effect without an auth restart.
 */
export function resetSmtpConfigCache() {
    cachedTransport = null;
    cachedFrom      = null;
    cachedNoSmtp    = false;
}

/** Back-compat alias for existing tests. */
export const _resetSmtpConfigCacheForTests = resetSmtpConfigCache;

// ── QCPRO-SMTP: instance SMTP onboarding helpers ───────────────────────────

const HOSTNAME_RE = /^[a-z0-9.-]+$/i;

function upsertRow(db, key, value, { encrypted = false, userId = null } = {}) {
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, encrypted, updated_at, updated_by)
        VALUES (?, ?, 'string', ?, datetime('now'), ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            encrypted = excluded.encrypted,
            updated_at = datetime('now'),
            updated_by = excluded.updated_by
    `).run(key, value, encrypted ? 1 : 0, userId);
}

/**
 * Drop the legacy instance_config credential rows. Called after a successful
 * vault write so there is exactly ONE place email is configured — a stale
 * second copy is how the two stacks drifted apart before P2. The
 * smtp_last_test_* rows are status, not credentials, and are left alone.
 */
export function purgeLegacySmtpConfigRows(db) {
    const placeholders = SMTP_KEYS.map(() => '?').join(', ');
    return db.prepare(`DELETE FROM instance_config WHERE key IN (${placeholders})`).run(...SMTP_KEYS).changes;
}

/**
 * Validate + save the instance SMTP config into QuoxVault (EMAIL-UNIFY P2 —
 * this used to write instance_config smtp_* rows directly).
 *
 * A blank `pass` keeps the stored password. Resets the send-path cache on
 * success so a fresh setup takes effect without an auth restart. Returns
 * { ok, errors? }.
 */
export function upsertSmtpConfig(fields, { db: dbArg, userId = null } = {}) {
    const db = dbArg || getDb();
    const { host, port, user, pass, from, secure } = fields || {};

    const errors = {};
    if (!host || typeof host !== 'string' || !HOSTNAME_RE.test(host)) errors.host = 'host must be a hostname';
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) errors.port = 'port must be 1-65535';
    if (!from || typeof from !== 'string' || !from.trim()) errors.from = 'from is required';
    if (Object.keys(errors).length) return { ok: false, errors };

    // A blank password on a first-ever save is legitimate (unauthenticated
    // relay), but must not silently inherit a legacy instance_config secret we
    // are about to delete — carry it across explicitly.
    let effectivePass = pass;
    if (!effectivePass && !readInstanceSmtp({ db })) {
        effectivePass = readCfg(db, 'smtp_pass') || '';
    }

    const tx = db.transaction(() => {
        writeInstanceSmtp(
            { host: host.trim(), port: portNum, user, pass: effectivePass, from: from.trim(), secure },
            { db, userId },
        );
        purgeLegacySmtpConfigRows(db);
    });
    tx();

    resetSmtpConfigCache();
    return { ok: true };
}

/**
 * Sanitised status for the admin surface: configured?, host, from, and the
 * last test-send outcome. Never returns credentials.
 */
export function getSmtpStatus({ db: dbArg } = {}) {
    const db = dbArg || getDb();
    const { config: cfg, source } = resolveSmtpConfig(db);
    const at = readCfg(db, 'smtp_last_test_at');
    const status = {
        configured: !!cfg,
        // Where the config is stored, so the panel can tell the truth about it.
        source,
        host: cfg ? cfg.host : null,
        from: cfg ? cfg.from : null,
        // Username is not a secret, and prefilling it means an admin editing
        // the port doesn't have to retype their whole login.
        user: cfg?.auth?.user || null,
        last_test: at ? {
            at,
            ok: readCfg(db, 'smtp_last_test_ok') === 'true',
            detail: readCfg(db, 'smtp_last_test_detail') || null,
        } : null,
    };
    return status;
}

/** Persist the outcome of a test send (shown on the admin surface). */
export function recordEmailTestResult(db, { ok, detail = null } = {}) {
    upsertRow(db, 'smtp_last_test_at', new Date().toISOString());
    upsertRow(db, 'smtp_last_test_ok', ok ? 'true' : 'false');
    upsertRow(db, 'smtp_last_test_detail', detail || '');
}
