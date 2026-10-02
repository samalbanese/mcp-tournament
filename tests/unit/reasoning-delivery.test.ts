import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicModelClient } from '../../src/clients/anthropic.js';
import { createMessage } from '../../src/clients/openrouter.js';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelResponse } from '../../src/clients/types.js';
import type { Catalog } from '../../src/catalog.js';
import * as limits from '../../src/config/constants.js';
import { outputAllowance } from '../../src/config/reasoning.js';
import { evaluateTournament } from '../../src/pipeline.js';
import { createCustomPlugin } from '../../src/plugins/custom.js';
import { dndPlugin } from '../../src/plugins/dnd.js';
import { modelSlug } from '../../src/plugins/base.js';
import { registerPlugin } from '../../src/plugins/index.js';
import { runScenario } from '../../src/phases/executor.js';
import { normalizeRunPlan } from '../../src/run-plan.js';
import { applyReasoningCatalog } from '../../src/config/reasoning.js';

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

const originals = { openrouter: getModelClient('openrouter'), anthropic: getModelClient('anthropic') };
let outputRoot: string;
const catalog: Catalog = {
  source: 'live',
  models: [{ id: 'a/b', name: 'B', contextLength: 0, promptPrice: 1, completionPrice: 2,
    hasReasoning: true, reasoningLevels: ['none', 'low', 'high'], reasonsByDefault: true }],
};
const bench = createCustomPlugin({
  name: 'reasoning-delivery', description: 'test',
  scenarios: [{ id: 'one', name: 'One', description: '', prompt: 'Answer the question.', rounds: 2,
    criteria: [{ name: 'quality', description: 'Quality' }] }],
});
registerPlugin(bench);

function reply(text: string): ModelResponse {
  return { text, content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 }, model: 'a/b' };
}

function fakeClient() {
  return { createMessage: vi.fn(async (params: CreateMessageParams) => {
    if (params.system?.startsWith('Synthesize')) return reply(JSON.stringify({
      final_scores: { quality: { score: 7, confidence: 'high', outliers: [] } },
      average_score: 7, rule_errors_confirmed: [], assessment: 'fine', judge_agreement: 'agreed',
    }));
    if (params.system?.includes('Score each listed criterion')) return reply(JSON.stringify({
      scores: { quality: { score: 7, justification: 'ok', quotes: [], improvement: 'more' } },
      rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine',
    }));
    return reply('A useful answer.');
  }) };
}

beforeEach(() => {
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-delivery-'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  vi.stubEnv('OPENROUTER_API_KEY', 'test');
  vi.stubEnv('TOURNAMENT_REASONING_EFFORT', 'max');
  createCompletion.mockReset().mockResolvedValue({ model: 'a/b',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
});

afterEach(() => {
  registerModelClient('openrouter', originals.openrouter);
  registerModelClient('anthropic', originals.anthropic);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('provider reasoning delivery', () => {
  it('sends Anthropic effort for a level and omits it for the default', async () => {
    const create = vi.fn(async (_body: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {},
    }));
    const client = createAnthropicModelClient(() => ({ create }), { retryDelayMs: 0 });
    const params = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };
    await client.createMessage({ ...params, reasoning: 'low' });
    await client.createMessage(params);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });
    expect(create.mock.calls[1][0]).not.toHaveProperty('output_config');
  });

  it('sends OpenRouter effort per call with a bare model and ignores the old env setting', async () => {
    const params = { model: 'a/b', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };
    await createMessage({ ...params, reasoning: 'high' });
    await createMessage(params);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({ model: 'a/b', reasoning: { effort: 'high' } });
    expect(createCompletion.mock.calls[1][0]).not.toHaveProperty('reasoning');
  });
});

describe('output allowances', () => {
  it.each([
    ['candidate', 4096, 32768], ['judge', 16384, 32768],
    ['synthesis', 4096, 16384], ['participant', 512, 8192],
  ] as const)('grows only for %s seats that reason', (kind, standard, reasoning) => {
    expect(outputAllowance(kind, true)).toBe(reasoning);
    expect(outputAllowance(kind, false)).toBe(standard);
    expect(outputAllowance(kind, undefined)).toBe(standard);
  });
});

