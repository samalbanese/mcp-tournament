import { CANDIDATE_MODELS, type CandidateModel } from './config/models.js';
import type { ParsedModelRef } from './config/model-ref.js';

const MODEL_CACHE_MS = 10 * 60 * 1000;
const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CATALOG_TIMEOUT_MS = 8000;

export interface CatalogModel { id: string; name: string; contextLength: number; promptPrice: number; completionPrice: number }
export interface Catalog { source: 'live' | 'curated-fallback'; models: CatalogModel[]; error?: string }
export type ShortlistTier = 'budget' | 'mid' | 'premium' | 'wildcards';
export interface ShortlistEntry { ref: string; name: string; notes: string; inputPrice: number | null; outputPrice: number | null }

let cache: { expiresAt: number; models: CatalogModel[] } | null = null;

export function resetCatalogCache(): void { cache = null; }

export async function fetchCatalogModels(fetcher: typeof fetch = fetch): Promise<CatalogModel[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.models;
  // A hung request must become an error so getCatalog can fall back to the curated list.
  const response = await fetcher(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OpenRouter models request failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> };
  if (!Array.isArray(body.data)) throw new Error('OpenRouter returned an invalid models response');
  const models = body.data
    .filter((model): model is typeof model & { id: string } => typeof model.id === 'string')
    .map(model => ({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      contextLength: Number(model.context_length) || 0,
      promptPrice: Number(model.pricing?.prompt) * 1e6 || 0,
      completionPrice: Number(model.pricing?.completion) * 1e6 || 0,
    }))
    // OpenRouter marks meta-entries like the Auto Router with -1 pricing;
    // they aren't real candidates and render as absurd negative prices.
    .filter(model => model.promptPrice >= 0 && model.completionPrice >= 0);
  cache = { expiresAt: Date.now() + MODEL_CACHE_MS, models };
  return models;
}

export async function getCatalog(fetcher: typeof fetch = fetch): Promise<Catalog> {
  try {
    return { source: 'live', models: await fetchCatalogModels(fetcher) };
  } catch (error) {
    return {
      source: 'curated-fallback',
      models: CANDIDATE_MODELS.map(model => ({ id: model.id, name: model.name, contextLength: 0, promptPrice: 0, completionPrice: 0 })),
      error: error instanceof Error && (
        /^OpenRouter models request failed \(\d{3}\)$/.test(error.message)
        || error.message === 'OpenRouter returned an invalid models response'
      ) ? error.message : 'OpenRouter catalog is unavailable. Try again later.',
    };
  }
}

export function buildShortlist(catalog: Catalog): Record<ShortlistTier, ShortlistEntry[]> {
  const live = new Map(catalog.models.map(model => [model.id, model]));
  const result: Record<ShortlistTier, ShortlistEntry[]> = { budget: [], mid: [], premium: [], wildcards: [] };
  for (const curated of CANDIDATE_MODELS) {
    if (curated.tier === 'unknown') continue;
    const match = live.get(curated.id);
    if (!match) continue; // dead curated ids drop out automatically
    const priced = catalog.source === 'live';
    result[curated.tier].push({
      ref: curated.id, name: curated.name, notes: curated.notes,
      inputPrice: priced ? match.promptPrice : null, outputPrice: priced ? match.completionPrice : null,
    });
  }
  return result;
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}

export function closestModelIds(id: string, candidates: string[], limit = 3): string[] {
  const target = id.toLowerCase();
  const vendor = target.split('/')[0];
  return candidates
    .map(candidate => {
      const lower = candidate.toLowerCase();
      // Same vendor is a strong signal for typos like "deepseek/deepseek-v3".
      const bonus = lower.split('/')[0] === vendor ? -3 : 0;
      return { candidate, score: editDistance(target, lower) + bonus };
    })
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map(entry => entry.candidate);
}

/** "claude-sonnet-5-5" -> "anthropic/claude-sonnet-5.5" (OpenRouter writes the version with a dot). */
function openRouterIdForAnthropic(model: string): string {
  return `anthropic/${model.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

export function findCatalogPrice(ref: ParsedModelRef, catalog: Catalog): CatalogModel | undefined {
  if (catalog.source !== 'live') return undefined;
  const id = ref.route === 'anthropic' ? openRouterIdForAnthropic(ref.model) : ref.model;
  return catalog.models.find(model => model.id === id);
}

export type { CandidateModel };
