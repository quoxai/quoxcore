/**
 * DevSuiteView — the Quox Dev Suite home: the FUNCTIONAL hub first, honest state second.
 *
 * Owner correction 2026-08-14 (DEV-SUITE-4): the first cut of this route was a
 * promo-style pitch board, which does not belong as an in-app landing. The route
 * now opens the real working surface (DevServersHubPanel: live dev_servers
 * registry, per-capability panels, skill-pack status + sync, plus DocsPanel),
 * with the honest capability/state map kept as a secondary tab. No promo hero.
 *
 * 2026-10-08 (owner): the "State map" tab is GONE. It was Quox's own
 * engineering notes (commit hashes, session ids, "decisions waiting on you")
 * gated only on workspace admin, so every customer org admin could read it,
 * and the hardcoded copy shipped in the bundle to everyone regardless. Stream
 * state lives in QuoxPlan (DEVSUITE) and docs/STATUS_AND_LIMITS_QLOOP.md.
 * A stale ?tab=state link falls back to Dev servers.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import DevServersHubPanel from '../../components/core/devsuite/DevServersHubPanel';
// LICENSE-LAUNCH LL-7 quoxslots strip (2026-08-31): this file used to
// `import SlotsDeckPanel` directly. That single line compiled the whole $39
// QuoxSlots deck into the $39 Dev Servers bundle (this view is itself stripped,
// so rollup follows the import), which is a cross-plugin entitlement leak: a
// dev-servers customer got QuoxSlots for nothing. The deck now ships in the
// signed quoxslots bundle and registers itself as the 'dev.slots' capability
// panel on activation; core keeps only the metadata that renders the locked
// slot. Re-adding the import here silently un-strips a paid plugin, and both
// eslint.config.js and scripts/check-dist-clean.mjs fail on it now.
import {
  resolveCapabilityPanel,
  CAPABILITY_PANEL_CHANGE_EVENT,
} from '../../config/capabilityPanelRegistry';
import DoneEnginePanel from '../../components/devsuite/DoneEnginePanel';
import SessionsPanel from '../../components/devsuite/SessionsPanel';
import './devsuite-view.css';

const DoneEngineTabIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M5 21V4" strokeLinecap="round" />
    <path d="M5 4h13l-2.5 4L18 12H5" strokeLinejoin="round" />
  </svg>
);

const SessionsTabIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M7 9l3 2-3 2M12 13h4" /><path d="M8 20h8" />
  </svg>
);

const SlotsTabIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="14" y="4" width="7" height="16" rx="1.5" />
    <circle cx="6.5" cy="8" r="1" fill="currentColor" />
  </svg>
);

const TABS = [
  {
    id: 'servers', label: 'Dev servers',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" />
        <circle cx="6.5" cy="6.5" r="0.5" fill="currentColor" /><circle cx="6.5" cy="17.5" r="0.5" fill="currentColor" />
      </svg>
    ),
  },
  // Slots was reachable only by scrolling past two panels inside the Dev
  // servers tab, so a product with its own promo page had no entry point of
  // its own (bundle audit theme S2). It gets a tab.
  // DEVSUITE phase 20 (owner 2026-10-08): the sessions register, the same
  // list the Sesha switchboard reads.
  { id: 'sessions', label: 'Sessions', icon: SessionsTabIcon },
  { id: 'slots', label: 'Slots', icon: SlotsTabIcon },
  // DONEENGINE phase 9: the mirror panel ("dashboard panel, last, once the
  // verbs are real"). Chequered flag per the icon registry.
  { id: 'doneengine', label: 'DoneEngine', icon: DoneEngineTabIcon },
];

/**
 * The Slots tab's content, resolved LATE (LICENSE-LAUNCH LL-7 quoxslots strip).
 *
 * Entitled, this is the real SlotsDeckPanel, carried by the signed quoxslots
 * bundle and registered as 'dev.slots' from its onActivate hook. Unentitled, it
 * is the locked upsell slot built from PREMIUM_CAPABILITY_PANELS metadata —
 * honest about the deck existing rather than pretending nothing was built.
 *
 * The event subscription matters: plugin activation is asynchronous (bundle
 * fetch + verify + inject), so a customer who lands directly on ?tab=slots can
 * render this before their own bundle has registered. Without it they would
 * hold a locked slot they had paid for until they reloaded.
 */
