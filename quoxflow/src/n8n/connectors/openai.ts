/**
 * n8n `@n8n/n8n-nodes-langchain.openAi` -> OpenAI Chat Completions API
 * https://platform.openai.com/docs/api-reference/chat/create
 *
 * NOTE: this is the plain "call OpenAI's REST API for one operation"
 * node — a genuine SaaS connector like the others in this directory.
 * It is NOT the same as `lmChatOpenAi` / `agent` / `chainLlm` etc.,
 * n8n's LangChain sub-connection wiring for agent orchestration —
 * those are a different, explicitly out-of-scope problem.
 *
 * Handles the two largest real-world buckets in the AI Agent Vault
 * sample: "chat" (the node's own default — ~45% of openAi nodes) and
 * "image" resource + "analyze" operation (vision, ~26%), both of
 * which are genuinely the same Chat Completions endpoint underneath.
 */

import { N8nNode } from '../types.js';
import { Connector } from './types.js';
import { credentialExpr } from './credential.js';

interface ModelLocator {
  value?: unknown;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function model(params: Record<string, unknown>, fallback: string): string {
  const modelId = params.modelId as ModelLocator | undefined;
  return typeof modelId?.value === 'string' ? modelId.value : fallback;
}

export const openAiConnector: Connector = (n8nNode: N8nNode, params) => {
  const resource = (params.resource as string) || 'chat';
  const operation = params.operation as string | undefined;
  const headers = {
    'Authorization': `Bearer ${credentialExpr(n8nNode, 'openai_api')}`,
    'Content-Type': 'application/json',
  };

  if (resource === 'chat') {
    const messagesUi = params.messages as { values?: ChatMessage[] } | undefined;
    const messages = (messagesUi?.values ?? []).map(m => ({
      role: m.role || 'user',
      content: m.content ?? '',
    }));
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers,
      body: { model: model(params, 'gpt-4o-mini'), messages },
      timeout: 60000,
    };
  }

  if (resource === 'image' && operation === 'analyze') {
    const options = params.options as { detail?: string; maxTokens?: number } | undefined;
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers,
      body: {
        model: model(params, 'gpt-4o'),
        max_tokens: options?.maxTokens ?? 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: params.text ?? '' },
              // n8n supplies the image via binary attachment on the
              // node's input item; the base64 payload's exact field
              // depends on which upstream node produced it (commonly
              // `input._binary.data.data`) — confirm this against the
              // real workflow's binary field name before running.
              { type: 'image_url', image_url: { url: '${input._binary.data.data}', detail: options?.detail ?? 'auto' } },
            ],
          },
        ],
      },
      timeout: 60000,
      _note: 'Image data URL references input._binary — confirm the actual binary property name from the upstream node before running.',
    };
  }

  return null;
};
