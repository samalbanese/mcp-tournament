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

// Mirrors anthropicSupportsLevels in src/config/reasoning.ts.
const ANTHROPIC_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANTHROPIC_FAMILIES = /^claude-(opus|sonnet|fable|mythos)-5(\b|-|\.)|^claude-(opus|sonnet)-4-([6-9])\b/;

/**
 * The catalog entry that drives a seat's level picker. Anthropic-routed refs are not in the
 * OpenRouter catalog, so they get the Anthropic levels; any other unknown ref with a level
 * keeps that level visible so it can be cleared.
 */
export function pickerModel(base: string, level: string | undefined, models: ApiModel[]): ApiModel | undefined {
  const found = models.find(model => model.id === base);
  if (found) return found;
  const unknown = { id: base, name: base, contextLength: 0, promptPrice: 0, completionPrice: 0 };
  if (base.startsWith('anthropic:') && ANTHROPIC_FAMILIES.test(base.slice('anthropic:'.length))) {
    return { ...unknown, reasoningLevels: ANTHROPIC_LEVELS };
  }
  return level ? { ...unknown, reasoningLevels: [level] } : undefined;
}

export function levelOptions(model?: ApiModel): Array<{ value: string; label: string }> {
  if (!model?.reasoningLevels?.length) return [];
  return [
    { value: '', label: `Default (${model.defaultReasoning ?? 'provider'})` },
    ...model.reasoningLevels.map(level => ({ value: level, label: level })),
  ];
}
