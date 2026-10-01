import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { ModelClient } from '../../src/clients/types.js';
import { resetCatalogCache } from '../../src/catalog.js';
import { createServer } from '../../src/mcp/server.js';
import * as pipeline from '../../src/pipeline.js';
import { createContext } from '../../src/mcp/data.js';
import { buildPlanPreview } from '../../src/mcp/tools.js';

const LIVE = [
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', context_length: 1, pricing: { prompt: '0.00000027', completion: '0.0000004' } },
  { id: 'qwen/qwen3.5-flash-02-23', name: 'Qwen', context_length: 1, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini', context_length: 1, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
];
const okFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: LIVE }) })) as unknown as typeof fetch;
const downFetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;

const originalClient = getModelClient('openrouter');
const originalAnthropicClient = getModelClient('anthropic');
const savedEnv = { ...process.env };
let resultsRoot: string;
let spyClient: ModelClient & { createMessage: ReturnType<typeof vi.fn> };
let connections: Array<() => Promise<void>> = [];

async function connect(fetcher: typeof fetch, capabilities: Record<string, unknown> = {}) {
  const server = createServer({ resultsRoot, fetch: fetcher });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const close = async () => { await client.close(); await server.close(); };
  connections.push(close);
  return { client, server, close };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
  resetCatalogCache();
  resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-swap-'));
  spyClient = { createMessage: vi.fn(async () => { throw new Error('no model calls expected'); }) };
  registerModelClient('openrouter', spyClient);
  registerModelClient('anthropic', spyClient);
});

afterEach(async () => {
  for (const close of connections) await close();
  connections = [];
  registerModelClient('openrouter', originalClient);
  registerModelClient('anthropic', originalAnthropicClient);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
  fs.rmSync(resultsRoot, { recursive: true, force: true });
});

describe('tournament_options', () => {
  it('reports a registered anthropic client as ready without ANTHROPIC_API_KEY', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const original = getModelClient('anthropic');
    registerModelClient('anthropic', { ...spyClient, isConfigured: () => true });
    try {
      const { client, close } = await connect(okFetch);
      const result = await client.callTool({ name: 'tournament_options', arguments: {} }).finally(close);
      const providers = (result.structuredContent as { providers: Array<{ id: string; status: string }> }).providers;
      expect(providers.find(provider => provider.id === 'anthropic')?.status).toBe('ready');
    } finally {
      registerModelClient('anthropic', original);
    }
  });
  it('T9: falls back to curated models when the catalog is down', async () => {
    const { client, close } = await connect(downFetch);
    const result = await client.callTool({ name: 'tournament_options', arguments: {} });
    expect((result.structuredContent as { models: { source: string } }).models.source).toBe('curated-fallback');
    await close();
  });

  it('T9: never leaks key values and reports provider status', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-very-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-very-secret';
    const { client, close } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_options', arguments: {} });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('very-secret');
    const providers = (result.structuredContent as { providers: Array<{ id: string; status: string }> }).providers;
    expect(providers.find(provider => provider.id === 'anthropic')?.status).toBe('ready');
    expect(providers.find(provider => provider.id === 'chatgpt')?.status).toBe('not_set_up');
    expect(serialized).toContain('anthropic:');
    await close();
  });

  it('lists eight personas and default turns per scenario', async () => {
    const { client, close } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_options', arguments: { bench: 'dnd' } });
    const structured = result.structuredContent as { personas: unknown[]; benches: Array<{ scenarios: Array<{ defaultTurns: number }> }> };
    expect(structured.personas).toHaveLength(8);
    expect(structured.benches).toHaveLength(1);
    expect(structured.benches[0].scenarios.every(scenario => scenario.defaultTurns >= 1)).toBe(true);
    await close();
  });

  it('is free, reports defaults and limits, and shows provider setup in markdown', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_DICE_ORACLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { client } = await connect(downFetch);
    const result = await client.callTool({ name: 'tournament_options', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      providers: [
        { id: 'openrouter', status: 'not_set_up' },
        { id: 'anthropic', status: 'not_set_up' },
        { id: 'chatgpt', status: 'not_set_up' },
      ],
      defaults: { judgePanel: [ { persona: 'rules' }, { persona: 'creative' }, { persona: 'holistic' } ],
        turns: "each scenario's own default (shown per scenario)" },
      limits: { candidates: '1-4', judges: '1-5', turns: '1-10', customLens: '1-1000 characters' },
      models: { source: 'curated-fallback', liveCount: 0 },
    });
    const markdown = JSON.stringify(result.content);
    for (const text of ['catalog offline', 'ANTHROPIC_API_KEY', 'billed per use', 'ChatGPT plan', 'Default turns', 'Any OpenRouter model ID works']) {
      expect(markdown).toContain(text);
    }
    expect(markdown).not.toContain('\u2014');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unknown bench with the discovery hint before fetching a catalog', async () => {
    const { client } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_options', arguments: { bench: 'unknown-bench' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unknown plugin');
    expect(JSON.stringify(result.content)).toContain('tournament_list_benches');
    expect(okFetch).not.toHaveBeenCalled();
  });

  it('advertises both discovery tools as read-only, repeatable network reads', async () => {
    const { client } = await connect(okFetch);
    const { tools } = await client.listTools();
    for (const name of ['tournament_options', 'tournament_plan_run']) {
      const tool = tools.find(item => item.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
      expect(tool?.outputSchema).toBeDefined();
    }
  });
});

