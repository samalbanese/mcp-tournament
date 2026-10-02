import { afterEach, describe, expect, it, vi } from 'vitest';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  vi.resetModules();
});

async function freshJudges(env: Record<string, string>) {
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../src/config/judges.js');
}

// Each test re-imports the config graph cold; under a busy machine that can pass 5 s.
describe('TOURNAMENT_MODEL_* env refs', { timeout: 30_000 }, () => {
  it('routes an anthropic: judge default to the anthropic route', async () => {
    const { JUDGES } = await freshJudges({ TOURNAMENT_MODEL_JUDGE_RULES: 'anthropic:claude-sonnet-5-5' });
    expect(JUDGES.find(judge => judge.role === 'rules')).toMatchObject({
      route: 'anthropic', model: 'claude-sonnet-5-5', family: 'anthropic',
    });
    expect(JUDGES.find(judge => judge.role === 'creative')?.route).toBe('openrouter');
  });

  it('bare env values stay on OpenRouter', async () => {
    const { JUDGES, resolveRoleRef } = await freshJudges({
      TOURNAMENT_MODEL_JUDGE_RULES: 'openai/gpt-5.4-mini',
      TOURNAMENT_MODEL_SYNTHESIZER: 'deepseek/deepseek-r1:free',
    });
    expect(JUDGES.find(judge => judge.role === 'rules')).toMatchObject({
      route: 'openrouter', model: 'openai/gpt-5.4-mini', family: 'deepseek',
    });
    expect(resolveRoleRef('synthesizer')).toEqual({
      ref: 'deepseek/deepseek-r1:free', route: 'openrouter', model: 'deepseek/deepseek-r1:free',
    });
  });

  it('routes synthesizer and participant env defaults through parsed refs', async () => {
    const judges = await freshJudges({
      TOURNAMENT_MODEL_SYNTHESIZER: 'anthropic:claude-sonnet-5-5',
      TOURNAMENT_MODEL_PARTICIPANT: 'anthropic:claude-haiku-4-5',
    });
    expect(judges.SYNTHESIZER).toMatchObject({ route: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(judges.PARTICIPANT_AGENT_ROUTE).toBe('anthropic');
    expect(judges.PARTICIPANT_AGENT_MODEL).toBe('anthropic:claude-haiku-4-5');
    expect(judges.resolveRoleRef('participant')).toEqual({
      ref: 'anthropic:claude-haiku-4-5', route: 'anthropic', model: 'claude-haiku-4-5',
    });
  });

  it('names the env var when an env default is not a valid ref', async () => {
    process.env.TOURNAMENT_MODEL_SYNTHESIZER = 'chatgpt:gpt-5';
    vi.resetModules();
    await expect(import('../../src/config/judges.js')).rejects.toThrow(/^TOURNAMENT_MODEL_SYNTHESIZER: /);
  });

  it('a run plan uses parsed env defaults for seats, synthesizer, and participant', async () => {
    Object.assign(process.env, {
      TOURNAMENT_MODEL_JUDGE_RULES: 'anthropic:claude-sonnet-5-5',
      TOURNAMENT_MODEL_SYNTHESIZER: 'anthropic:claude-sonnet-5-5',
      TOURNAMENT_MODEL_PARTICIPANT: 'anthropic:claude-haiku-4-5',
    });
    vi.resetModules();
    const { normalizeRunPlan } = await import('../../src/run-plan.js');
    const plan = normalizeRunPlan({
      bench: 'dnd', candidates: ['deepseek/deepseek-v3.2'], judgePanel: [{ persona: 'rules' }, { persona: 'creative' }],
    });
    expect(plan.judges[0]).toMatchObject({ route: 'anthropic', model: 'claude-sonnet-5-5', family: 'anthropic' });
    expect(plan.judges[1].route).toBe('openrouter');
    expect(plan.synthesizer).toEqual({ ref: 'anthropic:claude-sonnet-5-5', route: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(plan.participant).toEqual({ ref: 'anthropic:claude-haiku-4-5', route: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('a legacy judgeModels override with an anthropic: ref switches the judge route', async () => {
    vi.resetModules();
    const { selectJudges, RunPlanError } = await import('../../src/run-plan.js');
    expect(selectJudges(1, { rules: 'anthropic:claude-sonnet-5-5' })[0]).toMatchObject({
      route: 'anthropic', model: 'claude-sonnet-5-5', family: 'anthropic',
    });
    expect(selectJudges(1, { rules: 'openai/gpt-5.4-mini' })[0]).toMatchObject({
      route: 'openrouter', model: 'openai/gpt-5.4-mini',
    });
    expect(() => selectJudges(1, { rules: 'chatgpt:gpt-5' })).toThrow(RunPlanError);
    expect(() => selectJudges(1, { rules: 'chatgpt:gpt-5' })).toThrow(/judgeModels\.rules/);
  });
});
