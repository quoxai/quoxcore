/**
 * NotesQ suggested links (AQ-9D P5): pure markdown helpers behind the
 * "Suggested links" rail section. Same behaviour as the CLI copy used by
 * `quox notes suggest --link`; keep the two in step.
 */

const MASK = '\u0001';
const FENCE = /^\s*(```|~~~)/;

const blank = (s) => MASK.repeat(s.length);

/** Same-length copy of `markdown` with code, wikilinks and markdown links blanked out, so a scan only sees plain text. */
function maskProtected(markdown) {
  const lines = markdown.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) { inFence = !inFence; return blank(line); }
    if (inFence) return blank(line);
    return line.replace(/(`+)(.+?)\1(?!`)/g, blank);
  });
  return out.join('\n')
    .replace(/\[\[[^\]\n]*\]\]/g, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/^#[ \t]+[^\n]*/m, blank); // the note's own title heading
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn the first plain-text mention of `title` into [[title]].
 * Skips fenced code, inline code, existing [[...]] and [text](url) links.
 * Case-insensitive, whole-word. The matched span is replaced by the title exactly as given.
 * @returns {{markdown:string, changed:boolean}}
 */
export function linkMention(markdown, title) {
  const md = String(markdown ?? '');
  const t = String(title ?? '').trim();
  if (!t) return { markdown: md, changed: false };
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, 'iu');
  const m = re.exec(maskProtected(md));
  if (!m) return { markdown: md, changed: false };
  return { markdown: `${md.slice(0, m.index)}[[${t}]]${md.slice(m.index + m[0].length)}`, changed: true };
}

/**
 * Add `- [[title]]` to the "## See also" section, creating it at the end when absent.
 * An existing identical link in that section leaves the markdown unchanged.
 * @returns {string}
 */
export function addSeeAlso(markdown, title) {
  const md = String(markdown ?? '');
  const link = `[[${String(title ?? '').trim()}]]`;
  const lines = md.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (start === -1) {
      if (/^## See also\s*$/.test(line)) start = i;
    } else if (/^#{1,6}\s/.test(line)) { end = i; break; }
  }
  if (start === -1) {
    const base = md.replace(/\n+$/, '');
    return `${base ? `${base}\n\n` : ''}## See also\n\n- ${link}\n`;
  }
  const section = lines.slice(start + 1, end);
  if (section.some((l) => l.includes(link))) return md;
  let last = start;
  for (let i = end - 1; i > start; i--) { if (lines[i].trim()) { last = i; break; } }
  if (last === start) {
    // Empty section: replace its blank lines with one blank, the link, and one blank before a following heading.
    lines.splice(start + 1, end - start - 1, '', `- ${link}`, '');
    return lines.join('\n');
  }
  lines.splice(last + 1, 0, `- ${link}`);
  return lines.join('\n');
}
