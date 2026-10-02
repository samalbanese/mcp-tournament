import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelClient, registerModelClient, type ClientRoute } from '../../src/clients/index.js';
import type { CreateMessageParams, ModelClient, ModelResponse } from '../../src/clients/types.js';
import type { Catalog } from '../../src/catalog.js';
import { createCustomPlugin } from '../../src/plugins/custom.js';
import { registerPlugin } from '../../src/plugins/index.js';
import { modelSlug, scenarioSlug } from '../../src/plugins/base.js';
import { parseStudy, StudyError, type Study } from '../../src/study/schema.js';
import { planBatches } from '../../src/study/batches.js';
import { collectScores } from '../../src/study/collect.js';
import { runStudy } from '../../src/study/runner.js';
import { repairStudy } from '../../src/study/repair.js';

const originals = { openrouter: getModelClient('openrouter'), anthropic: getModelClient('anthropic') };
const savedEnv = { ...process.env };
const bench = createCustomPlugin({
  name: 'study-repair-test', description: 'Study repair fixture',
  scenarios: ['one', 'two'].map(id => ({
    id, name: `Scenario ${id}`, prompt: `Prompt ${id}`, rounds: 1,
    criteria: [{ name: 'quality', description: 'Useful and accurate' }],
  })),
});
registerPlugin(bench);
const catalog: Catalog = {
  source: 'live',
  models: ['openai/test', 'google/test', 'meta/participant', 'z-ai/synthesis', 'deepseek/test', 'qwen/test']
    .map(id => ({ id, name: id, contextLength: 10000, promptPrice: 2, completionPrice: 10 })),
};
interface Call {
  route: ClientRoute;
  model: string;
  phase: 'answer' | 'judge' | 'synthesis';
  text: string;
  effort: string | undefined;
}
let root: string;
let calls: Call[];
let failure: (call: Call) => string | undefined;
let invalid: (call: Call) => boolean;
let synthesisScore: number;
let duringCall: (call: Call) => Promise<void>;