describe('pipeline reasoning', () => {
  it('delivers all seat levels and keeps two candidate levels in separate folders and leaderboard rows', async () => {
    const client = fakeClient();
    registerModelClient('openrouter', client);
    const run = await evaluateTournament({ models: ['a/b@low', 'a/b@high'], plugin: bench.name, catalog, outputRoot,
      judgePanel: [{ model: 'a/b@none' }, { model: 'a/b@low' }],
      synthesizerModel: 'a/b@high', participantModel: 'a/b@low' });
    expect(run.failures).toEqual([]);
    expect(run.judgeFailures).toEqual([]);
    const calls = client.createMessage.mock.calls.map(([params]) => params);
    expect(calls).toHaveLength(12);
    expect(calls.every(call => call.model === 'a/b')).toBe(true);
    expect(calls.map(call => [call.reasoning, call.max_tokens])).toEqual([
      ['low', 32768], ['low', 8192], ['low', 32768], ['none', 16384], ['low', 32768], ['high', 16384],
      ['high', 32768], ['low', 8192], ['high', 32768], ['none', 16384], ['low', 32768], ['high', 16384],
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.candidates).toMatchObject([{ id: 'a/b@low', reasoning: 'low' }, { id: 'a/b@high', reasoning: 'high' }]);
    expect(manifest.judges).toMatchObject([{ model: 'a/b', reasoning: 'none' }, { model: 'a/b', reasoning: 'low' }]);
    expect(manifest.synthesizer).toMatchObject({ model: 'a/b', reasoning: 'high' });
    expect(manifest.participant).toMatchObject({ model: 'a/b@low', reasoning: 'low' });
    expect(fs.readdirSync(path.join(run.runDir, 'candidates')).sort()).toEqual(['a/b@low', 'a/b@high'].map(modelSlug).sort());
    expect(run.leaderboard.map(row => [row.modelId, row.modelName])).toEqual([
      ['a/b@low', 'b · low'], ['a/b@high', 'b · high'],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unsupported level before any call or result folder', async () => {
    const client = fakeClient();
    registerModelClient('openrouter', client);
    await expect(evaluateTournament({ models: ['a/b@max'], plugin: bench.name, catalog, outputRoot }))
      .rejects.toThrow(/B accepts none, low, high/);
    expect(client.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });

  it('warns when the catalog is offline and still sends the level', async () => {
    const client = fakeClient();
    registerModelClient('openrouter', client);
    const onProgress = vi.fn();
    await evaluateTournament({ models: ['a/b@high'], plugin: bench.name, turns: 1, judgePanel: [{ model: 'a/b@low' }],
      catalog: { source: 'curated-fallback', models: [] }, outputRoot, onProgress });
    expect(onProgress.mock.calls.filter(([progress]) => progress.message.includes('could not check'))).toHaveLength(2);
    const progress = onProgress.mock.calls.map(([value]) => value);
    expect(progress.map(value => value.completed)).toEqual([1, 2, 3, 4]);
    expect(progress.every(value => value.total === 4)).toBe(true);
    expect(client.createMessage.mock.calls[0][0]).toMatchObject({ model: 'a/b', reasoning: 'high', max_tokens: 32768 });
  });

  it('uses larger allowances for catalog defaults without recording an explicit level', async () => {
    const client = fakeClient();
    registerModelClient('openrouter', client);
    const run = await evaluateTournament({ models: ['a/b'], plugin: bench.name, turns: 1,
      judgePanel: [{ model: 'a/b' }], catalog, outputRoot });
    const calls = client.createMessage.mock.calls.map(([params]) => params);
    expect(calls.map(call => call.max_tokens)).toEqual([32768, 32768]);
    expect(calls.every(call => call.reasoning === undefined)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.candidates[0]).not.toHaveProperty('reasoning');
    expect(manifest.judges[0]).not.toHaveProperty('reasoning');
    expect(manifest.participant).not.toHaveProperty('reasoning');
    expect(run.leaderboard[0].modelName).toBe('b · default');
  });

  it('passes reasoning and the allowance to the D&D participant', async () => {
    const client = fakeClient();
    registerModelClient('openrouter', client);
    await dndPlugin.generateParticipantMessage(dndPlugin.scenarios[0], [{ turn: 1, role: 'candidate', content: 'What do you do?' }], undefined,
      { participant: { route: 'openrouter', model: 'a/b', reasoning: 'high', thinks: true } });
    expect(client.createMessage.mock.calls[0][0]).toMatchObject({
      model: 'a/b', reasoning: 'high', max_tokens: limits.MAX_TOKENS_PARTICIPANT_REASONING,
    });
  });

  it('keeps Anthropic thinking blocks verbatim when returning tool results', async () => {
    const thinking = { type: 'thinking', thinking: 'Check the tool.', signature: 'signed-thinking' };
    const toolContent = [thinking, { type: 'tool_use', id: 't1', name: 'check', input: {} }];
    const create = vi.fn(async (_body: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: {},
    } as unknown)).mockResolvedValueOnce({ content: toolContent, stop_reason: 'tool_use', usage: {} });
    registerModelClient('anthropic', createAnthropicModelClient(() => ({ create }), { retryDelayMs: 0 }));
    const plan = normalizeRunPlan({ bench: bench.name, candidates: ['anthropic:claude-opus-5-5@low'], turns: 1 });
    applyReasoningCatalog(plan, catalog);
    const handler = vi.fn(async () => 'Checked.');
    const result = await runScenario(plan.candidates[0], { ...bench.scenarios[0], maxTurns: 1 }, {
      ...bench, tools: [{ name: 'check', description: 'Check', parameters: { type: 'object' }, handler }],
    }, outputRoot);
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    for (const [body] of create.mock.calls) {
      expect(body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' }, max_tokens: 32768 });
    }
    expect(create.mock.calls[1][0].messages).toContainEqual({ role: 'assistant', content: toolContent });
  });
});
