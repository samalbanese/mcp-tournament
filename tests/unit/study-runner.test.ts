import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelClient, ModelResponse } from '../../src/clients/types.js';
import type { Catalog } from '../../src/catalog.js';
import { createCustomPlugin } from '../../src/plugins/custom.js';
import { registerPlugin } from '../../src/plugins/index.js';
import { modelSlug, scenarioSlug } from '../../src/plugins/base.js';
import { parseStudy, type Study } from '../../src/study/schema.js';
import { planBatches } from '../../src/study/batches.js';
import { collectScores } from '../../src/study/collect.js';
import { runStudy, reanalyzeStudy } from '../../src/study/runner.js';
import { writeStudyOutputs } from '../../src/study/export.js';

const originals = { openrouter: getModelClient('openrouter'), anthropic: getModelClient('anthropic') };
const savedEnv = { ...process.env };
const bench = createCustomPlugin({
  name: 'study-test', description: 'Study runner fixture',
  scenarios: ['one', 'two'].map(id => ({
    id, name: `Scenario ${id}`, prompt: 'Give a useful answer.', rounds: 1,
    criteria: [{ name: 'quality', description: 'Useful and accurate' }],
  })),
});
registerPlugin(bench);
const catalog: Catalog = {
  source: 'live',
  models: ['openai/test', 'google/test', 'meta/participant', 'z-ai/synthesis', 'deepseek/test', 'qwen/test', 'anthropic/claude-test']
    .map(id => ({ id, name: id, contextLength: 10000, promptPrice: 2, completionPrice: 10 })),
};
let root: string;
let calls: CreateMessageParams[];
let efforts: Array<string | undefined>;
let failModels: Set<string>;

function study(): Study {
  return parseStudy({
    id: 'runner-test', title: 'Runner test', reasoningEffort: 'low',
    benches: [{ bench: bench.name, label: 'Test bench', scenarios: ['one', 'two'] }],
    candidates: [
      { ref: 'anthropic:claude-test', family: 'anthropic', label: 'Claude' },
      { ref: 'openai/test', family: 'openai', label: 'OpenAI' },
      { ref: 'google/test', family: 'google', label: 'Google' },
    ],
    judges: [
      { ref: 'anthropic:claude-test', family: 'anthropic' },
      { ref: 'openai/test', family: 'openai' },
      { ref: 'google/test', family: 'google' },
    ],
    judgeLens: 'Assess usefulness.', participant: 'meta/participant', synthesizer: 'z-ai/synthesis',
  });
}

function reply(value: unknown): ModelResponse {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'fake', usage: { input_tokens: 1, output_tokens: 1 } };
}

function fake(): ModelClient {
  return {
    isConfigured: () => true,
    createMessage: vi.fn(async (params: CreateMessageParams) => {
      calls.push(params);
      efforts.push(process.env.TOURNAMENT_REASONING_EFFORT);
      if (failModels.has(params.model)) throw new Error('Interrupted fixture');
      if (params.system?.startsWith('Synthesize')) return reply({
        final_scores: { quality: { score: 7, confidence: 'high', outliers: [] } },
        average_score: 7, rule_errors_confirmed: [], assessment: 'fine', judge_agreement: 'agreed',
      });
      if (params.system?.includes('Score each listed criterion')) return reply({
        scores: { quality: { score: 7, justification: 'Useful', quotes: [], improvement: 'More detail' } },
        rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine',
      });
      return reply('A useful answer.');
    }),
  };
}

