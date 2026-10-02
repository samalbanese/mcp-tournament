import { describe, expect, it } from 'vitest';
import type { ApiModel } from '../../gui/src/api.js';
import { joinLevel, keepLevelIfSupported, levelOptions, splitLevel, swapModel } from '../../gui/src/reasoning.js';

const model = (id: string, extra: Partial<ApiModel> = {}): ApiModel => ({
  id, name: id, contextLength: 0, promptPrice: 0, completionPrice: 0, ...extra,
});
const thinking = model('a/b', { reasoningLevels: ['high', 'low', 'none'], defaultReasoning: 'high' });

describe('GUI reasoning controls', () => {
  it('splits full refs and preserves provider routes', () => {
    expect(splitLevel('a/b')).toEqual({ base: 'a/b' });
    expect(splitLevel('a/b@low')).toEqual({ base: 'a/b', level: 'low' });
    expect(splitLevel('anthropic:claude-opus-5-5@high')).toEqual({ base: 'anthropic:claude-opus-5-5', level: 'high' });
  });

  it('joins explicit levels and represents default without a suffix', () => {
    expect(joinLevel('a/b', 'none')).toBe('a/b@none');
    expect(joinLevel('a/b', 'low')).toBe('a/b@low');
    expect(joinLevel('a/b', '')).toBe('a/b');
    expect(joinLevel('a/b')).toBe('a/b');
  });

  it('offers only catalog levels in catalog order with default first', () => {
    expect(levelOptions(thinking)).toEqual([
      { value: '', label: 'Default (high)' },
      { value: 'high', label: 'high' },
      { value: 'low', label: 'low' },
      { value: 'none', label: 'none' },
    ]);
    expect(levelOptions(model('c/d', { reasoningLevels: ['low'] }))[0].label).toBe('Default (provider)');
    expect(levelOptions(model('c/d', { hasReasoning: true }))).toEqual([]);
    expect(levelOptions(model('c/d', { reasoningLevels: [] }))).toEqual([]);
    expect(levelOptions()).toEqual([]);
  });

  it('clears unsupported levels after a model swap and keeps supported ones', () => {
    const other = model('c/d', { reasoningLevels: ['high'] });
    expect(keepLevelIfSupported('a/b@low', other)).toBe('c/d');
    expect(keepLevelIfSupported('a/b@low', thinking)).toBe('a/b@low');
    expect(keepLevelIfSupported('a/b@low')).toBe('a/b');
    expect(swapModel('a/b@low', 'c/d', [thinking, other])).toBe('c/d');
    expect(swapModel('a/b@high', 'c/d', [thinking, other])).toBe('c/d@high');
    expect(swapModel('a/b@high', 'unknown/model', [thinking])).toBe('unknown/model');
    expect(swapModel('a/b', 'c/d', [other])).toBe('c/d');
  });
});
