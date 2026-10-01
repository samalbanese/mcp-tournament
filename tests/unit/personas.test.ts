import { describe, expect, it } from 'vitest';
import { JUDGES } from '../../src/config/judges.js';
import { DEFAULT_SEAT_ORDER, PERSONAS, PERSONA_IDS } from '../../src/config/personas.js';
import { buildJudgeSystemPrompt, JUDGE_LENSES, JUDGE_SYSTEM_PROMPTS } from '../../src/prompts/judge-prompts.js';

describe('personas', () => {
  it('keeps the five legacy system prompts byte-identical', () => {
    // Snapshot of the pre-change prompt text; regenerate ONLY if the legacy prompts are meant to change.
    expect(JUDGE_SYSTEM_PROMPTS).toMatchSnapshot();
    for (const role of Object.keys(JUDGE_LENSES)) {
      expect(buildJudgeSystemPrompt({ role, lens: undefined })).toBe(JUDGE_SYSTEM_PROMPTS[role]);
    }
  });

  it('builds lens + JSON instruction for presets and custom lenses', () => {
    const custom = buildJudgeSystemPrompt({ role: 'custom_1', lens: 'Judge like a pirate captain.' });
    expect(custom.startsWith('Judge like a pirate captain. ')).toBe(true);
    expect(custom).toContain('return only JSON');
    expect(buildJudgeSystemPrompt({ role: 'skeptic', lens: PERSONAS.skeptic.lens })).toContain('Hunt for factual errors');
  });

  it('exposes all eight presets with legacy names for legacy ids', () => {
    expect(PERSONA_IDS).toHaveLength(8);
    for (const judge of JUDGES) {
      expect(PERSONAS[judge.role as keyof typeof PERSONAS].judgeName).toBe(judge.name);
      expect(PERSONAS[judge.role as keyof typeof PERSONAS].pluginRole).toBe(judge.role);
    }
    expect(DEFAULT_SEAT_ORDER).toEqual(JUDGES.map(judge => judge.role));
    expect(PERSONAS.skeptic.pluginRole).toBe('rules');
  });
});
