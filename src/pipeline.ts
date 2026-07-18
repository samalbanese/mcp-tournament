import fs from 'node:fs';
import path from 'node:path';
import { JUDGES, SYNTHESIZER, type JudgeConfig } from './config/judges.js';
import { resolveCandidateModel } from './config/models.js';
import { buildLeaderboard, type LeaderboardEntry } from './phases/aggregator.js';
import { runScenario } from './phases/executor.js';
import { evaluateWithJudges } from './phases/judge-runner.js';
import { getPlugin } from './plugins/index.js';
import type { TestCase } from './plugins/base.js';
import { logError } from './utils/logger.js';

export interface EvaluateOptions {
  models: string[];
  plugin?: string;
  scenarios?: string[];
  judges?: number;
  judgeModels?: Record<string, string>;
  synthesizerModel?: string;
  outputRoot?: string;
  quick?: boolean;
  runId?: string;
}

export interface TournamentRun {
  runId: string;
  runDir: string;
  leaderboard: LeaderboardEntry[];
  failures?: Array<{ model: string; scenario: string; error: string }>;
  judgeFailures?: Array<{ model: string; scenario: string; error: string }>;
}

function createRunId(date = new Date()): string {
  return `run-${date.toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')}`;
}

function selectScenarios(all: TestCase[], requested?: string[]): TestCase[] {
  if (!requested?.length) return all;
  const selected = requested.map(id => all.find(scenario => scenario.id === id));
  const missing = requested.filter((_id, index) => !selected[index]);
  if (missing.length) throw new Error(`Unknown scenario ID(s): ${missing.join(', ')}`);
  return selected as TestCase[];
}

export function selectJudges(
  judgeCount: number,
  judgeModels?: Record<string, string>,
): JudgeConfig[] {
  return JUDGES.slice(0, judgeCount).map(judge => judgeModels?.[judge.role]
    ? { ...judge, model: judgeModels[judge.role] }
    : judge);
}

