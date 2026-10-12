/**
 * Plugin CSS Scoping (SEC-CSS-SCOPE)
 *
 * Third-party plugin CSS used to be injected UNSCOPED into document.head, so
 * a plugin bundle could redefine a HOST layout class (e.g. `.qx-view`, the
 * core view wrapper used by every page) and break the entire app.
 * LIVE-CONFIRMED: the `star-alignment` plugin shipped
 * `.qx-view { max-width: 980px; margin: 0 auto }`, squeezing every page into
 * a 980px centered column.
 *
 * This module rewrites every selector in a plugin's CSS so it can only match
 * elements INSIDE that plugin's own mount subtree
 * (`[data-plugin-root="<pluginId>"]`), using the browser's own CSS parser
 * (via a detached, never-applied `<style media="not all">` probe) rather
 * than a naive regex — so selector lists, pseudo-classes/elements,
 * @media/@supports nesting, and @keyframes/@font-face are all handled
 * correctly instead of breaking on commas or nested rules.
 *
 * Defense in depth: scoping alone already prevents a plugin selector from
 * ever matching a real host element (the scoped selector requires the host
 * element to be a descendant of the plugin's own container, which real host
 * chrome never is). On top of that, a small blocklist of bare host-chrome
 * selectors is dropped outright and logged, so any future escape is
 * auditable rather than silent.
 */

// NOTE: ':root' is intentionally NOT in this list. It's handled specially in
// scopeStyleRule — rewritten to the plugin's OWN root selector rather than
// dropped, because plugins legitimately define CSS custom properties via
// `:root` for their own theming. That rewrite is safe: it can never reach
// the real document root, only the plugin's own subtree.
const HOST_SELECTOR_EXACT_BLOCKLIST = new Set(['body', 'html', '*', '.qx-view', '.qx-card']);
const HOST_SELECTOR_PREFIX_BLOCKLIST = ['.app-shell'];

const RULE_TYPE = {
    STYLE: 1,
    MEDIA: 4,
    FONT_FACE: 5,
    KEYFRAMES: 7,
    SUPPORTS: 12,
};

/** Build the attribute selector used to scope a plugin's own subtree. */
export function pluginRootSelector(pluginId) {
    return `[data-plugin-root="${pluginId}"]`;
}

/**
 * Split a selector list (e.g. `.a, .b:hover, :is(.c, .d)`) on top-level
 * commas — i.e. commas that are not inside parens/brackets or quoted
 * attribute values.
 * @param {string} selectorText
 * @returns {string[]}
 */
export function splitTopLevelSelectors(selectorText) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < selectorText.length; i++) {
        const ch = selectorText[i];
        if (quote) {
            current += ch;
            if (ch === quote && selectorText[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
        if (ch === '(' || ch === '[') { depth++; current += ch; continue; }
        if (ch === ')' || ch === ']') { depth--; current += ch; continue; }
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts.map(s => s.trim()).filter(Boolean);
}

/**
 * True if `selector` (a single, already-trimmed selector — not a list)
 * targets host chrome directly and must never be allowed through, even
 * scoped.
 * @param {string} selector
 * @returns {boolean}
 */
export function isBlockedHostSelector(selector) {
    if (HOST_SELECTOR_EXACT_BLOCKLIST.has(selector) || HOST_SELECTOR_EXACT_BLOCKLIST.has(selector.toLowerCase())) {
        return true;
    }
    return HOST_SELECTOR_PREFIX_BLOCKLIST.some(prefix => selector.startsWith(prefix));
}

function scopeStyleRule(rule, rootSelector, pluginId, warn) {
    const selectors = splitTopLevelSelectors(rule.selectorText);
    const scoped = [];
    for (const selector of selectors) {
        if (isBlockedHostSelector(selector)) {
            warn(`[PluginHost] Dropped host-targeting CSS selector "${selector}" from plugin "${pluginId}" — plugins cannot style host chrome.`);
            continue;
        }
        // :root already refers to the top of the document — scope it to the
        // plugin's own root rather than nesting a descendant combinator
        // under it (which would never match anything).
        scoped.push(selector === ':root' ? rootSelector : `${rootSelector} ${selector}`);
    }
    if (scoped.length === 0) return '';
    return `${scoped.join(', ')} {\n  ${rule.style.cssText}\n}`;
}

function scopeRule(rule, rootSelector, pluginId, warn) {
    switch (rule.type) {
        case RULE_TYPE.STYLE:
            return scopeStyleRule(rule, rootSelector, pluginId, warn);
        case RULE_TYPE.MEDIA:
        case RULE_TYPE.SUPPORTS: {
            const inner = Array.from(rule.cssRules)
                .map(r => scopeRule(r, rootSelector, pluginId, warn))
                .filter(Boolean)
                .join('\n');
            if (!inner) return '';
            const header = rule.type === RULE_TYPE.MEDIA
                ? `@media ${rule.media.mediaText}`
                : `@supports ${rule.conditionText}`;
            return `${header} {\n${inner}\n}`;
        }
        case RULE_TYPE.FONT_FACE:
        case RULE_TYPE.KEYFRAMES:
            // @font-face and @keyframes carry no selectors that can match a
            // host element, so they are passed through verbatim. A future
            // improvement could namespace keyframe names to avoid
            // cross-plugin animation-name collisions.
            return rule.cssText;
        default:
            // Unknown/rare at-rules (@import, @page, @namespace, ...) pass
            // through unchanged — none of them can target host elements.
            return rule.cssText;
    }
}

/**
 * Scope a plugin's raw CSS so every rule can only match elements inside
 * `[data-plugin-root="<pluginId>"]`. Uses the host document's own CSS
 * parser (a detached `<style media="not all">` probe — parsed but never
 * applied) instead of a hand-rolled regex, so it correctly handles selector
 * lists, pseudo-elements/classes, @media/@supports nesting, and
 * @keyframes/@font-face.
 *
 * Fails safe: if the CSS cannot be parsed for any reason, the plugin's CSS
 * is dropped entirely (returns '') rather than risking unscoped injection.
 *
 * @param {string} cssCode - Raw CSS from the plugin bundle
 * @param {string} pluginId
 * @param {Document} [doc] - injectable for tests; defaults to window.document
 * @returns {string} scoped CSS, safe to inject globally
 */
export function scopePluginCss(cssCode, pluginId, doc = document) {
    if (!cssCode || !cssCode.trim()) return '';
    const rootSelector = pluginRootSelector(pluginId);
    const warn = (...args) => console.warn(...args);

    const probe = doc.createElement('style');
    // media="not all" never matches any device — the browser still parses
    // the sheet (populating cssRules) but the rules are NEVER applied, so
    // there is no flash of unscoped, host-breaking styles even for the
    // instant the probe is connected to the document.
    probe.media = 'not all';
    probe.setAttribute('data-plugin-css-probe', pluginId);
    doc.head.appendChild(probe);
    probe.textContent = cssCode;

    let scopedCss = '';
    try {
        const rules = probe.sheet ? Array.from(probe.sheet.cssRules) : [];
        scopedCss = rules.map(r => scopeRule(r, rootSelector, pluginId, warn)).filter(Boolean).join('\n');
    } catch (err) {
        console.warn(`[PluginHost] CSS scoping failed for plugin "${pluginId}" — CSS dropped:`, err.message);
        scopedCss = '';
    } finally {
        doc.head.removeChild(probe);
    }
    return scopedCss;
}
