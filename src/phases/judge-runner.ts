import fs from 'node:fs';
import path from 'node:path';
import { runJudge, type JudgeResult } from '../agents/judge-agent.js';
import { runSynthesis, type SynthesisResult } from '../agents/synthesizer.js';
import { JUDGES, type JudgeConfig } from '../config/judges.js';
import { modelSlug, scenarioSlug, type TestCase, type TournamentPlugin, type Turn } from '../plugins/base.js';
import type { Synthesis } from '../schemas/synthesis.js';
import { log } from '../utils/logger.js';

export interface JudgePhaseResult {
  judgeResults: JudgeResult[];
  failedJudges: Array<{ judge: string; error: string }>;
  synthesis: SynthesisResult;
}

function singleJudgeSynthesis(result: JudgeResult): Synthesis {
  if (!result.parsed) throw new Error(`${result.judgeName} returned invalid score JSON`);
  const finalScores = Object.fromEntries(Object.entries(result.parsed.scores).map(
    ([criterion, score]) => [criterion, {
      score: score.score,
      confidence: 'medium' as const,
      outliers: [],
    }],
  ));
  const values = Object.values(finalScores);
  return {
    final_scores: finalScores,
    average_score: values.length
      ? values.reduce((sum, value) => sum + value.score, 0) / values.length : 0,
    rule_errors_confirmed: result.parsed.rule_errors,
    assessment: result.parsed.overall_impression,
    judge_agreement: 'Single-judge quick test',
  };
}

export async function evaluateWithJudges(
  plugin: TournamentPlugin,
  scenario: TestCase,
  turns: Turn[],
  modelId: string,
  outputDir: string,
  judges: JudgeConfig[] = JUDGES,
  useSynthesizer = true,
  synthesizerModel?: string,
): Promise<JudgePhaseResult> {
  const judgeDir = path.join(outputDir, 'judges', modelSlug(modelId), scenarioSlug(scenario));
  fs.mkdirSync(judgeDir, { recursive: true });
  log(`  [Judge/${scenario.name}] Running ${judges.length} judge(s)`);

  const settled = await Promise.allSettled(judges.map(async judge => {
    const result = await runJudge(judge, plugin, scenario, turns);
    if (!result.parsed) {
      // Keep the unparseable output on disk — without it, a failed judge
      // leaves nothing to diagnose (only the one-line error in failures.json).
      fs.writeFileSync(path.join(judgeDir, `${judge.role}.failed.txt`), result.raw);
      throw new Error(`${judge.name} returned invalid score JSON`);
    }
    fs.writeFileSync(
      path.join(judgeDir, `${judge.role}.json`),
      JSON.stringify(result.parsed, null, 2),
    );
    return result;
  }));

  const judgeResults = settled
    .filter((result): result is PromiseFulfilledResult<JudgeResult> => result.status === 'fulfilled')
    .map(result => result.value);
  const failedJudges = settled.flatMap((result, index) => result.status === 'rejected'
    ? [{ judge: judges[index].name, error: result.reason instanceof Error
      ? result.reason.message : String(result.reason) }]
    : []);
  if (!judgeResults.length) throw new Error('All judges failed');

  let synthesis: SynthesisResult;
  if (useSynthesizer) {
    synthesis = await runSynthesis(scenario, judgeResults, synthesizerModel);
    if (!synthesis.synthesis) throw new Error(`Synthesis failed: ${synthesis.raw}`);
  } else {
    const derived = singleJudgeSynthesis(judgeResults[0]);
    synthesis = {
      synthesis: derived,
      raw: JSON.stringify(derived),
      parseSuccess: true,
      metrics: { inputTokens: 0, outputTokens: 0, timeMs: 0 },
    };
  }
  fs.writeFileSync(
    path.join(judgeDir, 'synthesis.json'),
    JSON.stringify(synthesis.synthesis, null, 2),
  );
  return { judgeResults, failedJudges, synthesis };
}
