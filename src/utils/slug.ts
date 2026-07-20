/** Convert a value to a lowercase, filesystem-safe slug. */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Cap a slug at a stable segment length, preferring the last word boundary.
 * Truncated slugs carry a short hash of the full slug: two long names that
 * share a prefix (gemini-2.5-flash vs gemini-2.5-flash-lite) must never map
 * to the same directory. Mirrored in gui/src/data.ts and gui/scripts/import-run.mjs.
 */
export function shortSlug(value: string, max = 24): string {
  const slug = slugify(value);
  if (slug.length <= max) return slug;

  let hash = 5381;
  for (let i = 0; i < slug.length; i++) hash = ((hash * 33) ^ slug.charCodeAt(i)) >>> 0;
  const suffix = hash.toString(36).slice(0, 4).padStart(4, '0');
  const prefix = slug.slice(0, max - 5);
  const boundary = prefix.lastIndexOf('_');
  const base = (boundary > 0 ? prefix.slice(0, boundary) : prefix).replace(/_+$/, '');
  return `${base}_${suffix}`;
}
