import type { LeaderboardEntry, RunManifest } from "./types";

export const criterionLabel = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const criteriaFor = (entries: LeaderboardEntry[]) => [
  ...new Set(
    entries.flatMap((entry) =>
      entry.scenarioScores.flatMap((scenario) => Object.keys(scenario.scores)),
    ),
  ),
];

/** A missing observation is not a zero. Incomplete candidates stay unranked. */
export function criterionAverage(
  entry: LeaderboardEntry,
  criterion: string,
): number | null {
  if (!entry.scenarioScores.length) return null;
  const scores = entry.scenarioScores.map(
    (scenario) => scenario.scores[criterion]?.score,
  );
  if (scores.some((score) => !Number.isFinite(score))) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export function weightedRanking(
  entries: LeaderboardEntry[],
  weights: Record<string, number>,
) {
  const active = Object.entries(weights).filter(
    ([, weight]) => Number.isFinite(weight) && weight > 0,
  );
  const total = active.reduce((sum, [, weight]) => sum + weight, 0);
  return entries
    .map((entry) => {
      const scores = active.map(([criterion, weight]) => ({
        score: criterionAverage(entry, criterion),
        weight,
      }));
      const score =
        total === 0 || scores.some((item) => item.score === null)
          ? null
          : scores.reduce((sum, item) => sum + item.score! * item.weight, 0) /
            total;
      return { entry, score };
    })
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

export function disagreementCount(entry: LeaderboardEntry) {
  return entry.scenarioScores.reduce(
    (sum, scenario) =>
      sum +
      Object.values(scenario.scores).filter(
        (score) =>
          score.outliers.length > 0 || score.confidence === "contested",
      ).length,
    0,
  );
}

export function buildReport(
  run: RunManifest,
  entries: LeaderboardEntry[],
  weights?: Record<string, number>,
) {
  const lines = [
    `# MCP Tournament: ${criterionLabel(run.plugin.replaceAll("-", "_"))}`,
    "",
    `Run: ${run.runId}`,
    `Recorded: ${run.createdAt}`,
    "",
    "## Recorded ranking",
    "",
    "| Model | Recorded score / 10 | Criteria with dissent |",
    "| --- | ---: | ---: |",
    ...entries.map(
      (entry) =>
        `| ${entry.modelName} | ${entry.overallAverage.toFixed(2)} | ${disagreementCount(entry)} |`,
    ),
    "",
  ];
  if (weights) {
    lines.push(
      "## Exploratory weighting",
      "",
      "Recomputed from final criterion scores. Does not replace the recorded result or call any models.",
      "",
      ...Object.entries(weights).map(
        ([criterion, weight]) => `- ${criterionLabel(criterion)}: ${weight}`,
      ),
      "",
      ...weightedRanking(entries, weights).map(
        ({ entry, score }) =>
          `- ${entry.modelName}: ${score?.toFixed(2) ?? "Not ranked (missing data or no active weights)"}`,
      ),
      "",
    );
  }
  lines.push("## Evidence and dissent", "");
  for (const entry of entries) {
    lines.push(`### ${entry.modelName}`, "");
    for (const scenario of entry.scenarioScores) {
      lines.push(`Scenario: ${scenario.scenarioName}`, "");
      for (const [criterion, score] of Object.entries(scenario.scores)) {
        lines.push(
          `- ${criterionLabel(criterion)}: ${score.score}/10 (${score.confidence})`,
          ...score.outliers.map((note) => `  - ${note}`),
        );
      }
      lines.push(
        ...scenario.ruleErrors.map((error) => `- Confirmed error: ${error}`),
        "",
      );
    }
  }
  lines.push(
    "## Evaluation limits",
    "",
    "These are recorded scenario-specific observations, not a universal model ranking. Small samples do not establish statistical significance. AI judges can make mistakes; candidate and judge models may overlap.",
    "",
    ...run.judges.map((judge) => `- ${judge.name}: ${judge.model}`),
    `- Synthesizer: ${run.synthesizer.model}`,
    "",
    "Source: https://github.com/samalbanese/mcp-tournament",
    "",
  );
  return lines.join("\n");
}
