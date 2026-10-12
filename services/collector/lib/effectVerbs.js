'use strict';
/**
 * QUOXTRUST — the ONE effect-verb classifier (WP2/D3 bridge broadening).
 *
 * Boundary-anchored EFFECT verbs. Read verbs (list/view/get/search/inspect/
 * check/status/posture) are deliberately EXCLUDED: a name carrying only a read
 * verb is not an effect. Extracted 2026-09-28 from
 * test/w-t9-effect-coverage.test.js (which now consumes THIS module) so the
 * connector bridge's durable-intent gate and the coverage invariant share one
 * source of truth — a verb added here is simultaneously ledger-gated at the
 * bridge and swept by the invariant; they cannot drift apart.
 *
 * The regex is a NAMING heuristic, not a no-bypass proof (codex M3): native
 * tools use the reviewed externalEffect flag; this classifier covers the
 * connector namespace where names are the only pre-execution signal and every
 * call is by definition outward to a provider.
 */

const EFFECT_VERB_RE = /(^|[_.])(add|create|update|delete|remove|move|edit|save|import|deploy|dispatch|execute|activate|deactivate|start|stop|restart|reboot|shutdown|kill|approve|deny|revoke|bind|unbind|assign|halt|post|repost|send|pay|upload|backup|rollback|manage|bundle|revive|generate|grant|reissue|publish|reply|comment|restore|forget|apply)(_|$|\.)/i;

function isEffectVerbName(name) {
  return EFFECT_VERB_RE.test(String(name || ''));
}

/**
 * QUOXTRUST F5 (FND_01M3R1TYXZW516YN6TNGW516YN) — classify a PLUGIN tool as a
 * read or an effect for the default approval gate. A plugin declares an intent
 * ('read' | 'effect') at registration; this is the SERVER-SIDE authority that
 * decides what actually happens, so a plugin's own label can only ADD restriction,
 * never remove it (T9: plugin-authored labels never grant authority):
 *
 *   - an effect-VERB name is always an effect, whatever the plugin declared
 *     (a plugin cannot label `delete_account` a "read" to skip approval);
 *   - a declared 'read' (non-effect-verb name) is honoured as a read;
 *   - a declared 'effect' is an effect;
 *   - UNDECLARED is an effect (fail-safe) — a plugin that wants a read ungated
 *     must say so.
 *
 * @param {{ baseName?: string, declared?: string }} p
 * @returns {'read'|'effect'}
 */
function classifyPluginToolEffect({ baseName, declared } = {}) {
  if (isEffectVerbName(baseName)) return 'effect';       // label can never downgrade
  const d = typeof declared === 'string' ? declared.toLowerCase() : null;
  if (d === 'read') return 'read';
  if (d === 'effect') return 'effect';
  return 'effect';                                        // undeclared → fail-safe
}

module.exports = { EFFECT_VERB_RE, isEffectVerbName, classifyPluginToolEffect };
