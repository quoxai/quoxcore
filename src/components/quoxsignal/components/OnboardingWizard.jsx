import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { AUTONOMY_LEVELS, AUTONOMY_DESCRIPTIONS } from '../lib/autonomy.js';
import { mergeLenses, DEFAULT_LENS_ID } from '../lib/triageLenses.js';
import {
  describeUrl, applyOnboarding, summariseFirstLook,
  LENS_EXPLAINER, SPEND_EXPLAINER, FIRST_POLL_NOTE,
  DEFAULT_ONBOARD_AUTONOMY, DEFAULT_ONBOARD_CAP_USD
} from '../lib/onboarding.js';

/**
 * SIGNAL-P8: the dashboard's first-run wizard, shown when an org follows ZERO sources.
 *
 * The mirror, not a second flow: `signal onboard` is the primary surface and this walks the
 * identical four steps in the identical order against the identical routes (POST /sources
 * carrying lens + autonomy_level, then PATCH /budgets/source/:id for the cap). The
 * decisions live in lib/onboarding.js so both surfaces answer the same questions the same
 * way; this component only asks and prints.
 *
 * Two things it refuses to fake:
 *   - a platform's real state is shown the moment a URL is pasted, not in a footnote, so an
 *     Instagram ACCOUNT url is called broken-upstream right there;
 *   - the last step does not claim to poll. Polling happens in the worker (or `signal
 *     poll`), so this shows what discovery has actually produced and says who does it.
 */

const STEPS = ['Sources', 'Lens', 'Spend', 'Go'];

/* The base .qx-banner is already the informational (blue) variant, so an info-level note
   needs no modifier; only broken and warn escalate the colour. */
