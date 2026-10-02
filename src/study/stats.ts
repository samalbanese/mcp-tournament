// Mulberry32 supplies repeatable uniform draws in [0, 1) from a 32-bit seed.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Arithmetic mean; an empty sample has no mean (NaN).
export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Quantiles linearly interpolate adjacent sorted values at (n - 1) * q.
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Percentile bootstrap: resample whole units with replacement at the original size.
export function bootstrapInterval<T>(
  units: T[],
  statistic: (sample: T[]) => number,
  options: { iterations?: number; seed?: number; level?: number } = {},
): { low: number; high: number } {
  const { iterations = 2000, seed = 20261001, level = 0.95 } = options;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError('Bootstrap iterations must be a positive integer');
  }
  if (!(level > 0 && level < 1)) {
    throw new RangeError('Bootstrap level must be between 0 and 1');
  }
  if (!units.length) return { low: NaN, high: NaN };
  const random = seededRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from({ length: units.length }, () => units[Math.floor(random() * units.length)]);
    const estimate = statistic(sample);
    // Missing observations can leave a resample undefined; retain only estimable draws.
    if (Number.isFinite(estimate)) estimates.push(estimate);
  }
  estimates.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { low: quantile(estimates, tail), high: quantile(estimates, 1 - tail) };
}

// Interval alpha = 1 - observed / expected squared disagreement, with missing values omitted.
export function krippendorffAlphaInterval(units: Array<Array<number | null>>): number | null {
  const pairable = units.map(unit => unit.filter((value): value is number => value !== null))
    .filter(unit => unit.length >= 2);
  if (pairable.length < 2) return null;
  const values = pairable.flat();
  const center = mean(values);
  const squaredDeviations = values.reduce((sum, value) => sum + (value - center) ** 2, 0);
  // Chance disagreement pairs all pairable values without replacement.
  const expected = 2 * squaredDeviations / (values.length - 1);
  if (expected === 0) return null;
  let disagreement = 0;
  for (const unit of pairable) {
    let pairs = 0;
    for (let left = 0; left < unit.length; left++) {
      for (let right = left + 1; right < unit.length; right++) {
        pairs += 2 * (unit[left] - unit[right]) ** 2;
      }
    }
    // Coincidence weighting gives each observed rating one unit of total pair weight.
    disagreement += pairs / (unit.length - 1);
  }
  return 1 - (disagreement / values.length) / expected;
}
