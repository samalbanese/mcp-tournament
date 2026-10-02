import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelResponse } from '../../src/clients/types.js';
import { MAX_TOKENS_CANDIDATE, MAX_TOKENS_CANDIDATE_REASONING } from '../../src/config/constants.js';
import type { CandidateModel } from '../../src/config/models.js';
import type { TestCase, TournamentPlugin } from '../../src/plugins/base.js';
import { runScenario } from '../../src/phases/executor.js';

const ROUTE = 'executor-test';
const model = { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'unknown', notes: '', route: ROUTE } as unknown as CandidateModel;
const scenario: TestCase = {
  id: 'free-shipping', name: 'Free Shipping or Percentage Discount', description: 'Pick a promotion.',
  setupMessage: 'Should we offer free shipping over $60 or 15% off?', goalCard: 'Pick a promotion.', minTurns: 1, maxTurns: 1,
};
const plugin = {
  name: 'business-strategy', description: '', scenarios: [scenario],
  buildCandidatePrompt: () => 'Answer directly.',
  buildJudgePrompt: () => '',
  generateParticipantMessage: async () => 'Thanks.',
} as unknown as TournamentPlugin;

function reply(text: string, stop_reason: string): ModelResponse {
  return { text, content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 120, output_tokens: 900 }, model: model.id };
}

describe('runScenario candidate replies', () => {
  let dir: string;
  let calls: CreateMessageParams[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-'));
    calls = [];
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function useReplies(...replies: ModelResponse[]) {
    registerModelClient(ROUTE, {
      createMessage: async params => {
        calls.push(params);
        return replies.shift()!;
      },
    });
  }

  it('fails the pair when reasoning uses the whole output allowance and no answer comes back', async () => {
    useReplies(reply('', 'max_tokens'));
    const result = await runScenario({ ...model, reasoning: 'low', thinks: true }, scenario, plugin, dir);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`Empty reply on turn 1: the model used all ${MAX_TOKENS_CANDIDATE_REASONING} output tokens (likely on reasoning) before answering.`);
    expect(result.turns.filter(turn => turn.role === 'candidate')).toHaveLength(0);
    const scenarioDir = fs.readdirSync(path.join(dir, 'candidates'))[0];
    expect(fs.readdirSync(path.join(dir, 'candidates', scenarioDir, fs.readdirSync(path.join(dir, 'candidates', scenarioDir))[0])))
      .toContain('error.json');
  });

  it('fails a reply cut off at the output limit instead of letting judges score half an answer', async () => {
    useReplies(reply('Run the free-shipping test for two weeks. Below 500 orders you are still', 'max_tokens'));
    const result = await runScenario(model, scenario, plugin, dir);
    expect(result).toMatchObject({ success: false, error: 'Reply cut off on turn 1: the model reached the 4096-token output limit.' });
  });

  it('never runs a tool requested by a reply that was cut off', async () => {
    const handler = vi.fn(async () => 'stock: 12');
    const withTool = { ...plugin, tools: [{ name: 'check_stock', description: '', parameters: { type: 'object' }, handler }] } as TournamentPlugin;
    useReplies({
      text: 'Let me check stock first.',
      content: [{ type: 'text', text: 'Let me check stock first.' }, { type: 'tool_use', id: 't1', name: 'check_stock', input: {} }],
      stop_reason: 'max_tokens', usage: { input_tokens: 120, output_tokens: 4096 }, model: model.id,
    } as ModelResponse);
    const result = await runScenario(model, scenario, withTool, dir);
    expect(result).toMatchObject({ success: false, error: 'Reply cut off on turn 1: the model reached the 4096-token output limit.' });
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('fails an empty reply that ended normally too', async () => {
    useReplies(reply('', 'end_turn'));
    const result = await runScenario(model, scenario, plugin, dir);
    expect(result).toMatchObject({ success: false, error: 'Empty reply on turn 1.' });
  });

  it('gives reasoning runs the larger output allowance', async () => {
    useReplies(reply('Offer free shipping over $60.', 'end_turn'));
    await expect(runScenario({ ...model, reasoning: 'low', thinks: true }, scenario, plugin, dir)).resolves.toMatchObject({ success: true });
    expect(calls[0].max_tokens).toBe(MAX_TOKENS_CANDIDATE_REASONING);
  });

  it('keeps the standard allowance without reasoning', async () => {
    useReplies(reply('Offer free shipping over $60.', 'end_turn'));
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'high');
    await runScenario(model, scenario, plugin, dir);
    expect(calls[0].max_tokens).toBe(MAX_TOKENS_CANDIDATE);
  });
});
