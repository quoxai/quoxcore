/**
 * Qlarity view — governed browser inspection.
 *
 * Native qx-* view, never an embedded app (blueprint rule). No per-product
 * CSS file: layout, cards, buttons and chips all come from the global design
 * vocabulary, per glass-design-system and BLUEPRINT defect 5.4.
 *
 * The view's job is to make three things obvious that a CLI hides:
 *   - what the egress policy currently allows, before you wonder why a URL
 *     failed;
 *   - what was BLOCKED during an inspection, because a silently broken page
 *     is an inspection that lies by omission;
 *   - that eval is an approval, not a result.
 */

import { useCallback, useEffect, useState } from 'react';
import api from './lib/api';

const DEFAULT_INSPECTOR = 'computed_style';

export default function QlarityView() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [inspectors, setInspectors] = useState([]);
  const [allowlist, setAllowlist] = useState(null);
  // The org's OWN declared origins, which is the part a customer can change.
  const [orgOrigins, setOrgOrigins] = useState([]);
  const [newOrigin, setNewOrigin] = useState('');
  const [originBusy, setOriginBusy] = useState(false);
  const [originError, setOriginError] = useState(null);

  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [inspector, setInspector] = useState(DEFAULT_INSPECTOR);
  const [result, setResult] = useState(null);
  const [blocked, setBlocked] = useState([]);
  // Held separately rather than folded into `result`, because these are
  // recordings of the whole session so far, not the answer to one question.
  const [consoleLog, setConsoleLog] = useState(null);
  const [network, setNetwork] = useState(null);
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);

  const refreshSessions = useCallback(async () => {
    try {
      const d = await api.listSessions();
      setSessions(d.sessions || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const addOrigin = useCallback(async () => {
    const v = newOrigin.trim();
    if (!v) return;
    setOriginBusy(true);
    setOriginError(null);
    try {
      const d = await api.addOrgOrigin(v);
      setOrgOrigins(d.origins || []);
      setNewOrigin('');
    } catch (e) {
      // Show the server's REASON (wildcard, credentials, bad hostname), not a
      // generic failure: the reason is what tells the user what to type next.
      setOriginError(e.status === 403
        ? 'Adding an origin requires an org admin.'
        : e.message);
    } finally {
      setOriginBusy(false);
    }
  }, [newOrigin]);

  const removeOrigin = useCallback(async (origin) => {
    setOriginBusy(true);
    setOriginError(null);
    try {
      const d = await api.removeOrgOrigin(origin);
      setOrgOrigins(d.origins || []);
    } catch (e) {
      setOriginError(e.status === 403 ? 'Removing an origin requires an org admin.' : e.message);
    } finally {
      setOriginBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [h, i, a, o] = await Promise.all([
          api.health(), api.inspectors(), api.allowlist(),
          // Fail-soft: an older collector without these routes must not blank
          // the whole view, it just shows no org origins.
          api.orgOrigins().catch(() => ({ origins: [] })),
        ]);
        if (!alive) return;
        setHealth(h);
        setInspectors(i.inspectors || []);
        setAllowlist(a);
        setOrgOrigins(o.origins || []);
        await refreshSessions();
      } catch (e) {
        if (alive) setError(e.message);
      }
    })();
    return () => { alive = false; };
  }, [refreshSessions]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const onCreate = () => run(async () => {
    const s = await api.createSession();
    setActive(s.id);
    setResult(null);
    setBlocked([]);
    await refreshSessions();
  });

  const onOpen = () => run(async () => {
    if (!active || !url) return;
    const r = await api.open(active, url);
    setBlocked(r.blocked || []);
    setResult({ kind: 'open', data: { url: r.url, status: r.status, title: r.title } });
    await refreshSessions();
  });

  const onInspect = () => run(async () => {
    if (!active) return;
    const args = selector ? { selector } : {};
    const r = await api.inspect(active, inspector, args);
    setResult({ kind: 'inspect', data: r.result });
    const b = await api.blocked(active);
    setBlocked(b.blocked || []);
  });

  const onClose = (id) => run(async () => {
    await api.closeSession(id);
    if (id === active) {
      setActive(null); setResult(null); setBlocked([]);
      setConsoleLog(null); setNetwork(null); setShot(null);
    }
    await refreshSessions();
  });

  // BUNDLE POLISH B: the service has recorded these since it shipped and the
  // dashboard rendered none of them, so seeing what QLarity actually saw meant
  // an agent tool call or curl. A governed browser whose findings a human
  // cannot read is half a product.
  const onConsole = () => run(async () => {
    if (!active) return;
    setConsoleLog(await api.consoleLog(active));
  });

  const onNetwork = () => run(async () => {
    if (!active) return;
    setNetwork(await api.network(active));
  });

  const onScreenshot = () => run(async () => {
    if (!active) return;
    setShot(await api.screenshot(active));
  });

  // Licence refusal is the one error worth its own treatment: it is not a
  // fault, it is the gate working, and it needs a different sentence.
  const unlicensed = error && /not licensed/i.test(error);

  return (
    <div className="qx-pad">
      <div className="qx-row qx-row--between">
        <div>
          <h1>Qlarity</h1>
          <p className="qx-muted">Open a page, ask it a question, keep the receipt.</p>
        </div>
        {health && (
          <span className="qx-chip">
            <span className={`qx-dot ${health.status === 'ok' ? 'qx-dot--online' : 'qx-dot--offline'}`} />
            {health.sessions} session{health.sessions === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {unlicensed && (
        <div className="qx-card">
          <strong>Qlarity is not licensed for this organisation.</strong>
          <p className="qx-muted">
            The service is running and refusing you, which is the licence gate working
            rather than a fault. Add the entitlement to enable it.
          </p>
        </div>
      )}

      {error && !unlicensed && (
        <div className="qx-card">
          <strong>{error}</strong>
        </div>
      )}

      {/* Egress policy up front. Nobody should have to guess why a URL failed.
          The empty state used to be legible but NOT actionable: it told a new
          customer nothing could be inspected and gave them no way to change
          that without shell access to the host. It is now the place you add
          an origin. */}
      {allowlist && (
        <div className="qx-card">
          <div className="qx-row qx-row--between">
            <strong>Egress policy</strong>
            <span className="qx-chip qx-chip--xs">{allowlist.policy}</span>
          </div>

          {orgOrigins.length > 0 && (
            <>
              <p className="qx-muted" style={{ marginBottom: 6 }}>Declared by your organisation</p>
              <div className="qx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {orgOrigins.map((e) => (
                  <span key={e.origin} className="qx-chip qx-chip--xs">
                    {e.origin}
                    <button
                      type="button"
                      className="qx-btn qx-btn--ghost qx-btn--sm"
                      style={{ marginLeft: 6, padding: '0 4px' }}
                      title={`Stop allowing ${e.origin}`}
                      disabled={originBusy}
                      onClick={() => removeOrigin(e.origin)}
                    >x</button>
                  </span>
                ))}
              </div>
            </>
          )}

          {allowlist.entries?.length ? (
            <>
              <p className="qx-muted" style={{ margin: '10px 0 6px' }}>
                Set for every organisation on this install
              </p>
              <div className="qx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {allowlist.entries.map((e) => <span key={e} className="qx-chip qx-chip--xs">{e}</span>)}
              </div>
            </>
          ) : null}

          {orgOrigins.length === 0 && !allowlist.entries?.length && (
            <p className="qx-muted">
              No origins declared, so nothing can be inspected. This is the safe default,
              not a misconfiguration to route around with a wildcard. Add the site you
              want to inspect below.
            </p>
          )}

          <div className="qx-row qx-row--tight" style={{ marginTop: 10 }}>
            <input
              type="text"
              className="qx-input qx-input--grow"
              placeholder="staging.example.com"
              value={newOrigin}
              disabled={originBusy}
              onChange={(e) => { setNewOrigin(e.target.value); setOriginError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') addOrigin(); }}
            />
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              disabled={originBusy || !newOrigin.trim()}
              onClick={addOrigin}
            >
              {originBusy ? 'Adding...' : 'Allow origin'}
            </button>
          </div>
          {originError && (
            <p className="qx-hint qx-hint--danger" style={{ marginTop: 6 }}>{originError}</p>
          )}
          <p className="qx-muted" style={{ marginTop: 6, fontSize: '0.8rem' }}>
            Adding an origin needs an org admin. It lets sessions reach that public site only:
            internal addresses stay blocked regardless, and widening to those is an operator
            change on the host.
          </p>
        </div>
      )}

      <div className="qx-card">
        <div className="qx-row qx-row--between">
          <strong>Sessions</strong>
          <button type="button" className="qx-btn qx-btn--sm" onClick={onCreate} disabled={busy}>
            New session
          </button>
        </div>
        {/* 2026-08-19: this was a bare "No open sessions." and nothing else —
            a dead end on a paid plugin's main screen. Honest, but it taught a
            new customer nothing about what the product does or how to start.
            The inspector list is already loaded above, so showing it costs
            nothing and answers the actual question ("what can I ask a page?")
            with REAL data rather than invented marketing copy. */}
        {sessions.length === 0 && (
          <div className="qx-empty">
            <p style={{ marginBottom: 10 }}>
              No open sessions. Start one above, or take a single reading from the terminal.
            </p>
            {inspectors.length > 0 && (
              <>
                <p className="qx-muted" style={{ fontSize: '0.8rem', marginBottom: 6 }}>
                  An inspector is a parameterised read: it takes a selector and a property,
                  never a code string. {inspectors.length} available here:
                </p>
                <div className="qx-row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {inspectors.map((i) => (
                    <span key={i.name} className="qx-chip" title={i.description || i.name}>{i.name}</span>
                  ))}
                </div>
              </>
            )}
            <code className="qx-code" style={{ display: 'block', fontSize: '0.78rem' }}>
              quox qlarity read https://example.com --inspector computed_style --selector &quot;h1&quot; --properties &quot;color,font-size&quot;
            </code>
          </div>
        )}
        {sessions.map((s) => (
          <div key={s.id} className="qx-row qx-row--between">
            <button
              type="button"
              className={`qx-btn qx-btn--ghost qx-btn--sm ${s.id === active ? 'qx-btn--active' : ''}`}
              onClick={() => { setActive(s.id); setResult(null); setBlocked([]); }}
            >
              {s.url || 'no page open'}
            </button>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => onClose(s.id)}>
              Close
            </button>
          </div>
        ))}
      </div>

      {active && (
        <>
          <div className="qx-card">
            <strong>Open a page</strong>
            <div className="qx-row">
              <input
                className="qx-input"
                value={url}
                placeholder="http://localhost:5173/"
                onChange={(e) => setUrl(e.target.value)}
              />
              <button type="button" className="qx-btn qx-btn--sm" onClick={onOpen} disabled={busy || !url}>
                Open
              </button>
            </div>
          </div>

          <div className="qx-card">
            <strong>Inspect</strong>
            <div className="qx-row">
              <select className="qx-input" value={inspector} onChange={(e) => setInspector(e.target.value)}>
                {inspectors.map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
              </select>
              <input
                className="qx-input"
                value={selector}
                placeholder=".card"
                onChange={(e) => setSelector(e.target.value)}
              />
              <button type="button" className="qx-btn qx-btn--sm" onClick={onInspect} disabled={busy}>
                Read
              </button>
            </div>
            <p className="qx-muted">
              Inspectors take a selector and a property, never a script. Arbitrary
              evaluation is a separate action and is always a human approval.
            </p>
          </div>

          <div className="qx-card">
            <strong>What the page did</strong>
            <p className="qx-muted">
              Recorded for the whole session, not just the last question. Console
              messages, requests and a screenshot of what is on screen right now.
            </p>
            <div className="qx-row">
              <button type="button" className="qx-btn qx-btn--sm" onClick={onConsole} disabled={busy} data-testid="qlarity-console-btn">
                Console
              </button>
              <button type="button" className="qx-btn qx-btn--sm" onClick={onNetwork} disabled={busy} data-testid="qlarity-network-btn">
                Network
              </button>
              <button type="button" className="qx-btn qx-btn--sm" onClick={onScreenshot} disabled={busy} data-testid="qlarity-screenshot-btn">
                Screenshot
              </button>
            </div>
          </div>
        </>
      )}

      {/* Each of these reports `dropped` rather than quietly truncating. Reading
          500 messages from a page that emitted 12,000 and not being told is how
          a user concludes a page is clean when it is not. */}
      {consoleLog && (
        <div className="qx-card" data-testid="qlarity-console-panel">
          <div className="qx-row qx-row--between">
            <strong>Console</strong>
            <span className="qx-chip qx-chip--xs">{consoleLog.total ?? 0}</span>
          </div>
          {consoleLog.dropped > 0 && (
            <p className="qx-muted">
              {consoleLog.dropped} earlier message{consoleLog.dropped === 1 ? '' : 's'} fell
              out of the buffer and are not shown.
            </p>
          )}
          {(consoleLog.messages || []).length === 0
            ? <p className="qx-muted">The page logged nothing. That is a result, not an empty panel.</p>
            : (consoleLog.messages || []).map((m, i) => (
              <div key={`${m.at}-${i}`} className="qx-row qx-row--between">
                <code>{m.text}</code>
                <span className={`qx-chip qx-chip--xs ${/error|pageerror/i.test(m.type) ? 'qx-chip--danger' : ''}`}>{m.type}</span>
              </div>
            ))}
        </div>
      )}

      {network && (
        <div className="qx-card" data-testid="qlarity-network-panel">
          <div className="qx-row qx-row--between">
            <strong>Network problems</strong>
            <span className="qx-chip qx-chip--xs">{network.total ?? 0}</span>
          </div>
          {/*
            Named for what it RECORDS. The service's recorder captures failed
            requests, HTTP 4xx/5xx and egress blocks — not all traffic. Driving
            it against a healthy page returned 0, and the old heading "Network"
            with a count made that read as a broken recorder rather than as a
            clean page. A panel implying it measures more than it does is the
            same defect as one claiming a state it never checked.
          */}
          <p className="qx-muted">
            Failed requests, HTTP errors and anything the egress policy refused.
            Successful requests are not listed.
          </p>
          {network.dropped > 0 && (
            <p className="qx-muted">{network.dropped} earlier problem(s) fell out of the buffer.</p>
          )}
          {(network.events || []).length === 0
            ? <p className="qx-muted">Nothing failed on this page. That is the good outcome, not an empty panel.</p>
            : (network.events || []).map((e, i) => (
              <div key={`${e.url}-${i}`} className="qx-row qx-row--between">
                <code>{e.url}</code>
                <span className={`qx-chip qx-chip--xs ${Number(e.status) >= 400 ? 'qx-chip--danger' : ''}`}>
                  {e.status ?? e.method ?? ''}
                </span>
              </div>
            ))}
        </div>
      )}

      {shot && (
        <div className="qx-card" data-testid="qlarity-screenshot-panel">
          <div className="qx-row qx-row--between">
            <strong>Screenshot</strong>
            <span className="qx-chip qx-chip--xs">{Math.round((shot.bytes || 0) / 1024)} KB</span>
          </div>
          <img
            src={`data:image/${shot.format || 'png'};base64,${shot.data}`}
            alt={`Rendered view of ${shot.url || 'the open page'}`}
            style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }}
          />
          {/* The digest is what makes this evidence rather than a loose PNG:
              it is the hash of what the page looked like at that moment. */}
          <p className="qx-muted">
            {shot.captured_at} · sha256 <code>{String(shot.sha256 || '').slice(0, 16)}…</code>
          </p>
        </div>
      )}

      {result && (
        <div className="qx-card">
          <strong>{result.kind === 'open' ? 'Page' : `Result: ${inspector}`}</strong>
          <pre className="qx-pre">{JSON.stringify(result.data, null, 2)}</pre>
        </div>
      )}

      {/* Blocked requests are shown even when the inspection "worked": a page
          that silently failed to load a subresource looks fine and is not. */}
      {blocked.length > 0 && (
        <div className="qx-card">
          <div className="qx-row qx-row--between">
            <strong>Blocked by egress policy</strong>
            <span className="qx-chip qx-chip--xs">{blocked.length}</span>
          </div>
          <p className="qx-muted">
            The page tried to reach these and was refused. If the page looks wrong,
            look here first.
          </p>
          {blocked.map((b, i) => (
            <div key={`${b.url}-${i}`} className="qx-row qx-row--between">
              <code>{b.url}</code>
              <span className="qx-chip qx-chip--xs">{b.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
