/**
 * MessageContextPanel — QCX-5i
 *
 * Slide-in admin drawer that shows EXACTLY what the LLM saw for a given
 * assistant message. Loads the QCX-5a backend (GET .../messages/:m/context)
 * and renders system prompt + sent history + RAG chunks + model/tier/tokens.
 *
 * Used by LogsTab to root-cause bad answers in ≤2 clicks.
 */

import { useEffect, useState } from 'react';
import './MessageContextPanel.css';

export default function MessageContextPanel({ orgId, widgetId, messageId, authFetch, onClose }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    (async () => {
      try {
        const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/messages/${messageId}/context`);
        if (cancelled) return;
        if (resp.status === 404) {
          setState({ loading: false, data: null, error: 'not_found' });
          return;
        }
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          setState({ loading: false, data: null, error: body.error || `Error ${resp.status}` });
          return;
        }
        const json = await resp.json();
        setState({ loading: false, data: json, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({ loading: false, data: null, error: e.message || 'Network error' });
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, orgId, widgetId, messageId]);

  return (
    <aside className="mcp" role="dialog" aria-label="Message context">
      <header className="mcp__head">
        <h3>LLM context</h3>
        <button type="button" className="mcp__close" aria-label="Close" onClick={onClose}>×</button>
      </header>

      {state.loading && (
        <div className="mcp__status">Loading…</div>
      )}

      {!state.loading && state.error === 'not_found' && (
        <div className="mcp__empty">
          <p>No context was captured for this message.</p>
          <p className="mcp__empty-detail">
            Older messages — or user-side rows — don’t have a captured context. New
            assistant turns from QCX-5a onward will populate this view.
          </p>
        </div>
      )}

      {!state.loading && state.error && state.error !== 'not_found' && (
        <div className="mcp__error">Couldn’t load context: {state.error}</div>
      )}

      {!state.loading && state.data && (
        <ContextBody data={state.data} />
      )}
    </aside>
  );
}

function ContextBody({ data }) {
  const ctx = data.context || {};
  const totalTokens = (ctx.input_tokens || 0) + (ctx.output_tokens || 0);
  return (
    <div className="mcp__body">
      <section className="mcp__section">
        <h4>Model</h4>
        <dl className="mcp__meta">
          <dt>Provider</dt><dd>{ctx.provider || '—'}</dd>
          <dt>Model</dt><dd className="mcp__mono">{ctx.model || '—'}</dd>
          <dt>Tier</dt><dd>{ctx.tier || '—'}</dd>
          <dt>Tokens (in / out / total)</dt>
          <dd>{ctx.input_tokens ?? '—'} / {ctx.output_tokens ?? '—'} / {totalTokens || '—'}</dd>
          {ctx.injection_score != null && (
            <>
              <dt>Injection score</dt>
              <dd>{ctx.injection_score}</dd>
            </>
          )}
        </dl>
      </section>

      {ctx.grounding && (
        <section className="mcp__section">
          <h4>Grounding</h4>
          <dl className="mcp__meta">
            <dt>Retrieval confidence</dt>
            <dd>{ctx.grounding.confidence || '—'}{ctx.grounding.top_score != null ? ` (top ${Number(ctx.grounding.top_score).toFixed(2)})` : ''}</dd>
            <dt>Links removed</dt>
            <dd className="mcp__mono">{(ctx.grounding.links_removed || []).length ? ctx.grounding.links_removed.join(', ') : 'none'}</dd>
            <dt>Unsupported figures</dt>
            <dd>{(ctx.grounding.unsupported_figures || []).length ? ctx.grounding.unsupported_figures.join(', ') : 'none'}</dd>
            <dt>Correction</dt>
            <dd>{ctx.grounding.corrected ? 'regenerated' : 'not needed'}{ctx.grounding.stripped ? ', unsupported sentences removed' : ''}</dd>
            <dt>Claim check</dt>
            <dd>{!ctx.grounding.claims ? 'not run' : ctx.grounding.claims.ok === false ? `unverified (${ctx.grounding.claims.error || 'verifier unavailable'})` : (ctx.grounding.claims.unsupported || []).length ? `flagged: ${ctx.grounding.claims.unsupported.join('; ')}` : (ctx.grounding.claims.checked ? 'all claims supported' : 'skipped (trivial reply)')}</dd>
            <dt>History</dt>
            <dd>{ctx.grounding.history_source || '—'}{ctx.grounding.dropped_client_assistant_turns ? ` (${ctx.grounding.dropped_client_assistant_turns} untrusted browser turns dropped)` : ''}</dd>
          </dl>
        </section>
      )}

      <section className="mcp__section">
        <h4>System prompt</h4>
        <pre className="mcp__pre">{ctx.system_prompt || '—'}</pre>
      </section>

      <section className="mcp__section">
        <h4>Messages sent to the LLM ({(ctx.messages_sent || []).length})</h4>
        <div className="mcp__messages">
          {(ctx.messages_sent || []).map((m, i) => (
            <div key={i} className={`mcp__msg mcp__msg--${m.role || 'user'}`}>
              <div className="mcp__msg-role">{m.role}</div>
              <div className="mcp__msg-content">{m.content}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mcp__section">
        <h4>RAG chunks ({(ctx.rag_chunks || []).length})</h4>
        {(ctx.rag_chunks || []).length === 0 ? (
          <div className="mcp__hint">No knowledge chunks were retrieved for this turn.</div>
        ) : (
          <ul className="mcp__chunks">
            {ctx.rag_chunks.map((c, i) => (
              <li
                key={i}
                className="mcp__chunk"
                data-pinned={c.pinned ? 'true' : undefined}
              >
                <div className="mcp__chunk-head">
                  {c.pinned && <span className="mcp__pin" title="Pinned">★</span>}
                  <span className="mcp__chunk-source">{c.source || '—'}</span>
                  {c.section && <span className="mcp__chunk-section">› {c.section}</span>}
                  {typeof c.score === 'number' && (
                    <span
                      className={`mcp__chunk-score mcp__chunk-score--${c.score >= 0.70 ? 'high' : c.score >= 0.40 ? 'med' : 'low'}`}
                    >
                      {Math.round(c.score * 100)}%
                    </span>
                  )}
                </div>
                {c.text && <div className="mcp__chunk-body">{c.text}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
