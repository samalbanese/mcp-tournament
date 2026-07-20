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
