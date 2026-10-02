import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelResponse } from '../../src/clients/types.js';
import type { Catalog } from '../../src/catalog.js';
import { REASONING_LEVELS, outputAllowance } from '../../src/config/reasoning.js';
import { createCustomPlugin } from '../../src/plugins/custom.js';
import { registerPlugin } from '../../src/plugins/index.js';
import { modelSlug, scenarioSlug } from '../../src/plugins/base.js';
import { parseStudy, studySeatRef, type Study } from '../../src/study/schema.js';
import { collectScores } from '../../src/study/collect.js';
import { analyzeStudy } from '../../src/study/analyze.js';
import { runStudy, reanalyzeStudy } from '../../src/study/runner.js';
import { repairStudy } from '../../src/study/repair.js';

const original = getModelClient('openrouter');
const bench = createCustomPlugin({
  name: 'study-reasoning', description: 'Study reasoning fixture',
  scenarios: [{ id: 'one', name: 'Scenario one', prompt: 'Give a useful answer.', rounds: 2,
    criteria: [{ name: 'quality', description: 'Useful and accurate' }] }],
});
registerPlugin(bench);
const catalog: Catalog = { source: 'live', models: ['openai/gpt-6.1-sol', 'google/judge', 'qwen/judge', 'meta/participant', 'z-ai/synthesis']
  .map(id => ({ id, name: id, contextLength: 10000, promptPrice: 2, completionPrice: 10,
    reasoningLevels: [...REASONING_LEVELS], reasonsByDefault: true })) };
let root: string;
let calls: CreateMessageParams[];
let failJudge: boolean;

