/**
 * PublicWaypointView — the public VOX share page (route `/w/:code`).
 *
 * This is what an EXTERNAL recipient of a share link sees: a delivery driver, a
 * visitor, anyone with no Quox account. It is a standalone, unauthenticated
 * route (no AppShell, no nav). It reads only the public read surface
 * (/collector/api/public/spatial/w/:code) which returns solely public-tier
 * fields; account-tier codes come back 403 (prompt sign-in) and private/absent
 * codes 404. Coordinates come straight from the API response, so the page needs
 * neither the VOX codec nor a map library — it renders a keyless OpenStreetMap
 * embed and native Maps deep-links for turn-by-turn directions.
 */
import React from 'react';
import { useParams } from 'react-router-dom';
import './public-waypoint.css';

const PUBLIC_LOOKUP = (code) => `/collector/api/public/spatial/w/${encodeURIComponent(code)}`;

function altitudeLabel(row) {
    if (row && typeof row.floor === 'number') {
        return row.floor === 0 ? 'Ground floor' : `Floor ${row.floor > 0 ? '+' : ''}${row.floor}`;
    }
    const z = row?.zSlice ?? 0;
    return z === 0 ? 'Ground level' : `${z * 40} m up (slice ${z})`;
}

export default function PublicWaypointView() {
    const { code } = useParams();
    const [state, setState] = React.useState({ status: 'loading' });
    const [copied, setCopied] = React.useState(false);

    React.useEffect(() => {
        let alive = true;
        setState({ status: 'loading' });
        (async () => {
            try {
                const res = await fetch(PUBLIC_LOOKUP(code), { headers: { Accept: 'application/json' } });
                let body = null;
                try { body = await res.json(); } catch { /* non-JSON */ }
                if (!alive) return;
                if (res.status === 200 && body) {
                    setState({ status: 'ok', row: body });
                } else if (res.status === 403) {
                    setState({ status: 'account_required' });
                } else if (res.status === 400) {
                    setState({ status: 'invalid' });
                } else if (res.status === 404) {
                    setState({ status: 'not_found' });
                } else {
                    setState({ status: 'error' });
                }
            } catch {
                if (alive) setState({ status: 'error' });
            }
        })();
        return () => { alive = false; };
    }, [code]);

    const copyCode = React.useCallback((text) => {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
            }).catch(() => {});
        }
    }, []);

    return (
        <div className="pubwp-root">
            <header className="pubwp-brand">
                <span className="pubwp-mark" aria-hidden="true">◈</span>
                <span className="pubwp-brand-name">Quoxel</span>
            </header>

            <main className="pubwp-card">
                {state.status === 'loading' && (
                    <div className="pubwp-msg">Resolving location…</div>
                )}

                {state.status === 'ok' && <ResolvedWaypoint row={state.row} onCopy={copyCode} copied={copied} />}

                {state.status === 'account_required' && (
                    <div className="pubwp-gate">
                        <div className="pubwp-gate-icon" aria-hidden="true">🔒</div>
                        <h1 className="pubwp-gate-title">Shared with Quox accounts</h1>
                        <p className="pubwp-gate-body">
                            This location is shared with signed-in Quox accounts only.
                            Sign in to view it.
                        </p>
                        <a className="pubwp-btn pubwp-btn-primary" href={`/login?next=${encodeURIComponent(`/w/${code}`)}`}>
                            Sign in with Quox
                        </a>
                        <div className="pubwp-code-quiet">{formatCode(code)}</div>
                    </div>
                )}

                {(state.status === 'not_found' || state.status === 'invalid') && (
                    <div className="pubwp-msg pubwp-msg-empty">
                        <div className="pubwp-gate-icon" aria-hidden="true">🧭</div>
                        <h1 className="pubwp-gate-title">
                            {state.status === 'invalid' ? 'Not a valid VOX code' : 'No public location here'}
                        </h1>
                        <p className="pubwp-gate-body">
                            {state.status === 'invalid'
                                ? 'This code failed its check symbol — it may have been mistyped.'
                                : 'This code is not shared publicly, or nothing has been published at it.'}
                        </p>
                        <div className="pubwp-code-quiet">{formatCode(code)}</div>
                    </div>
                )}

                {state.status === 'error' && (
                    <div className="pubwp-msg pubwp-msg-empty">
                        Couldn’t reach the location service. Please try again.
                    </div>
                )}
            </main>

            <footer className="pubwp-footer">
                <span>A voxel address you can decode offline, anywhere.</span>
            </footer>
        </div>
    );
}

function ResolvedWaypoint({ row, onCopy, copied }) {
    const { lat, lng, vox, label, publicFields } = row;
    const display = formatCode(vox || '');
    const d = 0.0025; // ~250 m bbox around the pin
    const osm = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}&layer=mapnik&marker=${lat}%2C${lng}`;
    const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    const amaps = `https://maps.apple.com/?daddr=${lat},${lng}`;

    return (
        <>
            {label && <h1 className="pubwp-title">{label}</h1>}

            <button type="button" className="pubwp-codechip" onClick={() => onCopy(display)} title="Copy VOX code">
                <span className="pubwp-codechip-text">{display}</span>
                <span className="pubwp-codechip-copy">{copied ? '✓ copied' : 'copy'}</span>
            </button>

            <div className="pubwp-map-wrap">
                <iframe
                    className="pubwp-map"
                    title="Location map"
                    src={osm}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                />
            </div>

            <dl className="pubwp-facts">
                <div><dt>Altitude</dt><dd>{altitudeLabel(row)}</dd></div>
                <div><dt>Coordinates</dt><dd>{lat.toFixed(5)}, {lng.toFixed(5)}</dd></div>
            </dl>

            {publicFields && typeof publicFields === 'object' && (
                <dl className="pubwp-facts pubwp-facts-extra">
                    {Object.entries(publicFields).slice(0, 8).map(([k, v]) => (
                        <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
                    ))}
                </dl>
            )}

            <div className="pubwp-actions">
                <a className="pubwp-btn pubwp-btn-primary" href={gmaps} target="_blank" rel="noreferrer noopener">
                    Open in Google Maps
                </a>
                <a className="pubwp-btn" href={amaps} target="_blank" rel="noreferrer noopener">
                    Open in Apple Maps
                </a>
            </div>
        </>
    );
}

function formatCode(raw) {
    const clean = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!clean) return '';
    return clean.match(/.{1,4}/g).join('-');
}
