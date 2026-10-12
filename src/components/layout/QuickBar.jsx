/**
 * QuickBar — User-pinnable quick access bar in the header center.
 *
 * Q icon expands a dropdown with pinned navigation items.
 * Items are pinned/unpinned from the sidebar flyout (star icon).
 * Persisted in localStorage.
 */

import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

const STORAGE_KEY = 'quox-quickbar'

/** Read pinned items from localStorage */
export function getQuickBarItems() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []
    } catch {
        return []
    }
}

/** Save pinned items to localStorage */
export function setQuickBarItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    window.dispatchEvent(new CustomEvent('quox-quickbar-change'))
}

/** Check if a path is pinned */
export function isQuickBarPinned(path) {
    return getQuickBarItems().some(i => i.path === path)
}

/** Toggle pin/unpin for an item */
export function toggleQuickBarItem(item) {
    const items = getQuickBarItems()
    const idx = items.findIndex(i => i.path === item.path)
    if (idx >= 0) {
        items.splice(idx, 1)
    } else {
        items.push({ path: item.path, label: item.label, icon: item.icon })
    }
    setQuickBarItems(items)
}

function QuickBar({ NavIcon }) {
    const navigate = useNavigate()
    const location = useLocation()
    const [open, setOpen] = useState(false)
    const [items, setItems] = useState(getQuickBarItems)
    const ref = useRef(null)

    // Listen for changes (from flyout pin/unpin)
    useEffect(() => {
        const handler = () => setItems(getQuickBarItems())
        window.addEventListener('quox-quickbar-change', handler)
        window.addEventListener('storage', handler)
        return () => {
            window.removeEventListener('quox-quickbar-change', handler)
            window.removeEventListener('storage', handler)
        }
    }, [])

    // Close on outside click
    useEffect(() => {
        if (!open) return
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Close on navigation
    useEffect(() => { setOpen(false) }, [location.pathname])

    const hasItems = items.length > 0

    return (
        <div className="quickbar" ref={ref}>
            <button
                className={`quickbar__trigger ${open ? 'quickbar__trigger--open' : ''} ${hasItems ? '' : 'quickbar__trigger--empty'}`}
                onClick={() => setOpen(!open)}
                title={hasItems ? 'Quick Access' : 'Quick Access: pin items with ★ in the sidebar'}
                aria-label="Quick Access"
            >
                <QIconMini />
                {hasItems && <span className="quickbar__count">{items.length}</span>}
            </button>

            {open && (
                <div className="quickbar__dropdown">
                    {hasItems ? (
                        <>
                            <div className="quickbar__header">Quick Access</div>
                            <div className="quickbar__items">
                                {items.map(item => (
                                    <button
                                        key={item.path}
                                        className={`quickbar__item ${location.pathname === item.path ? 'quickbar__item--active' : ''}`}
                                        onClick={() => { navigate(item.path); setOpen(false) }}
                                        title={item.label}
                                    >
                                        <span className="quickbar__item-icon">
                                            {NavIcon && <NavIcon name={item.icon} />}
                                        </span>
                                        <span className="quickbar__item-label">{item.label}</span>
                                        <button
                                            className="quickbar__item-unpin"
                                            onClick={(e) => { e.stopPropagation(); toggleQuickBarItem(item) }}
                                            title="Unpin"
                                            aria-label={`Unpin ${item.label}`}
                                        >
                                            ★
                                        </button>
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <div className="quickbar__empty">
                            <QIconMini size={32} />
                            <span>Pin items from the sidebar</span>
                            <span className="quickbar__empty-hint">Click ☆ next to any nav item</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

function QIconMini({ size = 18 }) {
    const h = size * (740 / 620)
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 740" width={size} height={h}>
            <defs>
                <linearGradient id="qb-grad" x1="0" y1="0" x2="620" y2="0" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
            </defs>
            <g transform="translate(96,30) scale(0.72)">
                <path d="M450.532 359.603L400.532 273C565.532 211.001 473.032 164 488.532 94.5C504.032 25 546.032 0 546.032 0C546.032 0 521.173 49.0536 522.532 85.5C524.38 135.078 577.449 175.548 576.032 227.5C573.947 303.958 450.532 359.603 450.532 359.603Z" fill="url(#qb-grad)" />
                <path d="M125.528 359.603L175.528 273C10.5279 211.001 103.028 164 87.5279 94.5C72.0279 25 30.0279 0 30.0279 0C30.0279 0 54.8869 49.0536 53.5279 85.5C51.6792 135.078 -1.38893 175.548 0.0278679 227.5C2.113 303.958 125.528 359.603 125.528 359.603Z" fill="url(#qb-grad)" />
            </g>
            <g transform="translate(50,200)">
                <path d="M262.181 1.92871C284.097 2.34428 321.484 3.59138 348.179 7.35156C400.234 14.6836 431.354 36.4934 464.679 77.9629C511.474 136.194 506.182 266.278 506.179 266.352H506.035C506.405 278.968 508.307 382.893 472.884 441.409L537.178 497.719L529.178 566.719H427.178L377.932 517.592C368.718 520.411 358.808 522.563 347.994 524.086C321.446 527.825 284.325 529.078 262.361 529.501V529.719C262.361 529.719 258.937 529.716 253.178 529.646C247.426 529.716 244.003 529.719 243.994 529.719V529.501C222.03 529.078 184.909 527.825 158.361 524.086C106.307 516.754 75.1863 494.944 41.8611 453.475C-2.24106 398.594 -0.0773581 279.892 0.320081 266.352H0.181409C0.178448 266.279 -5.11349 136.194 41.6814 77.9629C75.0066 36.4934 106.127 14.6836 158.181 7.35156C184.877 3.59139 222.263 2.34428 244.179 1.92871V1.71875C244.188 1.71875 247.539 1.72075 253.18 1.78809C258.829 1.72067 262.181 1.71875 262.181 1.71875V1.92871ZM253.18 84.8887C211.412 85.2342 162.416 88.5837 138.181 112.352C112.356 137.68 106.629 202.685 106.68 265.086H106.861C106.732 327.871 112.361 393.586 138.361 419.086C162.56 442.819 211.449 446.192 253.178 446.546C269.601 446.407 287.132 445.8 303.832 443.668L234.178 374.181V316.719H330.511L389.933 368.762C395.717 338.812 396.569 301.457 396.494 265.086H396.68C396.771 202.685 394.005 137.68 368.179 112.352C343.945 88.5837 294.949 85.2342 253.18 84.8887Z" fill="url(#qb-grad)" />
            </g>
        </svg>
    )
}

export default QuickBar
