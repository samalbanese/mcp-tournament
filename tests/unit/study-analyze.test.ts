import { describe, expect, it } from 'vitest';
import { analyzeStudy, type ScoreRow } from '../../src/study/analyze.js';
import { bootstrapInterval, mean, seededRandom } from '../../src/study/stats.js';

const families = ['anthropic', 'openai', 'google', 'deepseek', 'qwen'];
const qualities = [6.5, 7.5, 7, 6, 5.5];

function synthetic(bias = 0, quality = qualities): ScoreRow[] {
  const random = seededRandom(42);
  const rows: ScoreRow[] = [];
  for (let pair = 0; pair < 6; pair++) {
    const noise = families.map(() => families.map(() => (random() - 0.5) * 1.8));
    for (let side = 0; side < 2; side++) {
      const scenario = pair * 2 + side;
      const sign = side === 0 ? 1 : -1;
      families.forEach((candidate, c) => families.forEach((judge, j) => {
        for (let criterion = 0; criterion < 3; criterion++) {
          rows.push({
            runId: `run-${Math.floor(scenario / 4)}-${Math.floor(c / 3)}`,
            bench: `bench-${Math.floor(scenario / 4)}`,
            benchLabel: `Bench ${Math.floor(scenario / 4)}`,
            scenarioId: `scenario-${scenario % 4}`,
            scenarioName: `Scenario ${scenario}`,
            candidateRef: `${candidate}/model`, candidateFamily: candidate, candidateLabel: candidate,
            judgeRole: `custom_${j + 1}`, judgeRef: `${judge}/judge`, judgeFamily: judge,
            criterion: `criterion-${criterion}`,
            score: quality[c] + sign * (0.4 + noise[c][j]) + (criterion - 1) * 0.1
              + (c === 0 && j === 0 ? bias : 0),
          });
        }
      }));
    }
  }
  return rows;
}

function answer(
  candidateRef: string,
  scores: number[][],
  overrides: Partial<ScoreRow> = {},
): ScoreRow[] {
  return scores.flatMap((criteria, judge) => criteria.map((score, criterion) => ({
    runId: 'run-a', bench: 'bench-a', benchLabel: 'Bench A',
    scenarioId: 'scenario-a', scenarioName: 'Scenario A',
    candidateRef, candidateFamily: candidateRef, candidateLabel: candidateRef.toUpperCase(),
    judgeRole: `custom_${judge + 1}`, judgeRef: `judge-${judge}`, judgeFamily: ['a', 'b', 'c'][judge],
    criterion: `criterion-${criterion}`, score, ...overrides,
  })));
}

