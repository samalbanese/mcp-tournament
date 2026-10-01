import { describe, expect, it } from 'vitest';
import { normalizeRunPlan, RunPlanError, effectiveScenario } from '../../src/run-plan.js';
import { selectJudges } from '../../src/pipeline.js';
import '../../src/plugins/index.js';

const base = { bench: 'dnd', candidates: ['deepseek/deepseek-v3.2'] };

describe('normalizeRunPlan', () => {
  it('T5: legacy judges count and judgeModels match selectJudges exactly', () => {
    expect(normalizeRunPlan(base, { judges: 3 }).judges).toEqual(selectJudges(3));
    const judgeModels = { rules: 'a/one', creative: 'b/two' };
    expect(normalizeRunPlan(base, { judges: 2, judgeModels }).judges).toEqual(selectJudges(2, judgeModels));
    expect(normalizeRunPlan(base).judges.map(judge => judge.role)).toEqual(['rules', 'creative', 'holistic']);
    expect(normalizeRunPlan(base, { quick: true }).judges).toHaveLength(1);
  });

  it('T4: duplicate personas get unique role ids', () => {
    const plan = normalizeRunPlan({ ...base, judgePanel: [{ persona: 'skeptic' }, { persona: 'skeptic' }, { persona: 'skeptic' }] });
    expect(plan.judges.map(judge => judge.role)).toEqual(['skeptic', 'skeptic_2', 'skeptic_3']);
  });

  it('resolves custom personas and seat models with routes', () => {
    const plan = normalizeRunPlan({ ...base, judgePanel: [
      { model: 'anthropic:claude-haiku-4-5', customPersona: { lens: '  Judge like a pirate.  ' } },
      { model: 'qwen/qwen3.5-flash-02-23' },
    ] });
    expect(plan.judges[0]).toMatchObject({
      role: 'custom_1', name: 'Custom Judge 1', lens: 'Judge like a pirate.', pluginRole: 'holistic',
      persona: 'custom', route: 'anthropic', model: 'claude-haiku-4-5', family: 'anthropic',
    });
    expect(plan.judges[1]).toMatchObject({ role: 'creative', persona: 'creative', route: 'openrouter' });
  });

  it('review focus 1: judgePanel wins over legacy params with a warning', () => {
    const plan = normalizeRunPlan({ ...base, judgePanel: [{ persona: 'strict' }] }, { judges: 5 });
    expect(plan.judges.map(judge => judge.role)).toEqual(['strict']);
    expect(plan.warnings).toContain('judgePanel was used; judges and judgeModels were ignored.');
  });

  it('review focus 5: rejects bad custom persona input naming the seat', () => {
    expect(() => normalizeRunPlan({ ...base, judgePanel: [{ persona: 'rules' }, { customPersona: { lens: '   ' } }] }))
      .toThrow(/judgePanel seat 2/);
    expect(() => normalizeRunPlan({ ...base, judgePanel: [{ customPersona: { lens: 'x'.repeat(1001) } }] }))
      .toThrow(/judgePanel seat 1/);
    expect(() => normalizeRunPlan({ ...base, judgePanel: [{ persona: 'rules', customPersona: { lens: 'x' } }] }))
      .toThrow(/either persona or customPersona/);
  });

  it('T6: rejects cross-route slug collisions and duplicates', () => {
    expect(() => normalizeRunPlan({ ...base, candidates: ['anthropic:claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'] }))
      .toThrow(/would share a results folder/);
    expect(() => normalizeRunPlan({ ...base, candidates: ['deepseek/deepseek-v3.2', 'openrouter:deepseek/deepseek-v3.2'] }))
      .toThrow(/listed twice/);
    expect(() => normalizeRunPlan({ ...base, candidates: ['chatgpt:gpt-5.4'] })).toThrow(/not set up yet/);
    expect(() => normalizeRunPlan({ ...base, candidates: [] })).toThrow(RunPlanError);
  });

  it('validates turns and keeps null when omitted', () => {
    expect(normalizeRunPlan(base).turns).toBeNull();
    expect(normalizeRunPlan({ ...base, turns: 2 }).turns).toBe(2);
    expect(() => normalizeRunPlan({ ...base, turns: 11 })).toThrow(/turns/);
  });

  it('effectiveScenario overrides min and max turns without mutating', () => {
    const plan = normalizeRunPlan(base);
    const original = plan.scenarios[0];
    const copy = effectiveScenario(original, 2);
    expect(copy.maxTurns).toBe(2);
    expect(copy.minTurns).toBe(2);
    expect(original.maxTurns).not.toBe(2);
    expect(effectiveScenario(original, null)).toBe(original);
  });
});

import { describePlan } from '../../src/run-plan.js';

it('describePlan names every swappable setting in plain English', () => {
  const text = describePlan(normalizeRunPlan({
    bench: 'dnd', scenarios: ['dnd-combat'], candidates: ['deepseek/deepseek-v3.2', 'anthropic:claude-haiku-4-5'],
    judgePanel: [{ persona: 'skeptic' }, { model: 'qwen/qwen3.5-flash-02-23', customPersona: { lens: 'x' } }], turns: 2,
  }));
  for (const expected of ['Bench: dnd', 'deepseek/deepseek-v3.2', 'anthropic:claude-haiku-4-5',
    'Skeptic Judge (deepseek/deepseek-v3.2)', 'Custom Judge 2 (qwen/qwen3.5-flash-02-23)',
    'Turns: 2 per scenario', 'Synthesizer: ', 'Simulated user: ']) {
    expect(text).toContain(expected);
  }
  expect(describePlan(normalizeRunPlan({ bench: 'dnd', candidates: ['deepseek/deepseek-v3.2'] })))
    .toContain("Turns: each scenario's default");
});
