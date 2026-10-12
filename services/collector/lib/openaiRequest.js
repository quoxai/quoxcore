function usesMaxCompletionTokens(model) {
  return /^gpt-5($|[-.])/.test(String(model || ''));
}

function sanitizeOpenAIJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }

  const sanitized = {};

  if (typeof schema.type === 'string') sanitized.type = schema.type;
  if (typeof schema.description === 'string') sanitized.description = schema.description;
  if (Array.isArray(schema.enum)) sanitized.enum = [...schema.enum];
  if (Array.isArray(schema.required)) sanitized.required = [...schema.required];
  if (typeof schema.default !== 'undefined') sanitized.default = schema.default;
  if (typeof schema.minimum !== 'undefined') sanitized.minimum = schema.minimum;
  if (typeof schema.maximum !== 'undefined') sanitized.maximum = schema.maximum;
  if (typeof schema.additionalProperties === 'boolean') sanitized.additionalProperties = schema.additionalProperties;

  if (schema.type === 'object' || schema.properties) {
    sanitized.type = 'object';
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    sanitized.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, sanitizeOpenAIJsonSchema(value)])
    );
    if (!Array.isArray(sanitized.required)) {
      sanitized.required = [];
    }
  }

  if (schema.type === 'array') {
    sanitized.type = 'array';
    sanitized.items = sanitizeOpenAIJsonSchema(schema.items || { type: 'string' });
  }

  if (Array.isArray(schema.oneOf)) {
    sanitized.oneOf = schema.oneOf.map((entry) => sanitizeOpenAIJsonSchema(entry));
  }

  if (Array.isArray(schema.anyOf)) {
    sanitized.anyOf = schema.anyOf.map((entry) => sanitizeOpenAIJsonSchema(entry));
  }

  return sanitized;
}

function toOpenAIChatTools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeOpenAIJsonSchema(tool.input_schema),
    }
  }));
}

function flattenOpenAIMessageContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).filter(Boolean).join('\n\n');
  }
  return String(content);
}

/**
 * Compose [system, ...history, user] for an OpenAI-style chat completion.
 *
 * Lives here (rather than inline in server.js) so every OpenAI caller can
 * reach it, including the governed stack-mode failover path. That path used
 * to build [system, user] only, which silently dropped multi-turn context on
 * any chat whose policy resolved to an OpenAI candidate.
 */
function buildOpenAIStyleConversationMessages(systemPrompt, userMessage, conversation_history) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(conversation_history) && conversation_history.length > 0) {
    for (const turn of conversation_history) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const content = flattenOpenAIMessageContent(turn.content);
      if (!content) continue;
      messages.push({ role: turn.role, content });
    }
  }
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

function buildOpenAIChatCompletionBody({
  model,
  systemPrompt,
  userMessage,
  messages,
  maxTokens = 4096,
  tools,
  toolChoice,
}) {
  const body = {
    model,
    messages: Array.isArray(messages) && messages.length > 0
      ? messages
      : [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
  };

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  if (usesMaxCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  return body;
}

module.exports = {
  usesMaxCompletionTokens,
  sanitizeOpenAIJsonSchema,
  toOpenAIChatTools,
  buildOpenAIChatCompletionBody,
  flattenOpenAIMessageContent,
  buildOpenAIStyleConversationMessages,
};
