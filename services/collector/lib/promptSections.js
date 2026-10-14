'use strict';
/**
 * D3: chars per top-level "## " section of a system prompt, for the
 * model.requested envelope. Headers and lengths only, never content.
 * Text before the first header is "(preamble)". Repeated headers add up.
 * At most 40 sections; the rest go into "(other)".
 */
const MAX_SECTIONS = 40;

function promptSections(prompt) {
  const s = typeof prompt === 'string' ? prompt : '';
  const out = {};
  if (!s) return out;
  const re = /(^|\n)## ([^\n]{1,80})/g;
  const marks = [];
  let m;
  while ((m = re.exec(s)) !== null) marks.push({ at: m.index + m[1].length, name: m[2].trim() });
  const add = (name, n) => {
    if (n <= 0) return;
    const key = name in out || Object.keys(out).length < MAX_SECTIONS ? name : '(other)';
    out[key] = (out[key] || 0) + n;
  };
  add('(preamble)', (marks[0] ? marks[0].at : s.length));
  marks.forEach((mk, i) => add(mk.name, (marks[i + 1] ? marks[i + 1].at : s.length) - mk.at));
  return out;
}

module.exports = { promptSections, MAX_SECTIONS };
