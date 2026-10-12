import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared popout-menu portal (QUOXPLAN-UIFIX, owner's SECOND report on menu
 * clipping — every `.qx-menu` in the plugin must escape its panel).
 *
 * Root cause (see QuoxPlanView.jsx's original RoadmapSwitcher comment): most
 * popouts live inside a `.qx-card`, and `.qx-card` sets `overflow: hidden`
 * app-wide so its rounded corners/inset shadow clip cleanly — which also
 * clips any absolutely-positioned popover anchored inside one. Rather than
 * loosening `.qx-card` globally, every popout menu is portaled straight to
 * `document.body` with `position: fixed` coordinates computed from the
 * anchor's `getBoundingClientRect()`, extracted here from the pattern
 * RoadmapSwitcher/ScopeSelector already used so every other popout in
 * QuoxPlan (chip menus, phase row menu, version-history dropdown, dependency
 * combobox, ...) can share one implementation.
 *
 * Positions below the anchor by default, flips above it if there isn't
 * enough room below (and there is room above), flips its left edge to the
 * anchor's right edge if it would overflow the viewport's right edge, and
 * repositions on scroll (capture, so it catches scrollable ancestors) and
 * resize while open. Closes on outside click or Escape.
 *
 * `anchorRef` must point at the element the menu is positioned from, and
 * whose subtree is exempt from the outside-click close — usually a wrapping
 * div around the trigger button/input (the existing `.qxp-menu-anchor`
 * convention).
 */
export default function PortalMenu({
  open,
  onClose,
  anchorRef,
  className = '',
  minWidth,
  matchAnchorWidth = false,
  style,
  children
}) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open) return undefined;

    function reposition() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const menuEl = menuRef.current;
      const menuHeight = menuEl?.offsetHeight || 0;
      const menuWidth = menuEl?.offsetWidth || minWidth || rect.width;

      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const flipUp = spaceBelow < menuHeight + 12 && spaceAbove > spaceBelow;
      const top = flipUp ? Math.max(6, rect.top - menuHeight - 6) : rect.bottom + 6;

      const overflowsRight = rect.left + menuWidth > window.innerWidth - 8;
      const left = overflowsRight ? Math.max(8, rect.right - menuWidth) : rect.left;

      setPos({ top, left, width: matchAnchorWidth ? rect.width : undefined });
    }

    reposition();
    // Menu height/width aren't known until the portaled content has
    // rendered/measured once, so recompute a frame later to account for it
    // on the very first open (avoids a 1-open flash near viewport edges).
    const raf = requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, anchorRef, minWidth, matchAnchorWidth]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (anchorRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`qx-menu ${className}`.trim()}
      style={{
        position: 'fixed',
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? 'visible' : 'hidden',
        minWidth,
        width: pos?.width,
        zIndex: 'var(--m-z-dropdown)',
        ...style
      }}
    >
      {children}
    </div>,
    document.body
  );
}
