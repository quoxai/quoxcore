/**
 * QX Lab — Store Vision v3: SECTIONED BOARDS (LL-8 prototype)
 *
 * Owner steers 2026-08-28:
 *  v2 -> "whole thing a circuit board" (adopted) but fixed geometry is
 *  wrong: "panels will come and go, it needs to be programmatic not set
 *  in stone". And: "QuoxCORE at the top, because that's the first
 *  activation. Then expandable/contractable boards per section. Panels
 *  and sections more like the current plugin dashboard page."
 *
 * So v3: layout = the current PluginSettings shape (hero, then sectioned
 * panels of cards in responsive grids). Materials = the board language
 * (colours, chips, wires, glows). Wires are PROGRAMMATIC via a bus
 * architecture: each board carries a power rail; every chip-card drops a
 * stub trace onto it; deeper rows connect through vias. Zero coordinates,
 * chips flow with the grid, adding a plugin costs nothing.
 *
 * ALL STATE IS MOCK. Press Play to run the journey.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import QHorn from '../../../components/ui/QHorn';

// ─── MOCK CATALOGUE (accents + glyph paths from the real PluginCard map) ──
const P = (id, name, c, tier, d, desc, extra = {}) => ({ id, name, c, tier, d, desc, ...extra });
const QUOX_FREE = [
  P('noc', 'NOC', '#22d3ee', 'free', 'M22 12h-4l-3 9L9 3l-3 9H2', 'Network operations centre. Live fleet map and alerting.'),
  P('system-maint', 'System Maintenance', '#9ca3af', 'free', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', 'Backups, restore, updates, retention.'),
  P('action-tracker', 'Action Tracker', '#fbbf24', 'free', 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11', 'Cross-agent task delegation and follow-through.'),
  P('files', 'Files-Q', '#93c5fd', 'free', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', 'Governed file storage with agent skills.'),
  P('uptime', 'Uptime Kuma', '#34d399', 'free', 'M22 12h-4l-3 9L9 3l-3 9H2', 'Service uptime monitoring, quoxified.'),
  P('youtube', 'YouTube-Q', '#ef4444', 'free', 'M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z M9.75 15.02l5.75-3.27-5.75-3.27z', 'Channel intelligence and content ops.'),
];
const QUOX_PREMIUM = [
  P('soc', 'SOC', '#f43f5e', 'paid', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4', 'Security operations centre. Threat view, incident lanes.', { price: '$199/yr' }),
  P('grafana', 'Grafana', '#f97316', 'free', 'M18 20V10 M12 20V4 M6 20v-6', 'Dashboards under governance. Panels as evidence.', { upd: true }),
  P('proxmox', 'Proxmox', '#60a5fa', 'paid', 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', 'Virtualisation fleet, driven by agents.', { price: '$149/yr' }),
  P('terminal', 'Web Terminal', '#2dd4bf', 'paid', 'M4 17l6-6-6-6 M12 19h8', 'Governed terminal. Every keystroke witnessed.', { price: '$99/yr' }),
  P('browser-q', 'Browser-Q', '#818cf8', 'paid', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z', 'Agentic browsing with HITL approval gates.', { price: '$149/yr' }),
  P('adv-memory', 'Advanced Memory', '#c084fc', 'paid', 'M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5c-2 1-3 3.5-2 5.5s3.5 3 5.5 2c1.5 1.5 4 1.5 5.5 0s1.5-4 0-5.5c2-1 3-3.5 2-5.5s-3.5-3-5.5-2z', 'Deep recall, embeddings, decay. Core amplifier.', { price: '$199/yr', amp: true }),
  P('compliance', 'AOCL Compliance Suite', '#a78bfa', 'paid', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8', 'Audit exports, certification bundles, replay.', { price: '$499/yr' }),
];
const COMMUNITY = [
  P('n8n-bridge', 'n8n Bridge', '#fb7185', 'community', 'M13 2L3 14h9l-1 8 10-12h-9l1-8z', 'Community plugin. Import and convert n8n workflows.', { by: 'community' }),
  P('weather-station', 'Weather Station', '#7dd3fc', 'community', 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z', 'Marketplace plugin. Local sensor dashboard.', { by: 'marketplace' }),
  P('my-tool', 'My Custom Tool', '#a3e635', 'community', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'Your uploaded .quoxplugin. Signed by your org key.', { by: 'you' }),
];
const ALL = [...QUOX_FREE, ...QUOX_PREMIUM, ...COMMUNITY];

// Core systems that SHIP WITH QuoxCORE (study 2026-08-28: the five governed
// concepts + core services; QLoop is plugin-shaped in the registry today but
// owner-designated core furniture — flagged for the LL-5 classification).
const CORE_SYSTEMS = [
  { id: 'agents',   name: 'AGENTS',   c: '#38bdf8', d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75' },
  { id: 'flow',     name: 'FLOW',     c: '#a855f7', d: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9' },
  { id: 'memory',   name: 'MEMORY',   c: '#c084fc', d: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5' },
  { id: 'vault',    name: 'VAULT',    c: '#fbbf24', d: 'M3 11h18v11H3z M7 11V7a5 5 0 0 1 10 0v4' },
  { id: 'hitl',     name: 'HITL',     c: '#34d399', d: 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' },
  { id: 'evidence', name: 'EVIDENCE', c: '#22d3ee', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4' },
  { id: 'crystals', name: 'CRYSTALS', c: '#e879f9', d: 'M6 3h12l4 6-10 13L2 9z M11 3L8 9l4 13 4-13-3-6 M2 9h20' },
  { id: 'qloop',    name: 'QLOOP',    c: '#f97316', d: 'M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3' },
];

const MOCK_SERVERS = [
  { id: 'qi_7c41…9e02', name: 'dev-01', lease: 'renewed 2h ago' },
  { id: 'qi_b8d3…4f77', name: 'acme0001', lease: 'renewed 41m ago' },
];
const LEVELS = [
  { at: 0, name: 'Core Online' }, { at: 4, name: 'Operator' },
  { at: 8, name: 'Command Deck' }, { at: 12, name: 'Flagship' },
];
const levelFor = (n) => LEVELS.reduce((a, l) => (n >= l.at ? l : a), LEVELS[0]);
const levelIdx = (n) => LEVELS.indexOf(levelFor(n));

const I = {
  play: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  reset: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  eject: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  chev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  cart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>,
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  open: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  docs: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  promo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};

// ─── Chip card (programmatic: flows with the grid, stub-traces to the rail) ─
function ChipCard({ p, on, seating, installing, stage, onClick }) {
  return (
    <div
      className={`qx-chipcard ${on ? 'qx-chipcard--on' : 'qx-chipcard--socket'} ${seating ? 'qx-chipcard--seat' : ''}`}
      style={{ '--chip-c': p.c }}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <span className="qx-chipcard__stub" />
      <span className="qx-chip-bloom" />
      <div className="qx-row" style={{ alignItems: 'center', gap: 10 }}>
        <span className="qx-chipcard__die">
          <svg viewBox="0 0 24 24" fill="none" stroke={on ? p.c : 'rgba(255,255,255,0.5)'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={p.d} /></svg>
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="qx-chipcard__name">{p.name}</div>
          <div className="qx-chipcard__silk">
            {p.by ? `by ${p.by}` : on ? 'ONLINE' : p.tier === 'free' ? 'FREE' : p.price}
            {' · v2.1 · '}
            {p.upd && on ? <span style={{ color: '#fbbf24' }}>UPDATE 2.2</span> : 'SIGNED'}
          </div>
        </div>
        {p.amp && <span className="qx-chipcard__amp">AMP</span>}
        <span style={{ marginLeft: 'auto' }} className={`qx-plugin-state ${on ? 'qx-plugin-state--on' : ''}`}>{on ? 'ON' : 'OFF'}</span>
      </div>
      <p className="qx-chipcard__desc">{p.desc}</p>
      {on ? (
        <div className="qx-chipcard__act qx-row" style={{ gap: 4, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Open in dashboard">{I.open} Open</button>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Documentation">{I.docs} Docs</button>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Product page on quox.ai">{I.promo} Promo</button>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Plugin settings">{I.gear}</button>
        </div>
      ) : (
        <div className="qx-chipcard__act qx-row" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {installing ? (
            <span className="qx-pill"><span className="qx-spinner qx-spinner--sm" /> Installing signed bundle…</span>
          ) : p.tier === 'free' || p.tier === 'community' ? (
            <button className="qx-btn qx-btn--sm qx-btn--primary">{I.bolt} {stage === 'fresh' ? 'Connect to unlock' : 'Seat it'}</button>
          ) : (
            <button className="qx-btn qx-btn--sm">{I.cart} {p.price}</button>
          )}
          <span onClick={(e) => e.stopPropagation()} className="qx-row" style={{ gap: 4 }}>
            <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Product page on quox.ai">{I.promo} Learn</button>
            <button className="qx-btn qx-btn--sm qx-btn--ghost" title="Documentation">{I.docs}</button>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── A board section: glass panel, board substrate, rail, chip grid ──────
function Board({ title, silk, plugins, active, seating, installing, stage, onChip, extraCard }) {
  const [open, setOpen] = useState(true);
  const onCount = plugins.filter((p) => active.has(p.id)).length;
  const live = onCount > 0;
  return (
    <section className="qx-card" style={{ padding: 12 }}>
      <div className="qx-board qx-board--flow" style={{ '--qx-board-power': onCount / Math.max(plugins.length, 1) }}>
        <button className="qx-board__head" onClick={() => setOpen((o) => !o)}>
          <span className="qx-board__title">{title}</span>
          <span className="qx-board__silkname">{silk}</span>
          <span className="qx-pill" style={{ marginLeft: 'auto' }}>{onCount} of {plugins.length} online</span>
          <span className={`qx-board__chev ${open ? '' : 'qx-board__chev--closed'}`}>{I.chev}</span>
        </button>
        <div className={`qx-busrail ${live ? 'qx-busrail--live' : ''}`} />
        {open && (
          <div className="qx-chipgrid">
            {plugins.map((p) => (
              <ChipCard key={p.id} p={p} on={active.has(p.id)} seating={seating.has(p.id)} installing={installing === p.id} stage={stage} onClick={() => onChip(p)} />
            ))}
            {extraCard}
          </div>
        )}
      </div>
    </section>
  );
}

export default function QxLabStoreView() {
  const [stage, setStage] = useState('fresh'); // fresh → linking → grown
  const [coreOn, setCoreOn] = useState(false);
  const [active, setActive] = useState(new Set());
  const [seating, setSeating] = useState(new Set());
  const [installing, setInstalling] = useState(null);
  const [toast, setToast] = useState(null);
  const [levelBurst, setLevelBurst] = useState(false);
  const [typed, setTyped] = useState(-1); // -1 manual; 0..3 auto-typing; 4 accepted
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = useCallback((fn, ms) => { timers.current.push(setTimeout(fn, ms)); }, []);

  const total = ALL.length + 1;
  const activeCount = active.size + (coreOn ? 1 : 0);
  const pct = Math.round((activeCount / total) * 100);
  const level = levelFor(activeCount);

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    setStage('fresh'); setCoreOn(false); setActive(new Set()); setSeating(new Set());
    setInstalling(null); setToast(null); setLevelBurst(false); setTyped(-1);
  }, []);

  const seat = useCallback((id, msg) => {
    setActive((prev) => new Set([...prev, id]));
    setSeating((prev) => new Set([...prev, id]));
    later(() => setSeating((prev) => { const n = new Set(prev); n.delete(id); return n; }), 750);
    if (msg) setToast({ kind: 'success', msg });
  }, [later]);

  const runCascade = useCallback(() => {
    setStage('grown');
    setCoreOn(true);
    setToast({ kind: 'success', msg: 'QuoxCORE activated. Entitlements syncing…' });
    QUOX_FREE.forEach((p, i) => {
      later(() => seat(p.id, `${p.name} seated`), 900 + i * 500);
    });
    later(() => {
      setToast({ kind: 'success', msg: `${QUOX_FREE.length} capabilities online. The board is live.` });
      setLevelBurst(true); later(() => setLevelBurst(false), 2400);
    }, 900 + QUOX_FREE.length * 500 + 300);
  }, [later, seat]);

  const buy = useCallback((id) => {
    setInstalling(id);
    setToast({ kind: '', msg: `Purchase confirmed on quox.ai. Shipping ${ALL.find((p) => p.id === id).name}…` });
    later(() => { setInstalling(null); seat(id, `${ALL.find((p) => p.id === id).name} installed. Signed bundle verified.`); }, 2000);
  }, [later, seat]);

  const onChip = useCallback((p) => {
    if (stage === 'fresh') { setStage('linking'); return; }
    if (active.has(p.id)) return;
    if (p.tier === 'paid') { if (installing !== p.id) buy(p.id); }
    else seat(p.id, `${p.name} seated`);
  }, [stage, active, installing, buy, seat]);

  const playJourney = useCallback(() => {
    reset();
    // The connect moment is a real beat: the device code types itself in,
    // holds on "code accepted", and only then does the core seat.
    later(() => { setStage('linking'); setTyped(0); }, 600);
    [1, 2, 3].forEach((n) => later(() => setTyped(n), 600 + 900 * n));
    later(() => setTyped(4), 600 + 900 * 3 + 900);
    const cascadeAt = 600 + 900 * 3 + 900 + 1400;
    later(() => runCascade(), cascadeAt);
    later(() => buy('soc'), cascadeAt + 900 + QUOX_FREE.length * 500 + 1500);
  }, [reset, runCascade, buy, later]);

  return (
    <div className="qx-stack" style={{ position: 'relative' }}>

      {/* Demo controls */}
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="qx-pill">LL-8 VISION PROTOTYPE · MOCK DATA</span>
        <div className="qx-row" style={{ gap: 8 }}>
          <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={playJourney}>{I.play} Play the journey</button>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={reset}>{I.reset} Reset</button>
        </div>
      </div>

      {/* ═══ QUOXCORE — the first activation, top of the stack ═══ */}
      <section className={`qx-card ${levelBurst ? 'qx-levelup' : ''}`} style={{ padding: 12 }}>
        <div className="qx-board qx-board--flow" style={{ '--qx-board-power': activeCount / total }}>
          <div className="qx-row" style={{ alignItems: 'center', gap: 24, padding: 18, flexWrap: 'wrap' }}>
            <div className={`qx-bcore qx-bcore--static ${coreOn ? '' : 'qx-bcore--socket'}`}>
              <span className="qx-chip-bloom" style={{ '--chip-c': '#38bdf8' }} />
              <QHorn size={38} animated={coreOn} />
              <span className="qx-bcore__silk">QUOX CORE</span>
              <span className="qx-bcore__sub">{coreOn ? `${activeCount} of ${total} · ${pct}%` : 'UNSEATED'}</span>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="qx-row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 19 }}>QuoxCORE Platform</h2>
                <span className={`qx-pill ${levelBurst ? 'qx-enabled-glow' : ''}`}>{I.bolt} Level {levelIdx(activeCount) + 1} · {level.name}</span>
                {stage === 'grown' && <span className="qx-pill">{I.shield} Quox Verified</span>}
              </div>
              <p style={{ margin: '6px 0 10px', fontSize: 12.5, color: 'rgba(255,255,255,0.75)', maxWidth: 640 }}>
                {coreOn
                  ? `${activeCount} of ${total} capabilities online. Every chip you seat grows the system: new agents, new rooms, new evidence.`
                  : 'Seat the core to power the board. One account connection activates it and unlocks every capability you own.'}
              </p>
              <div className="qx-progress" style={{ maxWidth: 420, '--qx-progress': pct / 100 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              {!coreOn && (
                <button className="qx-btn qx-btn--primary" onClick={() => setStage('linking')}>{I.link} Activate QuoxCORE</button>
              )}
              <div className="qx-minichip-row">
                <span className="qx-minichip-row__silk">SHIPS WITH CORE · BUS-0</span>
                {CORE_SYSTEMS.map((s, i) => (
                  <div
                    key={s.id}
                    className={`qx-minichip ${coreOn ? 'qx-minichip--on' : ''}`}
                    style={{ '--chip-c': s.c, animationDelay: coreOn ? `${i * 110}ms` : undefined }}
                    title={`${s.name} ships with QuoxCORE`}
                  >
                    <span className="qx-chip-bloom" />
                    <span className="qx-minichip__die">
                      <svg viewBox="0 0 24 24" fill="none" stroke={coreOn ? s.c : 'rgba(255,255,255,0.45)'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={s.d} /></svg>
                    </span>
                    <span className="qx-minichip__silk">{s.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══ ACCOUNT LINK MOMENT ═══ */}
      {stage === 'linking' && (
        <section className="qx-card" style={{ textAlign: 'center', padding: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><QHorn size={40} animated /></div>
          <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>Connect your Quox account to seat the core</h3>
          <p style={{ margin: '0 auto 16px', maxWidth: 460, color: 'rgba(255,255,255,0.75)' }}>
            One connection unlocks everything you own, on every server you run. Visit <strong>quox.ai/link</strong> and enter:
          </p>
          <div className="qx-row" style={{ justifyContent: 'center', gap: 8, marginBottom: 18 }}>
            {['QX', '7F3K', '9DTP'].map((s, i) => (
              <span
                key={i}
                className="qx-kbd"
                style={{
                  fontSize: 20, padding: '9px 15px', letterSpacing: '0.15em',
                  opacity: typed === -1 || typed > i ? 1 : 0.25,
                  transition: 'opacity 300ms ease, box-shadow 300ms ease',
                  boxShadow: typed > i && typed !== -1 ? '0 0 12px rgba(56,189,248,0.4)' : undefined,
                }}
              >{s}</span>
            ))}
          </div>
          {typed >= 4 ? (
            <span className="qx-pill qx-enabled-glow" style={{ fontSize: 13 }}>Code accepted · account linked · seating the core…</span>
          ) : typed >= 0 ? (
            <span className="qx-pill" style={{ fontSize: 12 }}><span className="qx-spinner qx-spinner--sm" /> Entering code on quox.ai/link…</span>
          ) : (
            <div className="qx-row" style={{ justifyContent: 'center', gap: 10 }}>
              <button className="qx-btn qx-btn--primary" onClick={runCascade}>{I.link} I have connected</button>
              <button className="qx-btn qx-btn--ghost" onClick={() => setStage('fresh')}>Not now</button>
            </div>
          )}
        </section>
      )}

      {/* ═══ BOARD: QUOX PLUGINS (free) ═══ */}
      <Board
        title="Quox Plugins" silk="BUS-A · FREE WITH ACCOUNT"
        plugins={QUOX_FREE}
        active={active} seating={seating} installing={installing} stage={stage} onChip={onChip}
      />

      {/* ═══ BOARD: QUOX PREMIUM ═══ */}
      <Board
        title="Quox Premium" silk="BUS-B · SIGNED BUNDLES SHIP ON ACTIVATION"
        plugins={QUOX_PREMIUM}
        active={active} seating={seating} installing={installing} stage={stage} onChip={onChip}
      />

      {/* ═══ BOARD: COMMUNITY / MARKETPLACE / YOURS ═══ */}
      <Board
        title="Community, Marketplace and Yours" silk="BUS-C · THIRD-PARTY SOCKETS"
        plugins={COMMUNITY}
        active={active} seating={seating} installing={installing} stage={stage} onChip={onChip}
        extraCard={(
          <div className="qx-chipcard qx-chipcard--socket" style={{ '--chip-c': '#38bdf8', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }} role="button" tabIndex={0}>
            <span className="qx-chipcard__stub" />
            <span style={{ width: 20, height: 20, display: 'inline-flex', opacity: 0.8, margin: '8px auto 0' }}>{I.upload}</span>
            <div className="qx-chipcard__name" style={{ textAlign: 'center' }}>Empty socket</div>
            <p className="qx-chipcard__desc" style={{ textAlign: 'center' }}>Upload a .quoxplugin or browse the marketplace.</p>
          </div>
        )}
      />

      {/* ═══ SERVERS & SEATS ═══ */}
      <section className="qx-card">
        <div className="qx-row" style={{ alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Your servers</h3>
          <span className="qx-pill" style={{ marginLeft: 'auto' }}>Team band · 2 of 3 servers</span>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>
          Everything you own works on every server below. Move a licence by releasing a seat, no rebuying, no key juggling.
        </p>
        <div className="qx-grid-3">
          {MOCK_SERVERS.map((s) => (
            <div key={s.id} className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="qx-row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="qx-dot qx-dot--online" />
                <strong style={{ fontSize: 13 }}>{s.name}</strong>
              </div>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{s.id}</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Lease {s.lease}</span>
              <button className="qx-btn qx-btn--sm qx-btn--ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }}>{I.eject} Release seat</button>
            </div>
          ))}
          <div className="qx-card qx-card--compact" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, borderStyle: 'dashed', minHeight: 120 }}>
            <span style={{ width: 20, height: 20, display: 'inline-flex', opacity: 0.8 }}>{I.plus}</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>1 slot free · add a server</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Need more? Upgrade to Fleet (10)</span>
          </div>
        </div>
      </section>

      {toast && (
        <div className={`qx-toast ${toast.kind ? `qx-toast--${toast.kind}` : ''}`} style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1200 }}>
          <div className="qx-toast__body"><div className="qx-toast__msg">{toast.msg}</div></div>
        </div>
      )}
    </div>
  );
}
