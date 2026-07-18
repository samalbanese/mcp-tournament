export interface CandidateModel {
  id: string;
  name: string;
  tier: 'budget' | 'mid' | 'premium' | 'wildcards' | 'unknown';
  notes: string;
}

export const CANDIDATE_MODELS: CandidateModel[] = [
  // Budget (under $1/M output) — 10 models
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', tier: 'budget', notes: 'Latest DeepSeek, strong tool use' },
  { id: 'x-ai/grok-4.3', name: 'Grok 4.3', tier: 'mid', notes: '$2.50/M output — replaces deprecated Grok 4.1 Fast' },
  { id: 'mistralai/mistral-small-3.2-24b-instruct', name: 'Mistral Small 3.2', tier: 'budget', notes: 'Cheap open-weight all-rounder' },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', tier: 'budget', notes: '1M context, open-weight' },
  { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout', tier: 'budget', notes: '328K context, cheapest Llama' },
  { id: 'qwen/qwen3.5-flash-02-23', name: 'Qwen3.5 Flash', tier: 'budget', notes: 'Ultra-cheap, 65K output cap' },
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', tier: 'budget', notes: '1M context, budget Google' },
  { id: 'inception/mercury-2', name: 'Mercury 2', tier: 'budget', notes: 'Diffusion LLM wildcard' },
  { id: 'bytedance-seed/seed-2.0-mini', name: 'Seed 2.0 Mini', tier: 'budget', notes: 'ByteDance agent model' },
  { id: 'thedrummer/rocinante-12b', name: 'Rocinante 12B', tier: 'budget', notes: 'RP storytelling specialist' },

  // Mid ($1-5/M output) — 9 models
  { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', tier: 'mid', notes: 'Current production DM baseline' },
  { id: 'mistralai/mistral-large-2512', name: 'Mistral Large 3', tier: 'mid', notes: '675B MoE, open-weight flagship' },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', tier: 'mid', notes: 'Near-Pro quality at Flash price' },
  { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', tier: 'mid', notes: 'Newest Gemini lite' },
  { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen3.5 397B', tier: 'mid', notes: 'Largest Qwen MoE' },
  { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7', tier: 'mid', notes: 'Autonomous agent focus' },
  { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'mid', notes: 'Latest GPT compact' },
  { id: 'mistralai/mistral-medium-3.1', name: 'Mistral Medium 3.1', tier: 'mid', notes: 'Enterprise-grade' },
  { id: 'arcee-ai/virtuoso-large', name: 'Virtuoso Large', tier: 'mid', notes: 'Creative writing specialist' },

  // Premium ($5+/M output) — 5 models
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', tier: 'premium', notes: 'OpenAI frontier' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', tier: 'premium', notes: 'Via OR for fair comparison' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', tier: 'premium', notes: 'Google frontier' },
  { id: 'x-ai/grok-4', name: 'Grok 4', tier: 'premium', notes: 'xAI reasoning flagship' },
  { id: 'x-ai/grok-4.20-beta', name: 'Grok 4.20 Beta', tier: 'premium', notes: 'Newest xAI, 2M context' },

  // Wildcards — 4 models
  { id: 'sao10k/l3.1-euryale-70b', name: 'Euryale 70B', tier: 'wildcards', notes: 'Premier RP community finetune' },
  { id: 'thedrummer/unslopnemo-12b', name: 'UnslopNemo 12B', tier: 'wildcards', notes: 'Adventure writing specialist' },
  { id: 'qwen/qwen3.6-plus-preview', name: 'Qwen3.6 Plus Preview', tier: 'wildcards', notes: 'Newest Qwen gen, free during preview' },
  { id: 'deepseek/deepseek-r1-0528', name: 'DeepSeek R1 0528', tier: 'wildcards', notes: 'Reasoning model as DM' },
];

export function getModelsByTier(tier: CandidateModel['tier']): CandidateModel[] {
  return CANDIDATE_MODELS.filter(m => m.tier === tier);
}

export function getModelById(id: string): CandidateModel | undefined {
  return CANDIDATE_MODELS.find(m => m.id === id);
}

export function resolveCandidateModel(id: string): CandidateModel {
  return getModelById(id) ?? {
    id,
    name: id.split('/').at(-1) ?? id,
    tier: 'unknown',
    notes: 'User-supplied OpenRouter model',
  };
}

export function getModelTier(id: string): CandidateModel['tier'] {
  return CANDIDATE_MODELS.find(m => m.id === id)?.tier ?? 'unknown';
}
