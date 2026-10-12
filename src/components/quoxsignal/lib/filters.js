/**
 * The filters allowed on the Feed's main surface: source, stage, topic,
 * unread (the standalone app's original P1 UX brief), plus free-text search
 * and the discard/show-discarded toggle added for SIGNAL-UX. Pure functions
 * so the narrowing logic is testable without mounting a component. Ported
 * (and extended) from quox-signal/web/src/lib/filters.js.
 */

/** Unique source labels present across a list of items, for the source filter's options. */
export function sourceOptions(items) {
  return [...new Set(items.map((i) => i.source_label).filter(Boolean))].sort();
}

/** Unique topics drawn from every item's triage.topics, for the topic filter's options. */
export function topicOptions(items) {
  const topics = new Set();
  for (const item of items) {
    for (const t of item.triage?.topics || []) topics.add(t);
  }
  return [...topics].sort();
}

/**
 * Narrows `items` by the four original filters plus two additions: free-text
 * search (`q`) and the discard toggle (`showDiscarded`).
 * `filters` is { source, stage, topic, unread, q, showDiscarded }, all
 * optional/falsy meaning "no filter". `isRead(id)` resolves the client-only
 * read/unread view state (see lib/readState.js), `isDiscarded(id)` resolves
 * the client-only discard view state (see lib/discardState.js) — both passed
 * in rather than imported so this stays a pure function for tests.
 */
export function filterItems(items, filters = {}, isRead = () => true, isDiscarded = () => false) {
  const { source, stage, topic, unread, q, showDiscarded, hideText } = filters;
  const needle = (q || '').trim().toLowerCase();
  return items.filter((item) => {
    if (source && item.source_label !== source) return false;
    if (stage && item.stage !== stage) return false;
    if (topic && !(item.triage?.topics || []).includes(topic)) return false;
    if (unread && isRead(item.id)) return false;
    // Text-native items (server flag: engine json:source) stay visible by
    // default but can be muted so ASR output is not drowned by feed text.
    if (hideText && item.text_native) return false;
    // Discarded items stay out of the working view by default — never
    // deleted, just filtered — until the owner explicitly asks to see them.
    if (!showDiscarded && isDiscarded(item.id)) return false;
    if (needle) {
      const haystack = [item.title, item.source_label, item.text]
        .filter(Boolean)
        .join(' \n ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
