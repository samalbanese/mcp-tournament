import { describe, expect, it } from 'vitest';
import { compactRunSummary } from '../../src/pipeline.js';

describe('compactRunSummary', () => {
  it('reports judge misses separately from skipped pairs', () => {
    const summary = compactRunSummary({
      runId: 'run-test',
      runDir: 'results/run-test',
      leaderboard: [],
      failures: [],
      judgeFailures: [{
        model: 'candidate/model',
        scenario: 'scenario-01',
        error: 'judge Rules Judge: invalid score JSON',
      }],
    });

    expect(summary).toContain(
      'Incomplete judge panels: candidate/model/scenario-01 (judge Rules Judge)',
    );
    expect(summary).not.toContain('Skipped 1 failed pair');
  });
});