function study(): Study {
  return parseStudy({
    id: 'reasoning-study', title: 'Reasoning study', reasoningEffort: 'low',
    benches: [{ bench: bench.name, label: 'Test bench', scenarios: ['one'] }],
    candidates: [
      { ref: 'openai/gpt-6.1-sol', family: 'openai', label: 'GPT low' },
      { ref: 'openai/gpt-6.1-sol@high', family: 'openai', label: 'GPT high' },
    ],
    judges: [{ ref: 'openai/gpt-6.1-sol', family: 'openai' }, { ref: 'google/judge@high', family: 'google' },
      { ref: 'qwen/judge', family: 'qwen' }],
    judgeLens: 'Assess usefulness.', participant: 'meta/participant', synthesizer: 'z-ai/synthesis@none',
  });
}
function reply(value: unknown): ModelResponse {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'fake',
    usage: { input_tokens: 1, output_tokens: 1 } };
}
function phase(call: CreateMessageParams) {
  return call.system?.startsWith('Synthesize') ? 'synthesis'
    : call.system?.includes('Score each listed criterion') ? 'judge'
    : call.model === 'meta/participant' ? 'participant' : 'candidate';
}
function options() {
  return { resultsRoot: root, catalog, confirm: vi.fn(async (_summary: string) => true),
    fetchUsage: vi.fn(async () => null) };
}
function runDir() { return path.join(root, 'run-study-reasoning-study-1-1'); }
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-reasoning-'));
  calls = []; failJudge = false;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  registerModelClient('openrouter', { isConfigured: () => true, createMessage: async params => {
    calls.push(params);
    if (phase(params) === 'judge') {
      if (failJudge && params.model.startsWith('openai/')) throw new Error('Missing judge');
      return reply({ scores: { quality: { score: 7, justification: 'Useful', quotes: [], improvement: 'More detail' } },
        rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine' });
    }
    if (phase(params) === 'synthesis') return reply({
      final_scores: { quality: { score: 7, confidence: 'high', outliers: [] } },
      average_score: 7, rule_errors_confirmed: [], assessment: 'fine', judge_agreement: 'agreed',
    });
    return reply('A useful answer.');
  } });
});
afterEach(() => {
  registerModelClient('openrouter', original);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('study reasoning', { timeout: 30_000 }, () => {
  it.each(REASONING_LEVELS)('accepts study default %s and keeps explicit seat levels', level => {
    // A distinct second model: at default high, "gpt" and "gpt@high" would be one candidate twice.
    const candidates = [study().candidates[0], { ref: 'google/gemini-3.1-pro-preview@high', family: 'google', label: 'Gemini' }];
    const input = parseStudy({ ...study(), reasoningEffort: level, candidates });
    expect(studySeatRef('openrouter:openai/gpt-6.1-sol', input)).toBe(`openai/gpt-6.1-sol@${level}`);
    expect(studySeatRef('openai/gpt-6.1-sol@HIGH', input)).toBe('openai/gpt-6.1-sol@high');
  });

  it.each([undefined, 'max'])('ignores the removed environment setting (%s) during run and repair', async previous => {
    vi.stubEnv('TOURNAMENT_REASONING_EFFORT', previous);
    const env = process.env;
    const accesses: string[] = [];
    process.env = new Proxy(env, {
      get(target, key) { if (key === 'TOURNAMENT_REASONING_EFFORT') accesses.push('read'); return Reflect.get(target, key); },
      set(target, key, value) { if (key === 'TOURNAMENT_REASONING_EFFORT') accesses.push('write'); return Reflect.set(target, key, value); },
      deleteProperty(target, key) { if (key === 'TOURNAMENT_REASONING_EFFORT') accesses.push('delete'); return Reflect.deleteProperty(target, key); },
    });
    try {
      const opts = options(); failJudge = true;
      await runStudy(study(), opts);
      expect(calls.filter(call => phase(call) === 'candidate').map(call => [call.model, call.reasoning]))
        .toEqual([['openai/gpt-6.1-sol', 'low'], ['openai/gpt-6.1-sol', 'low'],
          ['openai/gpt-6.1-sol', 'high'], ['openai/gpt-6.1-sol', 'high']]);
      expect(calls.every(call => !call.model.includes('@'))).toBe(true);
      expect(calls.filter(call => phase(call) === 'participant').every(call => call.reasoning === 'low')).toBe(true);
      expect(opts.confirm.mock.calls[0][0]).toContain('Reasoning:');
      expect(opts.confirm.mock.calls[0][0]).not.toContain('estimate does not count');
      failJudge = false; calls = [];
      expect(await repairStudy(study(), options())).toMatchObject({ judgeSeatsFilled: 2, remaining: [] });
      expect(calls.filter(call => phase(call) === 'judge').every(call => call.reasoning === 'low')).toBe(true);
      expect(calls.filter(call => phase(call) === 'synthesis').every(call => call.reasoning === 'none')).toBe(true);
      for (const call of calls) expect(call.max_tokens).toBe(outputAllowance(phase(call), call.reasoning !== 'none'));
      expect(fetch).not.toHaveBeenCalled();
    } finally { process.env = env; }
    expect(accesses).toEqual([]);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe(previous);
  });

  it('rejects unsupported levels before confirmation, usage reads, or calls', async () => {
    const opts = options();
    opts.catalog = { ...catalog, models: catalog.models.map(model => ({ ...model, reasoningLevels: ['high'] })) };
    await expect(runStudy(study(), opts)).rejects.toThrow(/accepts high/);
    expect(opts.confirm).not.toHaveBeenCalled(); expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(calls).toEqual([]); expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([true, false])('rebuilds every repair seat with its reasoning allowance (study default: %s)', async hasDefault => {
    const input = study();
    if (!hasDefault) delete input.reasoningEffort;
    await runStudy(input, options());
    const candidate = studySeatRef(input.candidates[0].ref, input);
    write(path.join(runDir(), 'candidates', modelSlug(candidate), scenarioSlug(bench.scenarios[0]), 'error.json'), { error: 'Cut off' });
    write(path.join(runDir(), 'failures.json'), [{ model: candidate, scenario: 'one', error: 'Cut off' }]);
    calls = [];
    expect(await repairStudy(input, options())).toMatchObject({ answersRerun: 1, remaining: [] });
    expect(new Set(calls.map(phase))).toEqual(new Set(['candidate', 'participant', 'judge', 'synthesis']));
    for (const call of calls) {
      const level = call.model === 'z-ai/synthesis' ? 'none'
        : call.model === 'google/judge' ? 'high' : hasDefault ? 'low' : undefined;
      expect(call.reasoning).toBe(level);
      expect(call.max_tokens).toBe(outputAllowance(phase(call), level !== 'none'));
      expect(call.model).not.toContain('@');
    }
  });

  it('keeps legacy rows and analysis identical and repairs into the existing bare-ID folders', async () => {
    const input = study();
    input.candidates[1] = { ref: 'google/judge', family: 'google', label: 'Google' };
    input.judges[1].ref = 'google/judge';
    const scenario = bench.scenarios[0];
    write(path.join(runDir(), 'run.json'), { runId: path.basename(runDir()), plugin: bench.name,
      candidates: input.candidates.map(candidate => ({ id: candidate.ref })), scenarios: [{ id: scenario.id, name: scenario.name }],
      judges: input.judges.map((judge, index) => ({ role: `custom_${index + 1}`, model: judge.ref, route: 'openrouter' })),
    });
    const expected = input.candidates.flatMap(candidate => input.judges.map((judge, index) => {
      write(path.join(runDir(), 'judges', modelSlug(candidate.ref), scenarioSlug(scenario), `custom_${index + 1}.json`),
        { scores: { quality: { score: 7, justification: 'Useful', quotes: [], improvement: 'More detail' } },
          rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine' });
      return { runId: path.basename(runDir()), bench: bench.name, benchLabel: 'Test bench',
        scenarioId: scenario.id, scenarioName: scenario.name, candidateRef: candidate.ref,
        candidateFamily: candidate.family, candidateLabel: candidate.label,
        judgeRole: `custom_${index + 1}`, judgeRef: judge.ref, judgeFamily: judge.family, criterion: 'quality', score: 7 };
    }));
    const studyDir = path.join(root, 'studies', input.id);
    write(path.join(studyDir, 'progress.json'), { done: ['1-1'], study: input });
    expect(collectScores(input, [runDir()])).toEqual(expected);
    expect(await reanalyzeStudy(input.id, root)).toEqual(analyzeStudy(expected));
    const candidate = input.candidates[0].ref;
    const judgeFile = path.join(runDir(), 'judges', modelSlug(candidate), scenarioSlug(scenario), 'custom_1.json');
    fs.unlinkSync(judgeFile);
    write(path.join(runDir(), 'candidates', modelSlug(candidate), scenarioSlug(scenario), 'turns.json'),
      [{ role: 'candidate', content: 'A useful answer.', turnNumber: 1 }]);
    write(path.join(runDir(), 'failures.json'), [{ model: candidate, scenario: 'one', error: 'judge openai judge: Missing judge' }]);
    expect(await repairStudy(input, options())).toMatchObject({ judgeSeatsFilled: 1, remaining: [] });
    expect(calls.find(call => phase(call) === 'judge')).toMatchObject({ reasoning: 'low', model: candidate });
    expect(collectScores(input, [runDir()])).toEqual(expected);
    expect(await reanalyzeStudy(input.id, root)).toEqual(analyzeStudy(expected));
  });

  it('rejects a recorded judge level that disagrees with the study', async () => {
    await runStudy(study(), options());
    const file = path.join(runDir(), 'run.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.judges[0].reasoning = 'high'; write(file, manifest);
    expect(() => collectScores(study(), [runDir()])).toThrow(/Judge seat 1 mismatch/);
  });
});

describe('study duplicate checks use the level that will run', () => {
  it('refuses a bare candidate and the same model at the study default', () => {
    const input = study();
    input.reasoningEffort = 'low';
    input.candidates.push({ ...input.candidates[0], ref: `${input.candidates[0].ref}@low`, label: 'Same model again' });
    expect(() => parseStudy(input)).toThrow(/duplicate candidate/);
  });

  it('allows the same model at two different levels', () => {
    const input = study();
    input.reasoningEffort = 'low';
    input.candidates.push({ ...input.candidates[0], ref: `${input.candidates[0].ref}@medium`, label: 'Same model, medium' });
    expect(() => parseStudy(input)).not.toThrow();
  });
});