export async function evaluateTournament(options: EvaluateOptions): Promise<TournamentRun> {
  if (options.models.length < 1 || options.models.length > 4) {
    throw new Error('Evaluate requires between 1 and 4 candidate models');
  }
  const plugin = getPlugin(options.plugin ?? 'dnd');
  const scenarios = selectScenarios(plugin.scenarios, options.scenarios);
  if (!scenarios.length) throw new Error(`Plugin "${plugin.name}" has no scenarios`);
  const judgeCount = options.quick ? 1 : options.judges ?? 3;
  if (judgeCount < 1 || judgeCount > JUDGES.length) {
    throw new Error(`Judge count must be between 1 and ${JUDGES.length}`);
  }

  const candidates = options.models.map(resolveCandidateModel);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(process.cwd(), 'results'));
  if (options.runId && (!/^run-[a-zA-Z0-9-]+$/.test(options.runId) || path.basename(options.runId) !== options.runId)) {
    throw new Error('Invalid run ID');
  }
  let collisionOffsetSeconds = 0;
  let runId = options.runId ?? createRunId();
  let runDir = path.join(outputRoot, runId);
  while (!options.runId && fs.existsSync(runDir)) {
    collisionOffsetSeconds += 1;
    runId = createRunId(new Date(Date.now() + collisionOffsetSeconds * 1000));
    runDir = path.join(outputRoot, runId);
  }
  if (options.runId && fs.existsSync(runDir)) throw new Error(`Run already exists: ${options.runId}`);
  const actualRunId = path.basename(runDir);
  fs.mkdirSync(runDir, { recursive: true });
  const selectedJudges = selectJudges(judgeCount, options.judgeModels);
  const synthesizerModel = options.synthesizerModel ?? SYNTHESIZER.model;

  const manifest = {
    runId: actualRunId,
    plugin: plugin.name,
    createdAt: new Date().toISOString(),
    candidates: candidates.map(({ id, name, tier }) => ({ id, name, tier })),
    judges: selectedJudges.map(({ role, name, model }) => ({ role, name, model })),
    synthesizer: options.quick ? null : { model: synthesizerModel },
    scenarios: scenarios.map(({ id, name }) => ({ id, name })),
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(manifest, null, 2));

  // A failed candidate/scenario is recorded and skipped rather than aborting the
  // whole tournament — one flaky model must not waste every other model's run.
  const failures: Array<{ model: string; scenario: string; error: string }> = [];
  const judgeFailures: Array<{ model: string; scenario: string; error: string }> = [];
  for (const candidate of candidates) {
    for (const scenario of scenarios) {
      try {
        const execution = await runScenario(candidate, scenario, plugin, runDir);
        if (!execution.success) {
          throw new Error(execution.error ?? 'Scenario execution failed');
        }
        const judgePhase = await evaluateWithJudges(
          plugin,
          scenario,
          execution.turns,
          candidate.id,
          runDir,
          selectedJudges,
          !options.quick,
          synthesizerModel,
        );
        for (const failure of judgePhase.failedJudges) {
          const message = `judge ${failure.judge}: ${failure.error}`;
          judgeFailures.push({ model: candidate.id, scenario: scenario.id, error: message });
          logError(`  [${candidate.name}/${scenario.name}] ${message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ model: candidate.id, scenario: scenario.id, error: message });
        logError(`  [${candidate.name}/${scenario.name}] Skipped: ${message}`);
      }
    }
  }
  if (failures.length || judgeFailures.length) {
    fs.writeFileSync(
      path.join(runDir, 'failures.json'),
      JSON.stringify([...failures, ...judgeFailures], null, 2),
    );
  }
  if (failures.length === candidates.length * scenarios.length) {
    throw new Error(
      `Every candidate/scenario pair failed. First error: ${failures[0].error}`,
    );
  }
  return {
    runId: actualRunId,
    runDir,
    leaderboard: buildLeaderboard(runDir, candidates, scenarios),
    failures,
    judgeFailures,
  };
}

export async function quickTest(options: {
  model: string;
  plugin?: string;
  scenario?: string;
  outputRoot?: string;
}): Promise<TournamentRun> {
  const plugin = getPlugin(options.plugin ?? 'dnd');
  const scenario = options.scenario ?? plugin.scenarios[0]?.id;
  if (!scenario) throw new Error(`Plugin "${plugin.name}" has no scenarios`);
  return evaluateTournament({
    models: [options.model],
    plugin: plugin.name,
    scenarios: [scenario],
    judges: 1,
    outputRoot: options.outputRoot,
    quick: true,
  });
}

export function readLeaderboard(options: {
  plugin?: string;
  limit?: number;
  outputRoot?: string;
} = {}): LeaderboardEntry[] {
  const root = path.resolve(options.outputRoot ?? path.join(process.cwd(), 'results'));
  if (!fs.existsSync(root)) return [];
  const best = new Map<string, LeaderboardEntry>();
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const runDir = path.join(root, directory.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as {
        plugin?: string;
      };
      if (options.plugin && manifest.plugin !== options.plugin) continue;
      const entries = JSON.parse(
        fs.readFileSync(path.join(runDir, 'leaderboard.json'), 'utf8'),
      ) as LeaderboardEntry[];
      for (const entry of entries) {
        const current = best.get(entry.modelId);
        if (!current || entry.overallAverage > current.overallAverage) {
          best.set(entry.modelId, entry);
        }
      }
    } catch {
      // Ignore incomplete or unrelated directories.
    }
  }
  return [...best.values()]
    .sort((left, right) => right.overallAverage - left.overallAverage)
    .slice(0, options.limit ?? 10);
}

export function formatLeaderboard(entries: LeaderboardEntry[]): string {
  if (!entries.length) return 'No tournament results found.';
  const rows = entries.map((entry, index) =>
    `${String(index + 1).padStart(2)}  ${entry.modelName.padEnd(28)}  ${entry.overallAverage.toFixed(2)}`);
  return ['#   Model                         Score', ...rows].join('\n');
}

export function compactRunSummary(run: TournamentRun): string {
  const failureNote = run.failures?.length
    ? `\n\nSkipped ${run.failures.length} failed pair(s): ${run.failures
        .map(failure => `${failure.model}/${failure.scenario}`)
        .join(', ')} (details in failures.json)`
    : '';
  const judgeFailureNote = run.judgeFailures?.length
    ? `\n\n${run.judgeFailures.map(failure => {
        const judge = failure.error.split(':', 1)[0];
        return `Incomplete judge panels: ${failure.model}/${failure.scenario} (${judge})`;
      }).join('\n')} (details in failures.json)`
    : '';
  return `${formatLeaderboard(run.leaderboard)}${failureNote}${judgeFailureNote}\n\nResults: ${run.runDir}`;
}
