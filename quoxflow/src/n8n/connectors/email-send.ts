/**
 * n8n `n8n-nodes-base.emailSend` -> SendGrid Mail Send API v3
 * https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 *
 * n8n's emailSend node itself talks raw SMTP (its `credentials` type
 * is "smtp"), which has no HTTP REST shape at all — QuoxFlow's `call`
 * node is HTTP-only. SendGrid's Mail Send API is used here as the
 * real, well-documented transactional-email REST vendor an admin can
 * swap in for their SMTP provider; the field transform (to/from/
 * subject/body -> personalizations/from/subject/content) is the part
 * that's genuinely vendor-specific and reusable regardless of which
 * HTTP email provider is actually wired up.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

export const emailSendConnector: Connector = (n8nNode: N8nNode, params) => {
  const to = params.toEmail;
  const from = params.fromEmail;
  const isHtml = params.html !== undefined;
  const body = params.html ?? params.text ?? '';

  return {
    url: 'https://api.sendgrid.com/v3/mail/send',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credentialExpr(n8nNode, 'smtp')}`,
      'Content-Type': 'application/json',
    },
    body: {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: params.subject ?? '',
      content: [{ type: isHtml ? 'text/html' : 'text/plain', value: body }],
    },
    timeout: 30000,
    _note: 'Vendor endpoint assumes SendGrid (n8n\'s node is SMTP-generic; swap the URL/auth if a different transactional email API is used).',
  };
};
