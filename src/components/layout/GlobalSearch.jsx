/**
 * GlobalSearch — top-bar search / command palette (Top-bar #4).
 *
 * Replaces the now-useless per-sidebar filter (menus split into short
 * sub-menus). A single header search: click the pill or press Cmd/Ctrl+K to
 * open a centred palette that autosuggests across every nav destination
 * (from getNavSections), keyboard-navigable, Enter to go.
 *
 * First-cut: searches nav items. Extension points (noted for the live walk):
 * plugins, agents, docs, and recent items can be folded into `buildIndex()`.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getNavSections } from '../../config/navRegistry';

function buildIndex() {
    const items = [];
    try {
        for (const section of getNavSections()) {
            for (const item of (section.items || [])) {
                if (!item.path) continue;
                items.push({
                    label: item.label,
                    path: item.path,
                    section: section.label,
                    icon: item.icon || null,
                    hay: `${item.label} ${section.label} ${item.path} ${(item.keywords || []).join(' ')}`.toLowerCase(),
                });
            }
        }
    } catch { /* nav not ready */ }
    // de-dupe by path
    const seen = new Set();
    return items.filter(i => (seen.has(i.path) ? false : seen.add(i.path)));
}

function score(item, q) {
    const label = item.label.toLowerCase();
    if (label === q) return 100;
    if (label.startsWith(q)) return 80;
    if (label.includes(q)) return 60;
    if (item.hay.includes(q)) return 40;
    return 0;
}

export default function GlobalSearch() {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef(null);

    const index = useMemo(() => (open ? buildIndex() : []), [open]);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return index.slice(0, 8); // show a few destinations before typing
        return index
            .map(i => ({ i, s: score(i, q) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 10)
            .map(x => x.i);
    }, [query, index]);

    // Cmd/Ctrl+K opens; Esc closes
    useEffect(() => {
        const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                setOpen(v => !v);
            } else if (e.key === 'Escape' && open) {
                setOpen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    useEffect(() => {
        if (open) {
            setQuery('');
            setActive(0);
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open]);

    useEffect(() => { setActive(0); }, [query]);

    const go = useCallback((item) => {
        if (!item) return;
        setOpen(false);
        navigate(item.path);
    }, [navigate]);

    const onInputKey = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    };

    return (
        <>
            <button
                type="button"
                className="global-search__trigger global-search__trigger--icon"
                onClick={() => setOpen(true)}
                title="Search (Ctrl/Cmd + K)"
                aria-label="Search (Ctrl or Cmd + K)"
            >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
            </button>

            {open && createPortal(
                <div className="global-search__overlay" onMouseDown={() => setOpen(false)}>
                    <div
                        className="global-search__panel glass-panel"
                        role="dialog"
                        aria-label="Search"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <div className="global-search__inputrow">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                            <input
                                ref={inputRef}
                                className="global-search__input"
                                type="text"
                                placeholder="Search destinations…"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={onInputKey}
                            />
                            <span className="global-search__kbd">Esc</span>
                        </div>
                        <div className="global-search__results" role="listbox">
                            {results.length === 0 ? (
                                <div className="global-search__empty">No matches for “{query}”.</div>
                            ) : results.map((item, idx) => (
                                <button
                                    key={item.path}
                                    type="button"
                                    role="option"
                                    aria-selected={idx === active}
                                    className={`global-search__result${idx === active ? ' global-search__result--active' : ''}`}
                                    onMouseEnter={() => setActive(idx)}
                                    onClick={() => go(item)}
                                >
                                    <span className="global-search__result-label">{item.label}</span>
                                    <span className="global-search__result-section">{item.section}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
