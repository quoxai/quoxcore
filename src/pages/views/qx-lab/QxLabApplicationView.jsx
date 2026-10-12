/**
 * QX Lab — Application (compact)
 *
 * "Fleet Operations" composed entirely from global .qx-* utilities.
 * Fits above the fold. Zero bespoke CSS.
 */

import { useState } from 'react';
import QHorn from '../../../components/ui/QHorn';

const HOSTS = [
  { name: 'gw-01',  ip: '198.51.100.247', role: 'Bastion',    status: 'online',   cpu: 12 },
  { name: 'hyp-01', ip: '203.0.113.250',  role: 'Proxmox',    status: 'online',   cpu: 32 },
  { name: 'hyp-02', ip: '203.0.113.248',  role: 'Proxmox',    status: 'degraded', cpu: 74 },
  { name: 'hyp-03', ip: '203.0.113.237',  role: 'Proxmox',    status: 'offline',  cpu: 0  },
  { name: 'hyp-04', ip: '203.0.113.236',  role: 'Proxmox',    status: 'online',   cpu: 44 },
  { name: 'edge-01', ip: '203.0.113.101', role: 'Containers', status: 'online',   cpu: 58 },
];

const EVENTS = [
  { time: '00:14', severity: 'critical', host: 'hyp-03',   message: 'Node unreachable' },
  { time: '00:11', severity: 'high',     host: 'hyp-02',   message: 'CPU sustained > 70%' },
  { time: '23:58', severity: 'medium',   host: 'edge-01', message: 'Container restart: nginx' },
  { time: '23:42', severity: 'low',      host: 'bak-01',    message: 'Backup complete (quox-db)' },
];

const I = {
  server:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>,
  refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
  plus:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  search:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  kebab:   <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>,
  play:    <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
};

export default function QxLabApplicationView() {
  const [filter, setFilter] = useState('all');
  const filteredHosts = HOSTS.filter(h => filter === 'all' || h.status === filter);
  const counts = {
    all: HOSTS.length,
    online:   HOSTS.filter(h => h.status === 'online').length,
    degraded: HOSTS.filter(h => h.status === 'degraded').length,
    offline:  HOSTS.filter(h => h.status === 'offline').length,
  };

  return (
    <div className="qx-stack" style={{ gap: 12 }}>
      {/* Header strip */}
      <div className="qx-card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <QHorn size={24} animated />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Fleet Operations</div>
          <div style={{ fontSize: 11, color: '#fff', opacity: 0.8 }}>{HOSTS.length} hosts · synced 14s ago</div>
        </div>
        <span className="qx-pill qx-pill--online qx-pill--sm"><span className="qx-dot qx-dot--online qx-dot--sm" /> Collector LIVE</span>
        <button className="qx-btn qx-btn--sm">{I.refresh} Refresh</button>
        <button className="qx-btn qx-btn--primary qx-btn--sm">{I.plus} Add host</button>
      </div>

      {/* Stats + filter strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div className="qx-card" style={{ padding: 14 }}>
          <div className="qx-stat">
            <div className="qx-stat__head">{I.server} Fleet</div>
            <div className="qx-stat__value" style={{ fontSize: 22 }}>{HOSTS.length}</div>
          </div>
        </div>
        <div className="qx-card" style={{ padding: 14 }}>
          <div className="qx-stat">
            <div className="qx-stat__head"><span className="qx-dot qx-dot--online qx-dot--sm" /> Healthy</div>
            <div className="qx-stat__value" style={{ fontSize: 22, color: '#30ff90' }}>{counts.online}</div>
          </div>
        </div>
        <div className="qx-card" style={{ padding: 14 }}>
          <div className="qx-stat">
            <div className="qx-stat__head"><span className="qx-dot qx-dot--degraded qx-dot--sm" /> Attention</div>
            <div className="qx-stat__value" style={{ fontSize: 22, color: '#f59e0b' }}>{counts.degraded}</div>
          </div>
        </div>
        <div className="qx-card" style={{ padding: 14 }}>
          <div className="qx-stat">
            <div className="qx-stat__head"><span className="qx-dot qx-dot--offline qx-dot--sm" /> Down</div>
            <div className="qx-stat__value" style={{ fontSize: 22, color: '#f87171' }}>{counts.offline}</div>
          </div>
        </div>
      </div>

      {/* Filter + search */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {[
          { k: 'all',      l: 'All'      },
          { k: 'online',   l: 'Online'   },
          { k: 'degraded', l: 'Degraded' },
          { k: 'offline',  l: 'Offline'  },
        ].map(f => (
          <button
            key={f.k}
            className={`qx-chip ${filter === f.k ? 'qx-chip--active' : ''}`}
            onClick={() => setFilter(f.k)}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            {f.l} <span className="qx-badge" style={{ marginLeft: 4 }}>{counts[f.k]}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', maxWidth: 240, flex: 1 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#fff', opacity: 0.8, display: 'flex' }}>{I.search}</span>
          <input className="qx-input" placeholder="Search hosts…" style={{ paddingLeft: 32, padding: '8px 12px 8px 32px', fontSize: 12 }} />
        </div>
      </div>

      {/* Table + event feed side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div className="qx-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="qx-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Host</th>
                <th>Role</th>
                <th className="qx-num">CPU</th>
                <th style={{ width: 48 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredHosts.map(h => (
                <tr key={h.name}>
                  <td><span className={`qx-dot qx-dot--${h.status}`} /></td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 600 }}>{h.name}</span>
                      <span style={{ fontSize: 10, color: '#fff', opacity: 0.8, fontFamily: 'var(--font-mono)' }}>{h.ip}</span>
                    </div>
                  </td>
                  <td><span className="qx-pill qx-pill--ghost qx-pill--sm">{h.role}</span></td>
                  <td className="qx-num">
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 96 }}>
                      <span className={`qx-progress ${h.cpu > 80 ? 'qx-progress--crit' : h.cpu > 60 ? 'qx-progress--warn' : 'qx-progress--success'}`} style={{ '--qx-progress': h.cpu / 100, flex: 1 }} />
                      <span style={{ minWidth: 30, textAlign: 'right', fontSize: 11 }}>{h.cpu}%</span>
                    </div>
                  </td>
                  <td>
                    <div className="qx-row-actions">
                      <button className="qx-row-action" title="Run">{I.play}</button>
                      <button className="qx-row-action" title="More">{I.kebab}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="qx-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 6px' }}>
            <QHorn size={12} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff' }}>Event feed</span>
            <span className="qx-pill qx-pill--info qx-pill--sm" style={{ marginLeft: 'auto' }}>
              <span className="qx-dot qx-dot--loading qx-dot--sm" /> live
            </span>
          </div>
          {EVENTS.map((e, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 6 }}>
              <span style={{ fontSize: 10, color: '#fff', opacity: 0.8, fontFamily: 'var(--font-mono)', minWidth: 36 }}>{e.time}</span>
              <span className={`qx-severity qx-severity--${e.severity}`}>{e.severity}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.message}</div>
                <div style={{ fontSize: 10, color: '#fff', opacity: 0.8, fontFamily: 'var(--font-mono)' }}>{e.host}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
