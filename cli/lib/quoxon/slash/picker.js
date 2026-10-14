/**
 * A modal list under the composer (the /resume picker, the /config card). While open it takes every key,
 * like the /connect card: Up/Down select, Enter picks, Esc closes, Left/Right/Space go to onAdjust.
 * Typing (any text but a Space the card uses) closes it and goes to the composer, so a slash command typed
 * while it is open runs instead of being read as navigation (R3 D2). onEvent returns false for those keys.
 */
export function createPicker({ refresh = () => {} } = {}) {
  let cur = null; // { title, rows, sel, hint, onPick, onAdjust, onClose, rowsFn }
  const close = () => { const c = cur; cur = null; c?.onClose?.(); refresh(); };
  return {
    isOpen: () => Boolean(cur),
    open(spec) { cur = { sel: 0, ...spec }; refresh(); },
    close,
    rows: () => (cur ? (cur.rowsFn ? cur.rowsFn() : cur.rows) : []),
    onEvent(e) {
      if (!cur) return false;
      const rows = cur.rowsFn ? cur.rowsFn() : cur.rows;
      // onChar(char, sel): a card key such as f or d. true, or a new selection index = handled.
      if (e.type === 'text' && cur.onChar) {
        const r = cur.onChar(e.text, cur.sel);
        if (r === true || typeof r === 'number') {
          if (typeof r === 'number') {
            const n = (cur.rowsFn ? cur.rowsFn() : cur.rows).length;
            cur.sel = Math.max(0, Math.min(r, Math.max(0, n - 1)));
          }
          refresh();
          return true;
        }
      }
      if (e.type === 'paste' || (e.type === 'text' && !(e.text === ' ' && cur.onAdjust))) { close(); return false; } // typing goes to the composer
      if (e.type !== 'key' && !(e.type === 'text' && e.text === ' ')) return true;
      const name = e.type === 'text' ? 'space' : e.name;
      if (name === 'escape' || name === 'ctrl-c') { close(); return true; }
      if (name === 'up' && rows.length) cur.sel = (cur.sel - 1 + rows.length) % rows.length;
      else if (name === 'down' && rows.length) cur.sel = (cur.sel + 1) % rows.length;
      else if ((name === 'left' || name === 'right' || name === 'space') && cur.onAdjust) cur.onAdjust(cur.sel, name === 'left' ? -1 : 1);
      else if (name === 'enter') {
        const c = cur; const pick = rows[c.sel];
        if (c.keepOpen?.(c.sel)) c.onPick?.(pick, c.sel);
        else { cur = null; c.onPick?.(pick, c.sel); }
      }
      refresh();
      return true;
    },
    view() {
      if (!cur) return null;
      const rows = cur.rowsFn ? cur.rowsFn() : cur.rows;
      const max = 10;
      const start = Math.max(0, Math.min(cur.sel - max + 1, rows.length - max));
      const title = cur.titleFn ? cur.titleFn() : cur.title;
      const more = Math.max(0, rows.length - max);
      const view = rows.slice(start, start + max);
      return { title, rows: view, sel: cur.sel - start, more, hint: cur.hint, empty: cur.empty };
    }
  };
}
