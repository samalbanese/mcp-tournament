import fs from 'node:fs';
import path from 'node:path';
import type { CandidateModel } from '../config/models.js';
import { modelSlug, scenarioSlug, type TestCase } from '../plugins/base.js';
import { SynthesisSchema, type FinalCriterion } from '../schemas/synthesis.js';
import { JudgeScoreSchema } from '../schemas/judge-score.js';

export interface ScenarioScore {
  scenarioId: string;
  scenarioName: string;
  average: number;
  scores: Record<string, FinalCriterion>;
  ruleErrors: string[];
  flags: string[];
}

export interface LeaderboardEntry {
  modelId: string;
  modelName: string;
  tier: string;
  overallAverage: number;
  scenarioScores: ScenarioScore[];
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function readFlags(judgeDir: string): string[] {
  if (!fs.existsSync(judgeDir)) return [];
  const flags = new Set<string>();
  for (const filename of fs.readdirSync(judgeDir)) {
    if (filename === 'synthesis.json' || !filename.endsWith('.json')) continue;
    try {
      const parsed = JudgeScoreSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(judgeDir, filename), 'utf8')),
      );
      if (parsed.success) parsed.data.flags.forEach(flag => flags.add(flag));
    } catch {
      // A malformed judge artifact is ignored; synthesis remains authoritative.
    }
  }
  return [...flags];
}

export function buildLeaderboard(
  outputDir: string,
  candidates: CandidateModel[],
  scenarios: TestCase[],
): LeaderboardEntry[] {
  const leaderboard: LeaderboardEntry[] = [];

  for (const candidate of candidates) {
    const candidateSlug = modelSlug(candidate.id);
    const scenarioScores: ScenarioScore[] = [];
    for (const scenario of scenarios) {
      const judgeDir = path.join(outputDir, 'judges', candidateSlug, scenarioSlug(scenario));
      const synthesisPath = path.join(judgeDir, 'synthesis.json');
      if (!fs.existsSync(synthesisPath)) continue;
      try {
        const parsed = SynthesisSchema.safeParse(
          JSON.parse(fs.readFileSync(synthesisPath, 'utf8')),
        );
        if (!parsed.success) continue;
        scenarioScores.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          average: roundScore(parsed.data.average_score),
          scores: parsed.data.final_scores,
          ruleErrors: parsed.data.rule_errors_confirmed,
          flags: readFlags(judgeDir),
        });
      } catch {
        // Skip incomplete scenario artifacts.
      }
    }
    if (!scenarioScores.length) continue;
    leaderboard.push({
      modelId: candidate.id,
      modelName: candidate.name,
      tier: candidate.tier,
      overallAverage: roundScore(
        scenarioScores.reduce((sum, score) => sum + score.average, 0) / scenarioScores.length,
      ),
      scenarioScores,
    });
  }

  leaderboard.sort((left, right) => right.overallAverage - left.overallAverage);
  fs.writeFileSync(
    path.join(outputDir, 'leaderboard.json'),
    JSON.stringify(leaderboard, null, 2),
  );
  return leaderboard;
}
