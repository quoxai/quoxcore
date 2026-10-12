/**
 * The platform a thing came from, as a mark.
 *
 * WHY this replaces a generic placeholder glyph: thumbnails are captured for 95% of social
 * items (TikTok 40/41, YouTube 13/14 on the live dataset) and for 0% of web feed items,
 * because an RSS or JSON entry frequently carries no per-item image and never will. So the
 * empty state is not "not captured yet" for those sources, it is permanent. A picture-frame
 * glyph in that slot says "an image is missing", which is wrong and slightly alarming; the
 * source mark says "this came from a newsletter", which is true and useful at a glance.
 *
 * Deliberately drawn here rather than pulled from a logo pack: real brand logos carry
 * trademark and colour-usage rules that a dashboard should not casually breach, and an
 * offline SVG has no network cost. These are recognisable silhouettes and a lettermark, not
 * facsimiles of the official logos.
 */

const MARKS = {
  tiktok: { label: 'TikTok', color: '#25f4ee', text: '♪' },
  youtube: { label: 'YouTube', color: '#ff4e45', text: '▶' },
  instagram: { label: 'Instagram', color: '#e1306c', text: '◎' },
  web: { label: 'Web feed', color: '#38bdf8', text: '≋' },
  json: { label: 'JSON API', color: '#a78bfa', text: '{ }' },
  local: { label: 'Local file', color: '#94a3b8', text: '▤' },
};

const FALLBACK = { label: 'Source', color: 'rgba(255,255,255,0.35)', text: '•' };

export function markFor(platform) {
  return MARKS[String(platform || '').toLowerCase()] || FALLBACK;
}

export default function PlatformMark({ platform, size = 20, title }) {
  const mark = markFor(platform);
  return (
    <span
      className="qx-platform-mark"
      title={title || mark.label}
      aria-label={mark.label}
      role="img"
      data-testid="signal-platform-mark"
      data-platform={String(platform || 'unknown').toLowerCase()}
      style={{
        color: mark.color,
        fontSize: Math.round(size * 0.6),
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        /* Tinted from the mark's own colour so each platform reads distinctly at a glance
           without needing a second colour token per platform. */
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        borderRadius: 4,
        fontWeight: 600,
      }}
    >
      {mark.text}
    </span>
  );
}
