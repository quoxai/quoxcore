/**
 * Shared credential-reference helper for vendor connectors.
 *
 * Mirrors the credential detection already used for the "Requires
 * credentials: X" import warning in workflow-converter.ts's
 * convertNode() (n8nNode.credentials keys are n8n's *credential type*
 * name, e.g. "slackApi", "googleSheetsOAuth2Api"). A connector turns
 * that same name into a QuoxFlow workflow variable reference an admin
 * wires up with the real secret (Workflow variables / QuoxVault) —
 * e.g. `${vars.CREDENTIAL_SLACK_API}`.
 */

import { N8nNode } from '../types.js';

function toSnakeUpper(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}

/** e.g. `CREDENTIAL_SLACK_API` — the raw variable name, no `${vars.}` wrapper. */
export function credentialVarName(n8nNode: N8nNode, fallback: string): string {
  const credType = n8nNode.credentials ? Object.keys(n8nNode.credentials)[0] : undefined;
  return `CREDENTIAL_${toSnakeUpper(credType || fallback)}`;
}

/** e.g. `${vars.CREDENTIAL_SLACK_API}` — ready to splice into a header/url/body value. */
export function credentialExpr(n8nNode: N8nNode, fallback: string): string {
  return `\${vars.${credentialVarName(n8nNode, fallback)}}`;
}