function SlotsTab() {
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = (e) => {
      if (!e?.detail?.capability || e.detail.capability === 'dev.slots') bump((n) => n + 1);
    };
    window.addEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CAPABILITY_PANEL_CHANGE_EVENT, onChange);
  }, []);
  const Panel = resolveCapabilityPanel('dev.slots');
  return <Panel />;
}

export default function DevSuiteView() {
  // Tabs are URL-addressable (?tab=slots). Three reasons this matters and none
  // of them are cosmetic: the sidebar can deep-link a bundle member the
  // customer actually paid for instead of dumping them on the hub, a tab
  // becomes shareable and bookmarkable, and a support answer can be a link.
  //
  // The valid set is derived from TABS rather than written out, because a
  // hand-maintained allowlist is exactly how a new section ends up needing two
  // clicks to activate (the settings-hash trap in the design-system skill).
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [tab, setTabState] = useState(
    () => (TABS.some((t) => t.id === requestedTab) ? requestedTab : 'servers')
  );
  const setTab = useCallback((next) => {
    setTabState(next);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'servers') p.delete('tab');
      else p.set('tab', next);
      return p;
    }, { replace: true });
  }, [setSearchParams]);

  // A later ?tab= change (a sidebar click while already on this page) must
  // move the tab, or the nav link silently does nothing on the second use.
  useEffect(() => {
    if (requestedTab && TABS.some((t) => t.id === requestedTab) && requestedTab !== tab) {
      setTabState(requestedTab);
    }
  }, [requestedTab, tab]);

  return (
    <div className="qx-view ds-view">

      {/* Compact header: what this is + where it runs. No promo hero. */}
      <header className="qx-card qx-card--compact ds-head">
        <div className="ds-head__row">
          <h1 className="ds-head__title">Dev Suite</h1>
          {/* Was leaking a fleet hostname and IP plus four raw protocol
              acronyms to every customer (bundle audit theme S3). Same
              information, said in a way a buyer can read. */}
          <div className="ds-hero__meta">
            <span>Register your development machines, run governed AI coding loops on them, and see what each one is doing.</span>
          </div>
        </div>
        {/*
          BUNDLE POLISH B: the hub named QLoop as the flagship and then offered
          no way to start one. Loops are created at /objectives, which a
          customer landing here has no reason to guess, so the marketed surface
          was a description of a capability rather than a door to it.

          A link, not a duplicate form: the creation flow lives in one place and
          gains nothing from a second implementation here that would drift.
        */}
        <div className="ds-head__cta">
          <Link to="/objectives" className="qx-btn qx-btn--sm qx-btn--primary" data-testid="dev-suite-create-loop">
            Start a loop
          </Link>
          <span className="qx-muted" style={{ fontSize: '0.78rem' }}>
            Give a goal to a governed host and watch every turn get witnessed.
          </span>
        </div>
        <div className="qx-tabs" role="tablist" aria-label="Dev suite tabs" style={{ marginTop: 12 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`qx-tab${tab === t.id ? ' qx-tab--active' : ''}`}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              type="button"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {t.icon}{t.label}
              </span>
            </button>
          ))}
        </div>
      </header>

      {tab === 'servers' && (
        <>
          {/* The functional hub: live dev_servers registry, capability panels,
              skill-pack status/sync. Bare mounts: these panels own their chrome. */}
          <DevServersHubPanel />
          {/* DocsPanel removed 2026-10-08: it listed Quox's own repo maps and STATUS docs to every org. Customer replacement is an owner call (DEVSUITE phase 25). */}
        </>
      )}

      {/* DEVSUITE-SLOTS phase 11: Slots gets its own tab rather than sitting
          below two other panels inside Dev servers. */}
      {tab === 'slots' && <SlotsTab />}
      {tab === 'sessions' && <SessionsPanel />}
      {tab === 'doneengine' && <DoneEnginePanel />}


    </div>
  );
}
