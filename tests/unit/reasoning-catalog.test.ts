import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShortlist, fetchCatalogModels, getCatalog, resetCatalogCache, type Catalog } from '../../src/catalog.js';
import { anthropicSupportsLevels, applyReasoningCatalog } from '../../src/config/reasoning.js';
import { normalizeRunPlan } from '../../src/run-plan.js';

const live = (models: Catalog['models']): Catalog => ({ source: 'live', models });
const model = (id: string, extra: Partial<Catalog['models'][number]> = {}) =>
  ({ id, name: id.split('/')[1], contextLength: 0, promptPrice: 1, completionPrice: 2, ...extra });
const deepseek = model('deepseek/deepseek-v4-pro-0813', { name: 'DeepSeek V4 Pro', hasReasoning: true, reasoningLevels: ['max', 'high', 'low'], defaultReasoning: 'high', reasonsByDefault: true });
const undated = model('deepseek/deepseek-v4-pro', { hasReasoning: true, reasoningLevels: ['xhigh', 'high'], defaultReasoning: 'high', reasonsByDefault: true });
const flash = model('qwen/qwen3.5-flash-02-23', { hasReasoning: true, reasonsByDefault: false });
const plain = model('mistralai/mistral-small-3.2-24b-instruct');

beforeEach(() => {
  resetCatalogCache();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
});
afterEach(() => {
  resetCatalogCache();
  vi.unstubAllGlobals();
});

describe('catalog reasoning metadata', () => {
  it('parses OpenRouter reasoning objects', async () => {
    resetCatalogCache();
    const fetcher = async () => new Response(JSON.stringify({ data: [
      { id: 'a/r', name: 'R', pricing: { prompt: '0', completion: '0' }, reasoning: { mandatory: true, supported_efforts: ['high', 'low', 'turbo'], default_effort: 'low' } },
      { id: 'a/off', name: 'Off', pricing: { prompt: '0', completion: '0' }, reasoning: { mandatory: false, default_enabled: false } },
      { id: 'a/plain', name: 'Plain', pricing: { prompt: '0', completion: '0' } },
    ] }));
    const models = await fetchCatalogModels(fetcher as typeof fetch);
    expect(models[0]).toMatchObject({ hasReasoning: true, reasoningLevels: ['high', 'low'], defaultReasoning: 'low', reasonsByDefault: true });
    expect(models[1]).toMatchObject({ hasReasoning: true, reasonsByDefault: false });
    expect(models[1].reasoningLevels).toBeUndefined();
    expect(models[2].hasReasoning).toBeUndefined();
  });

  it.each([
    [{ default_effort: 'low' }, true, 'low'],
    [{ default_enabled: false, default_effort: 'high' }, false, 'high'],
    [{ mandatory: true, default_enabled: false }, true, undefined],
    [{ default_enabled: true, default_effort: 'turbo' }, true, undefined],
    [{ supported_efforts: ['turbo', 1, null] }, false, undefined],
  ])('resolves reasoning defaults from %j', async (reasoning, thinks, defaultLevel) => {
    const fetcher = async () => new Response(JSON.stringify({ data: [{ id: 'a/b', reasoning }] }));
    const [entry] = await fetchCatalogModels(fetcher as typeof fetch);
    expect(entry.reasonsByDefault).toBe(thinks);
    expect(entry.defaultReasoning).toBe(defaultLevel);
    expect(entry.reasoningLevels).toBeUndefined();
  });

  it('ignores malformed reasoning metadata', async () => {
    const fetcher = async () => new Response(JSON.stringify({ data:
      [null, [], 'high'].map(reasoning => ({ id: 'a/b', reasoning })),
    }));
    const entries = await fetchCatalogModels(fetcher as typeof fetch);
    expect(entries.every(entry => entry.hasReasoning === undefined)).toBe(true);
  });

  it('copies live levels to the shortlist and leaves fallback metadata absent', async () => {
    const id = 'deepseek/deepseek-v3.2';
    const shortlist = buildShortlist(live([model(id, { reasoningLevels: ['high', 'low'] })]));
    expect(shortlist.budget[0].reasoningLevels).toEqual(['high', 'low']);
    const fallback = await getCatalog();
    expect(fallback.source).toBe('curated-fallback');
    expect(fallback.models.every(entry => entry.reasoningLevels === undefined)).toBe(true);
    expect(Object.values(buildShortlist(fallback)).flat().every(entry => entry.reasoningLevels === undefined)).toBe(true);
  });
});

