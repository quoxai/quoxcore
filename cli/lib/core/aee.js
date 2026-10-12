/**
 * AEE envelope emitter for CLI commands
 *
 * Emits lightweight event envelopes so CLI actions appear in the
 * AEE audit trail. Fire-and-forget — failures are silently ignored
 * so they never block the command itself.
 *
 * CLI-3 EVIDENCED dimension (quoxai/quox#290)
 */

import { resolveEndpoint } from '../api/endpoints.js';

const PROTOCOL_VERSION = '1';

function ulid() {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Array.from({ length: 16 }, () => Math.random().toString(36)[2]).join('');
  return (t + r).toUpperCase();
}

/**
 * Emit an AEE event envelope for a CLI command invocation.
 *
 * @param {Object} client - The CLI HTTP client (ctx.client)
 * @param {Object} params
 * @param {string} params.command - CLI command name (e.g. 'status', 'doctor')
 * @param {string} params.intent - AEE intent string (e.g. 'quox.cli.status')
 * @param {Object} [params.payload] - Command-specific result data
 * @param {string} [params.status] - 'success' | 'error'
 */
export async function emitCliEvent(client, { command, intent, payload = {}, status = 'success' }) {
  try {
    const envelope = {
      v: PROTOCOL_VERSION,
      id: ulid(),
      ts: new Date().toISOString(),
      type: 'event',
      from: 'cli.quox',
      to: 'system.audit',
      intent,
      corr: null,
      reply_to: null,
      payload: {
        command,
        status,
        ...payload,
      },
    };
    await client.post(resolveEndpoint('aee.store').path, { service: resolveEndpoint('aee.store').service, body: envelope, timeout: 3000 });
  } catch {
    // Fire-and-forget — never block CLI output
  }
}