function options() {
  return { resultsRoot: root, catalog, confirm: vi.fn(async (_summary: string) => true), fetchUsage: vi.fn(async (): Promise<number | null> => null) };
}
function read(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function studyDir() { return path.join(root, 'studies', study().id); }
function runDirs(input = study()) { return planBatches(input).map(batch => path.join(root, batch.runId)); }
function judgeFile(role = 'custom_1') {
  return path.join(runDirs()[0], 'judges', modelSlug(study().candidates[0].ref), scenarioSlug(bench.scenarios[0]), `${role}.json`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-runner-'));
  calls = []; efforts = []; failModels = new Set();
  delete process.env.TOURNAMENT_REASONING_EFFORT;
  registerModelClient('openrouter', fake());
  registerModelClient('anthropic', fake());
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
});
afterEach(() => {
  registerModelClient('openrouter', originals.openrouter);
  registerModelClient('anthropic', originals.anthropic);
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('study runner', () => {
  it('runs the real pipeline, collects judge seats, and records the usage delta', async () => {
    const opts = options();
    opts.fetchUsage.mockResolvedValueOnce(1.25).mockResolvedValueOnce(4.75);
    const result = await runStudy(study(), opts);
    expect(result).toMatchObject({ studyDir: studyDir(), batchesRun: 1, batchesSkipped: 0, cancelled: false });
    expect(result.analysis.answers).toEqual({ total: 6, analyzed: 6, dropped: 0 });
    const output = read(path.join(result.studyDir, 'study.json'));
    expect(output.meta.actualUsd).toBe(3.5);
    expect(output.meta.estimateUsd).toBeGreaterThan(0);
    expect(output.meta.runIds).toEqual(planBatches(study()).map(batch => batch.runId));
    expect(fs.existsSync(path.join(result.studyDir, 'scores.csv'))).toBe(true);
    expect(opts.confirm.mock.calls[0][0]).toMatch(/anthropic:.*excluded.*subscription/s);
    expect(opts.confirm.mock.calls[0][0]).toMatch(/1 batch.*3.*judge.*6.*answer.*≈ \$/s);
    const rows = collectScores(study(), runDirs());
    expect(rows).toHaveLength(18);
    expect(rows.filter(row => row.judgeRole === 'custom_1').every(row =>
      row.judgeRef === 'anthropic:claude-test' && row.judgeFamily === 'anthropic')).toBe(true);
    expect(result.analysis.contested[0].byJudge).toEqual({ anthropic: 7, openai: 7, google: 7 });
    expect(efforts.every(value => value === 'low')).toBe(true);
    expect(process.env).not.toHaveProperty('TOURNAMENT_REASONING_EFFORT');
  });

  it('excludes subscription pricing even when Claude appears in the catalog', async () => {
    const opts = options();
    opts.confirm.mockResolvedValue(false);
    await runStudy(study(), opts);
    const first = opts.confirm.mock.calls[0][0];
    opts.catalog = { ...catalog, models: catalog.models.filter(model => !model.id.startsWith('anthropic/')) };
    await runStudy(study(), opts);
    expect(opts.confirm.mock.calls[1][0]).toBe(first);
    expect(calls).toHaveLength(0);
  });

  it('declines without calls, usage requests, or output folders', async () => {
    const opts = options(); opts.confirm.mockResolvedValue(false);
    expect((await runStudy(study(), opts)).cancelled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(['bench', 'scenario'])('rejects an unknown %s before confirmation or calls', async kind => {
    const input = study();
    if (kind === 'bench') input.benches[0].bench = 'missing-bench';
    else input.benches[0].scenarios = ['missing-scenario'];
    const opts = options();
    await expect(runStudy(input, opts)).rejects.toThrow(/missing-/);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('preflights even a route used only in the last batch before confirmation', async () => {
    const input = study();
    input.candidates = [input.candidates[1], input.candidates[2],
      { ref: 'deepseek/test', family: 'deepseek', label: 'DeepSeek' },
      { ref: 'qwen/test', family: 'qwen', label: 'Qwen' }, input.candidates[0]];
    input.judges = input.judges.slice(1);
    registerModelClient('anthropic', { ...fake(), isConfigured: () => false });
    const opts = options();
    await expect(runStudy(input, opts)).rejects.toThrow(/not set up/);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('resumes finished batches, preserves partial data, and restores the env on failure', async () => {
    const input = study();
    input.candidates.push({ ref: 'deepseek/test', family: 'deepseek', label: 'DeepSeek' },
      { ref: 'qwen/test', family: 'qwen', label: 'Qwen' });
    failModels = new Set(['deepseek/test', 'qwen/test']);
    process.env.TOURNAMENT_REASONING_EFFORT = 'high';
    await expect(runStudy(input, options())).rejects.toThrow(/Every candidate\/scenario pair failed/);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe('high');
    expect(read(path.join(studyDir(), 'progress.json')).done).toEqual(['1-1']);
    const firstManifest = fs.readFileSync(path.join(runDirs(input)[0], 'run.json'), 'utf8');
    const partial = fs.readFileSync(path.join(runDirs(input)[1], 'failures.json'), 'utf8');
    failModels.clear(); calls.length = 0;
    const result = await runStudy(input, options());
    expect(result).toMatchObject({ batchesRun: 1, batchesSkipped: 1 });
    expect(result.analysis.answers.analyzed).toBe(10);
    const abandoned = fs.readdirSync(root).find(name => /^run-study-runner-test-1-2-abandoned-\d+$/.test(name));
    expect(abandoned).toBeDefined();
    expect(fs.readFileSync(path.join(root, abandoned!, 'failures.json'), 'utf8')).toBe(partial);
    expect(fs.readFileSync(path.join(runDirs(input)[0], 'run.json'), 'utf8')).toBe(firstManifest);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe('high');
    expect(read(path.join(studyDir(), 'progress.json')).done).toEqual(['1-1', '1-2']);
  });

  it.each(['caught failure', 'hard kill', 'legacy progress', 'failed reading'])('keeps spend on resume after %s', async kind => {
    const input = study();
    input.candidates.push({ ref: 'deepseek/test', family: 'deepseek', label: 'DeepSeek' },
      { ref: 'qwen/test', family: 'qwen', label: 'Qwen' });
    failModels = new Set(['deepseek/test', 'qwen/test']);
    const first = options();
    // Start 10, after batch 1 12, after the failed batch 13: 3 spent before the crash.
    first.fetchUsage.mockResolvedValueOnce(10).mockResolvedValueOnce(12).mockResolvedValueOnce(13);
    await expect(runStudy(input, first)).rejects.toThrow(/Every candidate\/scenario pair failed/);
    const progressFile = path.join(studyDir(), 'progress.json');
    const progress = read(progressFile);
    expect(progress).toMatchObject({ done: ['1-1'], spentUsd: 3, lastUsage: 13, study: input });
    if (kind === 'hard kill') {
      // The process died before recording usage after the in-flight batch.
      progress.spentUsd = 2;
      progress.lastUsage = 12;
    } else if (kind === 'legacy progress') {
      delete progress.lastUsage;
    } else if (kind === 'failed reading') {
      progress.spentUsd = null;
      progress.lastUsage = null;
    }
    fs.writeFileSync(progressFile, JSON.stringify(progress));
    failModels.clear();
    const second = options();
    const initialUsage = kind === 'hard kill' ? 12.4 : 13.5;
    const finalUsage = kind === 'hard kill' ? 15 : 16;
    second.fetchUsage.mockResolvedValueOnce(initialUsage).mockResolvedValueOnce(finalUsage);
    const onProgress = vi.fn(({ message }: { message: string }) => {
      if (message !== 'Running batch 1-2') return;
      const saved = read(progressFile);
      expect(saved.lastUsage).toBe(initialUsage);
      if (kind === 'failed reading') expect(saved.spentUsd).toBeNull();
      else expect(saved.spentUsd).toBeCloseTo(kind === 'hard kill' ? 2.4 : kind === 'legacy progress' ? 3 : 3.5);
    });
    const result = await runStudy(input, { ...second, onProgress });
    expect(result).toMatchObject({ batchesRun: 1, batchesSkipped: 1 });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ message: 'Running batch 1-2' }));
    expect(second.fetchUsage).toHaveBeenCalledTimes(2);
    expect(read(progressFile).lastUsage).toBe(finalUsage);
    const actualUsd = read(path.join(studyDir(), 'study.json')).meta.actualUsd;
    if (kind === 'failed reading') expect(actualUsd).toBeNull();
    else expect(actualUsd).toBeCloseTo(kind === 'hard kill' ? 5 : kind === 'legacy progress' ? 5.5 : 6);
  });

  it('skips missing judge files and verifies manifest seats before assigning families', async () => {
    await runStudy(study(), options());
    fs.unlinkSync(judgeFile());
    expect(collectScores(study(), runDirs())).toHaveLength(17);
    const file = path.join(runDirs()[0], 'run.json');
    const manifest = read(file);
    [manifest.judges[0], manifest.judges[1]] = [manifest.judges[1], manifest.judges[0]];
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => collectScores(study(), runDirs())).toThrow(/judge/i);
    delete manifest.judges;
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(collectScores(study(), runDirs())).toHaveLength(17);
  });

  it.each(['model', 'route', 'count'])('rejects a mismatched judge %s in saved evidence', async field => {
    await runStudy(study(), options());
    const file = path.join(runDirs()[0], 'run.json');
    const manifest = read(file);
    if (field === 'count') manifest.judges.pop();
    else manifest.judges[0][field] = field === 'model' ? 'claude-wrong' : 'openrouter';
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => collectScores(study(), runDirs())).toThrow(/judge/i);
  });

  it('keeps an inherited effort when the study does not set one', async () => {
    const input = study(); delete input.reasoningEffort;
    process.env.TOURNAMENT_REASONING_EFFORT = 'medium';
    await runStudy(input, options());
    expect(efforts.every(value => value === 'medium')).toBe(true);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe('medium');
  });

  it('deletes a previously unset effort after a failed batch', async () => {
    failModels = new Set(['claude-test', 'openai/test', 'google/test']);
    await expect(runStudy(study(), options())).rejects.toThrow(/Every candidate/);
    expect(process.env).not.toHaveProperty('TOURNAMENT_REASONING_EFFORT');
  });

  it('does not rerun or reread usage for an already completed study', async () => {
    const opts = options();
    opts.fetchUsage.mockResolvedValueOnce(1.25).mockResolvedValueOnce(4.75);
    await runStudy(study(), opts);
    calls.length = 0; opts.fetchUsage.mockClear();
    const result = await runStudy(study(), opts);
    expect(result).toMatchObject({ batchesRun: 0, batchesSkipped: 1 });
    expect(calls).toHaveLength(0);
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBe(3.5);
  });

  it('records the absolute input path and refuses to mix changed studies on resume', async () => {
    await runStudy(study(), { ...options(), studyFile: 'relative-study.json' });
    const progress = read(path.join(studyDir(), 'progress.json'));
    expect(progress.studyFile).toBe(path.resolve('relative-study.json'));
    expect(progress.study).toEqual(study());
    const input = study(); input.judgeLens = 'A changed rubric';
    const opts = options(); calls.length = 0;
    await expect(runStudy(input, opts)).rejects.toThrow(/saved study differs/i);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('reanalyzes without clients and preserves headlines and other metadata', async () => {
    await runStudy(study(), options());
    const file = path.join(studyDir(), 'study.json');
    const output = read(file);
    output.meta.headlines = [{ title: 'In this study', body: 'An edited finding.' }];
    fs.writeFileSync(file, JSON.stringify(output));
    fs.unlinkSync(judgeFile());
    calls.length = 0;
    const analysis = await reanalyzeStudy(study().id, root);
    expect(calls).toHaveLength(0);
    expect(read(file).meta).toEqual(output.meta);
    expect(read(file).analysis).toEqual(analysis);
    expect(fs.readFileSync(path.join(studyDir(), 'scores.csv'), 'utf8').split('\r\n')).toHaveLength(19);
  });

  it('reanalyzes an interrupted study from progress and the saved absolute study file', async () => {
    await runStudy(study(), options());
    const file = path.join(root, 'input.json');
    fs.writeFileSync(file, JSON.stringify(study()));
    fs.unlinkSync(path.join(studyDir(), 'study.json'));
    fs.writeFileSync(path.join(studyDir(), 'progress.json'), JSON.stringify({ done: ['1-1'], studyFile: file }));
    calls.length = 0;
    expect((await reanalyzeStudy(study().id, root)).answers.analyzed).toBe(6);
    expect(calls).toHaveLength(0);
  });

  it('records null cost and completes when the injected usage reader throws', async () => {
    const opts = options(); opts.fetchUsage.mockRejectedValue(new Error('Unavailable'));
    await runStudy(study(), opts);
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBeNull();
    expect(opts.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it.each(['primary', 'legacy'])('reads default usage using the %s OpenRouter key', async key => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_DICE_ORACLE_API_KEY = 'fixture-legacy';
    if (key === 'primary') process.env.OPENROUTER_API_KEY = 'fixture-primary';
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: { usage: 1.25 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { usage: 4.75 } }) });
    vi.stubGlobal('fetch', fetcher);
    const { fetchUsage: _unused, ...opts } = options();
    await runStudy(study(), opts);
    expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({
      headers: { Authorization: `Bearer fixture-${key}` },
    }));
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBe(3.5);
    expect(fs.readFileSync(path.join(studyDir(), 'study.json'), 'utf8')).not.toContain('fixture-');
  });

  it.each(['3.5', null, NaN, Infinity])('treats non-finite or non-numeric usage %s as unavailable', async usage => {
    process.env.OPENROUTER_API_KEY = 'fixture-primary';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { usage } }) })));
    const { fetchUsage: _unused, ...opts } = options();
    await runStudy(study(), opts);
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBeNull();
  });

  it.each(['request', 'json', 'status'])('completes when the default usage reader fails at %s', async stage => {
    process.env.OPENROUTER_API_KEY = 'fixture-secret';
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (stage === 'request') throw new Error('fixture-secret');
      return { ok: stage !== 'status', json: async () => { throw new Error('fixture-secret'); } };
    }));
    const { fetchUsage: _unused, ...opts } = options();
    await runStudy(study(), opts);
    const output = fs.readFileSync(path.join(studyDir(), 'study.json'), 'utf8');
    expect(JSON.parse(output).meta.actualUsd).toBeNull();
    expect(output).not.toContain('fixture-secret');
  });

  it('writes RFC 4180 fields that round-trip commas, quotes, and newlines', async () => {
    const result = await runStudy(study(), options());
    const rows = collectScores(study(), runDirs()).slice(0, 1);
    rows[0].scenarioName = 'A comma, a "quote"\nand a newline';
    const meta = read(path.join(studyDir(), 'study.json')).meta;
    writeStudyOutputs(studyDir(), study(), result.analysis, rows, meta);
    const csv = fs.readFileSync(path.join(studyDir(), 'scores.csv'), 'utf8');
    expect(csv).toContain('"A comma, a ""quote""\nand a newline"');
    // Parse complete records, including embedded newlines inside quoted fields.
    const records: string[][] = []; let record: string[] = []; let field = ''; let quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const char = csv[i];
      if (char === '"') {
        if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (char === ',' || char === '\r')) {
        record.push(field); field = '';
        if (char === '\r') { expect(csv[++i]).toBe('\n'); records.push(record); record = []; }
      } else field += char;
    }
    expect(records).toHaveLength(2);
    expect(records[1][records[0].indexOf('scenarioName')]).toBe(rows[0].scenarioName);
    expect(records[1]).toHaveLength(records[0].length);
  });
});
