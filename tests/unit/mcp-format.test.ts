import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFailure, splitFailures } from '../../src/mcp/format.js';

const judgeMiss = {
  model: 'google/gemini-2.5-flash-lite',
  scenario: 'billing-dispute',
  error: 'judge Rules Judge: Rules Judge returned invalid score JSON',
};
const skippedPair = { model: 'x-ai/grok-4.3', scenario: 'billing-dispute', error: 'upstream 503' };

describe('MCP failure formatting', () => {
  it('separates skipped pairs from judge misses on scored pairs', () => {
    expect(splitFailures([judgeMiss, skippedPair])).toEqual({
      skipped: [skippedPair],
      judgeMisses: [judgeMiss],
    });
  });

  it('does not repeat the judge name', () => {
    expect(describeFailure(judgeMiss)).toBe(
      'google/gemini-2.5-flash-lite on `billing-dispute`: Rules Judge returned invalid score JSON',
    );
    expect(describeFailure({ ...judgeMiss, error: 'judge Rules Judge: timed out' })).toContain(
      '`billing-dispute`: Rules Judge: timed out',
    );
  });
});

describe('results directory', () => {
  it('honors TOURNAMENT_RESULTS_DIR so MCP clients can point at the repo results', async () => {
    const { createContext } = await import('../../src/mcp/data.js');
    const previous = process.env.TOURNAMENT_RESULTS_DIR;
    process.env.TOURNAMENT_RESULTS_DIR = path.resolve('some', 'results-dir');
    try {
      expect(createContext().resultsRoot).toBe(path.resolve('some', 'results-dir'));
    } finally {
      if (previous === undefined) delete process.env.TOURNAMENT_RESULTS_DIR;
      else process.env.TOURNAMENT_RESULTS_DIR = previous;
    }
  });
});
