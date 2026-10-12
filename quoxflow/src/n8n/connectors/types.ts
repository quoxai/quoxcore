/**
 * n8n Vendor Connectors — shared types
 *
 * A connector maps ONE n8n integration node type to a real, working
 * QuoxFlow `call` node config (url/method/headers/body) for that
 * vendor's actual REST API. See connectors/index.ts for how these are
 * registered, and connectors/slack.ts for the simplest example to copy
 * when adding a new vendor.
 */

import { N8nNode } from '../types.js';

/**
 * Shape a connector returns — a subset of CallNode['config']
 * (src/core/workflow.ts) that buildCallConfig() merges with defaults.
 */
export interface ConnectorCallConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  /** Optional extra context surfaced in the node's config for the admin. */
  _note?: string;
}

/**
 * `params` is the node's n8n `parameters`, already expression-converted
 * by expression-converter.ts's `convertObject()` — n8n's `{{ }}` syntax
 * has already become QuoxFlow's `${...}` syntax by the time a connector
 * sees it.
 *
 * Return `null` when this specific node instance's resource/operation
 * isn't one this connector implements. The caller falls back to the
 * generic placeholder rather than emit a guessed, possibly-wrong
 * request — an honest "not yet supported" beats a plausible-looking
 * wrong one.
 */
export type Connector = (n8nNode: N8nNode, params: Record<string, unknown>) => ConnectorCallConfig | null;
