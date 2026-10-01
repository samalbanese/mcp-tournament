import fs from 'node:fs';
import path from 'node:path';
import { isRouteReady, routeSetupHint, type ClientRoute } from './clients/index.js';
import { buildLeaderboard, type LeaderboardEntry } from './phases/aggregator.js';
import { runScenario } from './phases/executor.js';
import { evaluateWithJudges } from './phases/judge-runner.js';
import { getPlugin } from './plugins/index.js';
import { logError } from './utils/logger.js';
import { effectiveScenario, normalizeRunPlan, type JudgeSeat, type ResolvedRunPlan } from './run-plan.js';

export { selectJudges } from './run-plan.js';

export interface EvaluateProgress {
  completed: number;
  total: number;
  message: string;
}

export interface EvaluateOptions {
  models: string[];
  plugin?: string;
  scenarios?: string[];
  judges?: number;
  judgeModels?: Record<string, string>;
  synthesizerModel?: string;
  judgePanel?: JudgeSeat[];
  turns?: number;
  participantModel?: string;
  outputRoot?: string;
  quick?: boolean;
  runId?: string;
  /**
   * Called once when a candidate/scenario pair starts and once when it finishes
   * (success or failure). `completed` strictly increases (MCP progress requires
   * it) and equals `total` on the final call.
   */
  onProgress?: (progress: EvaluateProgress) => void;
}

export interface TournamentRun {
  runId: string;
  runDir: string;
  leaderboard: LeaderboardEntry[];
  failures?: Array<{ model: string; scenario: string; error: string }>;
  judgeFailures?: Array<{ model: string; scenario: string; error: string }>;
}

/**
 * Where runs are written and read: TOURNAMENT_RESULTS_DIR if set, else ./results.
 * MCP clients launch the server from their own working directory, so the env var
 * is how a Claude Desktop config points it at the repo's results.
 */
export function defaultResultsRoot(): string {
  return path.resolve(process.env.TOURNAMENT_RESULTS_DIR || path.join(process.cwd(), 'results'));
}

function createRunId(date = new Date()): string {
  return `run-${date.toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')}`;
}

export function assertRoutesReady(plan: ResolvedRunPlan): void {
  const uses: Array<{ label: string; route: ClientRoute }> = [
    ...plan.candidates.map(candidate => ({ label: `Candidate "${candidate.id}"`, route: candidate.route ?? 'openrouter' as const })),
    ...plan.judges.map(judge => ({ label: `Judge "${judge.name}" (${judge.model})`, route: judge.route })),
  ];
  if (!plan.quick && plan.judges.length >= 2) {
    uses.push({ label: `Synthesizer "${plan.synthesizer.ref}"`, route: plan.synthesizer.route });
  }
  if (plan.participantExplicit) {
    uses.push({ label: `Simulated user "${plan.participant.ref}"`, route: plan.participant.route });
  }
  const checked = new Set<ClientRoute>();
  for (const { label, route } of uses) {
    if (checked.has(route)) continue;
    if (!isRouteReady(route)) {
      throw new Error(`${label} needs a provider that is not set up. ${routeSetupHint(route)}`);
    }
    checked.add(route);
  }
}

export async function evaluateTournament(options: EvaluateOptions): Promise<TournamentRun> {
  if (options.models.length < 1 || options.models.length > 4) {
    throw new Error('Evaluate requires between 1 and 4 candidate models');
  }
  const plan = normalizeRunPlan({
    bench: options.plugin ?? 'dnd',
    scenarios: options.scenarios,
    candidates: options.models,
    judgePanel: options.judgePanel,
    synthesizer: options.synthesizerModel,
    participant: options.participantModel,
    turns: options.turns,
  }, { judges: options.judges, judgeModels: options.judgeModels, quick: options.quick });
  assertRoutesReady(plan);
  const { plugin, scenarios, candidates, judges: selectedJudges } = plan;
  const useSynthesizer = !plan.quick && selectedJudges.length >= 2;
  const runtime = { participant: { route: plan.participant.route, model: plan.participant.model } };
  const outputRoot = path.resolve(options.outputRoot ?? defaultResultsRoot());
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
  const manifest = {
    runId: actualRunId,
    plugin: plugin.name,
    createdAt: new Date().toISOString(),
    candidates: candidates.map(({ id, name, tier, route }) => ({ id, name, tier, route })),
    judges: selectedJudges.map(({ role, name, model, persona, route, lens }) => ({
      role, name, model, persona: persona ?? role, route,
      ...(persona === 'custom' ? { customLens: lens } : {}),
    })),
    synthesizer: useSynthesizer ? { model: plan.synthesizer.model, route: plan.synthesizer.route } : null,
    scenarios: scenarios.map(({ id, name }) => ({ id, name })),
    turns: plan.turns,
    participant: { model: plan.participant.ref, route: plan.participant.route },
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(manifest, null, 2));

  // A failed candidate/scenario is recorded and skipped rather than aborting the
  // whole tournament — one flaky model must not waste every other model's run.
  const failures: Array<{ model: string; scenario: string; error: string }> = [];
  const judgeFailures: Array<{ model: string; scenario: string; error: string }> = [];
  const totalProgressSteps = candidates.length * scenarios.length * 2;
  let completedProgressSteps = 0;
  for (const candidate of candidates) {
    for (const scenario of scenarios) {
      const runScenarioCase = effectiveScenario(scenario, plan.turns);
      completedProgressSteps += 1;
      options.onProgress?.({
        completed: completedProgressSteps,
        total: totalProgressSteps,
        message: `Running ${candidate.name} on ${scenario.name}`,
      });
      try {
        const execution = await runScenario(candidate, runScenarioCase, plugin, runDir, runtime);
        if (!execution.success) {
          throw new Error(execution.error ?? 'Scenario execution failed');
        }
        const judgePhase = await evaluateWithJudges(
          plugin,
          runScenarioCase,
          execution.turns,
          candidate.id,
          runDir,
          selectedJudges,
          useSynthesizer,
          plan.synthesizer.model,
          plan.synthesizer.route,
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
      completedProgressSteps += 1;
      options.onProgress?.({
        completed: completedProgressSteps,
        total: totalProgressSteps,
        message: `Finished ${candidate.name} on ${scenario.name}`,
      });
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
  judge?: JudgeSeat;
  turns?: number;
  outputRoot?: string;
  onProgress?: (progress: EvaluateProgress) => void;
}): Promise<TournamentRun> {
  const plugin = getPlugin(options.plugin ?? 'dnd');
  const scenario = options.scenario ?? plugin.scenarios[0]?.id;
  if (!scenario) throw new Error(`Plugin "${plugin.name}" has no scenarios`);
  return evaluateTournament({
    models: [options.model],
    plugin: plugin.name,
    scenarios: [scenario],
    judges: 1,
    judgePanel: options.judge ? [options.judge] : undefined,
    turns: options.turns,
    outputRoot: options.outputRoot,
    quick: true,
    onProgress: options.onProgress,
  });
}

export function readLeaderboard(options: {
  plugin?: string;
  limit?: number;
  outputRoot?: string;
} = {}): LeaderboardEntry[] {
  const root = path.resolve(options.outputRoot ?? defaultResultsRoot());
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
