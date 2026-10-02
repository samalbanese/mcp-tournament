import { describe, expect, it } from 'vitest';
import { shortSlug, slugify } from '../../src/utils/slug.js';

describe('shortSlug', () => {
  it('returns short slugs unchanged', () => {
    expect(shortSlug('The Moonlit Ambush')).toBe('the_moonlit_ambush');
    expect(shortSlug('deepseek/deepseek-v3.2')).toBe('deepseek_deepseek_v3_2');
  });

  it('truncates long slugs at a boundary with a stable hash suffix', () => {
    const short = shortSlug('free_shipping_or_percentage_discount');
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short).toMatch(/^free_shipping_or_[a-z0-9]{4}$/);
    expect(short).toBe(shortSlug('free_shipping_or_percentage_discount'));
  });

  it('hard-truncates when there is no boundary, still suffixed', () => {
    const short = shortSlug('abcdefghijklmnopqrstuvwxyz');
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short.startsWith('abcdefghijklmnopqrs')).toBe(true);
    expect(short).toMatch(/_[a-z0-9]{4}$/);
  });

  it('never collides for models that share a truncated prefix', () => {
    // Regression: plain truncation mapped gemini-2.5-flash-lite onto the
    // directory of gemini-2.5-flash, silently merging two models' results.
    const lite = shortSlug('google/gemini-2.5-flash-lite');
    const flash = shortSlug('google/gemini-2.5-flash');
    expect(lite).not.toBe(flash);
    expect(lite).not.toBe(slugify('google/gemini-2.5-flash'));
  });

  it('is idempotent for already-short slugs', () => {
    expect(shortSlug(shortSlug('The Moonlit Ambush'))).toBe('the_moonlit_ambush');
  });
});

describe('modelSlug with a reasoning level', () => {
  const ids = ['deepseek/deepseek-v4-pro-0813@low', 'deepseek/deepseek-v4-pro-0813@max', 'deepseek/deepseek-v4-pro-0813'];

  it('gives each level of a long model ID its own folder', async () => {
    // Regression: the hash suffix ignores the last characters, so @low and @max shared a folder.
    const { modelSlug } = await import('../../src/plugins/base.js');
    const slugs = ids.map(modelSlug);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs[0]).toMatch(/_low$/);
    for (const slug of slugs) {
      expect(slug.length).toBeLessThanOrEqual(24);
      expect(shortSlug(slug)).toBe(slug); // the GUI importer re-slugs folder names
    }
    expect(modelSlug('a/b@high')).toBe('a_b_high');
  });

  it('matches the GUI loader', async () => {
    const { modelSlug } = await import('../../src/plugins/base.js');
    const gui = await import('../../gui/src/data.js');
    for (const id of ids) expect(gui.modelSlug(id)).toBe(modelSlug(id));
  });

  it('lets a run compare two levels of a long model ID', async () => {
    const { normalizeRunPlan } = await import('../../src/run-plan.js');
    expect(normalizeRunPlan({ candidates: ids.slice(0, 2) }).candidates.map(c => c.id)).toEqual(ids.slice(0, 2));
  });
});
