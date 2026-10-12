/**
 * n8n `n8n-nodes-base.gmail` -> Gmail API v1 `users.messages.send`
 * https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
 *
 * Handles "send" (the node's own default — ~58% of gmail nodes in the
 * AI Agent Vault sample, by far the largest single bucket). Other
 * operations (get, getAll, reply, labels, ...) are intentionally left
 * unhandled.
 *
 * Gmail's API takes one base64url-encoded raw RFC 2822 message, not
 * separate to/subject/body fields — unlike every other connector in
 * this directory, the three source fields have to be combined into a
 * single computed value. QuoxFlow's `${...}` expression syntax is the
 * same syntax a JS template literal uses for its own `${...}`
 * placeholders, so splicing the (already n8n->QuoxFlow converted)
 * field text straight into a backtick template lets the expression
 * engine evaluate everything in place — real newlines are the one
 * thing that breaks QuoxFlow's own top-level "is this one whole
 * expression" check, so those get neutralised to their `\r\n` escape
 * form first. Base64-encoding is done via an inlined encoder
 * (base64.ts) rather than the engine's own `$.base64Encode` — see
 * that file for why.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';
import { inlineBase64Expr } from './base64.js';

function forTemplate(value: unknown): string {
  return String(value ?? '')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, '\\r\\n');
}

function rawMessageExpr(to: unknown, subject: unknown, body: unknown): string {
  const mime =
    `\`To: ${forTemplate(to)}\\r\\n` +
    `Subject: ${forTemplate(subject)}\\r\\n` +
    `Content-Type: text/html; charset=utf-8\\r\\n\\r\\n` +
    `${forTemplate(body)}\``;
  return `\${${inlineBase64Expr(mime)}}`;
}

export const gmailConnector: Connector = (n8nNode: N8nNode, params) => {
  const resource = (params.resource as string) || 'message';
  const operation = (params.operation as string) || 'send';
  if (resource !== 'message' || operation !== 'send') return null;

  const to = params.sendTo;
  const subject = params.subject;
  const body = params.message;

  return {
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credentialExpr(n8nNode, 'gmail_oauth2')}`,
      'Content-Type': 'application/json',
    },
    body: { raw: rawMessageExpr(to, subject, body) },
    timeout: 30000,
  };
};
