/**
 * Pure NotesQ link helpers (AQ-9D P5). The frontend keeps its own copy and a
 * parity test imports this one, so behaviour here is the contract.
 */

// Blank (same length) every region where a title must not be linked: front
// matter, fenced code, inline code, [[wikilinks]] and [text](url) links.
function maskNonProse(md) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(md || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, blank)
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/!?\[\[[^\]\n]*\]\]/g, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/^#[ \t]+[^\n]*/m, blank); // the note's own title heading
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace the first plain-text, case-insensitive, word-bounded occurrence of
 * `title` with `[[title]]` (the title exactly as given).
 * @returns {{markdown: string, changed: boolean}}
 */
export function linkMention(markdown, title) {
  const md = String(markdown ?? '');
  const t = String(title ?? '').trim();
  if (!t) return { markdown: md, changed: false };
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, 'iu');
  const m = re.exec(maskNonProse(md));
  if (!m) return { markdown: md, changed: false };
  return { markdown: `${md.slice(0, m.index)}[[${t}]]${md.slice(m.index + m[0].length)}`, changed: true };
}

/** Append `- [[title]]` to the `## See also` section, creating it at the end if absent. */
export function addSeeAlso(markdown, title) {
  const md = String(markdown ?? '');
  const link = `[[${title}]]`;
  const item = `- ${link}`;
  const lines = md.split('\n');
  // Lines inside fenced code never count as headings.
  const fenced = [];
  let open = null;
  for (const l of lines) {
    const f = /^\s*(```|~~~)/.exec(l);
    if (open) { fenced.push(true); if (f && f[1] === open) open = null; } else if (f) { fenced.push(true); open = f[1]; } else fenced.push(false);
  }
  const start = lines.findIndex((l, i) => !fenced[i] && /^## See also\s*$/.test(l));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (!fenced[i] && /^#{1,6}\s/.test(lines[i])) { end = i; break; }
    if (lines.slice(start + 1, end).some((l) => l.includes(link))) return md;
    let last = end - 1;
    while (last > start && lines[last].trim() === '') last--;
    lines.splice(last + 1, 0, item);
    return lines.join('\n');
  }
  return `${md.replace(/\n+$/, '')}\n\n## See also\n\n${item}\n`;
}
