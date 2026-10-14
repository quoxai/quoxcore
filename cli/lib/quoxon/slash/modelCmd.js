/**
 * QUOXON-FW6: the /model favourites, default and chooser behaviour, kept out of app.js.
 *
 * Favourites and the default live in the user's server-side preferences (api.modelPrefs and
 * api.setModelPrefs); this module only holds the in-memory copy (`mp.prefs`) and calls the api to
 * save. Provider parity: nothing here knows one provider from another; the connected list and the
 * live model lists decide what is shown.
 */
import {
  CHOICES,
  connectedChoices,
  providerId,
  choiceId,
  modelLabel,
  normChoice,
} from '../model.js';
import {
  normPrefs,
  addFav,
  rmFav,
  setDefault,
  clearDefault,
  toggleFav,
  favLines,
  liveModels,
  checkModelId,
  chooserItems,
  chooserRow,
  currentKey,
  label,
} from '../modelPrefs.js';
import { clip } from '../theme.js';

/**
 * deps: api, say, command, mc (ref to the stored choice), mp (ref { prefs, touched, warned }),
 * picker, state (ref), bump, cols.
 */
export function createModelCmd({ api, say, command, mc, mp, picker, state, bump, cols }) {
  const byId = (id) => CHOICES.find((x) => x.id === id) || null;
  const current = () => currentKey(mc.current, choiceId);

  /** Optimistic: the in-memory copy changes at once; the server (user preferences) is the truth. */
  async function save(next) {
    mp.current.prefs = next;
    bump();
    if (!api.setModelPrefs) return true;
    const r = await api.setModelPrefs(next);
    if (!r.synced) {
      say(
        `Saved on this machine only (${r.error || 'the server did not take it'}). It is not on ` +
          'the server yet, so it will not follow you to other machines. ' +
          'Making the change again retries.',
        'warn',
      );
    }
    return Boolean(r.synced);
  }

  async function addOrDefault(sub) {
    const pid = providerId(sub.provider);
    if (!pid) {
      const ids = CHOICES.map((x) => x.id).join(', ');
      return say(`No provider called "${sub.provider}". Use ${ids}.`, 'warn');
    }
    // New models appear before lists update: an id missing from the live list is kept, with a
    // warning.
    const live = await liveModels(api, pid);
    const chk = checkModelId(live.ids, sub.model, byId(pid).name);
    const prefs = mp.current.prefs;
    const r =
      sub.kind === 'fav-add' ? addFav(prefs, pid, chk.model) : setDefault(prefs, pid, chk.model);
    if (r.added === false || r.ok === false) return say(r.text, r.tone);
    await save(r.prefs);
    say(clip(r.text, cols() - 4), r.tone);
    if (chk.note) say(clip(chk.note, cols() - 4), 'warn');
    return undefined;
  }

  /**
   * Handles the favourites / default / chooser forms of /model.
   * -> undefined when `sub` (parseModelSub) is not one of them (the caller carries on), else a
   * promise.
   */
  function handle(sub) {
    const prefs = mp.current.prefs;
    switch (sub.kind) {
      case 'error':
        return Promise.resolve(say(sub.text, 'warn'));
      case 'fav-list':
        for (const [t, tone] of favLines(prefs, current())) say(clip(t, cols() - 4), tone);
        return Promise.resolve();
      case 'use': {
        const f = prefs.favourites[sub.n - 1];
        if (f) return command(`/model ${f.provider} ${f.model}`);
        return Promise.resolve(say(`No favourite ${sub.n}. /model fav lists them.`, 'warn'));
      }
      case 'default-show':
        return Promise.resolve(
          say(
            prefs.default
              ? `Default model: ${label(prefs.default)}. New sessions start on it when its ` +
                  'provider is connected. /model default clear removes it.'
              : 'No default model. /model default <provider> <model> sets one ' +
                  '(or press d in the /model chooser).',
          ),
        );
      case 'default-clear': {
        const c = clearDefault(prefs);
        return save(c.prefs).then(() => say(c.text, c.tone));
      }
      case 'fav-rm': {
        const r = rmFav(prefs, sub.ref);
        return (r.removed ? save(r.prefs) : Promise.resolve()).then(() => say(r.text, r.tone));
      }
      case 'fav-add':
      case 'default-set':
        return addOrDefault(sub);
      case 'chooser':
        return openChooser();
      default:
        return undefined;
    }
  }

  /** The /model chooser: favourites first, then each CONNECTED provider's live models. */
  async function openChooser() {
    if (!api.connections) return say('Model choice is not available in this mode.', 'warn');
    const [res, caps] = await Promise.all([
      api.connections(),
      api.capabilities ? api.capabilities() : null,
    ]);
    const conn = connectedChoices(res, caps);
    if (!conn.length) {
      return say(
        res?.ok === false
          ? `Could not read what is connected: ${res.error || 'no answer'}`
          : 'No AI provider is connected yet. /connect openai, /connect anthropic or ' +
              '/connect ollama <url>.',
        'warn',
      );
    }
    const groups = await Promise.all(
      conn.map(async (c) => {
        const l = await liveModels(api, c.id);
        const note = l.ok ? null : 'could not list its models; Enter uses the server default';
        return { id: c.id, name: c.name, ids: l.ids.slice(0, 200), note };
      }),
    );
    const items = () => chooserItems(mp.current.prefs, groups);
    const hidden = () =>
      mp.current.prefs.favourites.filter((f) => !groups.some((g) => g.id === f.provider)).length;
    const title = () => {
      const now = modelLabel(state.current.ctx, mc.current) || 'auto';
      const def = mp.current.prefs.default ? label(mp.current.prefs.default) : 'none';
      const h = hidden();
      const note = h ? ` · ${h} favourite${h === 1 ? '' : 's'} hidden, provider not connected` : '';
      return `Model · current ${now} · default ${def}${note}`;
    };
    picker.open({
      titleFn: title,
      rowsFn: () => items().map((it) => chooserRow(it, mp.current.prefs, current())),
      hint: '↑↓ select · Enter use · f favourite · d default · Esc close',
      onChar: (ch, sel) => {
        if (ch !== 'f' && ch !== 'd') return undefined;
        const it = items()[sel];
        if (!it || !it.model) {
          say('That row has no model to save. Pick a model row.', 'warn');
          return true;
        }
        const m = { provider: it.provider, model: it.model };
        if (ch === 'f') {
          const t = toggleFav(mp.current.prefs, m);
          save(t.prefs);
          say(`${t.added ? 'Added to' : 'Removed from'} favourites: ${label(m)}.`, 'ok');
        } else {
          save(setDefault(mp.current.prefs, m.provider, m.model).prefs);
          say(`Default model: ${label(m)}. New sessions start on it.`, 'ok');
        }
        const next = items();
        const same = (x) =>
          x.kind === it.kind && x.provider === it.provider && x.model === it.model;
        const j = next.findIndex(same);
        return j >= 0 ? j : Math.min(sel, Math.max(0, next.length - 1));
      },
      onPick: (_, i) => {
        const it = items()[i];
        if (it) command(it.model ? `/model ${it.provider} ${it.model}` : `/model ${it.provider}`);
      },
    });
    return undefined;
  }

  /**
   * New sessions start on the saved default model when its provider is connected. A --provider
   * flag, or a /model typed first, wins. A default on a provider that is not connected is said
   * once and nothing changes. -> a cancel function.
   */
  function startOnDefault({ flagged, off, dispatchCtx }) {
    if (!api.modelPrefs || off) return () => {};
    let dead = false;
    (async () => {
      let got = null;
      try {
        got = await api.modelPrefs();
      } catch {
        got = null;
      }
      if (dead || !got) return;
      mp.current.prefs = normPrefs(got.prefs);
      bump();
      const def = mp.current.prefs.default;
      if (!def || flagged || mp.current.touched) return;
      let res = null;
      let caps = null;
      try {
        [res, caps] = await Promise.all([
          api.connections?.(),
          api.capabilities ? api.capabilities() : null,
        ]);
      } catch {
        return; // cannot tell what is connected: stay quiet, the model is unchanged
      }
      if (dead || mp.current.touched || !res || res.ok === false) return;
      const row = byId(def.provider);
      if (!row) return;
      if (!connectedChoices(res, caps).some((c) => c.id === row.id)) {
        if (!mp.current.warned) {
          mp.current.warned = true;
          say(
            `Your default model ${label(def)} is on ${row.name}, which is not connected, so ` +
              `the model is unchanged. /connect ${row.connect} to use it, or ` +
              '/model default clear.',
            'warn',
          );
        }
        return;
      }
      let host = null;
      if (row.dynamic) {
        try {
          const lst =
            row.id === 'ollama' ? await api.ollamaModels?.() : await api.compatModels?.(row.id);
          host = lst?.host || null;
        } catch {
          host = null;
        }
      }
      if (dead || mp.current.touched) return;
      const via = row.via ? { via: row.via } : {};
      const at = host && !row.hosted ? { host } : {};
      mc.current = normChoice({ provider: row.provider, model: def.model, ...via, ...at });
      dispatchCtx();
      bump();
    })();
    return () => {
      dead = true;
    };
  }

  return { handle, openChooser, startOnDefault, save };
}
