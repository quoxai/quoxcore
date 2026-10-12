/**
 * QuoxShapeRadial — "The Shape of Quox".
 *
 * One SVG sunburst of the platform's real structure + health:
 *   - center hub: overall status + down/degraded counts + a thin uptime arc,
 *     with a status-tinted glow
 *   - service wedges by dependency: each depth-0 service owns an equal wedge;
 *     services that depend on it stack OUTWARD in the same wedge, so the chain
 *     reads centre-out
 *   - curved dependency edges that bow toward the hub; hovering a service lights
 *     its web (its dependencies + dependents) and dims the rest
 *   - outer band: the 12 real AOCL layers (L0-L11), cyan intensity = 24h volume
 *   - wheel to zoom, drag to pan, Reset to recentre
 *
 * Legibility: STATUS colours only (green/amber/red/grey), per-segment labels,
 * and a hover readout line beneath the radial.
 *
 * Truthfulness (do not soften): measured health wins (a service that answers its
 * own check is never red); dependency cascade is an ADDITIVE inference (amber
 * hatch + a red animated edge to the down ancestor), never a fake outage;
 * overallStatus 'unreachable' desaturates (3+ down = likely local link); AOCL
 * brightness is real per-browser 24h volume, zero = dim not red. Every motion
 * maps to a datum: alarm pulse = measured down, edge march = a real down
 * dependency. Nothing animates for atmosphere.
 */
import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { SERVICE_REGISTRY } from '../../../config/serviceRegistry';
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../../lib/aee/envelope';
import { computeCascade, computeDepth } from '../../../services/serviceCascade';
import { getUISetting, setUISetting } from '../../../services/uiSettings';

const DEFAULT_RINGS = { services: true, aocl: true, gov: true };

const CX = 300;
const CY = 300;
const RINGS = [
    { inner: 92, outer: 150 },
    { inner: 156, outer: 206 },
    { inner: 212, outer: 250 },
];
const AOCL_BAND = { inner: 262, outer: 296 };
// Outer governance rim: VOLT (evidence chain) + WARD (witness). Real counts
// via useGovernancePulse; sits beyond AOCL, so the base view is widened to
// leave room for radius 330 (see DEFAULT_VIEW).
const GOV_BAND = { inner: 302, outer: 330 };
const HUB_R = 74;
const UPTIME_ARC_R = 84;
const PAD_DEG = 1.4;
const DEFAULT_VIEW = { x: -32, y: -32, w: 664, h: 664 };

const STATUS = {
    healthy: '#30ff90', degraded: '#fbbf24', confirming: '#fbbf24',
    down: '#f87171', unmonitored: 'rgba(255,255,255,0.28)', absent: 'rgba(255,255,255,0.28)',
};
const STATUS_LABEL = {
    healthy: 'healthy', degraded: 'degraded', confirming: 'confirming…',
    down: 'DOWN', unmonitored: 'not monitored', absent: 'not installed',
};
const GHOST = new Set(['unmonitored', 'absent']); // grey, dashed, unfilled
const AOCL_ACCENT = '#38bdf8';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function polar(r, deg) {
    const a = ((deg - 90) * Math.PI) / 180;
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}
function sectorPath(rI, rO, a0, a1) {
    const large = a1 - a0 > 180 ? 1 : 0;
    const oa = polar(rO, a0), ob = polar(rO, a1), ia = polar(rI, a1), ib = polar(rI, a0);
    return `M ${oa.x.toFixed(2)} ${oa.y.toFixed(2)} A ${rO} ${rO} 0 ${large} 1 ${ob.x.toFixed(2)} ${ob.y.toFixed(2)} L ${ia.x.toFixed(2)} ${ia.y.toFixed(2)} A ${rI} ${rI} 0 ${large} 0 ${ib.x.toFixed(2)} ${ib.y.toFixed(2)} Z`;
}
function arcStroke(r, a0, a1) {
    const large = a1 - a0 > 180 ? 1 : 0;
    const p0 = polar(r, a0), p1 = polar(r, a1);
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}
// Curved edge that bows toward the hub (control point pulled centre-ward).
function edgePath(p0, p1) {
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    const cx = mx + (CX - mx) * 0.4, cy = my + (CY - my) * 0.4;
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}
function rootOf(key) {
    let k = key, guard = 0;
    while (SERVICE_REGISTRY[k]?.dependencies?.[0] && guard++ < 12) k = SERVICE_REGISTRY[k].dependencies[0];
    return k;
}

