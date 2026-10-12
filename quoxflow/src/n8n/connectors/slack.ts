/**
 * n8n `n8n-nodes-base.slack` -> Slack Web API `chat.postMessage`
 * https://api.slack.com/methods/chat.postMessage
 *
 * Covers the dominant real-world case (~88% of slack nodes in the AI
 * Agent Vault sample carry no explicit resource/operation at all —
 * the node's own default is "post a message to a channel").
 * This is the reference template for adding a new vendor connector.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

export const slackConnector: Connector = (n8nNode: N8nNode, params) => {
  const resource = (params.resource as string) || 'message';
  const operation = (params.operation as string) || 'post';
  if (resource !== 'message' || operation !== 'post') return null;

  const channelId = params.channelId as { value?: unknown } | undefined;
  const channel = channelId?.value ?? params.channel ?? '';

  return {
    url: 'https://slack.com/api/chat.postMessage',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credentialExpr(n8nNode, 'slack_api')}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: {
      channel,
      text: params.text ?? '',
    },
    timeout: 30000,
  };
};
