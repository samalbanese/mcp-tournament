export function humanizePlugin(name: string) {
  if (name === 'dnd') return 'D&D showcase';
  const normalized = name.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
}
