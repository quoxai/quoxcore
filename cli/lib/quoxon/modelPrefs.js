/**
 * QUOXON-FW6: model favourites and the default model. Pure helpers plus one quiet live-list reader.
 *
 * The preference is { favourites: [{ provider, model }], default: { provider, model } | null }.
 * `provider` is a /model provider id (openai, anthropic, claude-cli, ollama, a compat preset).
 * Persistence is the caller's (api.modelPrefs / api.setModelPrefs: the user's server-side
 * preferences, with the profile as a cache). There is no model list in this file: ids come from
 * the provider's own live list (liveModels) or from what the user typed. A typed id that is not on
 * the live list is kept with a warning, never refused.
 */
import { CHOICES, CLAUDE_FAMILIES, providerId } from './model.js';

export const MAX_FAVS = 20;
const nameOf = (id) => CHOICES.find((c) => c.id === id)?.name || id;

const cleanOne = (v) => {
  const provider = providerId(v?.provider);
  const model = typeof v?.model === 'string' ? v.model.trim().slice(0, 200) : '';
  return provider && model && !/\s/.test(model) ? { provider, model } : null;
};
export const sameModel = (a, b) =>
  Boolean(a && b) && a.provider === b.provider && a.model === b.model;

/** Anything stored or received -> a clean prefs object (bad rows dropped, duplicates removed). */
export function normPrefs(v) {
  const favs = [];
  for (const f of Array.isArray(v?.favourites) ? v.favourites : []) {
    const c = cleanOne(f);
    if (c && !favs.some((x) => sameModel(x, c)) && favs.length < MAX_FAVS) favs.push(c);
  }
  return { favourites: favs, default: cleanOne(v?.default) };
}

export const label = (m) => `${m.provider} ${m.model}`;

/** -> { prefs, added, text, tone }. */
export function addFav(prefs, provider, model) {
  const c = cleanOne({ provider, model });
  if (!c)
    return { prefs, added: false, text: 'Usage: /model fav add <provider> <model>', tone: 'warn' };
  const at = prefs.favourites.findIndex((f) => sameModel(f, c));
  if (at >= 0)
    return {
      prefs,
      added: false,
      text: `${label(c)} is already favourite ${at + 1}.`,
      tone: 'plain',
    };
  if (prefs.favourites.length >= MAX_FAVS)
    return {
      prefs,
      added: false,
      text: `You have ${MAX_FAVS} favourites already. /model fav rm <n> makes room.`,
      tone: 'warn',
    };
  const next = { ...prefs, favourites: [...prefs.favourites, c] };
  const n = next.favourites.length;
  return {
    prefs: next,
    added: true,
    text: `Added ${label(c)} as favourite ${n}. /model ${n} switches to it.`,
    tone: 'ok',
  };
}

/**
 * ref = a 1-based number, or a model id (exact, "provider model", "provider/model", or a
 * unique substring).
 */
export function rmFav(prefs, ref) {
  const q = String(ref ?? '')
    .trim()
    .toLowerCase();
  const favs = prefs.favourites;
  if (!q) return { prefs, removed: null, text: 'Usage: /model fav rm <n|model>', tone: 'warn' };
  let idx = -1;
  if (/^\d+$/.test(q)) idx = Number(q) - 1;
  else {
    const exact = favs
      .map((f, i) => i)
      .filter(
        (i) =>
          favs[i].model.toLowerCase() === q ||
          label(favs[i]).toLowerCase() === q ||
          `${favs[i].provider}/${favs[i].model}`.toLowerCase() === q,
      );
    const part = favs.map((f, i) => i).filter((i) => favs[i].model.toLowerCase().includes(q));
    const hits = exact.length ? exact : part;
    if (hits.length > 1)
      return {
        prefs,
        removed: null,
        text:
          `"${ref}" matches ${hits.map((i) => `${i + 1} ${label(favs[i])}`).join(', ')}. ` +
          'Use the number.',
        tone: 'warn',
      };
    idx = hits.length ? hits[0] : -1;
  }
  if (idx < 0 || idx >= favs.length)
    return {
      prefs,
      removed: null,
      text: favs.length
        ? `No favourite "${ref}". /model fav lists them.`
        : 'You have no favourites yet. /model fav add <provider> <model>',
      tone: 'warn',
    };
  const removed = favs[idx];
  return {
    prefs: { ...prefs, favourites: favs.filter((_, i) => i !== idx) },
    removed,
    text: `Removed ${label(removed)}. The numbers after it moved up by one.`,
    tone: 'ok',
  };
}

