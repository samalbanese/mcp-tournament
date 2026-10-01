import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../src/catalog.js';
import { estimateRunCost } from '../../src/estimate.js';
import { normalizeRunPlan } from '../../src/run-plan.js';
import '../../src/plugins/index.js';

const live = (models: Array<[string, number, number]>): Catalog => ({
  source: 'live',
  models: models.map(([id, promptPrice, completionPrice]) => ({ id, name: id, contextLength: 0, promptPrice, completionPrice })),
});

describe('estimateRunCost', () => {
  it('skips the synthesizer for one judge', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand'], scenarios: ['dnd-combat'],
      judgePanel: [{ model: 'a/judge' }], synthesizer: 'unpriced/synth', turns: 1 });
    const estimate = estimateRunCost(plan, live([['a/cand', 10, 10], ['a/judge', 10, 10]]));
    expect(estimate.usd).toBeCloseTo(0.044, 6);
    expect(estimate.excluded).toEqual([]);
  });

  it('prices growing inputs, follow-ups, and separate input/output rates for every pair', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand', 'b/cand'],
      scenarios: ['dnd-combat', 'dnd-roleplay'], judgePanel: [{ model: 'a/judge' }],
      participant: 'a/user', turns: 3 });
    const estimate = estimateRunCost(plan, live([
      ['a/cand', 1, 2], ['b/cand', 1, 2], ['a/judge', 3, 4], ['a/user', 5, 6],
    ]));
    // Per pair: candidate .0102, participant .00544, judge .01192.
    expect(estimate.usd).toBeCloseTo(4 * 0.02756, 8);
  });

  it('uses scenario defaults and omits synthesis for a quick plan', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand'], scenarios: ['dnd-combat'],
      judgePanel: [{ model: 'a/judge' }], participant: 'a/judge' });
    const prices = live([['a/cand', 1, 1], ['a/judge', 1, 1]]);
    const explicit = { ...plan, turns: plan.scenarios[0].maxTurns };
    expect(estimateRunCost(plan, prices)).toEqual(estimateRunCost(explicit, prices));
    const quick = { ...plan, turns: 1, quick: true, judges: [plan.judges[0], plan.judges[0]] };
    expect(estimateRunCost(quick, prices).usd).toBeCloseTo(0.0067, 8);
  });

  it('prices Anthropic refs by the matching catalog entry and formats small costs', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['anthropic:claude-haiku-4-5'],
      scenarios: ['dnd-combat'], judgePanel: [{ model: 'anthropic:claude-haiku-4-5' }], turns: 1 });
    const estimate = estimateRunCost(plan, live([['anthropic/claude-haiku-4.5', 1, 1]]));
    expect(estimate.usd).toBeCloseTo(0.0044, 8);
    expect(estimate.display).toBe('≈ < $0.01 (rough, could be ±50%)');
    expect(estimate.excluded).toEqual([]);
  });

  it('deduplicates excluded refs across roles and scenarios', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/unknown'],
      judgePanel: [{ model: 'a/unknown' }, { model: 'a/unknown' }],
      synthesizer: 'a/unknown', participant: 'a/unknown', turns: 2 });
    expect(estimateRunCost(plan, live([])).excluded).toEqual(['a/unknown']);
  });

  it('computes a deterministic estimate for a priced one-pair plan', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand'], scenarios: ['dnd-combat'],
      judgePanel: [{ model: 'a/judge' }, { model: 'a/judge' }], synthesizer: 'a/judge', participant: 'a/judge', turns: 1 });
    // T=1, all prices $10 per 1M: candidate 1500 in + 600 out = 2100 tokens -> 0.021
    // each judge (600 + 1000) in + 700 out = 2300 -> 0.023, x2 = 0.046
    // synthesizer (700 * 2 + 800) in + 500 out = 2700 -> 0.027; participant: 0 follow-ups at T=1
    const estimate = estimateRunCost(plan, live([['a/cand', 10, 10], ['a/judge', 10, 10]]));
    expect(estimate.usd).toBeCloseTo(0.094, 6);
    expect(estimate.display).toBe('≈ $0.09 (rough, could be ±50%)');
    expect(estimate.excluded).toEqual([]);
  });

  it('lists unpriced models as excluded', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand', 'b/unknown'], turns: 1 });
    const estimate = estimateRunCost(plan, live([['a/cand', 1, 1]]));
    expect(estimate.excluded).toContain('b/unknown');
    expect(estimate.display).toContain('excludes: ');
  });

  it('reports unavailable when the catalog is offline', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand'] });
    const estimate = estimateRunCost(plan, { source: 'curated-fallback', models: [] });
    expect(estimate.usd).toBeNull();
    expect(estimate.display).toBe('Cost estimate unavailable (model catalog offline).');
  });
});
