import { z } from 'zod';
import { JUDGES, resolveRoleModel, type JudgeConfig } from './config/judges.js';
import { ModelRefError, parseModelRef, type ParsedModelRef } from './config/model-ref.js';
import { resolveCandidateModel, type CandidateModel } from './config/models.js';
import { DEFAULT_SEAT_ORDER, PERSONAS, PERSONA_IDS } from './config/personas.js';
import { modelSlug, type TestCase, type TournamentPlugin } from './plugins/base.js';
import { getPlugin } from './plugins/index.js';

export const PLAN_LIMITS = { candidates: [1, 4], judges: [1, 5], turns: [1, 10], lens: [1, 1000], name: [1, 60] } as const;

export const ModelRefSchema = z.string().trim().min(1, 'model ID is empty').max(200);

export const CustomPersonaSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  lens: z.string().trim().min(1, 'lens must be 1-1000 characters').max(1000, 'lens must be 1-1000 characters'),
}).strict();

export const JudgeSeatSchema = z.object({
  model: ModelRefSchema.optional(),
  persona: z.enum(PERSONA_IDS).optional(),
  customPersona: CustomPersonaSchema.optional(),
}).strict().refine(seat => !(seat.persona && seat.customPersona), {
  message: 'use either persona or customPersona, not both',
});

export const RunPlanSchema = z.object({
  bench: z.string().trim().min(1).default('dnd'),
  scenarios: z.array(z.string().trim().min(1)).min(1).optional(),
  candidates: z.array(ModelRefSchema).min(1, 'pick 1-4 candidate models').max(4, 'pick 1-4 candidate models'),
  judgePanel: z.array(JudgeSeatSchema).min(1).max(5, 'a judge panel has 1-5 seats').optional(),
  synthesizer: ModelRefSchema.optional(),
  participant: ModelRefSchema.optional(),
  turns: z.number().int().min(1, 'turns must be 1-10').max(10, 'turns must be 1-10').optional(),
}).strict();

export type RunPlanInput = z.input<typeof RunPlanSchema>;
export type JudgeSeat = z.infer<typeof JudgeSeatSchema>;

export interface LegacyJudgeOptions {
  judges?: number;
  judgeModels?: Record<string, string>;
  quick?: boolean;
}

export interface ResolvedRunPlan {
  bench: string;
  plugin: TournamentPlugin;
  scenarios: TestCase[];
  candidates: CandidateModel[];
  judges: JudgeConfig[];
  synthesizer: ParsedModelRef;
  participant: ParsedModelRef;
  participantExplicit: boolean;
  turns: number | null;
  quick: boolean;
  warnings: string[];
}

export class RunPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPlanError';
  }
}

function parseRef(ref: string, label: string): ParsedModelRef {
  try {
    return parseModelRef(ref);
  } catch (error) {
    if (error instanceof ModelRefError) throw new RunPlanError(`${label}: ${error.message}`);
    throw error;
  }
}

function selectScenarios(all: TestCase[], requested?: string[]): TestCase[] {
  if (!requested?.length) return all;
  const selected = requested.map(id => all.find(scenario => scenario.id === id));
  const missing = requested.filter((_id, index) => !selected[index]);
  if (missing.length) throw new Error(`Unknown scenario ID(s): ${missing.join(', ')}`);
  return selected as TestCase[];
}

export function selectJudges(
  judgeCount: number,
  judgeModels?: Record<string, string>,
): JudgeConfig[] {
  return JUDGES.slice(0, judgeCount).map(judge => {
    const override = judgeModels?.[judge.role];
    if (!override) return judge;
    const parsed = parseRef(override, `judgeModels.${judge.role}`);
    return {
      ...judge, model: parsed.model, route: parsed.route,
      family: parsed.route === 'anthropic' ? 'anthropic' : judge.family,
    };
  });
}

function resolveSeat(seat: JudgeSeat, index: number): JudgeConfig {
  const preset = PERSONAS[seat.persona ?? DEFAULT_SEAT_ORDER[index] ?? 'holistic'];
  const parsed = parseRef(
    seat.model ?? resolveRoleModel(preset.defaultModelRole),
    seat.model ? `judgePanel seat ${index + 1}: model` : `judgePanel seat ${index + 1}: default model`,
  );
  const custom = seat.customPersona;
  return {
    role: custom ? `custom_${index + 1}` : preset.id,
    name: custom ? custom.name ?? `Custom Judge ${index + 1}` : preset.judgeName,
    lens: custom ? custom.lens.trim() : preset.lens,
    pluginRole: custom ? 'holistic' : preset.pluginRole,
    persona: custom ? 'custom' : preset.id,
    route: parsed.route,
    model: parsed.model,
    family: parsed.route === 'anthropic' ? 'anthropic' : parsed.model.split('/')[0],
    focus: custom ? ['custom'] : [...preset.focus],
  };
}

