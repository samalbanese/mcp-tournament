export function humanizePlugin(name: string) {
  const normalized = name.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
}
