export type JudgeRoute = 'anthropic-sdk' | 'openrouter';

export interface JudgeConfig {
  role: string;
  name: string;
  model: string;
  family: string;
  route: JudgeRoute;
  focus: string[];
}

export const JUDGES: JudgeConfig[] = [
  {
    role: 'rules',
    name: 'Rules Judge',
    model: 'openai/gpt-5.4-mini',
    family: 'openai',
    route: 'openrouter',
    focus: ['rules_accuracy', 'tool_usage'],
  },
  {
    role: 'creative',
    name: 'Creative Judge',
    model: 'moonshotai/kimi-k2.5',
    family: 'kimi',
    route: 'openrouter',
    focus: ['atmosphere', 'pacing', 'improvised_drama'],
  },
  {
    role: 'holistic',
    name: 'Holistic Judge',
    model: 'google/gemini-3.1-pro-preview',
    family: 'google',
    route: 'openrouter',
    focus: ['player_agency', 'dramatic_payoff', 'player_empowerment'],
  },
  {
    role: 'authentic_voice',
    name: 'Authentic Voice Judge',
    model: 'claude-sonnet-4-6',
    family: 'claude',
    route: 'anthropic-sdk',
    focus: ['authentic_voice'],
  },
  {
    role: 'npc_world',
    name: 'NPC & World Judge',
    model: 'mistralai/mistral-large-2512',
    family: 'mistral',
    route: 'openrouter',
    focus: ['npc_voices', 'voice_differentiation', 'world_building', 'memory_integration'],
  },
];

export const SYNTHESIZER: Omit<JudgeConfig, 'focus'> = {
  role: 'synthesizer',
  name: 'Opus Synthesizer',
  model: 'claude-opus-4-6',
  family: 'claude',
  route: 'anthropic-sdk',
};

export const PLAYER_AGENT_MODEL = 'claude-sonnet-4-6';
