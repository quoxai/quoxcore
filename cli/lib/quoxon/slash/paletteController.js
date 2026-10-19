/**
 * The palette's key handling, kept out of app.js. The palette is not modal: it shows while the draft is
 * a bare `/word`, and only Up, Down, Tab, Enter and Esc go to it. Everything else is ordinary typing,
 * which narrows the list because the draft IS the filter.
 */
import { findEntry } from '../commands.js';
import { signedOutNotice } from '../sessionDead.js';
import { paletteQuery, paletteItems, filterPalette, completion, paletteView, PALETTE_MAX } from './palette.js';
import { argContext, levelFor, staticItems, rankArgs, applyArg } from './args.js';
import { mentionContext, rankMentions, applyMention } from '../mentions.js';

const ARG_TTL = 30000;      // a fetched list is reused this long
const ARG_FAIL_TTL = 8000;  // a failed fetch is quiet (no rows) and retried after this

const startsLike = (q, it) => {
  const w = String(q || '').toLowerCase().replace(/^\//, '');
  return [it.name, ...(it.aliases || [])].some(n => String(n).toLowerCase().replace(/^\//, '').startsWith(w));
};

export function createPalette({
  getDraft, setDraft, run, say, ctx = () => ({}), source = null, refresh = () => {}, now = Date.now,
  mentions = null // MENTIONS: { cache (mentions.js createMentionCache), local: () => receipt items }
}) {
  const st = { sel: 0, q: null, dismissed: null, picked: false, aq: null, mq: null };
  const cache = new Map(); // 'src:param' -> { at, ttl, items, pending }
  /** Cached items for an async source; fetches when missing or stale. Never throws or blocks. */
  const fetchItems = (src, param) => {
    if (!source) return [];
    const key = `${src}:${param ?? ''}`;
    const hit = cache.get(key);
    if (hit && (hit.pending || now() - hit.at < hit.ttl)) return hit.items;
    const ent = { at: now(), ttl: ARG_TTL, items: hit?.items ?? [], pending: true };
    cache.set(key, ent);
    Promise.resolve().then(() => source(src, param)).then(
      (items) => {
        ent.items = Array.isArray(items) ? items : [];
        ent.at = now(); ent.pending = false;
      },
      () => { ent.items = []; ent.ttl = ARG_FAIL_TTL; ent.at = now(); ent.pending = false; }
    ).then(() => refresh());
    return ent.items;
  };
  /** The argument suggestions for the current draft, or null when it is not at an argument. */
  const argState = () => {
    const d = getDraft();
    const cx = argContext(d);
    if (!cx) return null;
    const lv = levelFor(cx.entry, cx.words);
    if (!lv) return null;
    const param = lv.of === 'partial' ? cx.partial.slice(0, cx.partial.lastIndexOf('/') + 1) : lv.of != null ? cx.words[lv.of] : undefined; // 'partial': the directory typed so far (QUOXON-MESH /send paths)
    const items = [...staticItems(lv), ...(lv.src ? fetchItems(lv.src, param) : [])];
    const rows = rankArgs(items, cx.partial);
    const key = d.slice(0, cx.start) + '\u0000' + cx.partial;
    if (key !== st.aq) { st.aq = key; st.sel = 0; st.picked = false; }
    return { cx, rows };
  };
  const argOpen = () => {
    const d = getDraft();
    if (st.dismissed !== null && st.dismissed !== d) st.dismissed = null;
    if (st.dismissed === d) return null;
    const a = argState();
    return a && a.rows.length ? a : null;
  };
  /** MENTIONS: the @word at the end of the draft and its ranked rows from the session cache, or null. */
  const mentionOpen = () => {
    if (!mentions) return null;
    const d = getDraft();
    const cx = mentionContext(d);
    if (!cx) return null;
    if (st.dismissed !== null && st.dismissed !== d) st.dismissed = null;
    if (st.dismissed === d) return null;
    const rows = rankMentions([...mentions.cache.items(), ...(mentions.local?.() || [])], cx.partial);
    const key = d.slice(0, cx.start) + '\u0000' + cx.partial;
    if (key !== st.mq) { st.mq = key; st.sel = 0; st.picked = false; }
    return rows.length ? { cx, rows } : null;
  };
  const rows = () => {
    const q = paletteQuery(getDraft());
    if (q !== st.q) { st.q = q; st.sel = 0; st.picked = false; }
    return q === null ? [] : filterPalette(paletteItems(ctx()), q);
  };
  const isOpen = () => {
    const d = getDraft();
    if (st.dismissed !== null && st.dismissed !== d) st.dismissed = null;
    if (paletteQuery(d) === null) return argOpen() !== null || mentionOpen() !== null;
    return st.dismissed !== d;
  };
  /** MENTIONS keys: Up/Down choose, Tab or Enter accept, Esc closes. */
  function onMentionKey(name, m) {
    const n = m.rows.length;
    switch (name) {
      case 'up': st.sel = (st.sel - 1 + n) % n; st.picked = true; return true;
      case 'down': st.sel = (st.sel + 1) % n; st.picked = true; return true;
      case 'escape': st.dismissed = getDraft(); return true;
      case 'tab': case 'enter': setDraft(applyMention(getDraft(), m.cx, m.rows[Math.min(st.sel, n - 1)].value)); return true;
      default: return false;
    }
  }
  /** -> true when the key was the palette's. */
  function onArgKey(name, a) {
    const n = a.rows.length;
    switch (name) {
      case 'up': st.sel = (st.sel - 1 + n) % n; st.picked = true; return true;
      case 'down': st.sel = (st.sel + 1) % n; st.picked = true; return true;
      case 'escape': st.dismissed = getDraft(); return true;
      case 'tab': case 'enter': {
        if (name === 'enter' && !st.picked) return false; // Enter sends what was typed
        const it = a.rows[Math.min(st.sel, n - 1)];
        setDraft(applyArg(getDraft(), a.cx, it.value));
        return true;
      }
      default: return false;
    }
  }
  function onKey(name) {
    if (!isOpen()) return false;
    if (paletteQuery(getDraft()) === null) { const a = argOpen(); return a ? onArgKey(name, a) : onMentionKey(name, mentionOpen()); }
    const list = rows();
    switch (name) {
      case 'up': if (!list.length) return false; st.sel = (st.sel - 1 + list.length) % list.length; st.picked = true; return true;
      case 'down': if (!list.length) return false; st.sel = (st.sel + 1) % list.length; st.picked = true; return true;
      case 'escape': st.dismissed = getDraft(); return true;
      case 'tab': {
        const it = list[st.sel];
        if (!it) return true;
        setDraft(completion(it));
        return true;
      }
      case 'enter': {
        const typed = findEntry(getDraft());
        if (typed && typed.kind === 'command') return false; // an exact command runs as typed (planned ones say so)
        const it = list[st.sel];
        if (!it) return false; // nothing matches: the normal path says "Unknown command"
        // A loose (subsequence) match only runs when the user chose it with the arrows. Typing an unknown
        // word and pressing Enter must not run some other command (z2h: "/hat" ran /approvals).
        if (!st.picked && !startsLike(st.q, it)) return false;
        if (it.disabled) { say(signedOutNotice(it.name, it.disabled), 'warn'); return true; }
        setDraft('');
        run(it.name);
        return true;
      }
      default: return false;
    }
  }
  function view() {
    if (paletteQuery(getDraft()) === null) {
      const a = argOpen();
      if (!a) {
        const mo = mentionOpen();
        if (!mo) return { rows: [], sel: 0, more: 0, empty: null, hint: null };
        const mv = paletteView(mo.rows, st.sel, PALETTE_MAX);
        return { rows: mv.rows.map(it => ({ key: `@${it.value}`, text: `${it.kind}${it.label ? ` · ${it.label}` : ''}` })), sel: mv.sel, more: mv.more, empty: null, hint: '↑↓ select · Tab or Enter accept · Esc close' };
      }
      const v = paletteView(a.rows, st.sel, PALETTE_MAX);
      const rows = v.rows.map(it => ({ key: it.value, text: it.desc || '' }));
      const hint = '↑↓ select · Tab complete · Esc close';
      return { rows, sel: v.sel, more: v.more, empty: null, hint };
    }
    const list = rows();
    const v = paletteView(list, st.sel, PALETTE_MAX);
    return {
      rows: v.rows.map(it => ({ key: it.name, text: (it.aliases.length ? `(also ${it.aliases.join(', ')}) ` : '') + it.desc, dim: Boolean(it.disabled), note: it.disabled || null })),
      sel: v.sel, more: v.more,
      empty: 'No command matches. Enter sends it anyway; /help lists everything.',
      hint: '↑↓ select · Tab complete · Enter run · Esc close'
    };
  }
  return { isOpen, onKey, view, state: st };
}
