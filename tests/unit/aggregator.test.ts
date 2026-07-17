import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLeaderboard } from '../../src/phases/aggregator.js';
import { modelSlug, scenarioSlug, type TestCase } from '../../src/plugins/base.js';
import type { CandidateModel } from '../../src/config/models.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('leaderboard aggregation', () => {
  it('writes contract-shaped entries with string scenario IDs in score order', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tournament-'));
    temporaryDirectories.push(outputDir);
    const scenario: TestCase = {
      id: 'scenario-01', name: 'Scenario One', description: 'Test',
      setupMessage: 'Start', goalCard: 'Finish', minTurns: 1, maxTurns: 1,
    };
    const candidates: CandidateModel[] = [
      { id: 'model/low', name: 'Low', tier: 'budget', notes: '' },
      { id: 'model/high', name: 'High', tier: 'mid', notes: '' },
    ];
    for (const [candidate, score] of [[candidates[0], 4], [candidates[1], 8]] as const) {
      const judgeDir = path.join(
        outputDir, 'judges', modelSlug(candidate.id), scenarioSlug(scenario),
      );
      fs.mkdirSync(judgeDir, { recursive: true });
      fs.writeFileSync(path.join(judgeDir, 'synthesis.json'), JSON.stringify({
        final_scores: { quality: { score, confidence: 'high', outliers: [] } },
        average_score: score,
        rule_errors_confirmed: [],
        assessment: 'Synthetic result',
        judge_agreement: '100%',
      }));
    }

    const leaderboard = buildLeaderboard(outputDir, candidates, [scenario]);
    const written = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'leaderboard.json'), 'utf8'),
    );
    expect(leaderboard.map(entry => entry.modelId)).toEqual(['model/high', 'model/low']);
    expect(written).toEqual(leaderboard);
    expect(typeof leaderboard[0].scenarioScores[0].scenarioId).toBe('string');
    expect(Object.keys(leaderboard[0]).sort()).toEqual(
      ['modelId', 'modelName', 'overallAverage', 'scenarioScores', 'tier'].sort(),
    );
    expect(Object.keys(leaderboard[0].scenarioScores[0]).sort()).toEqual(
      ['average', 'flags', 'ruleErrors', 'scenarioId', 'scenarioName', 'scores'].sort(),
    );
  });
});