describe('applyReasoningCatalog', () => {
  it('accepts a level the exact dated ID lists, even when the undated ID does not', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['deepseek/deepseek-v4-pro-0813@low'] });
    expect(applyReasoningCatalog(plan, live([deepseek, undated])).errors).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({ name: 'deepseek-v4-pro-0813 · low', thinks: true });
  });

  it('refuses an unlisted level before any spend, naming the accepted ones', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['deepseek/deepseek-v4-pro@low'] });
    expect(applyReasoningCatalog(plan, live([undated])).errors).toEqual(['Candidate "deepseek/deepseek-v4-pro@low": deepseek-v4-pro accepts xhigh, high.']);
  });

  it('refuses a level on a model with no listed levels', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['qwen/qwen3.5-flash-02-23@low'] });
    expect(applyReasoningCatalog(plan, live([flash])).errors[0]).toMatch(/has no reasoning levels/);
  });

  it('labels defaults only for models that have levels, and knows who thinks by default', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['deepseek/deepseek-v4-pro-0813', 'mistralai/mistral-small-3.2-24b-instruct'] });
    applyReasoningCatalog(plan, live([deepseek, plain]));
    expect(plan.candidates.map(c => [c.name, c.thinks])).toEqual([['deepseek-v4-pro-0813 · default', true], ['Mistral Small 3.2', false]]);
  });

  it('does not duplicate labels when a plan is checked again', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['deepseek/deepseek-v4-pro-0813@low', 'deepseek/deepseek-v4-pro-0813'] });
    applyReasoningCatalog(plan, live([deepseek]));
    applyReasoningCatalog(plan, live([deepseek]));
    expect(plan.candidates.map(candidate => candidate.name)).toEqual(['deepseek-v4-pro-0813 · low', 'deepseek-v4-pro-0813 · default']);
  });

  it('warns and sends anyway when the catalog is offline', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b@high'] });
    const result = applyReasoningCatalog(plan, { source: 'curated-fallback', models: [] });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['Model catalog offline: could not check that "a/b@high" accepts reasoning level high.']);
    expect(plan.candidates[0].thinks).toBe(true);
    expect(plan.candidates[0]).toMatchObject({ apiModel: 'a/b', reasoning: 'high', name: 'b · high' });
  });

  it('validates all seat types and reports one offline warning per explicit level', () => {
    const plan = normalizeRunPlan({
      bench: 'dnd', candidates: ['a/b@high'], judgePanel: [{ model: 'a/b@low' }],
      synthesizer: 'a/b@medium', participant: 'a/b@none',
    });
    const result = applyReasoningCatalog(plan, { source: 'curated-fallback', models: [] });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(4);
    expect([plan.candidates[0].thinks, plan.judges[0].thinks, plan.synthesizer.thinks, plan.participant.thinks])
      .toEqual([true, true, true, false]);
    const checked = applyReasoningCatalog(plan, live([model('a/b', { reasoningLevels: ['high'] })]));
    expect(checked.errors).toHaveLength(3);
    expect(checked.errors.map(error => error.split(' "')[0])).toEqual(['Judge', 'Synthesizer', 'Simulated user']);
  });

  it('explicit none overrides reasoning by default', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b@none', 'a/b@minimal', 'a/b'] });
    const result = applyReasoningCatalog(plan, live([model('a/b', { reasoningLevels: ['none', 'minimal'], reasonsByDefault: true })]));
    expect(result.errors).toEqual([]);
    expect(plan.candidates.map(candidate => candidate.thinks)).toEqual([false, true, true]);
  });

  it('does not leak judge thinking flags into another plan', () => {
    const first = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b'] });
    const second = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b'] });
    applyReasoningCatalog(first, live(first.judges.map(judge => model(judge.model, { reasonsByDefault: true }))));
    expect(first.judges.every(judge => judge.thinks === true)).toBe(true);
    expect(second.judges.every(judge => judge.thinks === undefined)).toBe(true);
  });

  it('knows the Anthropic families', () => {
    expect(anthropicSupportsLevels('claude-opus-5-5')).toBe(true);
    expect(anthropicSupportsLevels('claude-sonnet-4-6')).toBe(true);
    expect(anthropicSupportsLevels('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicSupportsLevels('claude-something-9')).toBeUndefined();
  });

  it('refuses a level on Haiku 4.5 and warns on an unknown Claude model', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['anthropic:claude-haiku-4-5-20251001@low', 'anthropic:claude-something-9@low'] });
    const result = applyReasoningCatalog(plan, live([]));
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});
