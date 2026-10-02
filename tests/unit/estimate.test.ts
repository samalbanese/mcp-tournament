import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../src/catalog.js';
import { estimateRunCost } from '../../src/estimate.js';
import { applyReasoningCatalog, type ReasoningLevel } from '../../src/config/reasoning.js';
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

  it('adds hidden candidate output at high for every turn and scenario', () => {
    const prices = live([['a/b', 1, 10]]);
    prices.models[0] = { ...prices.models[0], reasoningLevels: ['low', 'high'] };
    const input = { bench: 'dnd', scenarios: ['dnd-combat', 'dnd-roleplay'], turns: 3,
      judgePanel: [{ model: 'unpriced/judge' }] };
    const high = normalizeRunPlan({ ...input, candidates: ['a/b@high'] });
    expect(applyReasoningCatalog(high, prices).errors).toEqual([]);
    // Estimate the zero-reasoning baseline directly; this fixture only advertises low and high.
    const none = normalizeRunPlan({ ...input, candidates: ['a/b@none'] });
    expect(estimateRunCost(high, prices).usd! - estimateRunCost(none, prices).usd!)
      .toBeCloseTo(8000 * 3 * 2 * 10 / 1e6, 8);
  });

  it('adds default hidden judge output once per judged answer', () => {
    const prices = live([['a/judge', 1, 10]]);
    prices.models[0].reasonsByDefault = true;
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/cand', 'b/cand'],
      scenarios: ['dnd-combat', 'dnd-roleplay'], turns: 3, judgePanel: [{ model: 'a/judge' }] });
    applyReasoningCatalog(plan, prices);
    const thinking = estimateRunCost(plan, prices);
    plan.judges[0].thinks = false;
    expect(thinking.usd! - estimateRunCost(plan, prices).usd!).toBeCloseTo(4000 * 2 * 2 * 10 / 1e6, 8);
  });

  it.each([
    ['none', 0], ['minimal', 500], ['low', 2000], ['medium', 4000],
    ['high', 8000], ['xhigh', 12000], ['max', 16000],
  ] as const)('prices the %s level independently for every seat', (reasoning, hidden) => {
    const prices = live([['a/b', 0, 10]]);
    const estimate = (level: ReasoningLevel) => {
      const plan = normalizeRunPlan({ bench: 'dnd', candidates: [`a/b@${level}`], scenarios: ['dnd-combat'],
        turns: 3, judgePanel: [{ model: `a/b@${level}` }, { model: `a/b@${level}` }],
        synthesizer: `a/b@${level}`, participant: `a/b@${level}` });
      return estimateRunCost(plan, prices).usd!;
    };
    // Three candidate turns, two follow-ups, two judges, and one synthesis.
    expect(estimate(reasoning) - estimate('none')).toBeCloseTo(hidden * 8 * 10 / 1e6, 8);
  });

  it('prices default reasoning in candidates, synthesis, and participant follow-ups', () => {
    const prices = live([['a/b', 0, 10]]);
    prices.models[0].reasonsByDefault = true;
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b'], scenarios: ['dnd-combat'], turns: 3,
      judgePanel: [{ model: 'unpriced/judge' }, { model: 'unpriced/judge' }], synthesizer: 'a/b', participant: 'a/b' });
    const baseline = estimateRunCost(plan, prices).usd!;
    applyReasoningCatalog(plan, prices);
    expect(estimateRunCost(plan, prices).usd! - baseline).toBeCloseTo(4000 * 6 * 10 / 1e6, 8);
  });

  it('explains hidden reasoning in the estimate assumptions', () => {
    const plan = normalizeRunPlan({ bench: 'dnd', candidates: ['a/b'] });
    expect(estimateRunCost(plan, live([])).assumptions).toContain('hidden reasoning');
    expect(estimateRunCost(plan, { source: 'curated-fallback', models: [] }).assumptions).toContain('hidden reasoning');
  });
});