function NoteList({ notes }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="qx-stack qx-stack--tight">
      {notes.map((n) => (
        <div
          key={n.code}
          className={`qx-banner${n.level === 'broken' ? ' qx-banner--error' : n.level === 'warn' ? ' qx-banner--warn' : ''}`}
          data-testid={`signal-onboard-note-${n.code}`}
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}

export default function OnboardingWizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [urlInput, setUrlInput] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [inputError, setInputError] = useState(null);
  const [lenses, setLenses] = useState(() => mergeLenses([]));
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [firstLook, setFirstLook] = useState(null);
  const [looking, setLooking] = useState(false);

  /* Fetched when the user reaches the lens step, not on mount: the wizard renders as the
     Sources tab's first-run state, and issuing a request nobody asked for on every mount is
     what the tab-cache work (SIGNAL-PERF) exists to avoid.
     Custom lenses are best-effort, the same posture `signal lens list` takes: an unreachable
     lens table must not make onboarding impossible, because the built-in presets are enough
     to follow a source with. */
  const [lensesLoaded, setLensesLoaded] = useState(false);
  useEffect(() => {
    if (step < 1 || lensesLoaded) return undefined;
    if (typeof api.listTriageLenses !== 'function') return undefined;
    let cancelled = false;
    setLensesLoaded(true);
    api.listTriageLenses()
      .then((d) => { if (!cancelled) setLenses(mergeLenses(d?.lenses || [])); })
      .catch(() => { /* presets only */ });
    return () => { cancelled = true; };
  }, [step, lensesLoaded]);

  function addUrl() {
    setInputError(null);
    let draft;
    try {
      draft = describeUrl(urlInput);
    } catch (e) {
      setInputError(e.message);
      return;
    }
    if (drafts.some((d) => d.url === draft.url)) {
      setInputError('that URL is already on the list');
      return;
    }
    setDrafts((list) => [...list, draft]);
    setUrlInput('');
  }

  function patchDraft(url, patch) {
    setDrafts((list) => list.map((d) => {
      if (d.url !== url) return d;
      // Changing the kind changes what the platform notes say, so re-describe rather than
      // leaving a stale "this looks like an account" warning attached to a feed.
      if (patch.kind && patch.kind !== d.kind) {
        return { ...describeUrl(d.url, { kind: patch.kind }), label: d.label, lens: d.lens, autonomy: d.autonomy, daily_cap_usd: d.daily_cap_usd };
      }
      return { ...d, ...patch };
    }));
  }

  function removeDraft(url) {
    setDrafts((list) => list.filter((d) => d.url !== url));
  }

  async function follow() {
    setSubmitting(true);
    try {
      const existing = await api.listSources({ force: true }).then((d) => d?.sources || []).catch(() => []);
      const out = await applyOnboarding(drafts, {
        existingSources: existing,
        createSource: (payload) => api.createSource(payload),
        setSourceDailyCap: (id, usd) => api.setSourceDailyCap(id, usd)
      });
      setResults(out);
      setStep(3);
      onDone?.();
    } finally {
      setSubmitting(false);
    }
  }

  async function checkFirstLook() {
    setLooking(true);
    try {
      const data = await api.listItems({}, { force: true });
      setFirstLook(summariseFirstLook(results || [], data?.items || []));
    } catch (e) {
      setFirstLook([{ label: 'lookup', status: 'error', reason: e.message }]);
    } finally {
      setLooking(false);
    }
  }

  const canAdvanceFromSources = drafts.length > 0;

  return (
    <div className="qx-stack" data-testid="signal-onboarding-wizard">
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart">
          <span className="qx-section-title">Set up QuoxSignal</span>
          <div className="qx-row qx-row--tight">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={`qx-pill qx-pill--xs ${i === step ? 'qx-pill--online' : 'qx-pill--ghost'}`}
              >
                {i + 1}. {s}
              </span>
            ))}
          </div>
        </div>
        <span className="qx-hint qx-hint--sm">
          You follow no sources yet. Four questions and you are watching something real.
          The same walk-through on the CLI is <code>signal onboard</code>.
        </span>
      </div>

      {/* ---------------------------------------------------------- 1. Sources */}
      {step === 0 && (
        <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
          <span className="qx-section-title">1. What do you want to follow?</span>
          <span className="qx-hint qx-hint--sm">
            Paste a URL: a profile, a blog, an RSS or Atom feed. A bare @handle is CLI-only
            (<code>signal follow @handle --on tiktok</code>) because it has to be resolved against the platform first.
          </span>
          <div className="qx-row qx-row--tight qx-row--wrap">
            <input
              type="text"
              className="qx-input qx-input--mono qx-input--grow"
              placeholder="https://example.com/feed.xml"
              aria-label="Source URL"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
            />
            <button type="button" className="qx-btn qx-btn--sm" onClick={addUrl} disabled={!urlInput.trim()}>
              Add
            </button>
          </div>
          {inputError && <div className="qx-banner qx-banner--error">{inputError}</div>}

          {drafts.map((d) => (
            <div key={d.url} className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="signal-onboard-draft">
              <div className="qx-row qx-row--apart">
                <span className="qx-mono qx-hint qx-hint--sm">{d.url}</span>
                <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => removeDraft(d.url)}>
                  Remove
                </button>
              </div>
              <div className="qx-row qx-row--tight qx-row--wrap">
                <span className="qx-pill qx-pill--ghost qx-pill--xs">{d.platform}</span>
                <select
                  className="qx-select qx-select--auto"
                  aria-label={`Kind for ${d.url}`}
                  value={d.kind}
                  onChange={(e) => patchDraft(d.url, { kind: e.target.value })}
                >
                  <option value="account">account</option>
                  <option value="feed">feed</option>
                </select>
                <input
                  type="text"
                  className="qx-input qx-input--grow"
                  aria-label={`Label for ${d.url}`}
                  value={d.label}
                  onChange={(e) => patchDraft(d.url, { label: e.target.value })}
                />
              </div>
              <NoteList notes={d.notes} />
            </div>
          ))}

          <div className="qx-row qx-row--end">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" disabled={!canAdvanceFromSources} onClick={() => setStep(1)}>
              Next: lens
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- 2. Lens */}
      {step === 1 && (
        <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
          <span className="qx-section-title">2. Which lens should judge each one?</span>
          <span className="qx-hint qx-hint--sm">{LENS_EXPLAINER}</span>

          {drafts.map((d) => (
            <div key={d.url} className="qx-stack qx-stack--tight">
              <div className="qx-row qx-row--tight qx-row--wrap">
                <strong>{d.label}</strong>
                <select
                  className="qx-select qx-select--auto"
                  aria-label={`Lens for ${d.label}`}
                  value={d.lens}
                  onChange={(e) => patchDraft(d.url, { lens: e.target.value })}
                >
                  {lenses.map((l) => (
                    <option key={l.id} value={l.id}>{l.id}{l.tier === 'custom' ? ' (custom)' : ''}</option>
                  ))}
                </select>
              </div>
              <span className="qx-hint qx-hint--sm">
                {lenses.find((l) => l.id === d.lens)?.purpose || ''}
              </span>
            </div>
          ))}

          <div className="qx-row qx-row--apart">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setStep(0)}>Back</button>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => setStep(2)}>Next: spend</button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ 3. Spend */}
      {step === 2 && (
        <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
          <span className="qx-section-title">3. How much may it do on its own, and what may it spend?</span>
          <span className="qx-hint qx-hint--sm">{SPEND_EXPLAINER}</span>

          {drafts.map((d) => (
            <div key={d.url} className="qx-stack qx-stack--tight">
              <div className="qx-row qx-row--tight qx-row--wrap">
                <strong>{d.label}</strong>
                <select
                  className="qx-select qx-select--auto"
                  aria-label={`Autonomy for ${d.label}`}
                  value={d.autonomy}
                  onChange={(e) => patchDraft(d.url, { autonomy: e.target.value })}
                >
                  {AUTONOMY_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <label className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <span className="qx-hint qx-hint--sm">daily cap $</span>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    className="qx-input qx-input--narrow"
                    aria-label={`Daily cap for ${d.label}`}
                    value={d.daily_cap_usd}
                    onChange={(e) => patchDraft(d.url, { daily_cap_usd: Number(e.target.value) })}
                  />
                </label>
              </div>
              <span className="qx-hint qx-hint--sm">{AUTONOMY_DESCRIPTIONS[d.autonomy]}</span>
            </div>
          ))}

          <div className="qx-row qx-row--apart">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setStep(1)}>Back</button>
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--primary"
              disabled={submitting}
              onClick={follow}
              data-testid="signal-onboard-follow"
            >
              {submitting ? 'Following…' : `Follow ${drafts.length} source${drafts.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------- 4. Go */}
      {step === 3 && results && (
        <div className="qx-card qx-card--compact qx-stack qx-stack--tight">
          <span className="qx-section-title">4. Followed</span>
          {results.map((r) => (
            <div key={r.url} className="qx-stack qx-stack--tight" data-testid={`signal-onboard-result-${r.status}`}>
              <div className="qx-row qx-row--tight qx-row--wrap">
                <span className={`qx-pill qx-pill--xs ${r.status === 'error' ? 'qx-pill--offline' : r.status === 'existing' ? 'qx-pill--ghost' : 'qx-pill--online'}`}>
                  {r.status === 'created' ? 'followed' : r.status === 'existing' ? 'already followed' : 'failed'}
                </span>
                <strong>{r.label}</strong>
                {r.status === 'created' && (
                  <span className="qx-hint qx-hint--sm">
                    lens {r.lens} · autonomy {r.autonomy_level} ·{' '}
                    {r.cap_error ? `daily cap NOT set (${r.cap_error})` : `daily cap $${Number(r.daily_cap_usd).toFixed(2)}`}
                  </span>
                )}
                {r.status === 'error' && <span className="qx-hint qx-hint--sm">{r.error}</span>}
              </div>
              <NoteList notes={r.notes} />
            </div>
          ))}

          <span className="qx-section-title">First look</span>
          <span className="qx-hint qx-hint--sm">{FIRST_POLL_NOTE}</span>
          <div className="qx-row qx-row--tight">
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              onClick={checkFirstLook}
              disabled={looking}
              data-testid="signal-onboard-first-look"
            >
              {looking ? 'Checking…' : 'Check what has arrived'}
            </button>
          </div>
          {firstLook && (
            <div className="qx-stack qx-stack--tight">
              {firstLook.map((f) => (
                <div key={f.label} className="qx-row qx-row--tight qx-row--wrap">
                  <span className={`qx-pill qx-pill--xs ${f.status === 'items' ? 'qx-pill--online' : f.status === 'blocked' || f.status === 'error' ? 'qx-pill--offline' : 'qx-pill--ghost'}`}>
                    {f.status === 'items' ? `${f.count} item${f.count === 1 ? '' : 's'}` : f.status === 'blocked' ? 'blocked' : f.status === 'error' ? 'lookup failed' : 'nothing yet'}
                  </span>
                  <strong>{f.label}</strong>
                  {f.reason && <span className="qx-hint qx-hint--sm">{f.reason}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="qx-row qx-row--end">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => onDone?.()}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
