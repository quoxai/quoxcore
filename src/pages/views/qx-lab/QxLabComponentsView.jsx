/**
 * QX Lab — Components Gallery
 *
 * Internal tabs keep every category above the fold. Each tab is a single
 * viewport of related atoms so you can scan without scrolling.
 */

import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import QHorn from '../../../components/ui/QHorn';

// ─── Lab nav (outer) ─────────────────────────────────────────────────────
function QxLabNav() {
  const { pathname } = useLocation();
  const tabs = [
    { to: '/qx-lab/components',  label: 'Components'  },
    { to: '/qx-lab/application', label: 'Application' },
    { to: '/qx-lab/edge-cases',  label: 'Edge Cases'  },
    { to: '/qx-lab/store',       label: 'Store Vision' },
  ];
  return (
    <div className="qx-card qx-card--compact" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <QHorn size={20} animated />
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff' }}>
        QX Lab
      </div>
      <div style={{ width: 1, height: 18, background: 'var(--m-border-default)' }} />
      <nav className="qx-crumbs" aria-label="Lab nav">
        {tabs.map((t, i) => (
          <span key={t.to} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Link to={t.to} className={`qx-crumbs__item ${pathname === t.to ? 'qx-crumbs__item--current' : ''}`}>{t.label}</Link>
            {i < tabs.length - 1 && <span className="qx-crumbs__sep">›</span>}
          </span>
        ))}
      </nav>
      <div style={{ marginLeft: 'auto', fontSize: 11, color: '#fff', opacity: 0.8, fontFamily: 'var(--font-mono)' }}>
        GLASS-CYAN · blueprint
      </div>
    </div>
  );
}

