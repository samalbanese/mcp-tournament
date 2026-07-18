import type { ClientRoute } from '../clients/index.js';

export type JudgeRoute = ClientRoute;

export interface JudgeConfig {
  role: string;
  name: string;
  model: string;
  family: string;
  route: JudgeRoute;
  focus: string[];
}

// All defaults are budget-tier (<$1/M output) so a full tournament run costs
// cents. Override any role via TOURNAMENT_MODEL_* env vars for higher-quality
// judging when budget allows.
const DEFAULT_MODELS: Record<string, string> = {
  judge_rules: 'deepseek/deepseek-v3.2',
  judge_creative: 'qwen/qwen3.5-flash-02-23',
  judge_holistic: 'google/gemini-2.5-flash-lite',
  judge_authentic_voice: 'mistralai/mistral-small-3.2-24b-instruct',
  judge_npc_world: 'meta-llama/llama-4-scout',
  synthesizer: 'deepseek/deepseek-v3.2',
  participant: 'deepseek/deepseek-v3.2',
};

/**
 * Override models with TOURNAMENT_MODEL_JUDGE_RULES,
 * TOURNAMENT_MODEL_JUDGE_CREATIVE, TOURNAMENT_MODEL_JUDGE_HOLISTIC,
 * TOURNAMENT_MODEL_JUDGE_AUTHENTIC_VOICE, TOURNAMENT_MODEL_JUDGE_NPC_WORLD,
 * TOURNAMENT_MODEL_SYNTHESIZER, or TOURNAMENT_MODEL_PARTICIPANT.
 */
export function resolveRoleModel(role: string): string {
  const key = role.startsWith('judge_') ? role : role === 'synthesizer' || role === 'participant'
    ? role : `judge_${role}`;
  const envKey = `TOURNAMENT_MODEL_${key.toUpperCase()}`;
  return process.env[envKey] ?? DEFAULT_MODELS[key] ?? DEFAULT_MODELS.judge_holistic;
}

export const JUDGES: JudgeConfig[] = [
  {
    role: 'rules', name: 'Rules Judge', model: resolveRoleModel('rules'),
    family: 'deepseek', route: 'openrouter', focus: ['accuracy', 'tool_usage'],
  },
  {
    role: 'creative', name: 'Creative Judge', model: resolveRoleModel('creative'),
    family: 'qwen', route: 'openrouter', focus: ['clarity', 'creativity', 'communication'],
  },
  {
    role: 'holistic', name: 'Holistic Judge', model: resolveRoleModel('holistic'),
    family: 'google', route: 'openrouter', focus: ['overall_quality', 'task_completion'],
  },
  {
    role: 'authentic_voice', name: 'Authentic Voice Judge',
    model: resolveRoleModel('authentic_voice'), family: 'mistral',
    route: 'openrouter', focus: ['authentic_voice'],
  },
  {
    role: 'npc_world', name: 'Context Judge', model: resolveRoleModel('npc_world'),
    family: 'meta', route: 'openrouter', focus: ['context', 'consistency'],
  },
];

export const SYNTHESIZER: Omit<JudgeConfig, 'focus'> = {
  role: 'synthesizer',
  name: 'Synthesis Judge',
  model: resolveRoleModel('synthesizer'),
  family: 'deepseek',
  route: 'openrouter',
};

export const PARTICIPANT_AGENT_MODEL = resolveRoleModel('participant');
export const PARTICIPANT_AGENT_ROUTE: JudgeRoute = 'openrouter';
