// aggregator.ts — Build leaderboard from judge synthesis scores.
// Ported from v1 backend/scripts/oracle-tournament/aggregator.mjs

import { CANDIDATE_MODELS, getModelTier } from '../config/models.js';
import { SCENARIOS, modelSlug, scenarioSlug } from '../plugins/base.js';
import { MIN_SCENARIO_SCORE } from '../config/constants.js';
import fs from 'node:fs';
import path from 'node:path';

export interface LeaderboardEntry {
  modelId: string;
  modelName: string;
  tier: string;
  overallAverage: number;
  scenarioScores: Array<{
    scenarioId: number;
    scenarioName: string;
    scores: Record<string, unknown>;
    average: number;
    confidence?: string;
    ruleErrors: string[];
  }>;
  totalToolCalls: number;
  usedRollDice: boolean;
  scenariosCompleted: number;
  disqualified: boolean;
  dqReasons: string[];
}

/**
 * Aggregate all judge synthesis data into a leaderboard.
 * @param outputDir - Run output directory
 * @returns { leaderboard, disqualified }
 */
export function buildLeaderboard(outputDir: string): {
  leaderboard: LeaderboardEntry[];
  disqualified: LeaderboardEntry[];
} {
  const results: LeaderboardEntry[] = [];
  const disqualified: LeaderboardEntry[] = [];

  for (const model of CANDIDATE_MODELS) {
    const slug = modelSlug(model.id);
    const scenarioScores: LeaderboardEntry['scenarioScores'] = [];
    let totalToolCalls = 0;
    let usedRollDice = false;

    for (const scenario of SCENARIOS) {
      const scSlug = scenarioSlug(scenario);
      const synthPath = path.join(outputDir, 'judges', slug, scSlug, 'synthesis.json');

      if (!fs.existsSync(synthPath)) continue;

      let synthData: {
        synthesis?: {
          final_scores?: Record<string, { score?: number }>;
          judge_agreement?: string;
          rule_errors_confirmed?: string[];
          average_score?: number;
        };
      };

      try {
        synthData = JSON.parse(fs.readFileSync(synthPath, 'utf-8'));
      } catch {
        continue;
      }

      if (!synthData.synthesis?.final_scores) continue;

      const scores = synthData.synthesis.final_scores;
      const scoreValues = Object.values(scores);
      const scenarioAvg =
        scoreValues.reduce((sum, s) => sum + (s.score ?? 0), 0) / scoreValues.length;

      scenarioScores.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        scores: scores as Record<string, unknown>,
        average: scenarioAvg,
        confidence: synthData.synthesis.judge_agreement,
        ruleErrors: synthData.synthesis.rule_errors_confirmed ?? [],
      });

      // Load metrics for tool call count
      const metricsPath = path.join(outputDir, 'candidates', slug, scSlug, 'metrics.json');
      if (fs.existsSync(metricsPath)) {
        try {
          const metrics: { toolCallCount?: number } = JSON.parse(
            fs.readFileSync(metricsPath, 'utf-8'),
          );
          totalToolCalls += metrics.toolCallCount ?? 0;
        } catch {
          // skip on parse error
        }
      }

      // Load tool calls to check for roll_dice usage
      const toolPath = path.join(outputDir, 'candidates', slug, scSlug, 'tool-calls.json');
      if (fs.existsSync(toolPath)) {
        try {
          const toolCalls: Array<{ name: string }> = JSON.parse(
            fs.readFileSync(toolPath, 'utf-8'),
          );
          if (toolCalls.some(tc => tc.name === 'roll_dice')) usedRollDice = true;
        } catch {
          // skip on parse error
        }
      }
    }

    if (scenarioScores.length === 0) continue;

    const overallAvg =
      scenarioScores.reduce((sum, s) => sum + s.average, 0) / scenarioScores.length;
    const minScenarioScore = Math.min(...scenarioScores.map(s => s.average));

    // Check DQ criteria
    const dqReasons: string[] = [];
    if (minScenarioScore < MIN_SCENARIO_SCORE) {
      const worstScenario = scenarioScores.find(s => s.average === minScenarioScore);
      dqReasons.push(
        `Scored ${minScenarioScore.toFixed(1)} on ${worstScenario?.scenarioName ?? 'unknown'} (min: ${MIN_SCENARIO_SCORE})`,
      );
    }
    if (!usedRollDice && scenarioScores.length >= 3) {
      dqReasons.push('Never used roll_dice tool');
    }

    const entry: LeaderboardEntry = {
      modelId: model.id,
      modelName: model.name,
      tier: getModelTier(model.id),
      overallAverage: overallAvg,
      scenarioScores,
      totalToolCalls,
      usedRollDice,
      scenariosCompleted: scenarioScores.length,
      disqualified: dqReasons.length > 0,
      dqReasons,
    };

    if (dqReasons.length > 0) {
      disqualified.push(entry);
    } else {
      results.push(entry);
    }
  }

  // Sort by overall average (descending)
  results.sort((a, b) => b.overallAverage - a.overallAverage);

  // Save outputs
  fs.writeFileSync(
    path.join(outputDir, 'leaderboard.json'),
    JSON.stringify(results, null, 2),
  );
  fs.writeFileSync(
    path.join(outputDir, 'disqualified.json'),
    JSON.stringify(disqualified, null, 2),
  );

  return { leaderboard: results, disqualified };
}
