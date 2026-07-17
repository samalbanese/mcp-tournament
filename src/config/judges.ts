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

const DEFAULT_MODELS: Record<string, string> = {
  judge_rules: 'openai/gpt-5.4-mini',
  judge_creative: 'moonshotai/kimi-k2.5',
  judge_holistic: 'google/gemini-3.1-flash-lite-preview',
  judge_authentic_voice: 'moonshotai/kimi-k2.5',
  judge_npc_world: 'mistralai/mistral-large-2512',
  synthesizer: 'moonshotai/kimi-k2.5',
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
    family: 'openai', route: 'openrouter', focus: ['accuracy', 'tool_usage'],
  },
  {
    role: 'creative', name: 'Creative Judge', model: resolveRoleModel('creative'),
    family: 'kimi', route: 'openrouter', focus: ['clarity', 'creativity', 'communication'],
  },
  {
    role: 'holistic', name: 'Holistic Judge', model: resolveRoleModel('holistic'),
    family: 'google', route: 'openrouter', focus: ['overall_quality', 'task_completion'],
  },
  {
    role: 'authentic_voice', name: 'Authentic Voice Judge',
    model: resolveRoleModel('authentic_voice'), family: 'kimi',
    route: 'openrouter', focus: ['authentic_voice'],
  },
  {
    role: 'npc_world', name: 'Context Judge', model: resolveRoleModel('npc_world'),
    family: 'mistral', route: 'openrouter', focus: ['context', 'consistency'],
  },
];

export const SYNTHESIZER: Omit<JudgeConfig, 'focus'> = {
  role: 'synthesizer',
  name: 'Synthesis Judge',
  model: resolveRoleModel('synthesizer'),
  family: 'kimi',
  route: 'openrouter',
};

export const PARTICIPANT_AGENT_MODEL = resolveRoleModel('participant');
export const PARTICIPANT_AGENT_ROUTE: JudgeRoute = 'openrouter';
