import type { ClientRoute } from '../clients/index.js';
import type { Catalog } from '../catalog.js';
import type { ResolvedRunPlan } from '../run-plan.js';
import { ModelRefError } from './model-ref-error.js';

export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export const ANTHROPIC_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningLevel[];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Splits a trailing `@level`. OpenRouter IDs never contain "@". */
export function splitReasoning(raw: string): { base: string; reasoning?: ReasoningLevel } {
  const at = raw.lastIndexOf('@');
  if (at === -1) return { base: raw };
  const base = raw.slice(0, at).trim();
  const level = raw.slice(at + 1).trim().toLowerCase();
  if (!base) throw new ModelRefError(`"${raw}" has a reasoning level but no model ID before the "@".`);
  if (base.includes('@')) throw new ModelRefError(`"${raw}": use only one @level suffix. Valid levels: ${REASONING_LEVELS.join(', ')}.`);
  if (!isReasoningLevel(level)) {
    throw new ModelRefError(`"${raw}": unknown reasoning level "${level}". Use one of ${REASONING_LEVELS.join(', ')}, or leave it off for the model's default.`);
  }
  return { base, reasoning: level };
}

export function withReasoning(ref: string, level?: ReasoningLevel): string {
  return level && !ref.includes('@') ? `${ref}@${level}` : ref;
}

export function seatRef(route: ClientRoute, model: string, reasoning?: ReasoningLevel): string {
  return withReasoning(route === 'openrouter' ? model : `${route}:${model}`, reasoning);
}

const ANTHROPIC_FAMILIES = /^claude-(opus|sonnet|fable|mythos)-5(\b|-|\.)|^claude-(opus|sonnet)-4-([6-9])\b/;

/** True when the Anthropic API takes output_config.effort for this model; false for known models without it. */
export function anthropicSupportsLevels(model: string): boolean | undefined {
  if (ANTHROPIC_FAMILIES.test(model)) return true;
  if (/^claude-(haiku|opus|sonnet)-[34]/.test(model)) return false;
  return undefined;
}

interface Seat {
  label: string; ref: string; route: ClientRoute; model: string; reasoning?: ReasoningLevel;
  set(thinks: boolean): void;
  name?: { get(): string; set(value: string): void };
}

function seats(plan: ResolvedRunPlan): Seat[] {
  const list: Seat[] = plan.candidates.map(candidate => ({
    label: `Candidate "${candidate.id}"`, ref: candidate.id, route: candidate.route ?? 'openrouter',
    model: candidate.apiModel ?? candidate.id, reasoning: candidate.reasoning,
    set: thinks => { candidate.thinks = thinks; },
    name: { get: () => candidate.name, set: value => { candidate.name = value; } },
  }));
  for (const judge of plan.judges) {
    list.push({
      label: `Judge "${judge.name}"`, ref: seatRef(judge.route, judge.model, judge.reasoning), route: judge.route,
      model: judge.model, reasoning: judge.reasoning, set: thinks => { judge.thinks = thinks; },
    });
  }
  for (const [label, ref] of [['Synthesizer', plan.synthesizer], ['Simulated user', plan.participant]] as const) {
    list.push({
      label: `${label} "${ref.ref}"`, ref: ref.ref, route: ref.route, model: ref.model, reasoning: ref.reasoning,
      set: thinks => { ref.thinks = thinks; },
    });
  }
  return list;
}

/** Checks each seat's exact model, sets its thinking flag and labels candidates before a run. */
export function applyReasoningCatalog(plan: ResolvedRunPlan, catalog: Catalog): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const seat of seats(plan)) {
    let levels: readonly ReasoningLevel[] | undefined;
    let reasonsByDefault = false;
    let known = true;
    if (seat.route === 'anthropic') {
      const supported = anthropicSupportsLevels(seat.model);
      levels = supported ? ANTHROPIC_LEVELS : undefined;
      reasonsByDefault = supported === true;
      if (supported === undefined) known = false;
      if (supported === false && seat.reasoning) errors.push(`${seat.label}: ${seat.model} has no reasoning levels.`);
      if (supported === undefined && seat.reasoning) warnings.push(`${seat.label}: unknown Claude model, sending reasoning level ${seat.reasoning} without checking it.`);
    } else if (catalog.source !== 'live') {
      known = false;
      if (seat.reasoning) warnings.push(`Model catalog offline: could not check that "${seat.ref}" accepts reasoning level ${seat.reasoning}.`);
    } else {
      const entry = catalog.models.find(item => item.id === seat.model);
      levels = entry?.reasoningLevels;
      reasonsByDefault = entry?.reasonsByDefault === true;
      const display = entry?.name ?? seat.model;
      if (seat.reasoning) {
        if (!levels?.length) errors.push(`${seat.label}: ${display} has no reasoning levels.`);
        else if (!levels.includes(seat.reasoning)) errors.push(`${seat.label}: ${display} accepts ${levels.join(', ')}.`);
      }
    }
    seat.set(seat.reasoning ? seat.reasoning !== 'none' : reasonsByDefault);
    if (seat.name) {
      const tag = seat.reasoning ?? (known && levels?.length ? 'default' : undefined);
      if (tag && !seat.name.get().endsWith(` · ${tag}`)) seat.name.set(`${seat.name.get()} · ${tag}`);
    }
  }
  return { errors, warnings };
}