export function setDefault(prefs, provider, model) {
  const c = cleanOne({ provider, model });
  if (!c)
    return { prefs, ok: false, text: 'Usage: /model default <provider> <model>', tone: 'warn' };
  return {
    prefs: { ...prefs, default: c },
    ok: true,
    text:
      `Default model: ${label(c)}. New sessions start on it when ${nameOf(c.provider)} is ` +
      `connected. /model ${label(c)} uses it now.`,
    tone: 'ok',
  };
}
export const clearDefault = (prefs) => ({
  prefs: { ...prefs, default: null },
  text: 'Default model cleared. New sessions use the last choice, else the server policy.',
  tone: 'ok',
});

/** Toggle one model in the favourites -> { prefs, added }. */
export function toggleFav(prefs, m) {
  const i = prefs.favourites.findIndex((f) => sameModel(f, m));
  if (i >= 0)
    return {
      prefs: { ...prefs, favourites: prefs.favourites.filter((_, k) => k !== i) },
      added: false,
    };
  return {
    prefs: {
      ...prefs,
      favourites: [...prefs.favourites, { provider: m.provider, model: m.model }].slice(
        0,
        MAX_FAVS,
      ),
    },
    added: true,
  };
}

/** /model fav lines. `current` = the stored choice ({ provider, model?, via? }) or null. */
export function favLines(prefs, currentKey = null) {
  if (!prefs.favourites.length)
    return [
      [
        'No favourites yet. Add one: /model fav add <provider> <model> ' +
          '(or open /model and press f)',
      ],
    ];
  const out = [['Favourite models (/model <n> switches):']];
  prefs.favourites.forEach((f, i) => {
    const marks = [
      currentKey && sameModel(f, currentKey) ? 'current' : null,
      prefs.default && sameModel(f, prefs.default) ? 'default' : null,
    ].filter(Boolean);
    out.push([`  ${i + 1}  ${label(f)}${marks.length ? `  (${marks.join(', ')})` : ''}`, 'plain']);
  });
  out.push([
    prefs.default
      ? `Default: ${label(prefs.default)}`
      : 'No default model set. /model default <provider> <model>',
  ]);
  return out;
}

const FAV_WORDS = new Set(['fav', 'favs', 'favourite', 'favourites', 'favorite', 'favorites']);
const SUBS_ONE = { list: 'list', status: 'list' };

/**
 * The words after /model -> what to do. kinds: chooser list use fav-list fav-add fav-rm
 * default-show default-set default-clear error pass.
 */
export function parseModelSub(arg) {
  const w = String(arg || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!w.length) return { kind: 'chooser' };
  const first = w[0].toLowerCase();
  if (SUBS_ONE[first] && w.length === 1) return { kind: SUBS_ONE[first] };
  if (/^\d+$/.test(first) && w.length === 1) return { kind: 'use', n: Number(first) };
  if (FAV_WORDS.has(first)) {
    const sub = (w[1] || '').toLowerCase();
    if (!sub) return { kind: 'fav-list' };
    if (/^\d+$/.test(sub) && w.length === 2) return { kind: 'use', n: Number(sub) };
    if (sub === 'add') {
      if (w.length !== 4)
        return {
          kind: 'error',
          text:
            'Usage: /model fav add <provider> <model>   ' +
            'e.g. /model fav add openai gpt-5.6-terra',
        };
      return { kind: 'fav-add', provider: w[2], model: w[3] };
    }
    if (['rm', 'remove', 'del', 'delete'].includes(sub))
      return w.length < 3
        ? { kind: 'error', text: 'Usage: /model fav rm <n|model>' }
        : { kind: 'fav-rm', ref: w.slice(2).join(' ') };
    return {
      kind: 'error',
      text: 'Usage: /model fav [add <provider> <model> | rm <n|model> | <n>]',
    };
  }
  if (first === 'default') {
    if (w.length === 1) return { kind: 'default-show' };
    if (w.length === 2 && ['clear', 'none', 'off', 'unset'].includes(w[1].toLowerCase()))
      return { kind: 'default-clear' };
    if (w.length === 3) return { kind: 'default-set', provider: w[1], model: w[2] };
    return { kind: 'error', text: 'Usage: /model default [<provider> <model> | clear]' };
  }
  return { kind: 'pass' };
}

