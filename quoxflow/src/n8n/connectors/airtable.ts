/**
 * n8n `n8n-nodes-base.airtable` -> Airtable Web API v0
 * https://airtable.com/developers/web/api/create-records
 * https://airtable.com/developers/web/api/list-records
 *
 * Handles "create" and "search" (record listing) — the two cleanest,
 * best-defined operations in the AI Agent Vault sample. "update" is
 * intentionally left unhandled: n8n resolves which record to update
 * via arbitrary user-chosen "matching columns" (not always the record
 * `id`), which this converter can't reliably infer without guessing.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

interface ResourceLocator {
  value?: unknown;
}

function baseAndTable(params: Record<string, unknown>): { base: string; table: string } {
  const base = params.base as ResourceLocator | undefined;
  const table = params.table as ResourceLocator | undefined;
  return {
    base: typeof base?.value === 'string' ? base.value : '',
    table: typeof table?.value === 'string' ? table.value : '',
  };
}

export const airtableConnector: Connector = (n8nNode: N8nNode, params) => {
  const operation = (params.operation as string) || undefined;
  const { base, table } = baseAndTable(params);
  const auth = { 'Authorization': `Bearer ${credentialExpr(n8nNode, 'airtable_token_api')}` };
  const baseUrl = `https://api.airtable.com/v0/${base}/${table}`;

  if (operation === 'create') {
    const columns = params.columns as { value?: Record<string, unknown> } | undefined;
    return {
      url: baseUrl,
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: { fields: columns?.value ?? {} },
      timeout: 30000,
    };
  }

  if (operation === 'search') {
    const formula = params.filterByFormula as string | undefined;
    // Only URL-encode formulas that don't carry a QuoxFlow ${...}
    // expression — encoding would corrupt the `${` / `}` markers the
    // expression engine looks for at execution time.
    const query = formula
      ? `?filterByFormula=${formula.includes('${') ? formula : encodeURIComponent(formula)}`
      : '';
    return {
      url: `${baseUrl}${query}`,
      method: 'GET',
      headers: auth,
      timeout: 30000,
    };
  }

  return null;
};
