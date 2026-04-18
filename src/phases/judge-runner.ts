// judge-runner.ts — Runs all 5 judges in parallel on one model/scenario result, then synthesizes.

import { JUDGES } from '../config/judges.js';
import { runJudge, type JudgeResult } from '../agents/judge-agent.js';
import { runSynthesis, type SynthesisResult } from '../agents/synthesizer.js';
import type { TestCase } from '../plugins/base.js';
import type { Turn } from '../schemas/result.js';
import { modelSlug, scenarioSlug } from '../config/scenarios.js';
import { log, logWarn, logError } from '../utils/logger.js';
import { RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from '../config/constants.js';
import fs from 'node:fs';
import path from 'node:path';

export interface JudgePhaseResult {
  judgeResults: JudgeResult[];
  failedJudges: Array<{ judge: string; error: string }>;
  synthesis: SynthesisResult;
}

/**
 * Run a judge with retry logic. Retries up to RETRY_ATTEMPTS times
 * with exponential backoff starting at RETRY_BASE_DELAY_MS.
 */
async function runJudgeWithRetry(
  judge: typeof JUDGES[0],
  scenario: Scenario,
  turns: Turn[],
): Promise<JudgeResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await runJudge(judge, scenario, turns);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logWarn(`  [Judge/${scenario.name}] ${judge.name} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error('Judge failed with no error details');
}

export async function evaluateWithJudges(
  scenario: Scenario,
  turns: Turn[],
  modelId: string,
  outputDir: string,
): Promise<JudgePhaseResult> {
  const slug = modelSlug(modelId);
  const scSlug = scenarioSlug(scenario as Scenario);
  const judgeDir = path.join(outputDir, 'judges', slug, scSlug);
  fs.mkdirSync(judgeDir, { recursive: true });

  // Run all 5 judges in parallel
  log(`  [Judge/${scenario.name}] Sending to ${JUDGES.length} judges...`);
  const results = await Promise.allSettled(
    JUDGES.map(async (judge) => {
      const result = await runJudgeWithRetry(judge, scenario, turns);
      fs.writeFileSync(path.join(judgeDir, `${judge.role}-judge.json`), JSON.stringify(result, null, 2));
      log(`  [Judge/${scenario.name}]   ${judge.name}: ${result.parseSuccess ? 'OK' : 'PARSE FAILED'} (${result.metrics.timeMs}ms)`);
      return result;
    }),
  );

  const successfulJudges = results
    .filter((r): r is PromiseFulfilledResult<JudgeResult> => r.status === 'fulfilled')
    .map(r => r.value);

  const failedJudges = results
    .map((r, i) => ({ result: r, judge: JUDGES[i] }))
    .filter((x): x is { result: PromiseRejectedResult; judge: typeof JUDGES[0] } => x.result.status === 'rejected')
    .map(x => ({ judge: x.judge.name, error: (x.result.reason as Error)?.message ?? 'Unknown' }));

  if (failedJudges.length > 0) {
    logWarn(`  [Judge/${scenario.name}] WARNING: ${failedJudges.length} judge(s) failed after retries`);
    for (const fj of failedJudges) {
      logError(`  [Judge/${scenario.name}]   FAILED: ${fj.judge} — ${fj.error}`);
    }
  }

  if (successfulJudges.length === 0) {
    logError(`  [Judge/${scenario.name}] CRITICAL: All 5 judges failed. Cannot synthesize.`);
    // Return a degraded result so the pipeline doesn't crash
    return {
      judgeResults: [],
      failedJudges,
      synthesis: {
        synthesis: null,
        parseSuccess: false,
        raw: '',
        metrics: { timeMs: 0, inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  // Opus synthesis
  log(`  [Judge/${scenario.name}] Running synthesis with ${successfulJudges.length}/5 judges...`);
  const synthesis = await runSynthesis(scenario, successfulJudges);
  fs.writeFileSync(path.join(judgeDir, 'synthesis.json'), JSON.stringify(synthesis, null, 2));

  if (synthesis.synthesis) log(`  [Judge/${scenario.name}] Synthesis: avg ${synthesis.synthesis.average_score}/10`);

  return { judgeResults: successfulJudges, failedJudges, synthesis };
}
