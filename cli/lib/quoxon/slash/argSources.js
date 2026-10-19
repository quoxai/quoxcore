/**
 * QUOXON-FW6: the async sources behind registry `args` levels (slash/args.js). Each source reads
 * the same api the command itself uses and returns [{ value, desc? }]. A source may throw; the
 * palette caches that as empty and shows nothing (suggestions fail quietly, never an error row).
 */
import { CHOICES, connectedChoices, providerId } from '../model.js';
import { liveModels } from '../modelPrefs.js';
import { pathItems } from '../slotChat.js';

/** Provider ids /connect understands (one per provider; the subscription has no key). */
export const connectIds = () => [
  ...new Map(
    CHOICES.filter((c) => c.connect).map((c) => [c.connect, { value: c.connect, desc: c.name }]),
  ).values(),
];

export function createArgSources({ api, getPrefs = () => ({ favourites: [], default: null }), getRows = () => [] }) {
  return async function source(src, param) {
    switch (src) {
      case 'providers':
        return connectIds();
      case 'model.connected': {
        if (!api.connections) return [];
        const [res, caps] = await Promise.all([
          api.connections(),
          api.capabilities ? api.capabilities() : null,
        ]);
        return connectedChoices(res, caps).map((c) => ({ value: c.id, desc: c.name }));
      }
      case 'model.models': {
        const id = providerId(param);
        if (!id) return [];
        const l = await liveModels(api, id);
        return l.ids.map((v) => ({ value: v, desc: v === l.def ? 'newest' : '' }));
      }
      case 'model.favs':
        return getPrefs().favourites.map((f, i) => ({
          value: String(i + 1),
          desc: `${f.provider} ${f.model}`,
        }));
      case 'rows':
        return (getRows?.() || []).map((r) => ({ value: r.id, desc: r.source.type }));
      case 'orgs':
        return (await api.orgs()).map((o) => ({ value: o.slug || o.id, desc: o.name || '' }));
      case 'agents':
        return (await api.agents()).map((a) => ({
          value: a.agent_id,
          desc: a.name && a.name !== a.agent_id ? a.name : '',
        }));
      case 'fleetHosts':
        return (await api.objects?.fleetNames?.()) || [];
      case 'conversations':
        return ((await api.conversations?.(15)) || []).map((c) => ({ value: String(c.id), desc: c.title || '' }));
      case 'files': // QUOXON-MESH: /send <slot> <path>; param = the directory part typed so far
        return pathItems(param || '', { cwd: process.cwd() });
      case 'slots':
        return (await api.slots()).map((s) => ({
          value: String(s.name),
          desc: s.holder_session ? `held by ${s.holder_session}` : s.assigned_to ? `for ${s.assigned_to}` : '',
        }));
      default:
        return [];
    }
  };
}