describe('tournament_plan_run', () => {
  it('T10: rejects an unknown model with suggestions and makes no model call', async () => {
    const { client, close } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: { bench: 'dnd', candidates: ['deepseek/deepseek-v3'] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('deepseek/deepseek-v3.2');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    await close();
  });

  it('T10: returns a resolved plan, summary, and estimate without any model call', async () => {
    const { client, close } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: {
      bench: 'dnd', candidates: ['deepseek/deepseek-v3.2'], turns: 2,
      judgePanel: [{ persona: 'skeptic', model: 'qwen/qwen3.5-flash-02-23' }, { model: 'google/gemini-2.5-flash-lite' }],
    } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { estimate: { display: string }; plan: { turns: number }; summary: string };
    expect(structured.estimate.display).toMatch(/^≈ /);
    expect(structured.plan.turns).toBe(2);
    expect(structured.summary).toContain('Skeptic Judge');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    await close();
  });

  it('warns (not errors) for an anthropic: ref without a key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { client, close } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: { bench: 'dnd', candidates: ['anthropic:claude-haiku-4-5'] } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { warnings: string[]; readyToRun: boolean };
    expect(structured.warnings.join(' ')).toContain('ANTHROPIC_API_KEY');
    expect(structured.readyToRun).toBe(false);
    await close();
  });

  it.each([
    { judgePanel: [{ model: 'deepseek/deepseek-v3' }] },
    { synthesizer: 'deepseek/deepseek-v3' },
    { participant: 'deepseek/deepseek-v3' },
  ])('checks every selected model role against the live catalog: %j', async overrides => {
    const { client } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: {
      candidates: ['deepseek/deepseek-v3.2'], ...overrides,
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unknown OpenRouter model');
    expect(JSON.stringify(result.content)).toContain('deepseek/deepseek-v3.2');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
  });

  it('shows all resolved defaults without secrets or model calls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-plan-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-plan-secret';
    const { client } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: {
      candidates: ['deepseek/deepseek-v3.2'], scenarios: ['dnd-combat'],
    } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      plan: { bench: 'dnd', turns: null, candidates: [{ ref: 'deepseek/deepseek-v3.2', route: 'openrouter' }],
        judges: [{ role: 'rules', persona: 'rules' }, { role: 'creative', persona: 'creative' }, { role: 'holistic', persona: 'holistic' }],
        synthesizer: { ref: 'deepseek/deepseek-v3.2', route: 'openrouter' },
        participant: { ref: 'deepseek/deepseek-v3.2', route: 'openrouter' } },
      readyToRun: true, warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain('plan-secret');
    expect(JSON.stringify(result.content)).toContain('Estimated cost:');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
    expect(okFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(okFetch).mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports missing OpenRouter credentials without echoing values or failing the preview', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_DICE_ORACLE_API_KEY;
    const { client } = await connect(okFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: { candidates: ['deepseek/deepseek-v3.2'] } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ readyToRun: false });
    expect(JSON.stringify(result.structuredContent?.warnings)).toContain('OPENROUTER_API_KEY');
  });

  it('keeps catalog failure usable without falsely blocking a configured provider', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { client } = await connect(downFetch);
    const result = await client.callTool({ name: 'tournament_plan_run', arguments: { candidates: ['vendor/unlisted-model'] } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ readyToRun: true,
      estimate: { usd: null, display: 'Cost estimate unavailable (model catalog offline).' } });
    expect(JSON.stringify(result.structuredContent?.warnings)).toContain('Model catalog offline');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
  });

  it('preserves legacy judge overrides and the new-panel precedence warning in exported previews', async () => {
    const ctx = createContext(resultsRoot, undefined, okFetch);
    const input = { candidates: ['deepseek/deepseek-v3.2'], turns: 1 };
    const legacy = { judges: 1, judgeModels: { rules: 'qwen/qwen3.5-flash-02-23' } };
    const preview = await buildPlanPreview(ctx, input, legacy);
    expect(preview.plan.judges).toHaveLength(1);
    expect(preview.plan.judges[0].model).toBe('qwen/qwen3.5-flash-02-23');
    const override = await buildPlanPreview(ctx, { ...input, judgePanel: [{ persona: 'skeptic' }] }, legacy);
    expect(override.plan.judges[0].persona).toBe('skeptic');
    expect(override.warnings).toContain('judgePanel was used; judges and judgeModels were ignored.');
  });
});