export default function QuoxShapeRadial({
    services = {}, overallStatus = 'unknown', downCount = 0, degradedCount = 0,
    summary = {}, aoclLayers = [], governance = null, onSelectService, onSelectLayer,
}) {
    const cascade = useMemo(() => computeCascade(services, SERVICE_REGISTRY), [services]);
    const depth = useMemo(() => computeDepth(SERVICE_REGISTRY), []);
    const [hover, setHover] = useState(null);          // { key, kind, title, detail, color }
    const [view, setView] = useState(DEFAULT_VIEW);
    const [rings, setRings] = useState(() => ({ ...DEFAULT_RINGS, ...(getUISetting('radialRings') || {}) }));
    const svgRef = useRef(null);
    const drag = useRef(null);
    const toggleRing = (k) => setRings((prev) => {
        const next = { ...prev, [k]: !prev[k] };
        // Never allow every band off — keep at least one visible.
        if (!next.services && !next.aocl && !next.gov) return prev;
        setUISetting('radialRings', next);
        return next;
    });

    // Wedge layout: each depth-0 root owns an equal wedge; members stack outward.
    const slots = useMemo(() => {
        // Roots = the set of rootOf() values actually used, so every service is
        // guaranteed a wedge even if a future dependency chain is unusual.
        const groups = {};
        Object.keys(SERVICE_REGISTRY).forEach((k) => { const r = rootOf(k); (groups[r] = groups[r] || []).push(k); });
        const roots = Object.keys(groups).sort();
        const wedge = 360 / roots.length;
        const out = {};
        roots.forEach((r, i) => {
            const w0 = i * wedge, w1 = (i + 1) * wedge;
            const byLevel = { 0: [], 1: [], 2: [] };
            (groups[r] || []).forEach((k) => byLevel[Math.min(depth[k] ?? 0, 2)].push(k));
            [0, 1, 2].forEach((lv) => {
                const arr = byLevel[lv].sort(); const n = arr.length; if (!n) return;
                const step = (w1 - w0) / n;
                arr.forEach((k, j) => { const a0 = w0 + j * step, a1 = w0 + (j + 1) * step; out[k] = { d: lv, a0, a1, mid: (a0 + a1) / 2 }; });
            });
        });
        return out;
    }, [depth]);

    const aoclMap = useMemo(() => {
        const m = {}; (aoclLayers || []).forEach((l) => { if (l && l.layerId) m[l.layerId] = l; }); return m;
    }, [aoclLayers]);
    const aoclMax = useMemo(() => Math.max(1, ...(aoclLayers || []).map((l) => l?.total || 0)), [aoclLayers]);

    // Edges (dependent -> dependency), curved, lit red when the dependency is down.
    const edges = useMemo(() => {
        const list = [];
        Object.keys(SERVICE_REGISTRY).forEach((key) => {
            const from = slots[key]; if (!from) return;
            (SERVICE_REGISTRY[key].dependencies || []).forEach((dep) => {
                const to = slots[dep]; if (!to) return;
                list.push({
                    id: `${key}-${dep}`, from: key, dep,
                    d: edgePath(polar(RINGS[from.d].inner, from.mid), polar(RINGS[to.d].outer, to.mid)),
                    lit: cascade[dep]?.measured === 'down',
                });
            });
        });
        return list;
    }, [slots, cascade]);

    // Hover focus: the hovered service's web (its deps + its dependents).
    const focusSet = useMemo(() => {
        if (hover?.kind !== 'service') return null;
        const h = hover.key;
        const set = new Set([h]);
        edges.forEach((e) => { if (e.from === h) set.add(e.dep); if (e.dep === h) set.add(e.from); });
        return set;
    }, [hover, edges]);

    const unreachable = overallStatus === 'unreachable';
    const uptimePct = summary?.total > 0 ? (summary.healthy / summary.total) * 100 : null;
    const statusWord = unreachable ? 'UNREACHABLE'
        : overallStatus === 'operational' ? 'OPERATIONAL'
        : overallStatus === 'degraded' ? 'DEGRADED'
        : overallStatus === 'major_outage' ? 'MAJOR OUTAGE' : 'CHECKING';
    const hubColor = unreachable ? 'rgba(255,255,255,0.6)'
        : overallStatus === 'operational' ? STATUS.healthy
        : overallStatus === 'major_outage' ? STATUS.down
        : overallStatus === 'degraded' ? STATUS.degraded : 'rgba(255,255,255,0.6)';

    // ── zoom / pan ──────────────────────────────────────────────
    const clientToSvg = useCallback((clientX, clientY) => {
        const rect = svgRef.current.getBoundingClientRect();
        const px = (clientX - rect.left) / rect.width, py = (clientY - rect.top) / rect.height;
        return { px, py };
    }, []);
    useEffect(() => {
        const el = svgRef.current; if (!el) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            setView((v) => {
                const { px, py } = clientToSvg(e.clientX, e.clientY);
                const pointX = v.x + px * v.w, pointY = v.y + py * v.h;
                const nw = clamp(v.w * (e.deltaY > 0 ? 1.12 : 0.89), 150, 900);
                return { w: nw, h: nw, x: pointX - px * nw, y: pointY - py * nw };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [clientToSvg]);
    const onBgPointerDown = (e) => {
        drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onBgPointerMove = (e) => {
        if (!drag.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const dx = ((e.clientX - drag.current.x) / rect.width) * drag.current.view.w;
        const dy = ((e.clientY - drag.current.y) / rect.height) * drag.current.view.h;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
        setView({ ...drag.current.view, x: drag.current.view.x - dx, y: drag.current.view.y - dy });
    };
    const onBgPointerUp = () => { drag.current = null; };
    const zoomed = view.w !== DEFAULT_VIEW.w || view.x !== DEFAULT_VIEW.x || view.y !== DEFAULT_VIEW.y;

    // Governance rim segments (VOLT + WARD), real counts or null (unknown).
    const govSegs = useMemo(() => {
        const g = governance || {};
        const v = g.volt || { status: 'unknown' };
        const w = g.ward || { status: 'unknown' };
        const detail = (s, quiet, unknown, live) =>
            s.status === 'active' ? live : s.status === 'quiet' ? quiet : unknown;
        return [
            {
                id: 'volt', label: 'VOLT', a0: 0, a1: 180, status: v.status,
                detail: detail(v,
                    'VOLT · evidence chain · no runs recorded yet',
                    'VOLT · evidence chain · stats unavailable',
                    `VOLT · ${v.runs ?? 0} runs · ${v.events ?? 0} events · ${v.bundles ?? 0} bundles`),
            },
            {
                id: 'ward', label: 'WARD', a0: 180, a1: 360, status: w.status,
                detail: detail(w,
                    'WARD · witness ledger · no receipts yet',
                    'WARD · witness ledger · stats unavailable',
                    `WARD · ${w.entries ?? 0} receipts · ${w.chains ?? 0} chains${w.witness ? ` · ${w.witness} witnessed` : ''}`),
            },
        ];
    }, [governance]);

    function segLabel(text, rMid, mid, arcDeg) {
        const arcPx = (arcDeg * Math.PI / 180) * rMid;
        if (arcPx < text.length * 5.2) return null;
        const p = polar(rMid, mid);
        let rot = mid; if (mid > 90 && mid < 270) rot += 180;
        return (
            <text x={p.x} y={p.y} transform={`rotate(${rot} ${p.x} ${p.y})`}
                textAnchor="middle" dominantBaseline="middle" fontSize="8.5" fill="#fff" opacity="0.92" pointerEvents="none"
                style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 2, strokeLinejoin: 'round' }}>{text}</text>
        );
    }

    const readout = hover || {
        title: 'The Shape of Quox',
        detail: 'Hover a segment to trace its dependencies. Wheel to zoom, drag to pan. Inner rings = core services, then the 12 AOCL pipeline layers, then the VOLT + WARD governance rim. Toggle rings above.',
        color: 'rgba(255,255,255,0.7)',
    };

    const selectService = (key) => { if (!drag.current?.moved && onSelectService) onSelectService(key); };

    return (
        <div className="qx-radial-wrap">
            <div className="qx-radial-rings" role="group" aria-label="Which rings to show">
                <button type="button" className={`qx-radial-chip${rings.services ? ' is-on' : ''}`}
                    aria-pressed={rings.services} onClick={() => toggleRing('services')}>Services</button>
                <button type="button" className={`qx-radial-chip${rings.aocl ? ' is-on' : ''}`}
                    aria-pressed={rings.aocl} onClick={() => toggleRing('aocl')}>AOCL</button>
                <button type="button" className={`qx-radial-chip${rings.gov ? ' is-on' : ''}`}
                    aria-pressed={rings.gov} onClick={() => toggleRing('gov')}>Governance</button>
            </div>
            {zoomed && (
                <button type="button" className="qx-radial-reset" onClick={() => setView(DEFAULT_VIEW)}>Reset view</button>
            )}
            <svg ref={svgRef} className="qx-radial" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img"
                aria-label="Shape of Quox: service dependency and AOCL layer health"
                style={{ cursor: drag.current ? 'grabbing' : 'grab' }}>
                <defs>
                    <pattern id="qxHatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="#fbbf24" strokeWidth="1.4" opacity="0.9" />
                    </pattern>
                    <radialGradient id="qxHubGlow">
                        <stop offset="0%" stopColor={hubColor} stopOpacity="0.28" />
                        <stop offset="70%" stopColor={hubColor} stopOpacity="0" />
                    </radialGradient>
                </defs>

                {/* pan/zoom capture + click-away */}
                <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="transparent"
                    onPointerDown={onBgPointerDown} onPointerMove={onBgPointerMove}
                    onPointerUp={onBgPointerUp} onPointerLeave={onBgPointerUp} />

                <g opacity={unreachable ? 0.4 : 1} style={{ transition: 'opacity 0.3s ease' }}>
                    {/* hub glow */}
                    <circle cx={CX} cy={CY} r={AOCL_BAND.outer} fill="url(#qxHubGlow)" pointerEvents="none" />
                    {/* faint ring guides */}
                    {RINGS.map((r) => (
                        <circle key={r.outer} cx={CX} cy={CY} r={r.outer} fill="none" stroke="rgba(255,255,255,0.05)" pointerEvents="none" />
                    ))}

                    {/* dependency edges (curved, bow to hub) */}
                    {rings.services && edges.map((e) => {
                        const related = focusSet ? (e.from === hover.key || e.dep === hover.key) : null;
                        const base = focusSet ? (related ? 0.9 : 0.03) : (e.lit ? 0.85 : 0.12);
                        return (
                            <path key={e.id} d={e.d} fill="none"
                                className={e.lit && !unreachable ? 'qx-edge qx-edge--lit' : 'qx-edge'}
                                stroke={e.lit && !unreachable ? STATUS.down : (related ? '#8ecbff' : 'rgba(255,255,255,0.9)')}
                                strokeWidth={e.lit ? 2.4 : related ? 1.8 : 1}
                                opacity={unreachable ? 0.06 : base} strokeLinecap="round" pointerEvents="none" />
                        );
                    })}

                    {/* service segments */}
                    {rings.services && Object.keys(slots).map((key) => {
                        const slot = slots[key];
                        const reg = SERVICE_REGISTRY[key];
                        const c = cascade[key] || { measured: 'unmonitored', atRisk: false, rootCauses: [] };
                        const ring = RINGS[slot.d];
                        const a0 = slot.a0 + PAD_DEG / 2, a1 = slot.a1 - PAD_DEG / 2;
                        const m = c.measured;
                        const col = STATUS[m] || STATUS.unmonitored;
                        const ghost = GHOST.has(m);
                        const filled = !ghost;
                        const dimmed = focusSet && !focusSet.has(key);
                        const chain = c.rootCauses?.length ? ` · at risk: ${c.rootCauses.join(', ')} down` : '';
                        const label = `${reg.name}: ${STATUS_LABEL[m] || m}`;
                        const enter = () => setHover({
                            key, kind: 'service', title: reg.shortName || reg.name,
                            detail: `${reg.name} · ${STATUS_LABEL[m] || m}${reg.critical ? ' · critical' : ''}${reg.port ? ' · :' + reg.port : ''}${chain}`,
                            color: ghost ? 'rgba(255,255,255,0.7)' : col,
                        });
                        return (
                            <g key={key} className={`qx-seg qx-seg--${m}${m === 'down' ? ' qx-seg--alarm' : ''}`}
                                role="button" tabIndex={0} aria-label={label}
                                style={{ cursor: onSelectService ? 'pointer' : 'default', opacity: dimmed ? 0.28 : 1, transition: 'opacity 0.15s ease' }}
                                onClick={() => selectService(key)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectService && onSelectService(key); } }}
                                onMouseEnter={enter} onFocus={enter} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
                                <path d={sectorPath(ring.inner, ring.outer, a0, a1)}
                                    fill={filled ? col : 'transparent'} fillOpacity={filled ? 0.82 : 0}
                                    stroke={col} strokeWidth={reg.critical ? 1.8 : 1}
                                    strokeDasharray={ghost ? '3 3' : undefined} />
                                {c.atRisk && m !== 'down' && (
                                    <path d={sectorPath(ring.inner, ring.outer, a0, a1)} fill="url(#qxHatch)" fillOpacity={0.5} stroke="none" pointerEvents="none" />
                                )}
                                {segLabel(reg.shortName || key, (ring.inner + ring.outer) / 2, slot.mid, a1 - a0)}
                            </g>
                        );
                    })}

                    {/* AOCL outer band */}
                    {rings.aocl && AOCL_LAYER_ORDER.map((layerId, i) => {
                        const meta = AOCL_LAYERS[layerId] || {};
                        const stat = aoclMap[layerId];
                        const step = 360 / AOCL_LAYER_ORDER.length;
                        const a0 = i * step + PAD_DEG / 2, a1 = (i + 1) * step - PAD_DEG / 2;
                        const total = stat?.total || 0;
                        const errorRate = parseFloat(stat?.errorRate || 0);
                        const bright = total > 0 ? 0.35 + 0.55 * (Math.log(1 + total) / Math.log(1 + aoclMax)) : 0.12;
                        const col = errorRate > 20 ? STATUS.down : errorRate > 5 ? STATUS.degraded : AOCL_ACCENT;
                        const mid = (a0 + a1) / 2;
                        const lp = polar((AOCL_BAND.inner + AOCL_BAND.outer) / 2, mid);
                        let rot = mid; if (mid > 90 && mid < 270) rot += 180;
                        const dimmed = !!focusSet;
                        const enter = () => setHover({
                            key: layerId, kind: 'aocl', title: `${meta.label || layerId} (${layerId})`,
                            detail: `AOCL layer · ${total} events 24h (this browser)${errorRate > 0 ? ` · ${errorRate}% rejected` : total === 0 ? ' · quiet' : ''}`,
                            color: col,
                        });
                        return (
                            <g key={layerId} role="button" tabIndex={0} aria-label={`AOCL ${meta.label || layerId}`}
                                style={{ cursor: onSelectLayer ? 'pointer' : 'default', opacity: dimmed ? 0.4 : 1, transition: 'opacity 0.15s ease' }}
                                onClick={() => onSelectLayer && onSelectLayer(layerId)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectLayer && onSelectLayer(layerId); } }}
                                onMouseEnter={enter} onFocus={enter} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
                                <path d={sectorPath(AOCL_BAND.inner, AOCL_BAND.outer, a0, a1)}
                                    fill={col} fillOpacity={bright} stroke={col} strokeOpacity={total > 0 ? 0.6 : 0.25} strokeWidth={1} />
                                <text x={lp.x} y={lp.y} transform={`rotate(${rot} ${lp.x} ${lp.y})`}
                                    textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="#fff" opacity={total > 0 ? 0.9 : 0.5} pointerEvents="none"
                                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 2, strokeLinejoin: 'round' }}>{layerId}</text>
                            </g>
                        );
                    })}

                    {/* governance rim: VOLT + WARD (real counts). active=green,
                        quiet/unknown=dim grey — never red for a flaky probe. */}
                    {rings.gov && govSegs.map((s) => {
                        const a0 = s.a0 + PAD_DEG / 2, a1 = s.a1 - PAD_DEG / 2;
                        const live = s.status === 'active';
                        const col = live ? STATUS.healthy : STATUS.unmonitored;
                        const mid = (a0 + a1) / 2;
                        const lp = polar((GOV_BAND.inner + GOV_BAND.outer) / 2, mid);
                        let rot = mid; if (mid > 90 && mid < 270) rot += 180;
                        const dimmed = !!focusSet;
                        const enter = () => setHover({
                            key: s.id, kind: 'gov', title: `${s.label} · governance`,
                            detail: s.detail, color: col,
                        });
                        return (
                            <g key={s.id} role="button" tabIndex={0} aria-label={`Governance ${s.label}`}
                                style={{ cursor: 'default', opacity: dimmed ? 0.4 : 1, transition: 'opacity 0.15s ease' }}
                                onMouseEnter={enter} onFocus={enter} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
                                <path d={sectorPath(GOV_BAND.inner, GOV_BAND.outer, a0, a1)}
                                    fill={col} fillOpacity={live ? 0.7 : 0.12}
                                    stroke={col} strokeOpacity={live ? 0.7 : 0.3} strokeWidth={1}
                                    strokeDasharray={live ? undefined : '3 3'} />
                                <text x={lp.x} y={lp.y} transform={`rotate(${rot} ${lp.x} ${lp.y})`}
                                    textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="600" fill="#fff"
                                    opacity={live ? 0.95 : 0.6} pointerEvents="none"
                                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 2, strokeLinejoin: 'round' }}>{s.label}</text>
                            </g>
                        );
                    })}

                    {/* uptime arc */}
                    {uptimePct != null && (
                        <>
                            <path d={arcStroke(UPTIME_ARC_R, 0, 359.9)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
                            <path d={arcStroke(UPTIME_ARC_R, 0, Math.max(0.1, (uptimePct / 100) * 359.9))} fill="none"
                                stroke={uptimePct >= 99 ? STATUS.healthy : uptimePct >= 80 ? STATUS.degraded : STATUS.down} strokeWidth="4" strokeLinecap="round" />
                        </>
                    )}

                    {/* hub */}
                    <circle cx={CX} cy={CY} r={HUB_R} fill="var(--m-bg-base)" stroke="rgba(255,255,255,0.18)" />
                    <text x={CX} y={CY - 8} textAnchor="middle" fontSize="14" fontWeight="700" fill={hubColor}>{statusWord}</text>
                    {unreachable ? (
                        <text x={CX} y={CY + 14} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.6)">likely local link</text>
                    ) : (
                        <>
                            <text x={CX} y={CY + 16} textAnchor="middle" fontSize="19" fontWeight="700" fill="#fff">
                                {downCount > 0 ? `${downCount} down` : degradedCount > 0 ? `${degradedCount} degr` : 'all up'}
                            </text>
                            {uptimePct != null && (
                                <text x={CX} y={CY + 33} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.55)">{Math.round(uptimePct)}% up</text>
                            )}
                        </>
                    )}
                </g>
            </svg>
            <div className="qx-radial-readout">
                <span className="qx-radial-readout__title" style={{ color: readout.color }}>{readout.title}</span>
                <span className="qx-radial-readout__detail">{readout.detail}</span>
            </div>
        </div>
    );
}
