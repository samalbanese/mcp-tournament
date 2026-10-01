import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildShortlist, closestModelIds, fetchCatalogModels, findCatalogPrice, getCatalog, resetCatalogCache,
} from '../../src/catalog.js';
import { CANDIDATE_MODELS } from '../../src/config/models.js';
import { parseModelRef } from '../../src/config/model-ref.js';

function fakeFetch(data: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ data }) })) as unknown as typeof fetch;
}

const LIVE = [
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', context_length: 1000, pricing: { prompt: '0.00000027', completion: '0.0000004' } },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', context_length: 1000, pricing: { prompt: '0.000002', completion: '0.00001' } },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', context_length: 1000, pricing: { prompt: '0.000003', completion: '0.000015' } },
  { id: 'openrouter/auto', name: 'Auto', context_length: 1, pricing: { prompt: '-1', completion: '-1' } },
];

beforeEach(() => resetCatalogCache());
afterEach(() => vi.useRealTimers());

describe('catalog', () => {
  it('converts prices to per-1M and drops negative-priced meta entries', async () => {
    const models = await fetchCatalogModels(fakeFetch(LIVE));
    expect(models.map(model => model.id)).not.toContain('openrouter/auto');
    expect(models.find(model => model.id === 'openai/gpt-5.4')?.completionPrice).toBeCloseTo(10);
  });

  it('caches for 10 minutes', async () => {
    const fetcher = fakeFetch(LIVE);
    await fetchCatalogModels(fetcher);
    await fetchCatalogModels(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('falls back to the curated list when the fetch fails, without throwing', async () => {
    const catalog = await getCatalog(fakeFetch(null, false));
    expect(catalog.source).toBe('curated-fallback');
    expect(catalog.models.map(model => model.id)).toEqual(CANDIDATE_MODELS.map(model => model.id));
    expect(catalog.error).toMatch(/503/);
  });

  it('shortlists only curated ids still present live, with live prices', async () => {
    const shortlist = buildShortlist(await getCatalog(fakeFetch(LIVE)));
    const all = Object.values(shortlist).flat();
    expect(all.map(entry => entry.ref)).toEqual(expect.arrayContaining(['deepseek/deepseek-v3.2', 'openai/gpt-5.4']));
    expect(all.map(entry => entry.ref)).not.toContain('x-ai/grok-4');
    expect(shortlist.budget.find(entry => entry.ref === 'deepseek/deepseek-v3.2')?.outputPrice).toBeCloseTo(0.4);
  });

  it('suggests close ids for a typo', () => {
    expect(closestModelIds('deepseek/deepseek-v3', ['deepseek/deepseek-v3.2', 'openai/gpt-5.4', 'qwen/qwen3.5-flash-02-23'])[0])
      .toBe('deepseek/deepseek-v3.2');
  });

  it('prices anthropic: refs from the matching OpenRouter entry', async () => {
    const catalog = await getCatalog(fakeFetch(LIVE));
    expect(findCatalogPrice(parseModelRef('anthropic:claude-sonnet-5-5'), catalog)?.id).toBe('anthropic/claude-sonnet-5.5');
    expect(findCatalogPrice(parseModelRef('deepseek/deepseek-v3.2'), catalog)?.id).toBe('deepseek/deepseek-v3.2');
  });

  it('refreshes the cache at ten minutes and when explicitly reset', async () => {
    vi.useFakeTimers();
    const fetcher = fakeFetch(LIVE);
    await fetchCatalogModels(fetcher);
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    await fetchCatalogModels(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await fetchCatalogModels(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    resetCatalogCache();
    await fetchCatalogModels(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps GUI errors for failed or invalid catalog responses', async () => {
    await expect(fetchCatalogModels(fakeFetch(null, false))).rejects.toThrow('OpenRouter models request failed (503)');
    await expect(fetchCatalogModels(fakeFetch(null))).rejects.toThrow('OpenRouter returned an invalid models response');
    expect((await getCatalog(fakeFetch(null))).source).toBe('curated-fallback');
  });

  it('does not present missing fallback prices as free models or cache failures', async () => {
    const catalog = await getCatalog(fakeFetch(null, false));
    const entries = Object.values(buildShortlist(catalog)).flat();
    expect(entries).toHaveLength(CANDIDATE_MODELS.length);
    expect(entries.every(entry => entry.inputPrice === null && entry.outputPrice === null)).toBe(true);
    expect(findCatalogPrice(parseModelRef('deepseek/deepseek-v3.2'), catalog)).toBeUndefined();
    expect((await getCatalog(fakeFetch(LIVE))).source).toBe('live');
  });

  it('does not expose raw fetch errors that could contain credentials', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fetch failed: sk-private-xxxx (sk-private)'); });
    const catalog = await getCatalog(fetcher);
    expect(catalog.source).toBe('curated-fallback');
    expect(catalog.error).toMatch(/catalog.*unavailable/i);
    expect(catalog.error).not.toContain('sk-private');
  });

  it('limits suggestions and leaves the original candidate list untouched', () => {
    const candidates = ['openai/gpt-5.4', 'deepseek/deepseek-v3.2', 'deepseek/deepseek-r1:free'];
    const original = [...candidates];
    expect(closestModelIds('DEEPSEEK/DEEPSEEK-V3', candidates, 1)).toEqual(['deepseek/deepseek-v3.2']);
    expect(closestModelIds('unknown', [], 3)).toEqual([]);
    expect(candidates).toEqual(original);
  });
});