describe('tournament_evaluate confirm step', () => {
  const runArgs = { models: ['deepseek/deepseek-v3.2'], plugin: 'dnd', turns: 1, judges: 1 };

  function answer(client: Client, response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } | Error) {
    const handler = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    client.setRequestHandler(ElicitRequestSchema, handler);
    return handler;
  }

  it('T8: decline -> no model calls and no run folder', async () => {
    const { client, close } = await connect(okFetch, { elicitation: {} });
    const handler = answer(client, { action: 'decline' });
    const result = await client.callTool({ name: 'tournament_evaluate', arguments: runArgs });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('cancelled');
    expect(JSON.stringify(result.content)).toContain('Cancelled. Nothing was run and nothing was charged.');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
    await close();
  });

  it('a missing provider key errors before the form, so the user never confirms a run that cannot start', async () => {
    registerModelClient('openrouter', { ...spyClient, isConfigured: () => false });
    const { client, close } = await connect(okFetch, { elicitation: {} });
    const handler = answer(client, { action: 'accept', content: { confirm: true } });
    const result = await client.callTool({ name: 'tournament_evaluate', arguments: runArgs });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('OPENROUTER_API_KEY');
    expect(handler).not.toHaveBeenCalled();
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
    await close();
  });

  it('review focus 2: accept without confirm true, or a failing form, is treated as cancel', async () => {
    for (const response of [
      { action: 'accept' as const, content: {} }, { action: 'accept' as const, content: { confirm: false } }, new Error('client crashed'),
      { action: 'accept' as const }, { action: 'accept' as const, content: { confirm: 'true' } },
      { action: 'cancel' as const }, { action: 'decline' as const, content: { confirm: true } },
    ]) {
      const { client, close } = await connect(okFetch, { elicitation: {} });
      answer(client, response);
      const result = await client.callTool({ name: 'tournament_evaluate', arguments: runArgs });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { status: string }).status).toBe('cancelled');
      expect(result.structuredContent).toEqual({ status: 'cancelled', message: 'Cancelled. Nothing was run and nothing was charged.',
        runId: '', plugin: 'dnd', entries: [], failures: [], judgeFailures: [], resultsDir: '', judges: [] });
      expect(spyClient.createMessage).not.toHaveBeenCalled();
      await close();
    }
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
  });

  it('T8: accept with confirm true -> the run proceeds', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { client, close } = await connect(okFetch, { elicitation: {} });
    answer(client, { action: 'accept', content: { confirm: true } });
    await client.callTool({ name: 'tournament_evaluate', arguments: runArgs });
    expect(spyClient.createMessage).toHaveBeenCalled();
    await close();
  });

  it('T8: no elicitation capability -> runs with no form request', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { client, close } = await connect(okFetch);
    await client.callTool({ name: 'tournament_evaluate', arguments: runArgs });
    expect(spyClient.createMessage).toHaveBeenCalled();
    expect(okFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await close();
  });

  it('uses a false-by-default form with the legacy panel preview and a ten-minute timeout', async () => {
    const { client, server } = await connect(okFetch, { elicitation: { form: {} } });
    const form = vi.spyOn(server.server, 'elicitInput').mockRejectedValue(new Error('request timed out'));
    const result = await client.callTool({ name: 'tournament_evaluate', arguments: {
      ...runArgs, judgeModels: ['qwen/qwen3.5-flash-02-23'], synthesizerModel: 'google/gemini-2.5-flash-lite',
    } });
    expect(form).toHaveBeenCalledWith({ mode: 'form', message: expect.stringContaining('Rules Judge (qwen/qwen3.5-flash-02-23)'),
      requestedSchema: { type: 'object', properties: { confirm: {
        type: 'boolean', title: 'Start the run', description: 'Makes real, paid model calls.', default: false,
      } }, required: ['confirm'] } }, { timeout: 10 * 60 * 1000 });
    expect(form.mock.calls[0][0].message).toContain('Estimated cost:');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe('cancelled');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(resultsRoot)).toEqual([]);
  });

  it('returns completed and forwards the exact accepted choices to the pipeline', async () => {
    const run = vi.spyOn(pipeline, 'evaluateTournament').mockResolvedValue({ runId: 'run-test', runDir: 'test', leaderboard: [] });
    const { client } = await connect(okFetch, { elicitation: {} });
    const form = answer(client, { action: 'accept', content: { confirm: true } });
    const judgePanel = [{ model: 'qwen/qwen3.5-flash-02-23', customPersona: { name: 'Support expert', lens: 'Check the resolution.' } }];
    const result = await client.callTool({ name: 'tournament_evaluate', arguments: {
      ...runArgs, judgePanel, turns: 2, scenarios: ['dnd-combat'], participantModel: 'google/gemini-2.5-flash-lite',
    } });
    expect(form).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe('completed');
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...runArgs, judgePanel, turns: 2, scenarios: ['dnd-combat'], participantModel: 'google/gemini-2.5-flash-lite', outputRoot: resultsRoot,
    }));
  });

  it('does not call the preview or form without the capability, even for uncatalogued IDs', async () => {
    vi.spyOn(pipeline, 'evaluateTournament').mockResolvedValue({ runId: 'run-test', runDir: 'test', leaderboard: [] });
    const { client, server } = await connect(okFetch);
    const form = vi.spyOn(server.server, 'elicitInput');
    const result = await client.callTool({ name: 'tournament_evaluate', arguments: { models: ['uncatalogued/model'] } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe('completed');
    expect(form).not.toHaveBeenCalled();
    expect(okFetch).not.toHaveBeenCalled();
  });
});

