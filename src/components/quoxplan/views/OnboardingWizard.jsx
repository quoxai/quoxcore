import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { slugifyRoadmapName, isSlugifiableRoadmapName } from '../lib/slugify.js';
import { toastApiError } from '../lib/toastBus.js';
import OctaGlyph from '../components/OctaGlyph.jsx';

const STEPS = ['Name your roadmap', 'Meet ROADY', 'Set up your tools'];

/** Step 1: create-or-skip the org's first roadmap. */
function NameStep({ onCreated, onSkip }) {
  const { refreshRoadmaps } = useRoadmapCtx();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const slug = slugifyRoadmapName(name);
  const valid = isSlugifiableRoadmapName(name);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createRoadmap({ id: slug, name: name.trim(), description: description.trim() });
      await refreshRoadmaps();
      onCreated(created.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(`A roadmap with id "${slug}" already exists. Try a slightly different name.`);
      } else {
        toastApiError(err, 'Could not create roadmap');
        setError(err.body?.error || err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qx-stack">
      <p className="qx-hint" style={{ margin: 0 }}>
        Give your org's roadmap a name. QuoxPlan tracks streams, phases, plans and action items under it.
      </p>
      <label className="qx-stack qx-stack--tight">
        <span className="qx-hint qx-hint--sm">Name</span>
        <input
          className="qx-input"
          placeholder="e.g. Acme Platform"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        {name.trim() && <span className="qx-hint qx-hint--sm qxp-mono">id: {slug || '(needs letters or digits)'}</span>}
      </label>
      <label className="qx-stack qx-stack--tight">
        <span className="qx-hint qx-hint--sm">Description (optional)</span>
        <textarea
          className="qx-textarea"
          placeholder="What is this roadmap for?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </label>
      {error && <span className="qx-hint qx-hint--danger">{error}</span>}
      <div className="qx-row qx-row--tight">
        <button type="button" className="qx-btn qx-btn--primary" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create roadmap'}
        </button>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onSkip}>
          Skip this step
        </button>
      </div>
    </div>
  );
}

/** Step 2: introduce the ROADY rail. */
function RoadyStep({ onOpenRoady }) {
  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <OctaGlyph status="DECISION_NEEDED" size={20} />
        <strong>ROADY</strong>
      </div>
      <p className="qx-hint" style={{ margin: 0 }}>
        ROADY is the roadmap agent living in a collapsible rail on the right of every QuoxPlan view. Ask it about any
        roadmap or stream you're looking at, brief it before a status meeting, or have it draft a note for you; it
        reads the same data you do, nothing more.
      </p>
      {onOpenRoady && (
        <button type="button" className="qx-btn" onClick={onOpenRoady}>
          Open the ROADY rail
        </button>
      )}
    </div>
  );
}

/** Step 3: static pointers to the CLI/skill/docs — no live data needed. */
function ToolsStep() {
  return (
    <div className="qx-stack">
      <p className="qx-hint" style={{ margin: 0 }}>
        QuoxPlan works the same from the dashboard, the terminal, or a Claude session.
      </p>
      <ul className="qx-stack qx-stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
        <li>
          <span className="qxp-mono">quoxplan</span>: standalone CLI (focus, show, timeline, tui)
        </li>
        <li>
          <span className="qxp-mono">quox plan</span>: same verbs, authenticated through the dashboard
        </li>
        <li>The QuoxPlan skill + suggested rules block ships with the plugin for Claude sessions</li>
        <li>
          <a href="https://quox.ai/docs/plugins/quoxplan" target="_blank" rel="noreferrer">
            Full docs
          </a>
        </li>
      </ul>
    </div>
  );
}

/**
 * First-run onboarding (QUOXPLAN-P7, owner feedback wave 2 item 2): shown by
 * RootRedirect instead of the plain empty state when the org has no
 * roadmaps, or forced via `?onboarding=1` for QA/screenshots (see
 * QuoxPlanView.jsx). No data is stored client-side beyond the
 * `quoxplan.onboarding.dismissed` view pref, owned by the caller.
 */
export default function OnboardingWizard({ onOpenRoady, onDismiss, forcePreview }) {
  const navigate = useNavigate();
  const { roadmaps } = useRoadmapCtx();
  const [step, setStep] = useState(0);
  const [createdRoadmapId, setCreatedRoadmapId] = useState(null);

  function finish() {
    onDismiss();
    if (createdRoadmapId) {
      navigate(`/quoxplan/${createdRoadmapId}/focus`);
    } else if (forcePreview) {
      navigate('/quoxplan', { replace: true });
    }
  }

  return (
    <div className="qx-card qxp-onboarding">
      <div className="qxp-onboarding__dots" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length}>
        {STEPS.map((label, i) => (
          <span key={label} className={`qxp-onboarding__dot${i === step ? ' qxp-onboarding__dot--active' : ''}`} title={label} />
        ))}
      </div>
      <h2 style={{ marginTop: 4 }}>{STEPS[step]}</h2>

      {step === 0 && <NameStep onCreated={(id) => { setCreatedRoadmapId(id); setStep(1); }} onSkip={() => setStep(1)} />}
      {step === 1 && <RoadyStep onOpenRoady={onOpenRoady} />}
      {step === 2 && <ToolsStep />}

      <div className="qx-row qx-row--apart" style={{ marginTop: 20 }}>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={finish}>
          Skip onboarding
        </button>
        <div className="qx-row qx-row--tight">
          {step > 0 && (
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="button" className="qx-btn qx-btn--sm" onClick={() => setStep((s) => s + 1)}>
              Continue
            </button>
          ) : (
            <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={finish}>
              {createdRoadmapId || roadmaps.length > 0 ? 'Done' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
