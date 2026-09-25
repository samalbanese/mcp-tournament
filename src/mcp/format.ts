/**
 * Shared markdown formatting for MCP tool text output.
 *
 * Every tool returns both `structuredContent` (for programmatic consumers) and a
 * human-readable markdown `text` block (for a person reading inside a chat client).
 * These helpers keep that markdown consistent: GitHub-flavored tables, one-line
 * headlines, no filler.
 */
import type { BenchDefinition } from '../plugins/custom.js';
import type { BenchInfo, RunFailure, RunSummary } from './data.js';

export interface LeaderboardRow {
  rank: number;
  modelId: string;
  modelName: string;
  tier: string;
  score: number;
}

type ScoredEntry = { modelId: string; modelName: string; tier: string; overallAverage: number };

/** Leaderboard entries (already sorted best first) to the ranked rows every surface shares. */
export function toLeaderboardRows(entries: ScoredEntry[]): LeaderboardRow[] {
  return entries.map((entry, index) => ({
    rank: index + 1,
    modelId: entry.modelId,
    modelName: entry.modelName,
    tier: entry.tier,
    score: entry.overallAverage,
  }));
}

/** Overall scores are averages, so every table shows them to two decimals. */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

/** `2026-07-20T23:55:00.176Z` becomes `2026-07-20 23:55 UTC`; unparseable input passes through. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `tournament_list_benches` output: one heading per bench plus a compact scenario list. */
export function formatBenchesMarkdown(benches: BenchInfo[]): string {
  if (!benches.length) return 'No benches are registered.';
  const sections = benches.map(bench => {
    const scenarioLines = bench.scenarios.length
      ? bench.scenarios.map(scenario => `- \`${scenario.id}\`: ${scenario.name}`).join('\n')
      : '- (no scenarios)';
    return `## ${bench.name}\n\n${bench.description}\n\n${scenarioLines}`;
  });
  return sections.join('\n\n');
}

/** `tournament_create_bench` output: what was saved, its scenarios, and a next step. */
export function formatCreateBenchMarkdown(
  bench: BenchInfo,
  file: string,
  scenarios: BenchDefinition['scenarios'],
): string {
  const scenarioLines = scenarios.map(scenario => {
    const roundLabel = scenario.rounds === 1 ? '1 round' : `${scenario.rounds} rounds`;
    const criteriaNames = scenario.criteria.map(criterion => criterion.name).join(', ');
    return `- \`${scenario.id}\`: ${scenario.name} (${roundLabel}; criteria: ${criteriaNames})`;
  }).join('\n');
  return `Saved bench "${bench.name}" to \`${file}\`.\n\n${scenarioLines}\n\n` +
    `Run it with tournament_quick_test or tournament_evaluate using plugin: "${bench.name}".`;
}

export function scoreTable(rows: LeaderboardRow[]): string {
  const header = '| Rank | Model | Tier | Score out of 10 |\n|---|---|---|---|';
  const body = rows
    .map(row => `| ${row.rank} | ${row.modelName} | ${row.tier} | ${formatScore(row.score)} |`)
    .join('\n');
  return `${header}\n${body}`;
}

/** `tournament_leaderboard` output: a winner headline plus the ranked table. */
export function formatLeaderboardMarkdown(rows: LeaderboardRow[], plugin?: string): string {
  const scope = plugin ? ` for "${plugin}"` : '';
  if (!rows.length) {
    return `No tournament results${scope} yet. Run tournament_quick_test for a cheap sanity check, or tournament_evaluate for a full run.`;
  }
  const winner = rows[0];
  return `Winner${scope}: ${winner.modelName} (${formatScore(winner.score)}/10)\n\n${scoreTable(rows)}`;
}

/**
 * failures.json mixes two kinds of problem: pairs that were skipped outright, and
 * judges that failed on a pair that was still scored. Readers need them apart.
 */