describe('tournament_quick_test swappable settings', () => {
  it('forwards one judge and turns, completes, and never previews or requests a form', async () => {
    const quick = vi.spyOn(pipeline, 'quickTest').mockResolvedValue({ runId: 'run-test', runDir: 'test', leaderboard: [] });
    const { client, server } = await connect(okFetch, { elicitation: {} });
    const form = vi.spyOn(server.server, 'elicitInput');
    const args = { model: 'anthropic:claude-haiku-4-5', plugin: 'dnd', scenario: 'dnd-combat', turns: 2,
      judge: { persona: 'skeptic', model: 'qwen/qwen3.5-flash-02-23' } };
    const result = await client.callTool({ name: 'tournament_quick_test', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe('completed');
    expect(quick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(args));
    expect(form).not.toHaveBeenCalled();
    expect(okFetch).not.toHaveBeenCalled();
  });
});

describe('setup_tournament prompt', () => {
  it.each([undefined, '', ' , , '])('sends compare_models to setup when models are missing: %j', async models => {
    const { client } = await connect(okFetch);
    const prompt = await client.getPrompt({ name: 'compare_models', arguments: models === undefined ? {} : { models } });
    expect(JSON.stringify(prompt.messages)).toContain('setup_tournament');
    expect(spyClient.createMessage).not.toHaveBeenCalled();
  });

  it('includes the setup flow in server instructions and accepts a missing goal', async () => {
    const { client } = await connect(okFetch);
    expect(client.getInstructions()).toContain('preview with tournament_plan_run');
    expect(client.getInstructions()).toContain('get a yes before tournament_evaluate');
    const prompt = await client.getPrompt({ name: 'setup_tournament', arguments: {} });
    expect(JSON.stringify(prompt.messages)).toContain('Ask only for what is missing');
    expect(JSON.stringify(prompt.messages)).toContain('one short question at a time');
    expect(JSON.stringify(prompt.messages)).toContain('defaults are fine');
  });

  it('scripts the options -> ask -> plan -> confirm -> evaluate flow', async () => {
    const { client, close } = await connect(okFetch);
    const prompt = await client.getPrompt({ name: 'setup_tournament', arguments: { goal: 'support chats' } });
    const text = JSON.stringify(prompt.messages);
    const order = ['tournament_options', 'tournament_plan_run', 'tournament_evaluate'].map(name => text.indexOf(name));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('anthropic:');
    expect(text).toContain('support chats');
    expect(text).not.toContain('—');
    await close();
  });
});
