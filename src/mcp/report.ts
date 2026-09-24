/**
 * Builds the human-readable markdown scorecard served at
 * `tournament://runs/{runId}/report`.
 *
 * This is the one artifact in the MCP layer meant for a person to read
 * directly, so it stays plain GitHub markdown: a one-line verdict, a ranked
 * table, then a section per scenario with a criterion breakdown for every
 * model.
 */
import type { RunSummary } from './data.js';
import { describeFailure, formatScore, scoreTable, splitFailures, toLeaderboardRows } from './format.js';
import type { FinalCriterion } from '../schemas/synthesis.js';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function scoreCell(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function criterionLabel(key: string): string {
  return key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function criterionTable(scores: Record<string, FinalCriterion>): string {
  const rows = Object.entries(scores).map(([key, value]) =>
    `| ${criterionLabel(key)} | ${scoreCell(value.score)} | ${value.confidence} |`);
  if (!rows.length) return '_No criterion scores were recorded for this model._';
  return ['| Criterion | Score | Confidence |', '|---|---|---|', ...rows].join('\n');
}

/** Renders the full markdown report for a run. Handles interrupted runs (null leaderboard). */
export function buildReport(run: RunSummary): string {
  const title = `# ${run.plugin} bench: ${formatDate(run.createdAt)}`;
  const lines: string[] = [title, ''];

  if (!run.leaderboard || !run.leaderboard.length) {
    lines.push(
      '**No leaderboard available.** This run was interrupted or every candidate/scenario ' +
      'pair failed before scoring completed. Check the Issues section below, or call ' +
      '`tournament_get_run` for the raw run data.',
      '',
    );
  } else {
    const [winner, runnerUp] = run.leaderboard;
    const margin = runnerUp ? formatScore(winner.overallAverage - runnerUp.overallAverage) : null;
    const verdict = runnerUp
      ? `**Winner: ${winner.modelName}** (${formatScore(winner.overallAverage)}/10), ` +
        `ahead of ${runnerUp.modelName} by ${margin} point${margin === '1.00' ? '' : 's'}.`
      : `**Winner: ${winner.modelName}** (${formatScore(winner.overallAverage)}/10), the only model scored in this run.`;
    lines.push(verdict, '');

    lines.push(scoreTable(toLeaderboardRows(run.leaderboard)), '');

    for (const scenario of run.scenarios) {
      lines.push(`## Scenario: ${scenario.name}`, '');
      for (const entry of run.leaderboard) {
        const scenarioScore = entry.scenarioScores.find(item => item.scenarioId === scenario.id);
        lines.push(`### ${entry.modelName}`, '');
        if (!scenarioScore) {
          lines.push('_Not scored on this scenario (see Skipped below)._', '');
          continue;
        }
        lines.push(`Average: ${formatScore(scenarioScore.average)}/10`, '');
        lines.push(criterionTable(scenarioScore.scores), '');
        if (scenarioScore.flags.length) {
          lines.push(`Flags: ${scenarioScore.flags.join(', ')}`, '');
        }
        if (scenarioScore.ruleErrors.length) {
          lines.push(`Rule errors: ${scenarioScore.ruleErrors.join(', ')}`, '');
        }
      }
    }
  }

  lines.push('## Judge panel', '');
  if (run.judges.length) {
    lines.push('| Role | Name | Model |', '|---|---|---|');
    for (const judge of run.judges) {
      lines.push(`| ${judge.role} | ${judge.name} | ${judge.model} |`);
    }
  } else {
    lines.push('_No judge panel recorded for this run._');
  }
  lines.push('');

  const { skipped, judgeMisses } = splitFailures(run.failures);
  for (const [heading, items] of [
    ['Skipped (no score)', skipped],
    ['Incomplete judge panels (still scored)', judgeMisses],
  ] as const) {
    if (!items.length) continue;
    lines.push(`## ${heading}`, '', ...items.map(item => `- ${describeFailure(item)}`), '');
  }

  return lines.join('\n').trimEnd() + '\n';
}
