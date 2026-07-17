import { describe, expect, it } from 'vitest';
import { getPlugin } from '../../src/plugins/index.js';
import type { Turn } from '../../src/plugins/base.js';

describe.each(['dnd', 'coding'])('%s plugin', name => {
  it('loads and builds non-empty candidate and judge prompts', () => {
    const plugin = getPlugin(name);
    expect(plugin.scenarios.length).toBeGreaterThanOrEqual(1);
    const scenario = plugin.scenarios[0];
    const turns: Turn[] = [{ turn: 0, role: 'participant', content: scenario.setupMessage }];
    expect(plugin.buildCandidatePrompt(scenario).trim()).not.toBe('');
    expect(plugin.buildJudgePrompt('holistic', scenario, turns).trim()).not.toBe('');
  });
});
