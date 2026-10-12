/**
 * n8n `n8n-nodes-base.googleSheets` -> Google Sheets API v4
 * https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values
 *
 * Handles the two dominant real-world operations (append + read —
 * ~66% of googleSheets nodes in the AI Agent Vault sample, the two
 * largest buckets by far). Other operations (update, appendOrUpdate,
 * create, delete, lookup) are not attempted here — see types.ts on
 * why connectors return `null` rather than guess.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

interface ResourceLocator {
  value?: unknown;
  cachedResultName?: string;
}

function sheetName(params: Record<string, unknown>): string {
  const rl = params.sheetName as ResourceLocator | undefined;
  const name = rl?.cachedResultName || rl?.value;
  return typeof name === 'string' && name && name !== '=' ? name : 'Sheet1';
}

function spreadsheetId(params: Record<string, unknown>): string {
  const rl = params.documentId as ResourceLocator | undefined;
  return typeof rl?.value === 'string' ? rl.value : '';
}

export const googleSheetsConnector: Connector = (n8nNode: N8nNode, params) => {
  const operation = params.operation as string | undefined;
  const auth = { 'Authorization': `Bearer ${credentialExpr(n8nNode, 'google_sheets_oauth2_api')}` };
  const range = encodeURIComponent(sheetName(params));
  const docId = spreadsheetId(params);

  if (operation === 'append') {
    const columns = params.columns as { value?: Record<string, unknown> } | undefined;
    const row = Object.values(columns?.value ?? {});
    return {
      url: `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: { values: [row] },
      timeout: 30000,
    };
  }

  if (operation === undefined) {
    // No explicit operation is the node's own default: read rows.
    return {
      url: `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${range}`,
      method: 'GET',
      headers: auth,
      timeout: 30000,
    };
  }

  return null;
};
