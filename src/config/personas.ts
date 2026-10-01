import { JUDGES } from './judges.js';
import { JUDGE_LENSES } from '../prompts/judge-prompts.js';

export const PERSONA_IDS = ['rules', 'creative', 'holistic', 'authentic_voice', 'npc_world', 'strict', 'skeptic', 'audience'] as const;
export type PersonaId = typeof PERSONA_IDS[number];

export interface PersonaPreset {
  id: PersonaId;
  label: string;
  judgeName: string;
  description: string;
  lens: string;
  pluginRole: string;
  defaultModelRole: string;
  focus: string[];
}

export const DEFAULT_SEAT_ORDER: PersonaId[] = ['rules', 'creative', 'holistic', 'authentic_voice', 'npc_world'];

function legacyPreset(id: keyof typeof JUDGE_LENSES, label: string, description: string): PersonaPreset {
  const judge = JUDGES.find(judge => judge.role === id)!;
  return {
    id, label, judgeName: judge.name, description, lens: JUDGE_LENSES[id],
    pluginRole: id, defaultModelRole: id, focus: [...judge.focus],
  };
}

export const PERSONAS: Record<PersonaId, PersonaPreset> = {
  rules: legacyPreset('rules', 'Accuracy', 'Checks facts, reasoning, rules, and tool use.'),
  creative: legacyPreset('creative', 'Craft & Clarity', 'Looks for clear, original, and useful communication.'),
  holistic: legacyPreset('holistic', 'Holistic', 'Assesses task completion and the overall experience.'),
  authentic_voice: legacyPreset('authentic_voice', 'Authentic Voice', 'Looks for a natural, specific voice without repetitive phrasing.'),
  npc_world: legacyPreset('npc_world', 'Context & Consistency', 'Checks that details stay coherent throughout the interaction.'),
  strict: {
    id: 'strict', label: 'Strict Grader', judgeName: 'Strict Judge',
    description: 'Reserves high scores for excellent work and penalizes flaws.',
    lens: 'You are a demanding grader. Score harshly: a 7 or higher is only for clearly excellent work with no meaningful flaws, and any error, vagueness, or padding must cost points.',
    pluginRole: 'holistic', defaultModelRole: 'holistic', focus: ['overall_quality', 'precision'],
  },
  skeptic: {
    id: 'skeptic', label: 'Skeptic', judgeName: 'Skeptic Judge',
    description: 'Challenges unsupported claims and steps that would not work.',
    lens: 'You are a skeptical reviewer. Hunt for factual errors, unsupported claims, hand-waving, and steps that would not actually work, and treat confident but unverified statements as weaknesses.',
    pluginRole: 'rules', defaultModelRole: 'rules', focus: ['accuracy', 'evidence'],
  },
  audience: {
    id: 'audience', label: 'Target Audience', judgeName: 'Audience Judge',
    description: 'Checks whether the intended reader can understand, trust, and use the response.',
    lens: 'You judge from the point of view of the person this response is for. Ask whether they would understand it, trust it, and be able to act on it, and penalize anything that would confuse or frustrate them.',
    pluginRole: 'holistic', defaultModelRole: 'creative', focus: ['clarity', 'usefulness', 'audience_fit'],
  },
};
