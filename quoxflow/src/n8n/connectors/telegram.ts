/**
 * n8n `n8n-nodes-base.telegram` -> Telegram Bot API `sendMessage`
 * https://core.telegram.org/bots/api#sendmessage
 *
 * Covers the dominant real-world case (~81% of telegram nodes in the
 * AI Agent Vault sample carry no explicit resource/operation — the
 * node's own default is "send a text message"). Telegram's auth token
 * lives in the URL path, not a header — that's the vendor's own API
 * shape, not a QuoxFlow convention.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

export const telegramConnector: Connector = (n8nNode: N8nNode, params) => {
  const resource = (params.resource as string) || 'message';
  const operation = (params.operation as string) || 'sendMessage';
  if (resource !== 'message' || operation !== 'sendMessage') return null;

  return {
    url: `https://api.telegram.org/bot${credentialExpr(n8nNode, 'telegram_api')}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      chat_id: params.chatId,
      text: params.text ?? '',
    },
    timeout: 30000,
  };
};
