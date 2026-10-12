/**
 * n8n `n8n-nodes-base.googleDrive` -> Google Drive API v3 file download
 * https://developers.google.com/drive/api/reference/rest/v3/files/get
 *
 * Handles "download" only (the dominant *explicit* operation in the
 * AI Agent Vault sample, ~38%). The node's true default — no
 * resource/operation at all — is a binary file *upload*, which needs
 * a multipart/related request body; QuoxFlow's generic `call` node
 * (url/method/headers/body as JSON) has no multipart support, so
 * upload is intentionally left unhandled rather than emitting a
 * request that looks plausible but isn't a valid multipart upload.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

interface ResourceLocator {
  value?: unknown;
}

export const googleDriveConnector: Connector = (n8nNode: N8nNode, params) => {
  if (params.operation !== 'download') return null;

  const fileIdRl = params.fileId as ResourceLocator | undefined;
  const fileId = fileIdRl?.value ?? '';

  return {
    url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${credentialExpr(n8nNode, 'google_drive_oauth2_api')}`,
    },
    timeout: 30000,
  };
};
