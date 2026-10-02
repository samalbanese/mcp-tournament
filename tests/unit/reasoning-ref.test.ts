import { describe, expect, it, vi } from 'vitest';
import { ModelRefError, parseModelRef } from '../../src/config/model-ref.js';
import { seatRef, splitReasoning, withReasoning } from '../../src/config/reasoning.js';
import { describePlan, normalizeRunPlan, RunPlanError } from '../../src/run-plan.js';

describe('@level suffix', () => {
  it('keeps the level in the identity and strips it from the provider model', () => {
    expect(parseModelRef('openai/gpt-6.1-sol@HIGH')).toEqual({
      ref: 'openai/gpt-6.1-sol@high', route: 'openrouter', model: 'openai/gpt-6.1-sol', reasoning: 'high',
    });
    expect(parseModelRef('anthropic:claude-opus-5-5@low')).toEqual({
      ref: 'anthropic:claude-opus-5-5@low', route: 'anthropic', model: 'claude-opus-5-5', reasoning: 'low',
    });
    expect(parseModelRef('openrouter:deepseek/deepseek-r1:free@max').model).toBe('deepseek/deepseek-r1:free');
  });

  it('leaves refs without a suffix exactly as before', () => {
    expect(parseModelRef('deepseek/deepseek-v3.2')).toEqual({ ref: 'deepseek/deepseek-v3.2', route: 'openrouter', model: 'deepseek/deepseek-v3.2' });
  });

  it.each(['x/y@', 'x/y@turbo', 'x/y@default', '@low'])('rejects %s with the valid levels', input => {
    expect(() => parseModelRef(input)).toThrow(ModelRefError);
    expect(() => parseModelRef('x/y@turbo')).toThrow(/none, minimal, low, medium, high, xhigh, max/);
  });

  it('rejects levels the Anthropic API does not accept', () => {
    expect(() => parseModelRef('anthropic:claude-opus-5-5@none')).toThrow(/low, medium, high, xhigh, max/);
    expect(() => parseModelRef('anthropic:claude-opus-5-5@minimal')).toThrow(/low, medium, high, xhigh, max/);
  });

  it('rejects repeated suffixes instead of leaving @ in the provider model', () => {
    expect(() => parseModelRef('a/b@low@high')).toThrow(ModelRefError);
    expect(() => parseModelRef('anthropic:claude-opus-5-5@low@high')).toThrow(ModelRefError);
  });

  it('builds and defaults refs', () => {
    expect(withReasoning('a/b', 'low')).toBe('a/b@low');
    expect(withReasoning('a/b@high', 'low')).toBe('a/b@high');
    expect(withReasoning('a/b', undefined)).toBe('a/b');
    expect(withReasoning('a/b')).toBe('a/b');
    expect(splitReasoning('a/b@medium')).toEqual({ base: 'a/b', reasoning: 'medium' });
    expect(seatRef('anthropic', 'claude-opus-5-5', 'high')).toBe('anthropic:claude-opus-5-5@high');
    expect(seatRef('openrouter', 'a/b')).toBe('a/b');
  });

  it('treats the same model at two levels as two candidates but refuses an exact repeat', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b@low', 'a/b@high'] });
    expect(plan.candidates.map(c => [c.id, c.apiModel, c.reasoning])).toEqual([['a/b@low', 'a/b', 'low'], ['a/b@high', 'a/b', 'high']]);
    expect(() => normalizeRunPlan({ bench: 'dnd', candidates: ['a/b@high', 'a/b@HIGH'] })).toThrow(RunPlanError);
  });

  it('carries judge seat levels', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b'], judgePanel: [{ model: 'c/d@low' }] });
    expect(plan.judges[0]).toMatchObject({ model: 'c/d', reasoning: 'low' });
    expect(describePlan(plan)).toContain('c/d@low');
  });

  it('carries legacy judge overrides and the other seat levels', () => {
    const plan = normalizeRunPlan({
      bench: 'dnd', candidates: ['deepseek/deepseek-v3.2@high'],
      synthesizer: 'a/s@medium', participant: 'a/p@none',
    }, { judges: 1, judgeModels: { rules: 'anthropic:claude-opus-5-5@low' } });
    expect(plan.candidates[0]).toMatchObject({ name: 'DeepSeek V3.2', apiModel: 'deepseek/deepseek-v3.2', reasoning: 'high' });
    expect(plan.judges[0]).toMatchObject({ model: 'claude-opus-5-5', reasoning: 'low' });
    expect(plan.synthesizer).toMatchObject({ model: 'a/s', reasoning: 'medium' });
    expect(plan.participant).toMatchObject({ model: 'a/p', reasoning: 'none' });
    expect(plan.synthesizer.thinks).toBeUndefined();
    expect(describePlan(plan)).toContain('anthropic:claude-opus-5-5@low');
  });

  it('preserves levels from environment defaults and clears them for bare overrides', async () => {
    vi.stubEnv('TOURNAMENT_MODEL_JUDGE_RULES', 'a/j@high');
    vi.stubEnv('TOURNAMENT_MODEL_SYNTHESIZER', 'a/s@low');
    vi.resetModules();
    try {
      const { JUDGES, SYNTHESIZER } = await import('../../src/config/judges.js');
      const { selectJudges } = await import('../../src/run-plan.js');
      expect(JUDGES[0]).toMatchObject({ model: 'a/j', reasoning: 'high' });
      expect(SYNTHESIZER).toMatchObject({ model: 'a/s', reasoning: 'low' });
      expect(selectJudges(1)[0].reasoning).toBe('high');
      expect(selectJudges(1, { rules: 'a/other' })[0]).not.toHaveProperty('reasoning');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
