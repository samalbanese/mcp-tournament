import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelClient, ModelResponse } from '../../src/clients/types.js';
import { createCustomPlugin } from '../../src/plugins/custom.js';
import { registerPlugin } from '../../src/plugins/index.js';
import { modelSlug, scenarioSlug, type TournamentPlugin } from '../../src/plugins/base.js';
import { evaluateTournament, quickTest } from '../../src/pipeline.js';
import { dndPlugin } from '../../src/plugins/dnd.js';
import { generateParticipantMessage, setActivePlugin } from '../../src/agents/participant-agent.js';

const originalOpenRouter = getModelClient('openrouter');
const originalAnthropic = getModelClient('anthropic');
const savedEnv = { ...process.env };
let outputRoot: string;

function reply(text: string): ModelResponse {
  return { text, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' };
}

function judgeJson(criteria: string[]): string {
  return JSON.stringify({
    scores: Object.fromEntries(criteria.map(name => [name, { score: 7, justification: 'ok', quotes: [], improvement: 'more' }])),
    rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine',
  });
}

function synthesisJson(criteria: string[]): string {
  return JSON.stringify({
    final_scores: Object.fromEntries(criteria.map(name => [name, { score: 7, confidence: 'high', outliers: [] }])),
    average_score: 7, rule_errors_confirmed: [], assessment: 'fine', judge_agreement: 'agreed',
  });
}

/** One fake for every role, dispatched on the system prompt. */
function fakeClient(criteria: string[], log: CreateMessageParams[]): ModelClient {
  return {
    createMessage: vi.fn(async (params: CreateMessageParams) => {
      log.push(params);
      const system = params.system ?? '';
      if (system.startsWith('Synthesize')) return reply(synthesisJson(criteria));
      if (system.includes('Score each listed criterion')) return reply(judgeJson(criteria));
      if (system.includes('Stay in character')) return reply(`Follow-up ${log.length}?`);
      return reply(`Candidate answer ${log.length}`);
    }),
  };
}

const BENCH = createCustomPlugin({
  name: 'swap-test-bench',
  description: 'test',
  scenarios: [{ id: 'one-shot', name: 'One Shot', description: '', prompt: 'ORIGINAL PROMPT', rounds: 1, criteria: [{ name: 'quality', description: 'q' }] }],
});

const LONG_PLUGIN: TournamentPlugin = {
  ...BENCH,
  name: 'swap-test-long',
  scenarios: [{ ...BENCH.scenarios[0], id: 'long', name: 'Long', minTurns: 8, maxTurns: 8 }],
};

registerPlugin(BENCH);
registerPlugin(LONG_PLUGIN);

beforeEach(() => {
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-'));
  process.env.OPENROUTER_API_KEY = 'test-key';
});

afterEach(() => {
  registerModelClient('openrouter', originalOpenRouter);
  registerModelClient('anthropic', originalAnthropic);
  process.env = { ...savedEnv };
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

function candidateTurns(runDir: string, model: string, scenarioDir: string): Array<{ role: string; content: string }> {
  const name = scenarioDir === 'long' ? 'Long' : 'One Shot';
  return JSON.parse(fs.readFileSync(path.join(runDir, 'candidates', modelSlug(model), scenarioSlug({ name }), 'turns.json'), 'utf8'));
}

describe('swappable runs through the pipeline', () => {
  it('T1: turns override caps a long scenario; default keeps it', async () => {
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    const short = await evaluateTournament({ models: ['fake/model'], plugin: 'swap-test-long', turns: 2, judges: 2, outputRoot });
    expect(candidateTurns(short.runDir, 'fake/model', 'long').filter(turn => turn.role === 'candidate')).toHaveLength(2);
    const full = await evaluateTournament({ models: ['fake/model'], plugin: 'swap-test-long', judges: 2, outputRoot });
    expect(candidateTurns(full.runDir, 'fake/model', 'long').filter(turn => turn.role === 'candidate')).toHaveLength(8);
  });

  it('T2: a 1-round custom scenario with turns 3 gets real follow-ups', async () => {
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    const run = await evaluateTournament({ models: ['fake/model'], plugin: 'swap-test-bench', turns: 3, judges: 2, outputRoot });
    const participantTurns = candidateTurns(run.runDir, 'fake/model', 'one').filter(turn => turn.role === 'participant' && turn.content !== 'ORIGINAL PROMPT');
    expect(participantTurns.length).toBe(2);
    expect(participantTurns.every(turn => turn.content.startsWith('Follow-up'))).toBe(true);
  });

  it('T3 + T4: lens in system prompt, plugin role passed, duplicate seats both written', async () => {
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    const run = await evaluateTournament({
      models: ['fake/model'], plugin: 'swap-test-bench', outputRoot,
      judgePanel: [{ persona: 'skeptic' }, { persona: 'skeptic' }, { customPersona: { lens: 'Judge like a pirate.' } }],
    });
    const judgeSystems = log.map(call => call.system ?? '').filter(system => system.includes('Score each listed criterion'));
    expect(judgeSystems.some(system => system.startsWith('You are a skeptical reviewer.'))).toBe(true);
    expect(judgeSystems.some(system => system.startsWith('Judge like a pirate. '))).toBe(true);
    const judgePrompts = log.filter(call => (call.system ?? '').includes('Score each listed criterion'))
      .map(call => call.messages[0].content);
    expect(judgePrompts.filter(prompt => typeof prompt === 'string' && prompt.includes('You are the rules judge'))).toHaveLength(2);
    expect(judgePrompts.some(prompt => typeof prompt === 'string' && prompt.includes('You are the holistic judge'))).toBe(true);
    const judgeDir = path.join(run.runDir, 'judges');
    const files = fs.readdirSync(judgeDir, { recursive: true }).map(String);
    expect(files.some(file => file.endsWith('skeptic.json'))).toBe(true);
    expect(files.some(file => file.endsWith('skeptic_2.json'))).toBe(true);
    expect(files.some(file => file.endsWith('custom_3.json'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.judges[2]).toMatchObject({ role: 'custom_3', persona: 'custom', route: 'openrouter', customLens: 'Judge like a pirate.' });
    expect(manifest.judges[0].customLens).toBeUndefined();
    expect(manifest.turns).toBeNull();
    expect(manifest.participant).toEqual({ model: 'deepseek/deepseek-v3.2', route: 'openrouter' });
    expect(manifest.candidates[0].route).toBe('openrouter');
  });

  it('routes an anthropic: candidate and participant through the anthropic client', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    const openLog: CreateMessageParams[] = [];
    const anthropicLog: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], openLog));
    registerModelClient('anthropic', fakeClient(['quality'], anthropicLog));
    await evaluateTournament({
      models: ['anthropic:claude-haiku-4-5'], plugin: 'swap-test-bench', turns: 2, judges: 2,
      participantModel: 'anthropic:claude-haiku-4-5', outputRoot,
    });
    expect(anthropicLog.every(call => call.model === 'claude-haiku-4-5')).toBe(true);
    expect(anthropicLog.some(call => (call.system ?? '').includes('Stay in character'))).toBe(true);
    expect(openLog.some(call => call.model === 'claude-haiku-4-5')).toBe(false);
  });

  it('a one-judge panel scores without the synthesizer instead of failing', async () => {
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    const run = await evaluateTournament({ models: ['fake/model'], plugin: 'swap-test-bench', judgePanel: [{ persona: 'strict' }], outputRoot });
    expect(run.failures).toEqual([]);
    expect(run.judgeFailures).toEqual([]);
    expect(log.some(call => (call.system ?? '').startsWith('Synthesize'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.synthesizer).toBeNull();
  });

  it('review focus 3: missing provider key fails before any folder or model call', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    registerModelClient('anthropic', originalAnthropic);
    await expect(evaluateTournament({ models: ['anthropic:claude-haiku-4-5'], plugin: 'swap-test-bench', outputRoot }))
      .rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fs.readdirSync(outputRoot)).toEqual([]);
    expect(log).toHaveLength(0);
  });

  it('routes judge seats and synthesis through Anthropic and records their routes', async () => {
    const openLog: CreateMessageParams[] = [];
    const anthropicLog: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], openLog));
    registerModelClient('anthropic', fakeClient(['quality'], anthropicLog));
    const run = await evaluateTournament({
      models: ['fake/model'], plugin: BENCH.name, outputRoot,
      judgePanel: [{ model: 'anthropic:claude-haiku-4-5' }, { persona: 'audience' }],
      synthesizerModel: 'anthropic:claude-sonnet-5-5',
    });
    expect(anthropicLog.map(call => call.model)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);
    expect(anthropicLog[0].system).toContain('Score each listed criterion');
    expect(anthropicLog[1].system).toMatch(/^Synthesize/);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.judges[0]).toMatchObject({ model: 'claude-haiku-4-5', route: 'anthropic', persona: 'rules' });
    expect(manifest.synthesizer).toEqual({ model: 'claude-sonnet-5-5', route: 'anthropic' });
  });

  it.each([
    { judgePanel: [{ model: 'anthropic:claude-haiku-4-5' }], label: 'Judge' },
    { synthesizerModel: 'anthropic:claude-haiku-4-5', label: 'Synthesizer' },
    { participantModel: 'anthropic:claude-haiku-4-5', label: 'Simulated user' },
  ])('checks missing credentials for $label before creating a run', async ({ label, ...options }) => {
    delete process.env.ANTHROPIC_API_KEY;
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    registerModelClient('anthropic', originalAnthropic);
    await expect(evaluateTournament({ models: ['fake/model'], plugin: BENCH.name, outputRoot, ...options }))
      .rejects.toThrow(new RegExp(`${label}.*ANTHROPIC_API_KEY`));
    expect(log).toHaveLength(0);
    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });

  it.each([false, true])('skips unavailable synthesis for a single judge with quick=%s', async quick => {
    delete process.env.ANTHROPIC_API_KEY;
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    registerModelClient('anthropic', originalAnthropic);
    const run = await evaluateTournament({
      models: ['fake/model'], plugin: BENCH.name, judges: 1, quick,
      synthesizerModel: 'anthropic:claude-haiku-4-5', outputRoot,
    });
    expect(run.failures).toEqual([]);
    expect(run.leaderboard[0].overallAverage).toBe(7);
    expect(log).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8')).synthesizer).toBeNull();
  });

  it('quickTest forwards a custom seat and turn override', async () => {
    const log: CreateMessageParams[] = [];
    registerModelClient('openrouter', fakeClient(['quality'], log));
    const run = await quickTest({
      model: 'fake/model', plugin: BENCH.name, turns: 2, outputRoot,
      judge: { customPersona: { name: 'Careful Reader', lens: 'Check practical usefulness.' } },
    });
    expect(candidateTurns(run.runDir, 'fake/model', 'one').filter(turn => turn.role === 'candidate')).toHaveLength(2);
    expect(log.some(call => call.system?.startsWith('Check practical usefulness. '))).toBe(true);
    expect(log.some(call => call.system?.startsWith('Synthesize'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(manifest.turns).toBe(2);
    expect(manifest.judges).toHaveLength(1);
    expect(manifest.judges[0].name).toBe('Careful Reader');
  });

  it('D&D and the participant adapter honor runtime routing and env-based fallback', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_DICE_ORACLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const log: CreateMessageParams[] = [];
    const client = fakeClient(['quality'], log);
    registerModelClient('anthropic', client);
    const runtime = { participant: { route: 'anthropic' as const, model: 'claude-haiku-4-5' } };
    const turns = [{ turn: 1, role: 'candidate' as const, content: 'What do you do?' }];
    setActivePlugin(dndPlugin);
    await generateParticipantMessage(dndPlugin.scenarios[0], turns, undefined, runtime);
    expect(log).toHaveLength(0);
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    await generateParticipantMessage(dndPlugin.scenarios[0], turns, undefined, runtime);
    expect(log).toHaveLength(1);
    expect(log[0].model).toBe('claude-haiku-4-5');
    expect(log[0].system).toContain('You are roleplaying');
    delete process.env.ANTHROPIC_API_KEY;
    await BENCH.generateParticipantMessage({ ...BENCH.scenarios[0], maxTurns: 2 }, turns, undefined, runtime);
    expect(log).toHaveLength(1);
  });
});
