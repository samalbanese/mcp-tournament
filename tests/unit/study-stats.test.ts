import { describe, expect, it } from 'vitest';
import {
  bootstrapInterval,
  krippendorffAlphaInterval,
  mean,
  quantile,
  seededRandom,
} from '../../src/study/stats.js';

describe('study statistics', () => {
  it('uses reproducible mulberry32 random numbers in [0, 1)', () => {
    const first = seededRandom(1);
    expect(first()).toBe(0.6270739405881613);
    const sequence = (seed: number) => {
      const random = seededRandom(seed);
      return Array.from({ length: 100 }, () => random());
    };
    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
    expect(sequence(42).every(value => value >= 0 && value < 1)).toBe(true);
  });

  it('takes arithmetic means and linearly interpolated quantiles', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNaN();
    expect(quantile([1, 3, 7, 9], 0.25)).toBe(2.5);
    expect(quantile([1, 3, 7, 9], 0.5)).toBe(5);
    expect(quantile([1, 9], 0)).toBe(1);
    expect(quantile([1, 9], 1)).toBe(9);
    expect(quantile([5], 0.7)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('bootstraps deterministically with the documented defaults', () => {
    const values = [1, 2, 3, 4, 5];
    const interval = bootstrapInterval(values, mean);
    expect(interval).toEqual(bootstrapInterval(values, mean, {
      seed: 20261001, iterations: 2000, level: 0.95,
    }));
    expect(interval.low).toBeLessThan(mean(values));
    expect(interval.high).toBeGreaterThan(mean(values));
    expect(bootstrapInterval([7], mean)).toEqual({ low: 7, high: 7 });
  });

  it('resamples whole units with replacement and uses percentile endpoints', () => {
    const units = [{ values: [1, 3] }, { values: [8, 10] }];
    const samples: number[] = [];
    const interval = bootstrapInterval(units, sample => {
      expect(sample).toHaveLength(2);
      expect(sample.every(unit => units.includes(unit))).toBe(true);
      const value = mean(sample.flatMap(unit => unit.values));
      samples.push(value);
      return value;
    }, { iterations: 100, seed: 42, level: 0.8 });
    expect(samples).toHaveLength(100);
    expect(samples).toContain(2);
    expect(samples).toContain(9);
    samples.sort((a, b) => a - b);
    expect(interval.low).toBeCloseTo(quantile(samples, 0.1), 12);
    expect(interval.high).toBeCloseTo(quantile(samples, 0.9), 12);
  });

  it('reports unavailable intervals and ignores undefined resampled statistics', () => {
    expect(bootstrapInterval([], mean)).toEqual({ low: NaN, high: NaN });
    expect(bootstrapInterval([0, 1], sample => sample.includes(1) ? 7 : NaN))
      .toEqual({ low: 7, high: 7 });
    expect(bootstrapInterval([1], () => NaN)).toEqual({ low: NaN, high: NaN });
  });

  it('rejects invalid bootstrap options', () => {
    for (const iterations of [0, -1, 1.5, Infinity]) {
      expect(() => bootstrapInterval([1], mean, { iterations })).toThrow();
    }
    for (const level of [0, 1, -0.1, NaN]) {
      expect(() => bootstrapInterval([1], mean, { level })).toThrow();
    }
  });

  it('matches hand-computed interval alpha references', () => {
    expect(krippendorffAlphaInterval([[1, 2], [3, 3], [5, 4]]))
      .toBeCloseTo(5 / 6, 9);
    expect(krippendorffAlphaInterval([[2, 2], [4, 4], [7, 7]])).toBe(1);
    expect(krippendorffAlphaInterval([[1, 2, null], [3, 3, 3], [null, 5, 4]]))
      .toBeCloseTo(29 / 35, 9);
    expect(krippendorffAlphaInterval([[1, 2], [3, 3], [5, 4], [9, null]]))
      .toBeCloseTo(5 / 6, 9);
  });

  it('weights unequal judge counts using pairable values, not unit count', () => {
    // Observed disagreement = (2 + 14) / 5; expected = 2 * 10.8 / 4.
    expect(krippendorffAlphaInterval([[1, 2], [2, 4, 5]]))
      .toBeCloseTo(11 / 27, 9);
  });

  it('returns null for insufficient evidence or no expected disagreement', () => {
    for (const units of [[], [[1, 2]], [[1, null], [null, 2]], [[3, 3], [3, 3]]]) {
      expect(krippendorffAlphaInterval(units)).toBeNull();
    }
    expect(krippendorffAlphaInterval([[1, 5], [5, 1]])).toBeCloseTo(-0.5, 9);
  });
});
