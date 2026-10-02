import type { ClientRoute } from '../clients/index.js';
import { ModelRefError, parseModelRef, type ParsedModelRef } from './model-ref.js';
import type { ReasoningLevel } from './reasoning.js';

export type JudgeRoute = ClientRoute;

export interface JudgeConfig {
  role: string;
  name: string;
  model: string;
  family: string;
  route: JudgeRoute;
  focus: string[];
  reasoning?: ReasoningLevel;
  thinks?: boolean;
  /** Persona lens text; absent for legacy judge selections. */
  lens?: string;
  /** Role passed to plugin.buildJudgePrompt; defaults to role. */
  pluginRole?: string;
  /** Preset persona id, or 'custom'. */
  persona?: string;
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
 * Values are model refs: a bare OpenRouter ID or "anthropic:claude-<model>".
 */
export function resolveRoleModel(role: string): string {
  const key = roleKey(role);
  return process.env[`TOURNAMENT_MODEL_${key.toUpperCase()}`] ?? DEFAULT_MODELS[key] ?? DEFAULT_MODELS.judge_holistic;
}

function roleKey(role: string): string {
  return role.startsWith('judge_') ? role : role === 'synthesizer' || role === 'participant'
    ? role : `judge_${role}`;
}

/** The role's default model as a parsed ref, so env values pick their route. */
export function resolveRoleRef(role: string): ParsedModelRef {
  try {
    return parseModelRef(resolveRoleModel(role));
  } catch (error) {
    if (error instanceof ModelRefError) {
      throw new ModelRefError(`TOURNAMENT_MODEL_${roleKey(role).toUpperCase()}: ${error.message}`);
    }
    throw error;
  }
}

function defaultJudge(role: string, name: string, family: string, focus: string[]): JudgeConfig {
  const ref = resolveRoleRef(role);
  return {
    role, name, model: ref.model, route: ref.route,
    ...(ref.reasoning ? { reasoning: ref.reasoning } : {}),
    family: ref.route === 'anthropic' ? 'anthropic' : family, focus,
  };
}

export const JUDGES: JudgeConfig[] = [
  defaultJudge('rules', 'Rules Judge', 'deepseek', ['accuracy', 'tool_usage']),
  defaultJudge('creative', 'Creative Judge', 'qwen', ['clarity', 'creativity', 'communication']),
  defaultJudge('holistic', 'Holistic Judge', 'google', ['overall_quality', 'task_completion']),
  defaultJudge('authentic_voice', 'Authentic Voice Judge', 'mistral', ['authentic_voice']),
  defaultJudge('npc_world', 'Context Judge', 'meta', ['context', 'consistency']),
];

const synthesizerRef = resolveRoleRef('synthesizer');

export const SYNTHESIZER: Omit<JudgeConfig, 'focus'> = {
  role: 'synthesizer',
  name: 'Synthesis Judge',
  model: synthesizerRef.model,
  family: synthesizerRef.route === 'anthropic' ? 'anthropic' : 'deepseek',
  route: synthesizerRef.route,
  ...(synthesizerRef.reasoning ? { reasoning: synthesizerRef.reasoning } : {}),
};

export const PARTICIPANT_AGENT_MODEL = resolveRoleModel('participant');
export const PARTICIPANT_AGENT_ROUTE: JudgeRoute = resolveRoleRef('participant').route;