function study(): Study {
  return parseStudy({
    id: 'repair-test', title: 'Repair test', reasoningEffort: 'low',
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
function fake(route: ClientRoute): ModelClient {
  return {
    isConfigured: () => true,
    createMessage: vi.fn(async (params: CreateMessageParams) => {
      const phase = params.system?.startsWith('Synthesize') ? 'synthesis'
        : params.system?.includes('Score each listed criterion') ? 'judge' : 'answer';
      const call: Call = { route, model: params.model, phase, text: JSON.stringify(params.messages),
        effort: process.env.TOURNAMENT_REASONING_EFFORT };
      calls.push(call);
      await duringCall(call);
      const error = failure(call);
      if (error) throw new Error(error);
      if (invalid(call)) return reply('invalid score output');
      if (phase === 'synthesis') return reply({
        final_scores: { quality: { score: synthesisScore, confidence: 'high', outliers: [] } },
        average_score: synthesisScore, rule_errors_confirmed: [], assessment: 'fine', judge_agreement: 'agreed',
      });
      if (phase === 'judge') return reply({
        scores: { quality: { score: 7, justification: 'Useful', quotes: [], improvement: 'More detail' } },
        rule_errors: [], tool_errors: [], flags: [], overall_impression: 'fine',
      });
      return reply(`answer-${params.model}-${call.text.includes('Prompt two') ? 'two' : 'one'}`);
    }),
  };
}
function options() {
  return { resultsRoot: root, catalog, confirm: vi.fn(async (_summary: string) => true),
    fetchUsage: vi.fn(async (): Promise<number | null> => 0) };
}
function read(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function studyDir() { return path.join(root, 'studies', study().id); }
function runDirs(input = study()) { return planBatches(input).map(batch => path.join(root, batch.runId)); }
function artifact(area: 'judges' | 'candidates', file: string, model = 'openai/test', scenario = 0) {
  return path.join(runDirs()[0], area, modelSlug(model), scenarioSlug(bench.scenarios[scenario]), file);
}
function failuresFile() { return path.join(runDirs()[0], 'failures.json'); }
function missingJudge(call: Call) {
  return call.phase === 'judge' && call.route === 'anthropic' && call.text.includes('answer-openai/test-one');
}
async function finishedWithGap() {
  failure = call => missingJudge(call) ? 'Subscription exhausted' : undefined;
  const opts = options();
  opts.fetchUsage.mockResolvedValueOnce(10).mockResolvedValueOnce(12);
  await runStudy(study(), opts);
  failure = () => undefined;
  calls.length = 0;
}
function snapshot(dir = root): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file, 'utf8')]];
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-repair-'));
  calls = []; failure = () => undefined; invalid = () => false; synthesisScore = 7;
  duringCall = async () => undefined;
  delete process.env.TOURNAMENT_REASONING_EFFORT;
  registerModelClient('openrouter', fake('openrouter'));
  registerModelClient('anthropic', fake('anthropic'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
});
afterEach(() => {
  registerModelClient('openrouter', originals.openrouter);
  registerModelClient('anthropic', originals.anthropic);
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

// Each test runs a whole fake study on disk first; on a busy machine that can pass 5 s.
describe('study repair', { timeout: 30_000 }, () => {
  it('fills only the missing seat and refreshes synthesis, leaderboard, and study scores', async () => {
    await finishedWithGap();
    const before = snapshot();
    expect(fs.existsSync(artifact('judges', 'custom_1.json'))).toBe(false);
    fs.writeFileSync(artifact('judges', 'custom_1.failed.txt'), 'old invalid output');
    synthesisScore = 9;
    const onProgress = vi.fn();
    const opts = options();
    const result = await repairStudy(study(), { ...opts, onProgress });
    expect(result).toMatchObject({ studyDir: studyDir(), answersRerun: 0, judgeSeatsFilled: 1,
      remaining: [], cancelled: false, analysis: { answers: { analyzed: 6 } } });
    expect(calls.map(({ route, model, phase }) => ({ route, model, phase }))).toEqual([
      { route: 'anthropic', model: 'claude-test', phase: 'judge' },
      { route: 'openrouter', model: 'z-ai/synthesis', phase: 'synthesis' },
    ]);
    expect(fs.existsSync(artifact('judges', 'custom_1.json'))).toBe(true);
    expect(fs.existsSync(artifact('judges', 'custom_1.failed.txt'))).toBe(false);
    expect(fs.existsSync(failuresFile())).toBe(false);
    expect(read(artifact('judges', 'synthesis.json')).average_score).toBe(9);
    expect(read(path.join(runDirs()[0], 'leaderboard.json')).find((row: { modelId: string }) => row.modelId === 'openai/test').overallAverage).toBe(8);
    const rows = collectScores(study(), runDirs());
    expect(rows).toHaveLength(18);
    expect(rows.filter(row => row.candidateRef === 'openai/test' && row.scenarioId === 'one' && row.judgeRole === 'custom_1')).toHaveLength(1);
    const csv = fs.readFileSync(path.join(studyDir(), 'scores.csv'), 'utf8');
    expect(csv).toContain('openai/test,openai,OpenAI,custom_1,anthropic:claude-test,anthropic,quality,7');
    const changed = new Set([failuresFile(), artifact('judges', 'synthesis.json'),
      path.join(runDirs()[0], 'leaderboard.json'), ...['progress.json', 'study.json', 'scores.csv'].map(file => path.join(studyDir(), file))]);
    for (const [file, contents] of Object.entries(before)) {
      if (!changed.has(file)) expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    }
    expect(opts.confirm.mock.calls[0][0]).toContain('0 answer(s) to rerun and 1 judge seat(s)');
    expect(onProgress.mock.calls.map(([text]) => text)).toEqual([
      'Repairing batch 1-1', 'Starting judge anthropic judge for 1-1 openai/test one',
      'Finished judge anthropic judge for 1-1 openai/test one: filled', 'Finished batch 1-1: 0 gap(s) remain',
    ]);
  });

  it('refreshes only the synthesis for a synthesis gap left by an earlier repair', async () => {
    await finishedWithGap();
    failure = call => call.phase === 'synthesis' ? 'Synthesizer down' : undefined;
    const first = await repairStudy(study(), options());
    expect(first.judgeSeatsFilled).toBe(1);
    expect(first.remaining).toEqual([expect.objectContaining({ model: 'openai/test', scenario: 'one', error: 'synthesis: Synthesizer down' })]);
    expect(read(failuresFile())).toEqual([{ model: 'openai/test', scenario: 'one', error: 'synthesis: Synthesizer down' }]);
    const turns = fs.readFileSync(artifact('candidates', 'turns.json'), 'utf8');
    failure = () => undefined; calls.length = 0; synthesisScore = 9;
    const second = await repairStudy(study(), options());
    expect(second).toMatchObject({ answersRerun: 0, judgeSeatsFilled: 0, remaining: [] });
    expect(calls.map(call => call.phase)).toEqual(['synthesis']);
    expect(fs.readFileSync(artifact('candidates', 'turns.json'), 'utf8')).toBe(turns);
    expect(read(artifact('judges', 'synthesis.json')).average_score).toBe(9);
    expect(fs.existsSync(failuresFile())).toBe(false);
  });

  it('re-judges a saved answer whose judging failed instead of generating a new one', async () => {
    await finishedWithGap();
    write(failuresFile(), [{ model: 'openai/test', scenario: 'one', error: 'Synthesis failed: timeout' }]);
    const turns = fs.readFileSync(artifact('candidates', 'turns.json'), 'utf8');
    const result = await repairStudy(study(), options());
    expect(result).toMatchObject({ answersRerun: 0, judgeSeatsFilled: 1, remaining: [] });
    expect(calls.map(({ model, phase }) => `${phase}:${model}`)).toEqual(['judge:claude-test', 'synthesis:z-ai/synthesis']);
    expect(fs.readFileSync(artifact('candidates', 'turns.json'), 'utf8')).toBe(turns);
  });

  it('keeps a seat filled by an interrupted repair and only refreshes the synthesis', async () => {
    await finishedWithGap();
    write(artifact('judges', 'custom_1.json'), read(artifact('judges', 'custom_2.json')));
    const result = await repairStudy(study(), options());
    expect(result).toMatchObject({ answersRerun: 0, judgeSeatsFilled: 0, remaining: [] });
    expect(calls.map(call => call.phase)).toEqual(['synthesis']);
    expect(fs.existsSync(failuresFile())).toBe(false);
  });

  it('clears an earlier attempt\'s scores before regenerating an answer', async () => {
    await finishedWithGap();
    const model = 'openai/test';
    write(artifact('candidates', 'error.json', model), { error: 'Cut off' });
    write(failuresFile(), [{ model, scenario: 'one', error: 'Cut off' }]);
    expect(fs.existsSync(artifact('judges', 'custom_3.json', model))).toBe(true);
    failure = call => call.phase === 'judge' && call.route === 'openrouter' && call.model === 'google/test' ? 'Judge down' : undefined;
    const result = await repairStudy(study(), options());
    expect(result.answersRerun).toBe(1);
    expect(result.remaining).toEqual([expect.objectContaining({ model, scenario: 'one', error: 'judge google judge: Judge down' })]);
    expect(fs.existsSync(artifact('judges', 'custom_3.json', model))).toBe(false);
    expect(fs.existsSync(artifact('candidates', 'error.json', model))).toBe(false);
  });

  it('finishes an interrupted repair and recovers its spend', async () => {
    await finishedWithGap();
    const progressFile = path.join(studyDir(), 'progress.json');
    const leaderboard = path.join(runDirs()[0], 'leaderboard.json');
    write(progressFile, { ...read(progressFile), spentUsd: 2, lastUsage: 10, repairing: true });
    fs.rmSync(failuresFile());
    fs.rmSync(leaderboard);
    const opts = options(); opts.fetchUsage.mockResolvedValue(13);
    const result = await repairStudy(study(), opts);
    expect(opts.confirm.mock.calls[0][0]).toContain('A previous repair stopped early');
    expect(calls).toHaveLength(0);
    expect(result.analysis).not.toBeNull();
    expect(fs.existsSync(leaderboard)).toBe(true);
    const progress = read(progressFile);
    expect(progress).toMatchObject({ spentUsd: 5, lastUsage: 13 });
    expect(progress.repairing).toBeUndefined();
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBe(5);
  });

  it('reruns a skipped pair with all judges and removes the old execution error', async () => {
    failure = call => call.phase === 'answer' && call.route === 'anthropic' && call.text.includes('Prompt one')
      ? 'Subscription exhausted' : undefined;
    const first = await runStudy(study(), options());
    expect(first.analysis.answers.analyzed).toBe(5);
    const model = 'anthropic:claude-test';
    expect(fs.existsSync(artifact('candidates', 'error.json', model))).toBe(true);
    failure = () => undefined; calls.length = 0;
    const result = await repairStudy(study(), options());
    expect(result).toMatchObject({ answersRerun: 1, judgeSeatsFilled: 0, remaining: [], analysis: { answers: { analyzed: 6 } } });
    expect(fs.existsSync(artifact('candidates', 'error.json', model))).toBe(false);
    expect(read(artifact('candidates', 'turns.json', model))).toHaveLength(2);
    for (const role of ['custom_1', 'custom_2', 'custom_3']) expect(fs.existsSync(artifact('judges', `${role}.json`, model))).toBe(true);
    expect(calls.filter(call => call.phase === 'answer').map(call => call.model)).toEqual(['claude-test']);
    expect(calls.filter(call => call.phase === 'judge').map(call => call.model)).toEqual(['claude-test', 'openai/test', 'google/test']);
    expect(fs.existsSync(failuresFile())).toBe(false);
  });

  it.each(['throw', 'invalid'])('keeps a judge gap when the repair returns %s', async kind => {
    await finishedWithGap();
    if (kind === 'throw') failure = call => missingJudge(call) ? 'Still unavailable' : undefined;
    else invalid = missingJudge;
    const oldSynthesis = fs.readFileSync(artifact('judges', 'synthesis.json'), 'utf8');
    const result = await repairStudy(study(), options());
    const error = `judge anthropic judge: ${kind === 'throw' ? 'Still unavailable' : 'anthropic judge returned invalid score JSON'}`;
    expect(result).toMatchObject({ answersRerun: 0, judgeSeatsFilled: 0,
      remaining: [{ runId: path.basename(runDirs()[0]), model: 'openai/test', scenario: 'one', error }] });
    expect(read(failuresFile())).toEqual([{ model: 'openai/test', scenario: 'one', error }]);
    expect(fs.readFileSync(artifact('judges', 'synthesis.json'), 'utf8')).toBe(oldSynthesis);
    expect(calls.every(missingJudge)).toBe(true);
    if (kind === 'invalid') expect(fs.readFileSync(artifact('judges', 'custom_1.failed.txt'), 'utf8')).toBe('invalid score output');
  });

  it('does nothing when no repairable gaps exist, including unmatched entries', async () => {
    await runStudy(study(), options());
    const opts = options(); calls.length = 0;
    const result = await repairStudy(study(), opts);
    expect(result).toMatchObject({ cancelled: false, analysis: null, remaining: [], answersRerun: 0, judgeSeatsFilled: 0 });
    const unknown = { model: 'unknown', scenario: 'one', error: 'Original error' };
    write(failuresFile(), [unknown]);
    const before = snapshot();
    expect((await repairStudy(study(), opts)).remaining).toEqual([{ runId: path.basename(runDirs()[0]), ...unknown }]);
    expect(snapshot()).toEqual(before);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('declines without calls or any file changes', async () => {
    await finishedWithGap();
    const before = snapshot();
    const opts = options(); opts.confirm.mockResolvedValue(false);
    expect(await repairStudy(study(), opts)).toMatchObject({ cancelled: true, analysis: null,
      answersRerun: 0, judgeSeatsFilled: 0, remaining: [{ error: 'judge anthropic judge: Subscription exhausted' }] });
    expect(snapshot()).toEqual(before);
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects missing progress and a changed saved study before confirmation', async () => {
    const opts = options();
    await expect(repairStudy(study(), opts)).rejects.toThrow(new StudyError('No progress for this study'));
    await finishedWithGap();
    const input = study(); input.judgeLens = 'Changed';
    await expect(repairStudy(input, opts)).rejects.toThrow(StudyError);
    await expect(repairStudy(input, opts)).rejects.toThrow(/saved study differs/);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([[20, 23, 5], [null, 23, null], [20, null, null]])('adds repair usage %s to %s to prior spend', async (before, after, expected) => {
    await finishedWithGap();
    const file = path.join(studyDir(), 'study.json');
    const output = read(file);
    output.meta.headlines = [{ title: 'In this study', body: 'Keep this finding.' }];
    write(file, output);
    const opts = options(); opts.fetchUsage.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await repairStudy(study(), opts);
    expect(opts.fetchUsage).toHaveBeenCalledTimes(2);
    expect(read(path.join(studyDir(), 'progress.json'))).toMatchObject({ spentUsd: expected, lastUsage: after });
    expect(read(file).meta).toEqual({ ...output.meta, actualUsd: expected });
    expect(fs.existsSync(path.join(studyDir(), 'progress.json.tmp'))).toBe(false);
  });

  it('leaves unfinished batches and their failures untouched', async () => {
    const input = study();
    input.candidates.push({ ref: 'deepseek/test', family: 'deepseek', label: 'DeepSeek' },
      { ref: 'qwen/test', family: 'qwen', label: 'Qwen' });
    failure = call => missingJudge(call) ? 'Subscription exhausted'
      : ['deepseek/test', 'qwen/test'].includes(call.model) ? 'Interrupted' : undefined;
    await expect(runStudy(input, options())).rejects.toThrow(/Every candidate/);
    const unfinished = runDirs(input)[1];
    const before = snapshot(unfinished);
    calls.length = 0; failure = () => undefined;
    const result = await repairStudy(input, options());
    expect(result.judgeSeatsFilled).toBe(1);
    expect(result.remaining).toEqual([]);
    expect(snapshot(unfinished)).toEqual(before);
    expect(read(path.join(studyDir(), 'progress.json')).done).toEqual(['1-1']);
    expect(calls.some(call => ['deepseek/test', 'qwen/test'].includes(call.model))).toBe(false);
  });

  it('counts spend a hard-killed run never recorded before repairing its finished batches', async () => {
    const input = study();
    input.candidates.push({ ref: 'deepseek/test', family: 'deepseek', label: 'DeepSeek' },
      { ref: 'qwen/test', family: 'qwen', label: 'Qwen' });
    failure = call => missingJudge(call) ? 'Subscription exhausted'
      : ['deepseek/test', 'qwen/test'].includes(call.model) ? 'Interrupted' : undefined;
    await expect(runStudy(input, options())).rejects.toThrow(/Every candidate/);
    // As if the process died mid-way through batch 2: the last saved reading is from after batch 1.
    const progressFile = path.join(studyDir(), 'progress.json');
    write(progressFile, { ...read(progressFile), spentUsd: 2, lastUsage: 12 });
    calls.length = 0; failure = () => undefined;
    const opts = options(); opts.fetchUsage.mockResolvedValueOnce(15).mockResolvedValueOnce(16);
    await repairStudy(input, opts);
    expect(read(progressFile)).toMatchObject({ spentUsd: 6, lastUsage: 16 });
  });

  it('refuses to start while another run or repair holds the study', async () => {
    await finishedWithGap();
    const lock = path.join(studyDir(), '.lock');
    write(lock, { pid: process.pid, token: 'other-run' });
    const before = snapshot();
    const opts = options();
    await expect(repairStudy(study(), opts)).rejects.toThrow(/Another run or repair of this study is in progress/);
    await expect(runStudy(study(), options())).rejects.toThrow(/Another run or repair of this study is in progress/);
    expect(snapshot()).toEqual(before);
    expect(calls).toHaveLength(0);
    expect(opts.fetchUsage).not.toHaveBeenCalled();
  });

  it('replaces a lock left by a process that has exited and removes its own when done', async () => {
    await finishedWithGap();
    const lock = path.join(studyDir(), '.lock');
    write(lock, { pid: 2 ** 22 + 7, token: 'crashed-run' });
    const result = await repairStudy(study(), options());
    expect(result.judgeSeatsFilled).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('stops if another repair changed the study while the prompt was open', async () => {
    await finishedWithGap();
    const opts = options();
    opts.confirm.mockImplementation(async () => {
      fs.rmSync(failuresFile());
      return true;
    });
    await expect(repairStudy(study(), opts)).rejects.toThrow(/changed this study while waiting for confirmation/);
    expect(calls).toHaveLength(0);
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(studyDir(), '.lock'))).toBe(false);
  });

  it.each([undefined, 'high'])('sets reasoning effort and restores previous %s', async previous => {
    await finishedWithGap();
    if (previous) process.env.TOURNAMENT_REASONING_EFFORT = previous;
    await repairStudy(study(), options());
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.effort === 'low')).toBe(true);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe(previous);
  });

  it.each(['throw', 'invalid'])('keeps old synthesis when refresh returns %s and still analyzes the new seat', async kind => {
    await finishedWithGap();
    const old = fs.readFileSync(artifact('judges', 'synthesis.json'), 'utf8');
    if (kind === 'throw') failure = call => call.phase === 'synthesis' ? 'Unavailable synthesis' : undefined;
    else invalid = call => call.phase === 'synthesis';
    const result = await repairStudy(study(), options());
    expect(result.judgeSeatsFilled).toBe(1);
    expect(result.remaining).toEqual([{ runId: path.basename(runDirs()[0]), model: 'openai/test', scenario: 'one',
      error: `synthesis: ${kind === 'throw' ? 'Unavailable synthesis' : 'invalid score output'}` }]);
    expect(fs.readFileSync(artifact('judges', 'synthesis.json'), 'utf8')).toBe(old);
    expect(result.analysis?.answers.analyzed).toBe(6);
    expect(collectScores(study(), runDirs())).toHaveLength(18);
  });

  it('keeps unmatched entries while repairing known gaps and deduplicates repeated seats', async () => {
    await finishedWithGap();
    const known = read(failuresFile())[0];
    const unknown = { model: 'openai/test', scenario: 'unknown', error: 'Untouched' };
    write(failuresFile(), [known, unknown, known]);
    const result = await repairStudy(study(), options());
    expect(result.judgeSeatsFilled).toBe(1);
    expect(calls.filter(call => call.phase === 'judge')).toHaveLength(1);
    expect(read(failuresFile())).toEqual([unknown]);
    expect(result.remaining).toEqual([{ runId: path.basename(runDirs()[0]), ...unknown }]);
  });

  it.each(['answer', 'some judges', 'all judges'])('records new failures during pair repair: %s', async stage => {
    failure = call => call.phase === 'answer' && call.route === 'anthropic' ? 'Original failure' : undefined;
    await runStudy(study(), options());
    calls.length = 0;
    failure = call => {
      if (stage === 'answer' && call.phase === 'answer') return 'New answer failure';
      if (call.phase === 'judge' && (stage === 'all judges' || stage === 'some judges' && call.route === 'anthropic')) return 'New judge failure';
      return undefined;
    };
    const result = await repairStudy(study(), options());
    const error = stage === 'answer' ? 'New answer failure' : stage === 'all judges' ? 'All judges failed'
      : 'judge anthropic judge: New judge failure';
    expect(result.answersRerun).toBe(stage === 'some judges' ? 2 : 0);
    expect(result.judgeSeatsFilled).toBe(0);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining.every(gap => gap.model === 'anthropic:claude-test' && gap.error === error)).toBe(true);
    expect(read(failuresFile())).toEqual(result.remaining.map(({ model, scenario, error }) => ({ model, scenario, error })));
    if (stage === 'answer') expect(calls.every(call => call.phase === 'answer')).toBe(true);
  });

  it('repairs at most four answers concurrently and keeps seats on each answer sequential', async () => {
    const input = study();
    input.judges.push({ ref: 'deepseek/test', family: 'deepseek' });
    failure = call => call.phase === 'judge' && ['claude-test', 'openai/test'].includes(call.model)
      ? 'Missing seat' : undefined;
    await runStudy(input, options());
    calls.length = 0; failure = () => undefined;
    const active = new Set<string>();
    let maximum = 0;
    let overlap = false;
    duringCall = async call => {
      if (call.phase !== 'judge') return;
      const key = call.text.match(/answer-[\w/-]+-(?:one|two)/)?.[0];
      expect(key).toBeDefined();
      if (active.has(key!)) overlap = true;
      active.add(key!);
      maximum = Math.max(maximum, active.size);
      await new Promise(resolve => setTimeout(resolve, 5));
      active.delete(key!);
    };
    const result = await repairStudy(input, options());
    expect(result).toMatchObject({ answersRerun: 0, judgeSeatsFilled: 12, remaining: [] });
    expect(maximum).toBe(4);
    expect(overlap).toBe(false);
    expect(active.size).toBe(0);
    expect(calls.filter(call => call.phase === 'judge')).toHaveLength(12);
    expect(calls.filter(call => call.phase === 'synthesis')).toHaveLength(6);
    expect(calls.some(call => call.phase === 'answer')).toBe(false);
  });

  it('preflights routes before confirmation and preserves the environment on unexpected failure', async () => {
    await finishedWithGap();
    const opts = options();
    registerModelClient('anthropic', { ...fake('anthropic'), isConfigured: () => false });
    await expect(repairStudy(study(), opts)).rejects.toThrow(/not set up/);
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(opts.fetchUsage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    registerModelClient('anthropic', fake('anthropic'));
    process.env.TOURNAMENT_REASONING_EFFORT = 'high';
    await expect(repairStudy(study(), { ...options(), onProgress: () => { throw new Error('Stopped'); } })).rejects.toThrow('Stopped');
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe('high');
  });

  it('keeps an unknown prior spend unknown and inherits effort when the input omits it', async () => {
    const input = study(); delete input.reasoningEffort;
    failure = call => missingJudge(call) ? 'Missing seat' : undefined;
    const first = options(); first.fetchUsage.mockResolvedValue(null);
    await runStudy(input, first);
    calls.length = 0; failure = () => undefined;
    process.env.TOURNAMENT_REASONING_EFFORT = 'medium';
    const opts = options(); opts.fetchUsage.mockResolvedValueOnce(10).mockResolvedValueOnce(12);
    await repairStudy(input, opts);
    expect(read(path.join(studyDir(), 'progress.json')).spentUsd).toBeNull();
    expect(read(path.join(studyDir(), 'study.json')).meta.actualUsd).toBeNull();
    expect(calls.every(call => call.effort === 'medium')).toBe(true);
    expect(process.env.TOURNAMENT_REASONING_EFFORT).toBe('medium');
  });
});
