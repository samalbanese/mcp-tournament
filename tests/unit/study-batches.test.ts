import { beforeAll, describe, expect, it } from 'vitest';
import { loadDiscoveredBenches } from '../../src/plugins/custom.js';
import { getPlugin } from '../../src/plugins/index.js';
import { normalizeRunPlan, PLAN_LIMITS } from '../../src/run-plan.js';
import { planBatches, validateStudyAgainstBenches, type StudyBatch } from '../../src/study/batches.js';
import { parseStudy, StudyError, StudyFamilySchema, StudySchema, type Study } from '../../src/study/schema.js';

function fixture(): Study {
  const candidates = [
    { ref: 'anthropic:claude-opus-5-5', family: 'anthropic', label: 'Claude' },
    { ref: 'openai/gpt-6.1-sol', family: 'openai', label: 'GPT' },
    { ref: 'google/gemini-3.1-pro-preview', family: 'google', label: 'Gemini' },
    { ref: 'deepseek/deepseek-v4-pro-0813', family: 'deepseek', label: 'DeepSeek' },
    { ref: 'qwen/qwen3.8-max-0902', family: 'qwen', label: 'Qwen' },
  ];
  return {
    id: 'unit-study', title: 'Business model study', reasoningEffort: 'low',
    benches: [
      { bench: 'business-strategy', label: 'Strategy', scenarios: ['pricing-pivot'] },
      { bench: 'customer-support', label: 'Support', scenarios: ['billing-dispute'] },
      { bench: 'creative-writing', label: 'Writing', scenarios: ['opening-chapter'] },
    ],
    candidates, judges: candidates.map(({ ref, family }) => ({ ref, family })),
    judgeLens: 'Score the response using the scenario criteria.',
    participant: 'meta-llama/llama-4-maverick', synthesizer: 'z-ai/glm-5.3',
  };
}

beforeAll(() => { loadDiscoveredBenches(); });

function expectCoverage(study: Study, batches: StudyBatch[]): void {
  const expected = study.benches.flatMap(bench => study.candidates.flatMap(candidate =>
    bench.scenarios.map(scenario => JSON.stringify([candidate.ref, bench.bench, scenario]))));
  const actual = batches.flatMap(batch => batch.candidates.flatMap(candidate =>
    batch.plan.scenarios!.map(scenario => JSON.stringify([candidate, batch.bench, scenario]))));
  expect(actual.sort()).toEqual(expected.sort());
  expect(new Set(actual).size).toBe(actual.length);
}

describe('parseStudy', () => {
  it('parses the study and trims shared model refs and display fields', () => {
    const input = fixture();
    input.title = '  Business model study  ';
    input.candidates[0].ref = '  anthropic:claude-opus-5-5  ';
    input.benches[0].scenarios[0] = '  pricing-pivot  ';
    expect(parseStudy(input)).toEqual(fixture());
    expect(StudySchema.safeParse(fixture()).success).toBe(true);
  });

  it('allows candidates without a matching judge family and repeated candidate families', () => {
    const input = fixture();
    input.candidates[0].family = 'new-lab';
    input.candidates[1].family = 'new-lab';
    expect(parseStudy(input).candidates[0].family).toBe('new-lab');
  });

  it.each(['minimal', 'low', 'medium', 'high', undefined] as const)('accepts reasoning effort %s', effort => {
    expect(parseStudy({ ...fixture(), reasoningEffort: effort }).reasoningEffort).toBe(effort);
  });

  it.each([
    ['too few candidates', (s: Study) => { s.candidates = s.candidates.slice(0, 1); }, /candidates/],
    ['too many candidates', (s: Study) => { s.candidates = Array.from({ length: 9 }, (_, i) => ({ ref: `lab/model-${i}`, family: 'lab', label: `Model ${i}` })); }, /candidates/],
    ['too few judges', (s: Study) => { s.judges = s.judges.slice(0, 1); }, /judges/],
    ['six judges', (s: Study) => { s.judges.push({ ref: 'other/judge', family: 'other' }); }, /judges/],
    ['duplicate candidate', (s: Study) => { s.candidates[4].ref = ` ${s.candidates[0].ref} `; }, /candidates\.4\.ref.*duplicate/i],
    ['duplicate judge', (s: Study) => { s.judges[4].ref = s.judges[0].ref; }, /judges\.4\.ref.*duplicate/i],
    ['duplicate judge family', (s: Study) => { s.judges[4].family = s.judges[0].family; }, /judges\.4\.family.*duplicate/i],
    ['bad id', (s: Study) => { s.id = '../Bad'; }, /id/],
    ['bad candidate family', (s: Study) => { s.candidates[0].family = 'Unknown Lab'; }, /candidates\.0\.family/],
    ['bad judge family', (s: Study) => { s.judges[0].family = 'X'; }, /judges\.0\.family/],
    ['empty benches', (s: Study) => { s.benches = []; }, /benches/],
    ['empty scenarios', (s: Study) => { s.benches[0].scenarios = []; }, /benches\.0\.scenarios/],
    ['blank model', (s: Study) => { s.participant = ' '; }, /participant/],
    ['long model', (s: Study) => { s.synthesizer = 'x'.repeat(201); }, /synthesizer/],
    ['blank lens', (s: Study) => { s.judgeLens = ' '; }, /judgeLens/],
    ['long lens', (s: Study) => { s.judgeLens = 'x'.repeat(1001); }, /judgeLens/],
  ] as const)('rejects %s with a field path', (_name, mutate, message) => {
    const input = fixture();
    mutate(input);
    expect(() => parseStudy(input)).toThrow(StudyError);
    expect(() => parseStudy(input)).toThrow(message);
  });

  it.each(['root', 'bench', 'candidate', 'judge'])('rejects unknown keys at the %s level', level => {
    const input = fixture();
    const target = level === 'root' ? input : level === 'bench' ? input.benches[0]
      : level === 'candidate' ? input.candidates[0] : input.judges[0];
    Object.assign(target, { unexpected: true });
    expect(() => parseStudy(input)).toThrow(/unexpected/);
  });

  it('rejects an unsupported reasoning effort', () => {
    expect(() => parseStudy({ ...fixture(), reasoningEffort: 'turbo' })).toThrow(/reasoningEffort/);
  });

  it('enforces family slug boundaries without a fixed lab roster', () => {
    for (const family of ['ab', 'new-lab', 'x'.repeat(30)]) expect(StudyFamilySchema.safeParse(family).success).toBe(true);
    for (const family of ['a', 'x'.repeat(31), 'OpenAI', 'lab_name', ' lab']) expect(StudyFamilySchema.safeParse(family).success).toBe(false);
  });
});

