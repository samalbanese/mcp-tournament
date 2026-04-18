// markdown-report.ts — Generate human-readable analysis.md from tournament results.
// Ported from v1 backend/scripts/oracle-tournament/reporter.mjs

import type { LeaderboardEntry } from '../phases/aggregator.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generate analysis.md from leaderboard data.
 * Saves to outputDir/analysis.md and returns the report string.
 */
export function generateReport(
  outputDir: string,
  leaderboard: LeaderboardEntry[],
  disqualified: LeaderboardEntry[],
): string {
  let report = `# Oracle Tournament Results\n\n`;
  report += `**Generated:** ${new Date().toISOString()}\n`;
  report += `**Models evaluated:** ${leaderboard.length + disqualified.length}\n`;
  report += `**Passed:** ${leaderboard.length} | **Disqualified:** ${disqualified.length}\n\n`;

  report += `---\n\n## Leaderboard\n\n`;
  report += `| Rank | Model | Tier | Avg Score | Best Scenario | Worst Scenario | Tools |\n`;
  report += `|------|-------|------|-----------|---------------|----------------|-------|\n`;

  for (let i = 0; i < leaderboard.length; i++) {
    const m = leaderboard[i];
    const best = m.scenarioScores.reduce((a, b) => (a.average > b.average ? a : b));
    const worst = m.scenarioScores.reduce((a, b) => (a.average < b.average ? a : b));

    report += `| ${i + 1} | ${m.modelName} | ${m.tier} | ${m.overallAverage.toFixed(2)} | ${best.scenarioName} (${best.average.toFixed(1)}) | ${worst.scenarioName} (${worst.average.toFixed(1)}) | ${m.totalToolCalls} |\n`;
  }

  if (disqualified.length > 0) {
    report += `\n---\n\n## Disqualified Models\n\n`;
    for (const m of disqualified) {
      report += `- **${m.modelName}** (${m.tier}): ${m.dqReasons.join('; ')}\n`;
    }
  }

  // Tier recommendations
  report += `\n---\n\n## Tier Recommendations\n\n`;
  const tiers: Record<string, LeaderboardEntry[]> = { budget: [], mid: [], premium: [] };
  for (const m of leaderboard) {
    if (m.overallAverage >= 8.0) tiers.premium.push(m);
    else if (m.overallAverage >= 7.0) tiers.mid.push(m);
    else if (m.overallAverage >= 6.0) tiers.budget.push(m);
  }

  for (const [tier, models] of Object.entries(tiers)) {
    report += `### ${tier.charAt(0).toUpperCase() + tier.slice(1)} Tier (${models.length} candidates)\n`;
    for (const m of models) {
      report += `- ${m.modelName}: ${m.overallAverage.toFixed(2)}/10\n`;
    }
    report += '\n';
  }

  // Per-scenario breakdown
  report += `---\n\n## Per-Scenario Breakdown\n\n`;
  const scenarioNames = leaderboard[0]?.scenarioScores?.map(s => s.scenarioName) ?? [];
  for (const sName of scenarioNames) {
    report += `### ${sName}\n\n`;
    const sorted = [...leaderboard]
      .map(m => ({
        name: m.modelName,
        score: m.scenarioScores.find(s => s.scenarioName === sName)?.average ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      report += `${i + 1}. ${sorted[i].name}: ${sorted[i].score.toFixed(2)}\n`;
    }
    report += '\n';
  }

  fs.writeFileSync(path.join(outputDir, 'analysis.md'), report);
  return report;
}
