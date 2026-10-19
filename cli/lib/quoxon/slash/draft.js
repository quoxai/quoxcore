/**
 * One drafting model call for /automate and /crystallize, through the same governed turn path as chat (api.stream)
 * but in its own throwaway conversation, so it never lands in the visible transcript. The model is told to answer
 * with JSON only and use no tools; an approval request or error aborts the draft. The JSON is validated by the
 * caller before any card is shown.
 */
import { textGate } from '../events.js';

const newId = () => `QXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** The visible conversation as plain text for the drafting prompt (last `max` chars). */
export function transcriptText(state, max = 12000) {
  const out = [];
  for (const it of [...(state?.history || []), ...(state?.blocks || [])]) {
    if (it.kind === 'user' && !it.echo && it.text && !it.text.startsWith('/')) out.push(`User: ${it.text}`);
    else if (it.kind === 'text' && it.text) out.push(`Quox: ${it.text}`);
    else if (it.kind === 'tool' && it.tool) out.push(`Tool used: ${[it.tool, it.target].filter(Boolean).join(' ')}`);
  }
  const t = out.join('\n');
  return t.length > max ? t.slice(t.length - max) : t;
}

/** First JSON object in a model reply (plain, fenced, or surrounded by prose), or null. */
export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fence ? fence[1] : s;
  const a = cand.indexOf('{'), b = cand.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(cand.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** -> parsed object, or throws Error(reason). `fields` = streamFields(model choice). */
export async function draftJson({ api, prompt, fields = {}, timeoutMs = 90000 }) {
  if (!api.stream) throw new Error('no model connection in this mode');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text = '', gate = null;
  try {
    for await (const ev of api.stream({ turnId: newId(), message: prompt, agent: 'quox', ...fields }, ctrl.signal)) {
      if (ev.type === 'error') throw new Error(String(ev.error || 'the model call failed'));
      if (ev.type === 'approval.requested') throw new Error('the model tried to use a tool instead of drafting');
      const g = textGate(gate, ev); gate = g.st;
      if (g.append) text += ev.content;
      if (ev.type === 'turn.finished' || ev.type === 'done') break;
    }
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('the model took too long');
    throw e;
  } finally { clearTimeout(timer); }
  const j = extractJson(text);
  if (!j) throw new Error('the model did not return a usable draft');
  return j;
}