export function QxLabLayout() {
  return (
    <div className="qx-view">
      <QxLabNav />
      <div style={{ marginTop: 12 }} />
      <Outlet />
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────
const I = {
  bolt:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  server:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>,
  shield:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  inbox:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>,
  plus:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  check:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  alert:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>,
  info:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="8"/></svg>,
};

// ─── Mini helpers for the gallery ────────────────────────────────────────
function Cell({ title, span = 1, children }) {
  return (
    <div className="qx-card qx-card--compact" style={{ gridColumn: `span ${span}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff', opacity: 0.85 }}>
          <QHorn size={9} />
          {title}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>{children}</div>
    </div>
  );
}
function Sparkline({ data, variant = '', withDot = true }) {
  const w = 100, h = 28, pad = 2;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => [pad + i * step, h - pad - ((v - min) / range) * (h - pad * 2)]);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${d} L${w - pad},${h} L${pad},${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <span className={`qx-spark ${variant}`}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="qx-spark-grad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#38bdf8" /><stop offset="100%" stopColor="#a855f7" /></linearGradient>
          <linearGradient id="qx-spark-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgba(56,189,248,0.35)" /><stop offset="100%" stopColor="rgba(168,85,247,0)" /></linearGradient>
        </defs>
        <path d={area} className="qx-spark__area" />
        <path d={d} className="qx-spark__line" />
        {withDot && <circle cx={last[0]} cy={last[1]} r={2.4} className="qx-spark__dot" />}
      </svg>
    </span>
  );
}

// Calm-layout utilities demo: popover menu, static dots, dense/muted table rows.
function CalmLayoutDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="qx-popover">
        <button type="button" className="qx-btn qx-btn--sm" onClick={() => setOpen(v => !v)}>Add flag ▾</button>
        {open && (
          <div className="qx-menu qx-popover__panel" role="menu">
            <button type="button" role="menuitem" className="qx-menu__item" onClick={() => setOpen(false)}>
              <span className="qx-menu__item-text">Do not call<small>Blocks voice calls to this person.</small></span>
            </button>
            <button type="button" role="menuitem" className="qx-menu__item" onClick={() => setOpen(false)}>
              <span className="qx-menu__item-text">VIP<small>A label for your own triage.</small></span>
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="qx-dot qx-dot--online qx-dot--static" /> granted
        <span className="qx-dot qx-dot--offline qx-dot--static" /> withdrawn
        <span className="qx-dot qx-dot--idle qx-dot--static" /> unknown
      </div>
      <table className="qx-table qx-table--dense">
        <tbody>
          <tr><td>Ada Lovelace</td><td>Customer</td></tr>
          <tr className="qx-table__row--muted"><td>Unknown caller</td><td>Candidate</td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Gallery with internal tabs ──────────────────────────────────────────
export default function QxLabComponentsView() {
  const [tab, setTab] = useState('atoms');
  const [toggle1, setToggle1] = useState(true);
  const [check1, setCheck1]   = useState(true);
  const [toast, setToast]     = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [seg, setSeg] = useState('day');

  const fire = (v, msg) => {
    setToast({ variant: v, title: msg.t, msg: msg.m });
    setTimeout(() => setToast(null), 3200);
  };

  const [pluginOn, setPluginOn] = useState(false);
  const [enableBurst, setEnableBurst] = useState(false);
  const triggerBurst = () => { setEnableBurst(false); requestAnimationFrame(() => setEnableBurst(true)); setTimeout(() => { setPluginOn(true); }, 100); setTimeout(() => setEnableBurst(false), 1200); };

  // RepoBrain Wave 2 demo state — scope picker (multi-select menu) + snippet gutter/focus.
  const scopeDemoTargets = ['quox-dashboard', 'quoxflow', 'quoxbastion'];
  const [scopeDemoSelected, setScopeDemoSelected] = useState(() => new Set(['quox-dashboard']));
  const toggleScopeDemo = (id) => {
    setScopeDemoSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { if (next.size > 1) next.delete(id); } else { next.add(id); }
      return next;
    });
  };
  const [snippetFocusDemo, setSnippetFocusDemo] = useState(true);

  const tabs = [
    { k: 'atoms',    l: 'Atoms'            },
    { k: 'stats',    l: 'Stats & Graphs'   },
    { k: 'forms',    l: 'Forms & Controls' },
    { k: 'nav',      l: 'Nav & Menus'      },
    { k: 'feedback', l: 'Feedback'         },
    { k: 'states',   l: 'States'           },
    { k: 'ops',      l: 'Ops & Data'       },
    { k: 'canvas',   l: 'Canvas & Nodes'   },
    { k: 'showcase', l: 'Showcase'         },
  ];

  return (
    <div className="qx-stack" style={{ gap: 12 }}>
      {/* Tabs row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="qx-tabs">
          {tabs.map(t => (
            <button key={t.k} className={`qx-tab ${tab === t.k ? 'qx-tab--active' : ''}`} onClick={() => setTab(t.k)}>{t.l}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <div className="qx-seg">
            <button className={`qx-seg__btn ${seg === 'day' ? 'qx-seg__btn--active' : ''}`} onClick={() => setSeg('day')}>Day</button>
            <button className={`qx-seg__btn ${seg === 'week' ? 'qx-seg__btn--active' : ''}`} onClick={() => setSeg('week')}>Week</button>
            <button className={`qx-seg__btn ${seg === 'month' ? 'qx-seg__btn--active' : ''}`} onClick={() => setSeg('month')}>Month</button>
          </div>
        </div>
      </div>

      {/* ATOMS */}
      {tab === 'atoms' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Dots">
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="qx-dot qx-dot--online" />
              <span className="qx-dot qx-dot--degraded" />
              <span className="qx-dot qx-dot--offline" />
              <span className="qx-dot qx-dot--loading" />
              <span className="qx-dot qx-dot--idle" />
              <span className="qx-dot qx-dot--info" />
            </div>
          </Cell>
          <Cell title="Pills" span={2}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="qx-pill qx-pill--online qx-pill--sm"><span className="qx-dot qx-dot--online qx-dot--sm" /> online</span>
              <span className="qx-pill qx-pill--degraded qx-pill--sm">degraded</span>
              <span className="qx-pill qx-pill--offline qx-pill--sm">offline</span>
              <span className="qx-pill qx-pill--info qx-pill--sm">active</span>
              <span className="qx-pill qx-pill--purple qx-pill--sm">aocl</span>
              <span className="qx-pill qx-pill--ghost qx-pill--sm">beta</span>
            </div>
          </Cell>
          <Cell title="Severity">
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <span className="qx-severity qx-severity--critical">critical</span>
              <span className="qx-severity qx-severity--high">high</span>
              <span className="qx-severity qx-severity--medium">medium</span>
              <span className="qx-severity qx-severity--low">low</span>
              <span className="qx-severity qx-severity--info">info</span>
            </div>
          </Cell>
          <Cell title="Chips & Badges">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="qx-chip" style={{ padding: '4px 10px', fontSize: 11 }}>All</span>
              <span className="qx-chip qx-chip--active" style={{ padding: '4px 10px', fontSize: 11 }}>Active</span>
              <span className="qx-chip qx-chip--brand" style={{ padding: '4px 10px', fontSize: 11 }}>Brand</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <span className="qx-badge">3</span>
              <span className="qx-badge qx-badge--ok">12</span>
              <span className="qx-badge qx-badge--alert">!</span>
            </div>
          </Cell>
          <Cell title="Chip hues (glassy, one hue per meaning)" span={2}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate'].map((h) => (
                <span key={h} className={`qx-chip qx-chip--xs qx-chip--static qx-chip--hue-${h}`}>{h}</span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="qx-chip qx-chip--toggle qx-chip--hue-red qx-tip qx-tip--wrap" aria-pressed="true" tabIndex={0} data-tip="Lit toggle: this flag is on.">Do not call</span>
              <span className="qx-chip qx-chip--toggle qx-chip--hue-red qx-tip qx-tip--wrap" aria-pressed="false" tabIndex={0} data-tip="Unlit toggle: this flag is off.">Do not text</span>
              <span className="qx-chip qx-chip--toggle qx-chip--hue-amber qx-tip qx-tip--wrap" aria-pressed="true" tabIndex={0} data-tip="Needs a person's approval.">Minor</span>
              <span className="qx-chip qx-chip--toggle qx-chip--hue-purple qx-tip qx-tip--wrap" aria-pressed="false" tabIndex={0} data-tip="A label only.">VIP</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {[12, 90, 160, 220, 290, 330].map((hue) => (
                <span key={hue} className="qx-avatar qx-avatar--tint qx-avatar--circle" style={{ '--qx-avatar-hue': hue }}>AB</span>
              ))}
            </div>
          </Cell>
          <Cell title="Kbd & Code" span={2}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: '#fff' }}>
              <span className="qx-kbd">⌘</span><span className="qx-kbd">K</span>
              <span className="qx-kbd">Esc</span>
              <span className="qx-kbd">/</span>
              <code className="qx-code" style={{ fontSize: 11, marginLeft: 10 }}>quox-build dashboard</code>
            </div>
          </Cell>
          <Cell title="Avatars">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="qx-avatar qx-avatar--xs">A</div>
              <div className="qx-avatar qx-avatar--sm">QX</div>
              <div className="qx-avatar">CQ</div>
              <div className="qx-avatar qx-avatar--ring" style={{ '--qx-avatar-ring': '#30ff90' }}>ON</div>
            </div>
          </Cell>
          <Cell title="Q-Horn">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <QHorn size={14} />
              <QHorn size={22} />
              <QHorn size={36} animated />
            </div>
          </Cell>
        </div>
      )}

      {/* STATS & GRAPHS */}
      {tab === 'stats' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Fleet">
            <div className="qx-stat">
              <div className="qx-stat__head">{I.server} hosts</div>
              <div className="qx-stat__value" style={{ fontSize: 22 }}>57</div>
              <Sparkline data={[20, 22, 20, 25, 28, 30, 33, 35, 40, 42, 48, 50, 57]} />
            </div>
          </Cell>
          <Cell title="Workflows">
            <div className="qx-stat">
              <div className="qx-stat__head">{I.bolt} saved</div>
              <div className="qx-stat__value" style={{ fontSize: 22 }}>1,340</div>
              <span className="qx-trend qx-trend--up">↑ 2.4% today</span>
            </div>
          </Cell>
          <Cell title="Integrity">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="qx-percent qx-percent--success" style={{ '--qx-pct': 100 }}>
                <span className="qx-percent__value">100<i>%</i></span>
              </div>
              <div className="qx-percent" style={{ '--qx-pct': 72 }}>
                <span className="qx-percent__value">72<i>%</i></span>
              </div>
            </div>
          </Cell>
          <Cell title="Events 24h">
            <div className="qx-stat">
              <div className="qx-stat__head">{I.inbox} live</div>
              <div className="qx-percent-value">32<i>K</i></div>
              <span className="qx-trend qx-trend--down">↓ 2.1%</span>
            </div>
          </Cell>

          <Cell title="Progress: thresholds" span={2}>
            <span className="qx-progress qx-progress--success" style={{ '--qx-progress': 0.32 }} />
            <span className="qx-progress qx-progress--warn" style={{ '--qx-progress': 0.68 }} />
            <span className="qx-progress qx-progress--crit" style={{ '--qx-progress': 0.92 }} />
            <span className="qx-progress qx-progress--brand qx-progress--tall" style={{ '--qx-progress': 0.74 }} />
          </Cell>
          <Cell title="Sparklines" span={2}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Sparkline data={[3, 5, 4, 6, 8, 7, 9, 10, 12]} />
              <Sparkline data={[10, 9, 8, 7, 6, 5, 6, 5, 4]} variant="qx-spark--warn" />
              <Sparkline data={[5, 6, 4, 8, 7, 9, 6, 10, 5]} variant="qx-spark--success" />
              <Sparkline data={[8, 5, 9, 4, 6, 2, 7, 1, 3]} variant="qx-spark--crit" />
            </div>
          </Cell>

          <Cell title="Bars: hourly load" span={2}>
            <div className="qx-bars">
              {[0.3, 0.5, 0.6, 0.45, 0.8, 0.9, 0.65, 0.5, 0.6, 0.75, 0.85, 0.55].map((h, i) => (
                <div key={i} className={`qx-bars__bar ${h > 0.85 ? 'qx-bars__bar--warn' : ''}`} style={{ '--qx-h': h }} />
              ))}
            </div>
          </Cell>
          <Cell title="Distribution" span={2}>
            <div className="qx-hbar"><span className="qx-hbar__label">hyp-01</span><span className="qx-hbar__track" style={{ '--qx-h': 0.32 }} /><span className="qx-hbar__value">32%</span></div>
            <div className="qx-hbar"><span className="qx-hbar__label">hyp-02</span><span className="qx-hbar__track" style={{ '--qx-h': 0.74 }} /><span className="qx-hbar__value">74%</span></div>
            <div className="qx-hbar"><span className="qx-hbar__label">hyp-03</span><span className="qx-hbar__track" style={{ '--qx-h': 0.92 }} /><span className="qx-hbar__value">92%</span></div>
          </Cell>

          <Cell title="Big ring" span={2}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div className="qx-percent qx-percent--lg qx-percent--brand" style={{ '--qx-pct': 82 }}>
                <span className="qx-percent__value">82<i>%</i></span>
                <span className="qx-percent__label">uptime</span>
              </div>
              <div className="qx-percent qx-percent--xl qx-percent--brand" style={{ '--qx-pct': 63 }}>
                <span className="qx-percent__value">63<i>%</i></span>
                <span className="qx-percent__label">quota</span>
              </div>
            </div>
          </Cell>
        </div>
      )}

      {/* FORMS */}
      {tab === 'forms' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Inputs" span={2}>
            <input className="qx-input" placeholder="Search hosts…" style={{ padding: '8px 12px', fontSize: 12 }} />
            <select className="qx-select" defaultValue="prod" style={{ padding: '8px 12px', fontSize: 12 }}>
              <option value="prod">Production</option>
              <option value="staging">Staging</option>
            </select>
            <textarea className="qx-textarea" placeholder="Notes…" rows={2} style={{ padding: '8px 12px', fontSize: 12, minHeight: 56 }} />
          </Cell>
          <Cell title="Field w/ error + hint" span={2}>
            <div className="qx-field">
              <label className="qx-field__label qx-field__label--required">Host name</label>
              <input className="qx-input" placeholder="hyp-01.internal" style={{ padding: '8px 12px', fontSize: 12 }} />
              <span className="qx-field__hint">FQDN or IP. Must be reachable via bastion.</span>
            </div>
            <div className="qx-field">
              <label className="qx-field__label">Invalid</label>
              <input className="qx-input" defaultValue="bad@value" style={{ borderColor: 'rgba(239,68,68,0.55)', padding: '8px 12px', fontSize: 12 }} />
              <span className="qx-field__error">Must be a valid FQDN.</span>
            </div>
          </Cell>

          <Cell title="Toggle & Check">
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="qx-toggle">
                <input type="checkbox" checked={toggle1} onChange={e => setToggle1(e.target.checked)} />
                <span className="qx-toggle__track" />
              </label>
              <label className="qx-checkbox" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={check1} onChange={e => setCheck1(e.target.checked)} />
                <span className="qx-checkbox__box" />
                Alerts
              </label>
            </div>
          </Cell>
          <Cell title="Tag input">
            <div className="qx-tagfield">
              <span className="qx-tagfield__tag">prod <button className="qx-tagfield__x">×</button></span>
              <span className="qx-tagfield__tag">critical <button className="qx-tagfield__x">×</button></span>
              <input className="qx-tagfield__input" placeholder="Add tag…" />
            </div>
          </Cell>
          <Cell title="Buttons" span={2}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="qx-btn qx-btn--primary qx-btn--sm">{I.plus} Add</button>
              <button className="qx-btn qx-btn--sm">Cancel</button>
              <button className="qx-btn qx-btn--danger qx-btn--sm">Delete</button>
              <button className="qx-btn qx-btn--sm qx-btn--ghost">Ghost</button>
              <button className="qx-btn qx-btn--sm" disabled>Disabled</button>
            </div>
          </Cell>
        </div>
      )}

      {/* NAV & MENUS */}
      {tab === 'nav' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Breadcrumbs" span={2}>
            <nav className="qx-crumbs">
              <Link to="/" className="qx-crumbs__item">Home</Link>
              <span className="qx-crumbs__sep">›</span>
              <Link to="/qx-lab" className="qx-crumbs__item">QX Lab</Link>
              <span className="qx-crumbs__sep">›</span>
              <span className="qx-crumbs__item qx-crumbs__item--current">Components</span>
            </nav>
          </Cell>
          <Cell title="Segmented" span={2}>
            <div className="qx-seg">
              <button className="qx-seg__btn qx-seg__btn--active">Grid</button>
              <button className="qx-seg__btn">List</button>
              <button className="qx-seg__btn">Map</button>
            </div>
          </Cell>

          <Cell title="Tabs: pill" span={2}>
            <div className="qx-tabs">
              <button className="qx-tab qx-tab--active">Overview</button>
              <button className="qx-tab">Activity <span className="qx-badge" style={{ marginLeft: 4 }}>3</span></button>
              <button className="qx-tab">Settings</button>
              <button className="qx-tab" disabled>Audit</button>
            </div>
          </Cell>
          <Cell title="Tabs: underline" span={2}>
            <div className="qx-tabs qx-tabs--underline">
              <button className="qx-tab qx-tab--active">Latest</button>
              <button className="qx-tab">Starred</button>
              <button className="qx-tab">Archived</button>
            </div>
          </Cell>

          <Cell title="Vertical tabs">
            <div className="qx-tabs qx-tabs--vert">
              <button className="qx-tab qx-tab--active">General</button>
              <button className="qx-tab">Integrations</button>
              <button className="qx-tab">Security</button>
              <button className="qx-tab">Billing</button>
            </div>
          </Cell>

          <Cell title="Pagination" span={2}>
            <div className="qx-pag">
              <button className="qx-pag__btn" disabled>‹</button>
              <button className="qx-pag__btn">1</button>
              <button className="qx-pag__btn qx-pag__btn--active">2</button>
              <button className="qx-pag__btn">3</button>
              <span className="qx-pag__ellipsis">…</span>
              <button className="qx-pag__btn">17</button>
              <button className="qx-pag__btn">›</button>
            </div>
          </Cell>

          <Cell title="Dropdown menu">
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="qx-btn qx-btn--sm" onClick={() => setMenuOpen(v => !v)}>
                Open menu ▾
              </button>
              {menuOpen && (
                <div className="qx-menu" style={{ position: 'absolute', top: 38, left: 0 }}>
                  <div className="qx-menu__header">Quick actions</div>
                  <button className="qx-menu__item qx-menu__item--active">Run playbook <span className="qx-menu__kbd">⌘R</span></button>
                  <button className="qx-menu__item">Inspect host <span className="qx-menu__meta">14ms</span></button>
                  <button className="qx-menu__item">Open terminal</button>
                  <div className="qx-menu__sep" />
                  <button className="qx-menu__item qx-menu__item--danger">Remove host</button>
                </div>
              )}
            </div>
          </Cell>

          <Cell title="Menu: check rows (scope picker)" span={2}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, color: '#fff', opacity: 0.8 }}>
                RepoBrain cross-repo scope picker. Trigger chip shows the selection count; the
                popover is a `.qx-menu` of `.qx-menu__item--check` rows.
              </div>
              <span className={`qx-chip ${scopeDemoSelected.size > 1 ? 'qx-chip--active' : ''}`} style={{ alignSelf: 'flex-start' }}>
                {scopeDemoSelected.size === 1 ? [...scopeDemoSelected][0]
                  : scopeDemoSelected.size === scopeDemoTargets.length ? 'All repos'
                  : `${scopeDemoSelected.size} repos`}
              </span>
              <div className="qx-menu" style={{ position: 'relative' }}>
                <div className="qx-menu__header">Search scope</div>
                <button className="qx-menu__item" onClick={() => setScopeDemoSelected(new Set(scopeDemoTargets))}>All repos</button>
                <button className="qx-menu__item" onClick={() => setScopeDemoSelected(new Set(['quox-dashboard']))}>Only this workspace</button>
                <div className="qx-menu__sep" />
                {scopeDemoTargets.map(id => (
                  <label key={id} className="qx-menu__item qx-menu__item--check">
                    <input type="checkbox" checked={scopeDemoSelected.has(id)} onChange={() => toggleScopeDemo(id)} />
                    <span className="qx-checkbox__box" />
                    <span>{id}</span>
                    <span className="qx-menu__meta">{id === 'quox-dashboard' ? '1,204' : id === 'quoxflow' ? '318' : '96'} files</span>
                  </label>
                ))}
              </div>
            </div>
          </Cell>
          <Cell title="Calm layout: popover, static dots, dense table" span={2}>
            <CalmLayoutDemo />
          </Cell>
        </div>
      )}

      {/* FEEDBACK */}
      {tab === 'feedback' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Banners: inline alerts" span={4}>
            <div className="qx-banner">
              <span className="qx-banner__icon">{I.info}</span>
              <div><span className="qx-banner__title">Note:</span> Fleet sync runs every 30 seconds in the background.</div>
              <div className="qx-banner__actions"><button className="qx-btn qx-btn--sm qx-btn--ghost">Dismiss</button></div>
            </div>
            <div className="qx-banner qx-banner--success">
              <span className="qx-banner__icon">{I.check}</span>
              <div><span className="qx-banner__title">Deployed.</span> Playbook ran on 4 hosts in 12.4s.</div>
            </div>
            <div className="qx-banner qx-banner--warn">
              <span className="qx-banner__icon">{I.alert}</span>
              <div><span className="qx-banner__title">Attention:</span> hyp-02 CPU sustained &gt; 70% for 4 minutes.</div>
            </div>
            <div className="qx-banner qx-banner--error">
              <span className="qx-banner__icon">{I.alert}</span>
              <div><span className="qx-banner__title">Offline.</span> hyp-03 unreachable via bastion.</div>
              <div className="qx-banner__actions"><button className="qx-btn qx-btn--sm qx-btn--danger">Investigate</button></div>
            </div>
          </Cell>

          <Cell title="Toasts: triggers" span={2}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => fire('success', { t: 'Saved', m: 'Playbook executed on 4 hosts.' })}>Success</button>
              <button className="qx-btn qx-btn--sm" onClick={() => fire('info', { t: 'FYI', m: 'Memory sync in progress.' })}>Info</button>
              <button className="qx-btn qx-btn--sm" onClick={() => fire('warn', { t: 'Careful', m: 'Host degraded, watching.' })}>Warn</button>
              <button className="qx-btn qx-btn--sm qx-btn--danger" onClick={() => fire('error', { t: 'Failed', m: 'Cannot connect to hyp-03.' })}>Error</button>
            </div>
          </Cell>
          <Cell title="Tooltip + clunky press" span={2}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="qx-btn qx-btn--sm qx-tip" data-tip="Runs the selected playbook">Hover me</button>
              <button className="qx-btn qx-btn--sm qx-btn--primary qx-tip" data-tip="Primary action: ⌘↵">Primary</button>
              <span className="qx-tip" data-tip="Tooltip on a plain element" style={{ fontSize: 12, cursor: 'help', color: '#fff', opacity: 0.85 }}>hover text</span>
            </div>
          </Cell>

          {toast && (
            <div className="qx-toast-stack">
              <div className={`qx-toast qx-toast--${toast.variant}`}>
                <svg className="qx-toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {toast.variant === 'success' ? <polyline points="20 6 9 17 4 12" /> :
                   toast.variant === 'error'   ? <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></> :
                   toast.variant === 'warn'    ? <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></> :
                                                  <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="8"/></>}
                </svg>
                <div className="qx-toast__body">
                  <div className="qx-toast__title">{toast.title}</div>
                  <div className="qx-toast__msg">{toast.msg}</div>
                </div>
                <button className="qx-toast__close" onClick={() => setToast(null)}>×</button>
                <div className="qx-toast__progress" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* STATES */}
      {tab === 'states' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Empty" span={2}>
            <div className="qx-empty" style={{ padding: '16px 8px' }}>
              <div className="qx-empty__icon" style={{ width: 40, height: 40 }}>{I.inbox}</div>
              <div className="qx-empty__title" style={{ fontSize: 13 }}>No items yet</div>
              <div className="qx-empty__body" style={{ fontSize: 12 }}>Nothing routed to your inbox in the last 24 hours.</div>
            </div>
          </Cell>
          <Cell title="Loading">
            <div className="qx-skeleton qx-skeleton--line-md" style={{ width: '80%' }} />
            <div className="qx-skeleton qx-skeleton--line-sm" style={{ width: '60%' }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span className="qx-spinner qx-spinner--sm" />
              <span className="qx-spinner" />
            </div>
          </Cell>
          <Cell title="Host row">
            <div className="qx-host-row" style={{ padding: '6px 8px' }}>
              <span className="qx-dot qx-dot--online qx-host-row__dot" />
              <div className="qx-host-row__body">
                <div className="qx-host-row__primary" style={{ fontSize: 12 }}>hyp-01</div>
                <div className="qx-host-row__secondary" style={{ fontSize: 10 }}>203.0.113.250</div>
              </div>
              <span className="qx-host-row__meta" style={{ fontSize: 10 }}>up 42d</span>
            </div>
          </Cell>
          <Cell title="Action card" span={2}>
            <button className="qx-action-card" style={{ padding: 10 }}>
              <span className="qx-action-card__icon" style={{ width: 28, height: 28 }}>{I.bolt}</span>
              <span className="qx-action-card__body">
                <div className="qx-action-card__title" style={{ fontSize: 12 }}>Run workflow</div>
                <div className="qx-action-card__desc" style={{ fontSize: 11 }}>Saved playbook on targets</div>
              </span>
            </button>
          </Cell>
          <Cell title="Disclosure" span={2}>
            <details className="qx-disclosure">
              <summary className="qx-disclosure__head">
                Advanced options
                <span className="qx-disclosure__chev">›</span>
              </summary>
              <div className="qx-disclosure__body">
                Controlled via <code className="qx-code">feature.flags</code>. Only shown to admins.
              </div>
            </details>
          </Cell>
        </div>
      )}

      {/* OPS & DATA — logs, heatmaps, diffs, trails, results, trees */}
      {tab === 'ops' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Cell title="Log stream" span={2}>
            <div className="qx-log-stream" style={{ maxHeight: 160 }}>
              <div className="qx-log-line"><span className="qx-log-line__ts">00:14:22</span><span className="qx-log-line__level qx-log-line__level--error">error</span><span className="qx-log-line__src">hyp-03</span><span className="qx-log-line__msg">Node unreachable, SSH timeout</span></div>
              <div className="qx-log-line"><span className="qx-log-line__ts">00:11:03</span><span className="qx-log-line__level qx-log-line__level--warn">warn</span><span className="qx-log-line__src">hyp-02</span><span className="qx-log-line__msg">CPU sustained &gt; 70% for 4m</span></div>
              <div className="qx-log-line"><span className="qx-log-line__ts">00:02:48</span><span className="qx-log-line__level qx-log-line__level--info">info</span><span className="qx-log-line__src">edge-01</span><span className="qx-log-line__msg">Container restart: nginx-ingress</span></div>
              <div className="qx-log-line"><span className="qx-log-line__ts">23:58:12</span><span className="qx-log-line__level qx-log-line__level--ok">ok</span><span className="qx-log-line__src">bak-01</span><span className="qx-log-line__msg">Scheduled backup completed (quox-db)</span></div>
              <div className="qx-log-line"><span className="qx-log-line__ts">23:42:01</span><span className="qx-log-line__level qx-log-line__level--debug">debug</span><span className="qx-log-line__src">gw-01</span><span className="qx-log-line__msg">New SSH session: control@laptop</span></div>
            </div>
          </Cell>

          <Cell title="Heatmap" span={2}>
            <div className="qx-heatmap">
              {[
                ['gw-01', 0.2, 'healthy'], ['hyp-01', 0.32, 'healthy'], ['hyp-02', 0.74, 'warn'], ['hyp-03', 0, 'unknown'],
                ['hyp-04', 0.44, 'healthy'], ['hyp-05', 0.9,  'crit'],    ['edge-01', 0.58, 'healthy'], ['edge-02', 0.29, 'healthy'],
              ].map(([n, v, s]) => (
                <div key={n} className={`qx-heatmap__cell qx-heatmap__cell--${s}`} style={{ '--qx-cell-intensity': v || 0.15 }}>
                  <span className="qx-heatmap__label">{n}</span>
                  <span className="qx-heatmap__val">{v ? `${Math.round(v * 100)}%` : '—'}</span>
                </div>
              ))}
            </div>
          </Cell>

          <Cell title="Trails" span={2}>
            <div className="qx-trail">
              <span className="qx-trail__node qx-trail__node--aee">AEE</span>
              <span className="qx-trail__sep">›</span>
              <span className="qx-trail__node qx-trail__node--aocl">AOCL</span>
              <span className="qx-trail__sep">›</span>
              <span className="qx-trail__node qx-trail__node--volt">VOLT</span>
              <span className="qx-trail__sep">›</span>
              <span className="qx-trail__node qx-trail__node--ward">WARD</span>
            </div>
            <div className="qx-evidence">
              <span className="qx-evidence__dot" />
              <span className="qx-evidence__source">edge-01</span>
              <span className="qx-evidence__sep">·</span>
              <span className="qx-evidence__ts">00:02:48Z</span>
              <span className="qx-evidence__sep">·</span>
              <span className="qx-evidence__source" style={{ color: '#30ff90' }}>verified</span>
            </div>
          </Cell>

          <Cell title="Diff view" span={2}>
            <div className="qx-diff">
              <div className="qx-diff__hunk">@@ -12,4 +12,6 @@ config/retention</div>
              <div className="qx-diff__line qx-diff__line--context"><span className="qx-diff__ln">12</span><span className="qx-diff__sign"> </span><span>retention:</span></div>
              <div className="qx-diff__line qx-diff__line--remove"><span className="qx-diff__ln">13</span><span className="qx-diff__sign">-</span><span>  policy: 30d</span></div>
              <div className="qx-diff__line qx-diff__line--add"><span className="qx-diff__ln">13</span><span className="qx-diff__sign">+</span><span>  policy: 90d</span></div>
              <div className="qx-diff__line qx-diff__line--add"><span className="qx-diff__ln">14</span><span className="qx-diff__sign">+</span><span>  encrypted: true</span></div>
              <div className="qx-diff__line qx-diff__line--context"><span className="qx-diff__ln">15</span><span className="qx-diff__sign"> </span><span>destinations:</span></div>
            </div>
          </Cell>

          <Cell title="Scored result" span={2}>
            <div className="qx-result">
              <div className="qx-result__score">
                <span className="qx-result__score-val">0.92</span>
                <span className="qx-result__score-label">match</span>
              </div>
              <div className="qx-result__body">
                <div className="qx-result__title">Fact · edge-01 runs nginx 1.24</div>
                <div className="qx-result__snippet">Confirmed <mark>edge-01</mark> running <mark>nginx 1.24</mark> on port 80, last observed during weekly scan.</div>
                <div className="qx-result__meta"><span>episodic</span><span>·</span><span>24 Mar 2026</span><span>·</span><span>cipher</span></div>
              </div>
            </div>
          </Cell>

          <Cell title="Snippet: line gutter + focus" span={2}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="qx-checkbox" style={{ fontSize: 11 }}>
                <input type="checkbox" checked={snippetFocusDemo} onChange={e => setSnippetFocusDemo(e.target.checked)} />
                <span className="qx-checkbox__box" />
                keyboard-focused (j/k)
              </label>
            </div>
            <div className={`qx-card qx-snippet${snippetFocusDemo ? ' qx-snippet--focus' : ''}`}>
              <div className="qx-snippet__header">
                <span className="qx-snippet__loc">src/components/nucleus/CodeSearch.jsx:112</span>
                <div className="qx-snippet__actions">
                  <button className="qx-btn qx-btn--ghost qx-btn--sm">Path</button>
                  <button className="qx-btn qx-btn--ghost qx-btn--sm">Code</button>
                </div>
              </div>
              <div style={{ display: 'flex' }}>
                <div className="qx-snippet__lines" aria-hidden="true">
                  <div>112</div><div>113</div><div>114</div>
                </div>
                <div className="qx-snippet__code" style={{ flex: 1 }}>
{`export default function CodeSearch() {
  const [query, setQuery] = useState('')
  const [selectedTargets, setSelectedTargets] = useState(...)`}
                </div>
              </div>
            </div>
          </Cell>

          <Cell title="Tree" span={2}>
            <div className="qx-tree">
              <div className="qx-tree__item qx-tree__item--open" style={{ '--qx-tree-depth': 0 }}>
                <span className="qx-tree__chev">›</span>
                <span className="qx-tree__label">Operations</span>
                <span className="qx-tree__count">12</span>
              </div>
              <div className="qx-tree__item qx-tree__item--selected" style={{ '--qx-tree-depth': 1 }}>
                <span className="qx-tree__chev" style={{ opacity: 0.3 }}>›</span>
                <span className="qx-tree__label">pve-cluster</span>
                <span className="qx-tree__count">4</span>
              </div>
              <div className="qx-tree__item" style={{ '--qx-tree-depth': 1 }}>
                <span className="qx-tree__chev" style={{ opacity: 0.3 }}>›</span>
                <span className="qx-tree__label">docker-hosts</span>
                <span className="qx-tree__count">2</span>
              </div>
              <div className="qx-tree__item qx-tree__item--open" style={{ '--qx-tree-depth': 0 }}>
                <span className="qx-tree__chev">›</span>
                <span className="qx-tree__label">Compliance</span>
                <span className="qx-tree__count">3</span>
              </div>
              <div className="qx-tree__item" style={{ '--qx-tree-depth': 1 }}>
                <span className="qx-tree__chev" style={{ opacity: 0.3 }}>›</span>
                <span className="qx-tree__label">ISO 27001</span>
              </div>
            </div>
          </Cell>

          <Cell title="Segmented bar" span={2}>
            <div className="qx-segbar">
              <span className="qx-segbar__seg" style={{ '--qx-seg-w': '42%', '--qx-seg-color': '#38bdf8' }} />
              <span className="qx-segbar__seg" style={{ '--qx-seg-w': '28%', '--qx-seg-color': '#a855f7' }} />
              <span className="qx-segbar__seg" style={{ '--qx-seg-w': '18%', '--qx-seg-color': '#30ff90' }} />
              <span className="qx-segbar__seg" style={{ '--qx-seg-w': '12%', '--qx-seg-color': '#f59e0b' }} />
            </div>
            <div className="qx-segbar-legend">
              <span className="qx-segbar-legend__item"><span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': '#38bdf8' }} /> API keys 42%</span>
              <span className="qx-segbar-legend__item"><span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': '#a855f7' }} /> OAuth 28%</span>
              <span className="qx-segbar-legend__item"><span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': '#30ff90' }} /> SSH 18%</span>
              <span className="qx-segbar-legend__item"><span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': '#f59e0b' }} /> Certs 12%</span>
            </div>
          </Cell>

          <Cell title="Agent tile + capabilities" span={2}>
            <div className="qx-agent-tile" style={{ '--qx-agent-color': '#38bdf8' }}>
              <div className="qx-agent-tile__avatar">CQ</div>
              <div className="qx-agent-tile__body">
                <div className="qx-agent-tile__name">CommanderQ</div>
                <div className="qx-agent-tile__role">Orchestrator</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  <span className="qx-cap qx-cap--read"><span className="qx-cap__dot" /> host.list</span>
                  <span className="qx-cap qx-cap--write"><span className="qx-cap__dot" /> memory.save</span>
                  <span className="qx-cap qx-cap--exec"><span className="qx-cap__dot" /> shell</span>
                </div>
              </div>
            </div>
          </Cell>

          <Cell title="Dropzone" span={2}>
            <div className="qx-dropzone">
              <div className="qx-dropzone__icon">{I.inbox}</div>
              <div>Drop a workflow <code className="qx-code">.json</code> here</div>
              <div className="qx-dropzone__hint">or click to browse · max 10MB</div>
            </div>
          </Cell>

          <Cell title="Scroll pane" span={2}>
            <div className="qx-hint qx-hint--sm">
              One block-flow scroller in a bounded flex column — natural-height content
              scrolls, the card itself never clips or shrinks below it.
            </div>
            <div
              className="qx-card qx-card--compact qx-surface--backed qx-stack"
              style={{ height: 140, minHeight: 0, overflow: 'hidden' }}
            >
              <div className="qx-scroll-pane qx-stack qx-stack--tight">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="qx-stat-row">
                    <span className="qx-stat-row__label">Row {i + 1}</span>
                    <span className="qx-stat-row__value">{(i + 1) * 7}</span>
                  </div>
                ))}
              </div>
            </div>
          </Cell>
        </div>
      )}

      {/* CANVAS & NODES — workflow builder primitives */}
      {tab === 'canvas' && (
        <div className="qx-card qx-card--compact" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="qx-canvas" style={{ position: 'relative', height: 440, padding: 20, borderRadius: 0, border: 'none' }}>
            <div className="qx-canvas__toolbar">
              <button className="qx-btn qx-btn--sm">Fit</button>
              <button className="qx-btn qx-btn--sm qx-btn--ghost">Export</button>
              <button className="qx-btn qx-btn--sm qx-btn--primary">Run</button>
            </div>

            {/* Nodes positioned absolutely */}
            <div className="qx-node" style={{ '--qx-node-color': '#38bdf8', position: 'absolute', top: 60, left: 40 }}>
              <div className="qx-node__head">{I.bolt} TRIGGER</div>
              <div className="qx-node__title">Schedule</div>
              <div className="qx-node__sub">cron: 0 */4 * * *</div>
              <span className="qx-node-handle" style={{ '--qx-handle-color': '#38bdf8', position: 'absolute', right: -5, top: '50%' }} />
            </div>

            <div className="qx-node qx-node--selected" style={{ '--qx-node-color': '#a855f7', position: 'absolute', top: 60, left: 260 }}>
              <div className="qx-node__head">{I.server} FETCH</div>
              <div className="qx-node__title">HTTP Request</div>
              <div className="qx-node__sub">GET /api/hosts</div>
              <span className="qx-node-handle" style={{ '--qx-handle-color': '#a855f7', position: 'absolute', left: -5, top: '50%' }} />
              <span className="qx-node-handle" style={{ '--qx-handle-color': '#a855f7', position: 'absolute', right: -5, top: '50%' }} />
            </div>

            <div className="qx-node" style={{ '--qx-node-color': '#30ff90', position: 'absolute', top: 180, left: 260 }}>
              <div className="qx-node__head">{I.shield} VALIDATE</div>
              <div className="qx-node__title">Schema Check</div>
              <div className="qx-node__sub">200 · application/json</div>
              <span className="qx-node-handle" style={{ '--qx-handle-color': '#30ff90', position: 'absolute', left: -5, top: '50%' }} />
            </div>

            <div className="qx-node" style={{ '--qx-node-color': '#f59e0b', position: 'absolute', top: 60, left: 480 }}>
              <div className="qx-node__head">{I.inbox} NOTIFY</div>
              <div className="qx-node__title">Slack Channel</div>
              <div className="qx-node__sub">#ops-alerts</div>
              <span className="qx-node-handle" style={{ '--qx-handle-color': '#f59e0b', position: 'absolute', left: -5, top: '50%' }} />
            </div>

            {/* Edges */}
            <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
              <path d="M 192 98 C 226 98, 226 98, 260 98" className="qx-edge qx-edge--animated" />
              <path d="M 320 130 C 320 155, 320 155, 320 180" className="qx-edge qx-edge--animated" />
              <path d="M 412 98 C 446 98, 446 98, 480 98" className="qx-edge qx-edge--animated" />
            </svg>
          </div>
        </div>
      )}

      {/* SHOWCASE — browser tabs + terminal v2 + plugin enable */}
      {tab === 'showcase' && (
        <div className="qx-stack" style={{ gap: 12 }}>
          <Cell title="Browser-style conversation tabs">
            <div className="qx-btabs">
              <button className="qx-btab"><span className="qx-btab__dot qx-btab__dot--idle" /><span className="qx-btab__label">Memory schema</span><button className="qx-btab__close">×</button></button>
              <button className="qx-btab qx-btab--active"><span className="qx-btab__dot qx-btab__dot--active" /><span className="qx-btab__label">CommanderQ · status review</span><button className="qx-btab__close">×</button></button>
              <button className="qx-btab"><span className="qx-btab__dot qx-btab__dot--busy" /><span className="qx-btab__label">Fleet ops run #341</span><button className="qx-btab__close">×</button></button>
              <button className="qx-btab"><span className="qx-btab__dot qx-btab__dot--idle" /><span className="qx-btab__label">Compliance gap audit</span><button className="qx-btab__close">×</button></button>
              <button className="qx-btabs__new" title="New tab">+</button>
            </div>
          </Cell>

          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 12 }}>
            <Cell title="Terminal v2">
              <div className="qx-terminal-v2">
                <div className="qx-terminal-v2__head">
                  <span className="qx-terminal-v2__title">control@dev-01 : ssh hyp-04</span>
                  <span className="qx-terminal-v2__chip"><span className="qx-dot qx-dot--online qx-dot--sm" /> LIVE</span>
                </div>
                <div className="qx-terminal-v2__body">
<span className="qx-terminal-v2__prompt">control@hyp-04</span>:<span className="qx-terminal-v2__user">~$</span> systemctl status quoxagent
● quoxagent.service: QuoxAgent fleet worker
   Loaded: loaded
   <span className="qx-terminal-v2__ok">Active: running</span> since 2026-04-13 21:08:42 UTC
   Memory: 38.4M · Tasks: 4 · CPU: 120ms
<span className="qx-terminal-v2__prompt">control@hyp-04</span>:<span className="qx-terminal-v2__user">~$</span> <span className="qx-terminal-v2__cursor"></span>
                </div>
                <div className="qx-terminal-v2__cmdbar">
                  <span className="qx-terminal-v2__prompt">❯</span>
                  <input defaultValue="journalctl -u quoxagent -n 20" />
                  <button className="qx-btn qx-btn--sm qx-btn--primary">Run</button>
                </div>
              </div>
            </Cell>

            <Cell title="Plugin enable effect">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div
                  className={`qx-enableable ${pluginOn ? 'qx-enabled-glow' : ''}`}
                  data-qx-enabled={enableBurst ? 'true' : 'false'}
                  style={{
                    padding: 14,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid var(--m-border-default)',
                    borderRadius: 12,
                    display: 'flex', alignItems: 'center', gap: 12,
                  }}
                >
                  <div className="qx-avatar qx-avatar--sm" style={{ background: pluginOn ? 'linear-gradient(135deg, rgba(168,85,247,0.5), rgba(56,189,248,0.25))' : undefined }}>
                    <QHorn size={14} animated={pluginOn} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>LinkedIn plugin</div>
                    <div style={{ fontSize: 11, color: '#fff', opacity: 0.8 }}>8 tools · 1 agent</div>
                  </div>
                  <span className={`qx-plugin-state ${pluginOn ? 'qx-plugin-state--on' : ''}`}>{pluginOn ? 'enabled' : 'disabled'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={triggerBurst} disabled={pluginOn}>Enable</button>
                  <button className="qx-btn qx-btn--sm" onClick={() => setPluginOn(false)} disabled={!pluginOn}>Disable</button>
                </div>
              </div>
            </Cell>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Cell title="Sticky actions (inside a scrollable form)">
              <div style={{ maxHeight: 140, overflowY: 'auto', paddingRight: 8 }}>
                <div className="qx-field" style={{ marginBottom: 10 }}>
                  <label className="qx-field__label">Display name</label>
                  <input className="qx-input" defaultValue="Quox Platform" style={{ padding: '8px 12px', fontSize: 12 }} />
                </div>
                <div className="qx-field" style={{ marginBottom: 10 }}>
                  <label className="qx-field__label">Tagline</label>
                  <input className="qx-input" defaultValue="AI infrastructure command centre" style={{ padding: '8px 12px', fontSize: 12 }} />
                </div>
                <div className="qx-sticky-actions">
                  <span className="qx-sticky-actions__status"><span className="qx-dot qx-dot--degraded qx-dot--sm" /> Unsaved changes</span>
                  <div className="qx-sticky-actions__spacer" />
                  <button className="qx-btn qx-btn--sm qx-btn--ghost">Discard</button>
                  <button className="qx-btn qx-btn--sm qx-btn--primary">Save</button>
                </div>
              </div>
            </Cell>

            <Cell title="Prompt box">
              <div className="qx-prompt" style={{ maxHeight: 140 }}>
                <div className="qx-prompt__toolbar">
                  <button className="qx-row-action" title="Copy">⧉</button>
                  <button className="qx-row-action" title="Expand">↗</button>
                </div>
{`You are CommanderQ, the platform orchestrator.
Provide clear, executive-level overviews.
Delegate domain queries to specialist agents.
Never fabricate metrics. Cite VOLT where possible.`}
              </div>
            </Cell>
          </div>

          <Cell title="Opaque-backed surface (glass-on-glass fix)" span={2}>
            <div
              className="qx-card qx-card--compact qx-surface--backed"
              style={{ display: 'flex', gap: 12 }}
            >
              <div className="qx-tabs qx-tabs--vert qx-tabs--plain" style={{ flex: '0 0 140px' }}>
                <button className="qx-tab qx-tab--active">Overview</button>
                <button className="qx-tab">Sources</button>
                <button className="qx-tab">History</button>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, color: '#fff', opacity: 0.75, marginBottom: 4 }}>
                  `.qx-card.qx-surface--backed` nested inside this already-glass gallery cell —
                  flat interior rows stay readable instead of compositing transparent.
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--m-border-subtle)' }}>
                  <span style={{ color: '#fff' }}>Fleet ops run #341</span>
                  <span className="qx-pill qx-pill--online">live</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--m-border-subtle)' }}>
                  <span style={{ color: '#fff' }}>Compliance gap audit</span>
                  <span className="qx-pill">queued</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                  <span style={{ color: '#fff' }}>Memory schema review</span>
                  <span className="qx-pill qx-pill--warn">stale</span>
                </div>
              </div>
            </div>
          </Cell>
        </div>
      )}
    </div>
  );
}