export function normalizeRunPlan(input: RunPlanInput, legacy: LegacyJudgeOptions = {}): ResolvedRunPlan {
  const parsed = RunPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new RunPlanError(parsed.error.issues.map(issue => {
      const [field, index, ...rest] = issue.path;
      if (field === 'judgePanel' && typeof index === 'number') {
        return `judgePanel seat ${index + 1}: ${rest.length ? `${rest.join('.')}: ` : ''}${issue.message}`;
      }
      return `${issue.path.join('.')}: ${issue.message}`;
    }).join('\n'));
  }
  const data = parsed.data;
  const plugin = getPlugin(data.bench);
  const scenarios = selectScenarios(plugin.scenarios, data.scenarios);
  if (!scenarios.length) throw new Error(`Plugin "${plugin.name}" has no scenarios`);
  const refs = new Set<string>();
  const slugs = new Map<string, string>();
  const candidates = data.candidates.map((ref, index) => {
    const model = parseRef(ref, `candidates[${index}]`);
    if (refs.has(model.ref)) throw new RunPlanError(`"${model.ref}" is listed twice`);
    refs.add(model.ref);
    const slug = modelSlug(model.ref);
    const previous = slugs.get(slug);
    if (previous) {
      throw new RunPlanError(`"${previous}" and "${model.ref}": These two models would share a results folder; run them in separate tournaments.`);
    }
    slugs.set(slug, model.ref);
    return resolveCandidateModel(model.ref);
  });

  const warnings: string[] = [];
  let judges: JudgeConfig[];
  if (data.judgePanel) {
    if (legacy.judges !== undefined || legacy.judgeModels !== undefined) {
      warnings.push('judgePanel was used; judges and judgeModels were ignored.');
    }
    judges = (legacy.quick ? data.judgePanel.slice(0, 1) : data.judgePanel).map(resolveSeat);
    const roles = new Map<string, number>();
    judges = judges.map(judge => {
      const count = (roles.get(judge.role) ?? 0) + 1;
      roles.set(judge.role, count);
      return count === 1 ? judge : { ...judge, role: `${judge.role}_${count}` };
    });
  } else {
    const count = legacy.quick ? 1 : legacy.judges ?? 3;
    if (!Number.isInteger(count) || count < 1 || count > 5) {
      throw new RunPlanError('Judge count must be between 1 and 5');
    }
    judges = selectJudges(count, legacy.judgeModels);
  }

  return {
    bench: data.bench, plugin, scenarios, candidates, judges,
    synthesizer: parseRef(data.synthesizer ?? resolveRoleModel('synthesizer'), 'synthesizer'),
    participant: parseRef(data.participant ?? resolveRoleModel('participant'), 'participant'),
    participantExplicit: data.participant !== undefined,
    turns: data.turns ?? null,
    quick: legacy.quick ?? false,
    warnings,
  };
}

export function effectiveScenario(scenario: TestCase, turns: number | null): TestCase {
  return turns === null ? scenario : { ...scenario, minTurns: turns, maxTurns: turns };
}

export function describePlan(plan: ResolvedRunPlan): string {
  const judgeRef = (judge: JudgeConfig) => judge.route === 'openrouter' ? judge.model : `${judge.route}:${judge.model}`;
  return [
    `Bench: ${plan.bench} (${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? '' : 's'}: ${plan.scenarios.map(scenario => scenario.name).join(', ')})`,
    `Models: ${plan.candidates.map(candidate => candidate.id).join(', ')}`,
    `Judges: ${plan.judges.map(judge => `${judge.name} (${judgeRef(judge)})`).join(', ')}`,
    `Turns: ${plan.turns === null ? "each scenario's default" : `${plan.turns} per scenario`}`,
    `Synthesizer: ${plan.quick || plan.judges.length < 2 ? 'not needed (one judge)' : plan.synthesizer.ref}`,
    `Simulated user: ${plan.participant.ref}`,
  ].join('\n');
}