describe('study batches', () => {
  it('creates six balanced batches with valid plans and distinct judge roles', () => {
    const study = parseStudy(fixture());
    const batches = planBatches(study);
    expect(batches.map(batch => batch.batchId)).toEqual(['1-1', '1-2', '2-1', '2-2', '3-1', '3-2']);
    expect(batches.map(batch => batch.candidates.length)).toEqual([3, 2, 3, 2, 3, 2]);
    expectCoverage(study, batches);
    for (const batch of batches) {
      expect(batch.runId).toBe(`run-study-${study.id}-${batch.batchId}`);
      expect(batch.runId).toMatch(/^run-[a-zA-Z0-9-]+$/);
      expect(batch.plan).toEqual({
        bench: batch.bench, scenarios: study.benches.find(bench => bench.bench === batch.bench)!.scenarios,
        candidates: batch.candidates, participant: study.participant, synthesizer: study.synthesizer,
        judgePanel: study.judges.map(judge => ({ model: judge.ref, customPersona: { name: `${judge.family} judge`, lens: study.judgeLens } })),
      });
      const resolved = normalizeRunPlan(batch.plan);
      expect(resolved.judges.map(judge => judge.role)).toEqual(['custom_1', 'custom_2', 'custom_3', 'custom_4', 'custom_5']);
      expect(resolved.judges.every(judge => judge.lens === study.judgeLens)).toBe(true);
      expect(resolved.participant.ref).toBe(study.participant);
      expect(resolved.synthesizer.ref).toBe(study.synthesizer);
    }
  });

  it.each([
    [2, [2]], [3, [3]], [4, [4]], [5, [3, 2]], [6, [3, 3]], [7, [4, 3]], [8, [4, 4]],
  ] as const)('balances %i candidates with complete multi-scenario coverage', (count, sizes) => {
    const input = fixture();
    input.candidates = Array.from({ length: count }, (_, i) => ({ ref: `lab/model-${i}`, family: 'lab', label: `Model ${i}` }));
    input.benches = [{ bench: 'dnd', label: 'D&D', scenarios: getPlugin('dnd').scenarios.map(scenario => scenario.id) }];
    expect(input.benches[0].scenarios.length).toBeGreaterThan(1);
    const study = parseStudy(input);
    const before = structuredClone(study);
    const batches = planBatches(study);
    expect(batches.map(batch => batch.candidates.length)).toEqual(sizes);
    expect(batches).toHaveLength(Math.ceil(count / PLAN_LIMITS.candidates[1]));
    expectCoverage(study, batches);
    for (const batch of batches) expect(() => normalizeRunPlan(batch.plan)).not.toThrow();
    expect(planBatches(study)).toEqual(batches);
    expect(study).toEqual(before);
  });

  it('validates selected scenarios against their own bench', () => {
    const study = parseStudy(fixture());
    expect(() => validateStudyAgainstBenches(study)).not.toThrow();
    study.benches[0].scenarios = ['billing-dispute'];
    expect(() => validateStudyAgainstBenches(study)).toThrow(StudyError);
    expect(() => validateStudyAgainstBenches(study)).toThrow(/business-strategy.*billing-dispute/);
    expect(() => planBatches(study)).toThrow(StudyError);
  });

  it('reports an unknown bench as a study error before planning', () => {
    const study = parseStudy(fixture());
    study.benches[0].bench = 'missing-bench';
    expect(() => validateStudyAgainstBenches(study)).toThrow(StudyError);
    expect(() => validateStudyAgainstBenches(study)).toThrow(/missing-bench/);
    expect(() => planBatches(study)).toThrow(StudyError);
  });

  it.each(['within a bench', 'across bench entries'])('rejects repeated scenario coverage %s', location => {
    const study = parseStudy(fixture());
    if (location === 'within a bench') study.benches[0].scenarios.push('pricing-pivot');
    else study.benches.push(structuredClone(study.benches[0]));
    expect(() => validateStudyAgainstBenches(study)).toThrow(StudyError);
    expect(() => validateStudyAgainstBenches(study)).toThrow(/duplicate scenario "pricing-pivot".*business-strategy/);
  });

  it('wraps run-plan errors with the failing batch ID', () => {
    const study = parseStudy(fixture());
    study.candidates[4].ref = 'chatgpt:gpt-5.4';
    expect(() => planBatches(study)).toThrow(StudyError);
    expect(() => planBatches(study)).toThrow(/batch 1-2:.*not set up yet/);
  });
});
