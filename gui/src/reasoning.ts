import type { ApiModel } from './api.js';

export function splitLevel(ref: string): { base: string; level?: string } {
  const at = ref.lastIndexOf('@');
  return at < 0 ? { base: ref } : { base: ref.slice(0, at), level: ref.slice(at + 1).toLowerCase() };
}

export function joinLevel(base: string, level?: string): string {
  return level ? `${base}@${level}` : base;
}

export function keepLevelIfSupported(ref: string, model?: ApiModel): string {
  const { base, level } = splitLevel(ref);
  return joinLevel(model?.id ?? base, level && model?.reasoningLevels?.includes(level) ? level : undefined);
}

export function swapModel(oldRef: string, newId: string, models: ApiModel[]): string {
  return keepLevelIfSupported(joinLevel(newId, splitLevel(oldRef).level), models.find(model => model.id === newId));
}

export function levelOptions(model?: ApiModel): Array<{ value: string; label: string }> {
  if (!model?.reasoningLevels?.length) return [];
  return [
    { value: '', label: `Default (${model.defaultReasoning ?? 'provider'})` },
    ...model.reasoningLevels.map(level => ({ value: level, label: level })),
  ];
}
