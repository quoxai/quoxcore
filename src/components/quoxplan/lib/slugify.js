/**
 * Roadmap-name -> id slug for the onboarding wizard's "Name your roadmap"
 * step. Matches the server's isValidSlug rule (mutations.js): lowercase
 * letters/digits, hyphen-separated, 2-64 chars — so a name that slugifies
 * cleanly never gets rejected by the create-roadmap 422.
 */
export function slugifyRoadmapName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug;
}

/** True when a slugified name would pass the server's isValidSlug check. */
export function isSlugifiableRoadmapName(name) {
  const slug = slugifyRoadmapName(name);
  return slug.length >= 2 && slug.length <= 64;
}