/**
 * A provider's list response (the shape differs per provider) -> ids, newest first as the
 * server gave them.
 */
export function idsOf(choiceId, res) {
  if (choiceId === 'claude-cli') return [...CLAUDE_FAMILIES];
  if (!res?.ok || !Array.isArray(res.models)) return [];
  const raw =
    choiceId === 'ollama'
      ? res.models.map((m) => (typeof m === 'string' ? m : m?.name))
      : res.models.map((m) => (typeof m === 'string' ? m : m?.id));
  return raw.filter((x) => typeof x === 'string' && x);
}

/**
 * The live model ids for one provider, never throws. -> { ok, ids, def }. ok=false means
 * "could not list" (the caller decides how quiet to be); ids is [] then.
 */
export async function liveModels(api, id, { refresh = false } = {}) {
  try {
    if (id === 'claude-cli') return { ok: true, ids: [...CLAUDE_FAMILIES], def: null };
    const row = CHOICES.find((c) => c.id === id);
    if (!row) return { ok: false, ids: [], def: null };
    let res = null;
    if (id === 'ollama') res = await api.ollamaModels?.();
    else if (row.compat) res = await api.compatModels?.(id);
    else if (row.discover)
      res = await api.providerModels?.(row.provider, refresh ? { refresh: true } : undefined);
    if (!res?.ok) return { ok: false, ids: [], def: null };
    return { ok: true, ids: idsOf(id, res), def: res.default_model || null };
  } catch {
    return { ok: false, ids: [], def: null };
  }
}

/**
 * Typed id vs the live list -> { model, known: true|false|null, note? }. null = no list to
 * check against.
 */
export function checkModelId(ids, typed, providerName = '') {
  if (!ids?.length) return { model: typed, known: null };
  if (ids.includes(typed)) return { model: typed, known: true };
  const ci =
    ids.find((i) => i.toLowerCase() === typed.toLowerCase()) ||
    ids.find((i) => i === `${typed}:latest`);
  if (ci) return { model: ci, known: true };
  return {
    model: typed,
    known: false,
    note:
      `${typed} is not on ${providerName || 'the provider'}'s live list right now; ` +
      'kept as typed in case it is new.',
  };
}

/* ---- the /model chooser ---------------------------------------------------------- */

/**
 * Selectable items, in display order: favourites first (numbered by their place in the full
 * list; ones on a provider that is not connected are left out), then each connected provider's
 * models.
 * groups: [{ id, name, ids, note? }] for CONNECTED providers only.
 */
export function chooserItems(prefs, groups) {
  const connected = new Set(groups.map((g) => g.id));
  const items = [];
  prefs.favourites.forEach((f, i) => {
    if (connected.has(f.provider))
      items.push({ kind: 'fav', n: i + 1, provider: f.provider, model: f.model });
  });
  for (const g of groups) {
    if (!g.ids.length)
      items.push({
        kind: 'provider',
        provider: g.id,
        model: null,
        name: g.name,
        note: g.note || 'no model list; the server picks',
      });
    else
      for (const id of g.ids)
        items.push({ kind: 'model', provider: g.id, model: id, name: g.name });
  }
  return items;
}

/**
 * One picker row ({ key, text, note? }) for an item. `current` = { provider, model } of the
 * stored choice, or null.
 */
export function chooserRow(item, prefs, current) {
  if (item.kind === 'provider')
    return { key: item.provider, text: item.name, note: item.note, dim: false };
  const here = current && current.model ? sameModel(current, item) : false;
  const marks = [
    here ? 'current' : null,
    prefs.default && sameModel(prefs.default, item) ? 'default' : null,
    item.kind === 'model' && prefs.favourites.some((f) => sameModel(f, item)) ? '★' : null,
  ].filter(Boolean);
  const body = item.kind === 'fav' ? label(item) : item.model;
  return {
    key: item.kind === 'fav' ? `★ ${item.n}` : item.provider,
    text: body + (marks.length ? `   ${marks.join(' · ')}` : ''),
  };
}

/**
 * The stored choice as { provider: <CHOICES id>, model } for marking; null when it carries no
 * model.
 */
export function currentKey(choice, idOf) {
  if (!choice?.model) return null;
  const provider = idOf(choice);
  return provider ? { provider, model: choice.model } : null;
}