describe('study analysis', () => {
  it('detects planted self-preference with an interval excluding zero', () => {
    const result = analyzeStudy(synthetic(1));
    const own = result.selfPreference.find(row => row.judgeFamily === 'anthropic')!.ownFamily!;
    expect(own.mean).toBeGreaterThanOrEqual(0.8);
    expect(own.mean).toBeLessThanOrEqual(1.2);
    expect(own.low).toBeGreaterThan(0);
    for (const judge of result.selfPreference.filter(row => row.judgeFamily !== 'anthropic')) {
      expect(judge.ownFamily!.low).toBeLessThanOrEqual(0);
      expect(judge.ownFamily!.high).toBeGreaterThanOrEqual(0);
    }
  });

  it('includes zero in every self-preference interval without planted bias', () => {
    for (const judge of analyzeStudy(synthetic()).selfPreference) {
      expect(judge.ownFamily!.mean).toBeCloseTo(0, 12);
      expect(judge.ownFamily!.low).toBeLessThanOrEqual(0);
      expect(judge.ownFamily!.high).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks by answer means and marks overlapping intervals symmetrically', () => {
    const result = analyzeStudy(synthetic());
    expect(result.answers).toEqual({ total: 60, analyzed: 60, dropped: 0 });
    expect(result.leaderboards).toHaveLength(4);
    for (const board of result.leaderboards) {
      expect(board.rows.map(row => row.family)).toEqual(['openai', 'google', 'anthropic', 'deepseek', 'qwen']);
      expect(board.rows.map(row => row.rank)).toEqual([1, 2, 3, 4, 5]);
      for (const row of board.rows) {
        expect(row.score.mean).toBeCloseTo(qualities[families.indexOf(row.family)], 12);
        expect(row.tiedWith).not.toContain(row.candidateRef);
      }
    }
    const tied = analyzeStudy(synthetic(0, [7.5, 7.5, 7, 6, 5.5]));
    const board = tied.leaderboards.find(row => row.bench === 'overall')!;
    expect(board.rows.find(row => row.family === 'anthropic')!.tiedWith).toContain('openai/model');
    expect(board.rows.find(row => row.family === 'openai')!.tiedWith).toContain('anthropic/model');
    const separated = analyzeStudy([...answer('a', [[9], [9]]), ...answer('b', [[2], [2]])]);
    expect(separated.leaderboards[0].rows.every(row => row.tiedWith.length === 0)).toBe(true);
  });

  it('drops only answers with fewer than two judges after partial failures', () => {
    const rows = synthetic().filter(row => {
      if (row.candidateFamily !== 'anthropic' || row.bench !== 'bench-0') return true;
      return row.scenarioId === 'scenario-3'
        ? row.judgeRole === 'custom_1'
        : row.judgeRole !== 'custom_5';
    });
    const result = analyzeStudy(rows);
    expect(result.answers).toEqual({ total: 60, analyzed: 59, dropped: 1 });
    expect(result.contested.some(row => row.candidateRef === 'anthropic/model'
      && row.bench === 'bench-0' && row.scenarioId === 'scenario-3')).toBe(false);
  });

  it('averages returned criteria per judge before giving each judge equal weight', () => {
    const result = analyzeStudy(answer('a', [[2, 4], [9]]));
    expect(result.leaderboards[0].rows[0].score).toEqual({ mean: 6, low: 6, high: 6 });
    expect(result.contested[0].byJudge).toEqual({ a: 3, b: 9 });
    expect(result.contested[0].spread).toBe(6);
  });

  it('computes other-judge offsets and own-minus-other preference exactly', () => {
    const result = analyzeStudy([...answer('a', [[8], [6], [6]]), ...answer('b', [[6], [6], [6]])]);
    const judgeA = result.selfPreference.find(row => row.judgeRef === 'judge-0')!;
    expect(judgeA.matrix).toEqual({ a: 2, b: 0 });
    expect(judgeA.ownFamily).toEqual({ mean: 2, low: 2, high: 2 });
    const judgeB = result.selfPreference.find(row => row.judgeRef === 'judge-1')!;
    expect(judgeB.matrix).toEqual({ a: -1, b: 0 });
    expect(judgeB.ownFamily).toEqual({ mean: 1, low: 1, high: 1 });
    expect(result.selfPreference.find(row => row.judgeRef === 'judge-2')!.ownFamily).toBeNull();
  });

  it('changes the biased judge winner while other judges retain the quality winner', () => {
    const result = analyzeStudy(synthetic(3));
    for (const judge of result.singleJudgeWinners) {
      expect(judge.winnerRef).toBe(judge.judgeFamily === 'anthropic' ? 'anthropic/model' : 'openai/model');
    }
    const ties = analyzeStudy([...answer('b', [[6], [6]]), ...answer('a', [[6], [6]])]);
    expect(ties.singleJudgeWinners.every(row => row.winnerRef === 'a' && row.winnerLabel === 'A')).toBe(true);
  });

  it('returns sorted unique run IDs containing analyzed answers in each scope', () => {
    const result = analyzeStudy([
      ...answer('a', [[6], [6]], { runId: 'run-z' }),
      ...answer('a', [[7], [7]], { runId: 'run-a' }),
      ...answer('a', [[8], [8]], { runId: 'run-a', scenarioId: 'scenario-b' }),
      ...answer('a', [[5], [5]], { runId: 'run-m', bench: 'bench-b', benchLabel: 'Bench B' }),
      ...answer('a', [[10]], { runId: 'run-dropped' }),
      ...answer('b', [[9], [9]], { runId: 'run-other' }),
    ]);
    const row = (bench: string) => result.leaderboards.find(board => board.bench === bench)!
      .rows.find(candidate => candidate.candidateRef === 'a')!;
    expect(result.answers).toEqual({ total: 6, analyzed: 5, dropped: 1 });
    expect(row('overall').runIds).toEqual(['run-a', 'run-m', 'run-z']);
    expect(row('bench-a').runIds).toEqual(['run-a', 'run-z']);
    expect(row('bench-b').runIds).toEqual(['run-m']);
  });

  it('bootstraps scenario clusters, keeping batches together and benches distinct', () => {
    const rows = [
      ...answer('a', [[1], [1]], { runId: 'run-1' }),
      ...answer('a', [[3], [3]], { runId: 'run-2' }),
      ...answer('a', [[9], [9]], { bench: 'bench-b', benchLabel: 'Bench B' }),
    ];
    const result = analyzeStudy(rows);
    const expected = bootstrapInterval([[1, 3], [9]], sample => mean(sample.flat()));
    expect(result.leaderboards[0].rows[0].score).toEqual({ mean: 13 / 3, ...expected });
  });

  it('computes agreement on judge means overall and per bench', () => {
    const rows = [[1, 2], [3, 3], [5, 4]].flatMap((scores, index) =>
      answer('a', scores.map(score => [score]), { scenarioId: `s-${index}` }));
    rows.push(...answer('a', [[9]], { scenarioId: 'dropped' }));
    const result = analyzeStudy(rows);
    expect(result.agreement.overall).toBeCloseTo(5 / 6, 9);
    expect(result.agreement.byBench['bench-a']).toBeCloseTo(5 / 6, 9);
    const missing = analyzeStudy([
      ...answer('a', [[1], [2], []]),
      ...answer('a', [[3], [3], [3]], { scenarioId: 's-2' }),
      ...answer('a', [[], [5], [4]], { scenarioId: 's-3' }),
    ]);
    expect(missing.agreement.overall).toBeCloseTo(29 / 35, 9);
  });

  it('returns the top five contested answers with stable evidence ordering', () => {
    const keys = [
      ['run-b', 's-a', 'a'], ['run-a', 's-b', 'a'], ['run-a', 's-a', 'b'],
      ['run-a', 's-a', 'a'], ['run-c', 's-a', 'a'], ['run-d', 's-a', 'a'],
    ];
    const rows = keys.flatMap(([runId, scenarioId, candidate]) =>
      answer(candidate, [[2], [8]], { runId, scenarioId }));
    rows.push(...answer('a', [[1], [10]], { runId: 'run-z' }));
    const contested = analyzeStudy(rows).contested;
    expect(contested.map(row => [row.runId, row.scenarioId, row.candidateRef])).toEqual([
      ['run-z', 'scenario-a', 'a'], ['run-a', 's-a', 'a'], ['run-a', 's-a', 'b'],
      ['run-a', 's-b', 'a'], ['run-b', 's-a', 'a'],
    ]);
    expect(contested[0].spread).toBe(9);
  });

  it('handles empty input and entirely dropped data without inventing scores', () => {
    expect(analyzeStudy([])).toEqual({
      answers: { total: 0, analyzed: 0, dropped: 0 },
      leaderboards: [{ bench: 'overall', label: 'Overall', rows: [] }],
      selfPreference: [], singleJudgeWinners: [], agreement: { overall: null, byBench: {} }, contested: [],
    });
    const result = analyzeStudy(answer('a', [[10]]));
    expect(result.answers).toEqual({ total: 1, analyzed: 0, dropped: 1 });
    expect(result.leaderboards.every(board => board.rows.length === 0)).toBe(true);
    expect(result.agreement).toEqual({ overall: null, byBench: { 'bench-a': null } });
    expect(result.singleJudgeWinners).toEqual([]);
    expect(result.selfPreference[0].matrix.a).toBeNull();
    expect(result.selfPreference[0].ownFamily).toBeNull();
  });

  it('handles judges without observations for a candidate family', () => {
    const result = analyzeStudy([
      ...answer('a', [[4], [6], []]),
      ...answer('b', [[], [7], [9]]),
    ]);
    const judge = result.selfPreference.find(row => row.judgeRef === 'judge-0')!;
    expect(judge.matrix).toEqual({ a: -2, b: null });
    expect(judge.ownFamily).toBeNull();
    expect(result.singleJudgeWinners.find(row => row.judgeFamily === 'a')!.scores).toEqual({ a: 4 });
    expect(JSON.stringify(result)).not.toContain('NaN');
  });

  it('is deterministic under row reordering and does not mutate its input', () => {
    const rows = synthetic();
    const original = structuredClone(rows);
    const result = analyzeStudy(rows);
    expect(rows).toEqual(original);
    expect(analyzeStudy([...rows].reverse())).toEqual(result);
  });
});
