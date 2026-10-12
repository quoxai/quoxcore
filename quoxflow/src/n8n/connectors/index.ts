/**
 * n8n Vendor Connectors — registry
 *
 * Adding a new vendor: drop a new `<vendor>.ts` file in this
 * directory exporting a `Connector` (see types.ts), then add one line
 * below keyed by the n8n node type string. Nothing else changes —
 * buildCallConfig() in workflow-converter.ts already checks this map
 * before falling back to the generic placeholder.
 */

import { Connector } from './types.js';
import { slackConnector } from './slack.js';
import { telegramConnector } from './telegram.js';
import { gmailConnector } from './gmail.js';
import { googleSheetsConnector } from './google-sheets.js';
import { googleDriveConnector } from './google-drive.js';
import { airtableConnector } from './airtable.js';
import { notionConnector } from './notion.js';
import { emailSendConnector } from './email-send.js';
import { openAiConnector } from './openai.js';

export * from './types.js';

export const N8N_CONNECTORS: Record<string, Connector> = {
  'n8n-nodes-base.slack': slackConnector,
  'n8n-nodes-base.telegram': telegramConnector,
  'n8n-nodes-base.gmail': gmailConnector,
  'n8n-nodes-base.googleSheets': googleSheetsConnector,
  'n8n-nodes-base.googleDrive': googleDriveConnector,
  'n8n-nodes-base.airtable': airtableConnector,
  'n8n-nodes-base.notion': notionConnector,
  'n8n-nodes-base.emailSend': emailSendConnector,
  '@n8n/n8n-nodes-langchain.openAi': openAiConnector,
};