export function splitFailures(failures: RunFailure[]): { skipped: RunFailure[]; judgeMisses: RunFailure[] } {
  return {
    skipped: failures.filter(failure => !failure.error.startsWith('judge ')),
    judgeMisses: failures.filter(failure => failure.error.startsWith('judge ')),
  };
}

/** Drops the pipeline's `judge <name>: ` prefix when the message already names the judge. */
export function describeFailure(failure: RunFailure): string {
  const judge = /^judge ([^:]+): ([\s\S]*)$/.exec(failure.error);
  const detail = judge
    ? (judge[2].startsWith(judge[1]) ? judge[2] : `${judge[1]}: ${judge[2]}`)
    : failure.error;
  return `${failure.model} on \`${failure.scenario}\`: ${detail}`;
}

function failuresSection(title: string, failures: RunFailure[]): string {
  if (!failures.length) return '';
  return `\n\n### ${title}\n\n${failures.map(failure => `- ${describeFailure(failure)}`).join('\n')}`;
}

function issuesSections(skipped: RunFailure[], judgeMisses: RunFailure[]): string {
  return failuresSection('Skipped (no score)', skipped)
    + failuresSection('Incomplete judge panels (still scored)', judgeMisses);
}

/** `tournament_evaluate` / `tournament_quick_test` output: headline, table, issues, run ID. */
export function formatRunResultMarkdown(result: {
  runId: string;
  plugin: string;
  entries: LeaderboardRow[];
  failures: RunFailure[];
  judgeFailures: RunFailure[];
  resultsDir: string;
  judges: Array<{ role: string; name: string; model: string }>;
}): string {
  const headline = result.entries.length
    ? `Winner: ${result.entries[0].modelName} (${formatScore(result.entries[0].score)}/10) on "${result.plugin}"`
    : `No scored results for "${result.plugin}" (every candidate/scenario pair failed or produced no score)`;
  const table = result.entries.length ? `\n\n${scoreTable(result.entries)}` : '';
  const judgesLine = result.judges.length
    ? `\n\nJudges: ${result.judges.map(judge => `${judge.name} (${judge.model})`).join(', ')}`
    : '';
  const footer = `\n\nRun ID: \`${result.runId}\`. Call tournament_get_run with this ID for full detail, or read resource tournament://runs/${result.runId}/report.`;
  return `${headline}${table}${judgesLine}${issuesSections(result.failures, result.judgeFailures)}${footer}`;
}

/** `tournament_get_run` output: run facts, ranked table, model-by-scenario grid, issues. */
export function formatRunSummaryMarkdown(run: RunSummary): string {
  const { skipped, judgeMisses } = splitFailures(run.failures);
  const facts = [
    `**Run \`${run.runId}\`** · ${run.plugin} bench · ${formatTimestamp(run.createdAt)}`,
    '',
    `- Models: ${run.candidates.map(candidate => candidate.name).join(', ') || '(none)'}`,
    `- Judges: ${run.judges.map(judge => `${judge.name} (${judge.model})`).join(', ') || '(none)'}`,
  ].join('\n');

  if (!run.leaderboard?.length) {
    const note = run.leaderboard === null
      ? 'No leaderboard was written: the run was likely interrupted before scoring finished.'
      : 'No model was scored on any scenario.';
    return `${facts}\n\n${note}${issuesSections(skipped, judgeMisses)}`;
  }

  const grid = [
    `| Model | ${run.scenarios.map(scenario => scenario.name).join(' | ')} |`,
    `|---|${run.scenarios.map(() => '---').join('|')}|`,
    ...run.leaderboard.map(entry => {
      const cells = run.scenarios.map(scenario => {
        const score = entry.scenarioScores.find(item => item.scenarioId === scenario.id);
        return score ? formatScore(score.average) : 'n/a';
      });
      return `| ${entry.modelName} | ${cells.join(' | ')} |`;
    }),
  ].join('\n');

  return [
    facts,
    scoreTable(toLeaderboardRows(run.leaderboard)),
    `### Scores by scenario\n\n${grid}`,
  ].join('\n\n') + issuesSections(skipped, judgeMisses);
}
