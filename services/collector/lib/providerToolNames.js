'use strict';
// QUOXON-ADV (2026-10-13): provider tool-name boundary. OpenAI (and every OpenAI-compatible
// path, Ollama included) and Anthropic accept only ^[a-zA-Z0-9_-]{1,64}$ as a tool name, but
// some registered tools are dotted (toolsmith.runScript), which made every toolsmith turn 400.
// Names are encoded ONLY when invalid, and a model's call is decoded through the tools that
// were actually offered, so a valid name (including one with '__') round-trips untouched.
const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function encodeToolName(name) {
  const n = String(name || '');
  if (PROVIDER_TOOL_NAME.test(n)) return n;
  return n.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/** -> (providerName) => registered name. `offered` is a function returning the current tool list. */
function toolNameDecoder(offered) {
  let map = null, size = -1;
  return (providerName) => {
    const list = (typeof offered === 'function' ? offered() : offered) || [];
    if (!map || list.length !== size) {
      map = new Map(); size = list.length;
      for (const t of list) if (t && t.name) map.set(encodeToolName(t.name), t.name);
    }
    return map.get(providerName) || providerName;
  };
}

module.exports = { PROVIDER_TOOL_NAME, encodeToolName, toolNameDecoder };
