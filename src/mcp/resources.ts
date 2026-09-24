/**
 * MCP resources: free, read-only local data an assistant can pull in without
 * calling a tool. Every resource here reads from disk through `data.ts`; none
 * of them make a network call or cost money.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readLeaderboard } from '../pipeline.js';
import { completeRunIds, describeBenches, listRuns, readRun, type McpContext } from './data.js';
import { toLeaderboardRows } from './format.js';
import { buildReport } from './report.js';

function json(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] };
}

function runsList(ctx: McpContext) {
  return listRuns(ctx).map(run => ({
    runId: run.runId,
    plugin: run.plugin,
    createdAt: run.createdAt,
    models: run.candidates.map(candidate => candidate.id),
    winner: run.leaderboard?.[0]?.modelName ?? null,
  }));
}

export function registerResources(server: McpServer, ctx: McpContext): void {
  server.registerResource(
    'benches',
    'tournament://benches',
    {
      title: 'Available benches',
      description:
        'Every registered evaluation bench (plugin) and its scenarios, with plain-language ' +
        'descriptions. Free, local, no API calls. Read this first when deciding which bench ' +
        'fits a task, or before calling tournament_evaluate to see valid scenario IDs.',
      mimeType: 'application/json',
    },
    async uri => json(uri.href, { benches: describeBenches() }),
  );

  server.registerResource(
    'leaderboard',
    'tournament://leaderboard',
    {
      title: 'All-time leaderboard',
      description:
        'Best score ever recorded per model, across every run in the results directory ' +
        '(one row per model, its single highest overallAverage). Free, local, no API calls. ' +
        'Use this for "which model has historically done best" questions; use ' +
        'tournament://runs/{runId} for a single run\'s detail instead.',
      mimeType: 'application/json',
    },
    async uri => json(uri.href, {
      entries: toLeaderboardRows(readLeaderboard({ outputRoot: ctx.resultsRoot, limit: 50 })),
    }),
  );

  server.registerResource(
    'runs',
    'tournament://runs',
    {
      title: 'All runs (index)',
      description:
        'Every tournament run on disk, newest first, as a lightweight index: run ID, plugin, ' +
        'creation time, candidate model IDs, and the winning model name (null if the run was ' +
        'interrupted or has no leaderboard yet). Free, local, no API calls. Use this to find a ' +
        'runId to pass to tournament://runs/{runId} or tournament://runs/{runId}/report.',
      mimeType: 'application/json',
    },
    async uri => json(uri.href, { runs: runsList(ctx) }),
  );

  const runIdCompleter = async (value: string) => completeRunIds(ctx, value);

  server.registerResource(
    'run',
    new ResourceTemplate('tournament://runs/{runId}', {
      list: async () => ({
        resources: listRuns(ctx).map(run => ({
          uri: `tournament://runs/${run.runId}`,
          name: run.runId,
          title: `${run.plugin} bench: ${run.runId}`,
          mimeType: 'application/json',
        })),
      }),
      complete: { runId: runIdCompleter },
    }),
    {
      title: 'Run detail',
      description:
        'Full structured detail for one run: candidates, judge panel, scenarios, the full ' +
        'leaderboard (null if the run was interrupted before scoring), and any recorded ' +
        'failures. Free, local, no API calls. For a human-readable version of the same run, ' +
        'read tournament://runs/{runId}/report instead. Throws an actionable error naming ' +
        'recent run IDs if runId is invalid or unknown.',
    },
    async (uri, variables) => json(uri.href, { run: readRun(ctx, String(variables.runId)) }),
  );

  server.registerResource(
    'run-report',
    new ResourceTemplate('tournament://runs/{runId}/report', {
      list: async () => ({
        resources: listRuns(ctx).map(run => ({
          uri: `tournament://runs/${run.runId}/report`,
          name: `${run.runId}-report`,
          title: `${run.plugin} bench report: ${run.runId}`,
          mimeType: 'text/markdown',
        })),
      }),
      complete: { runId: runIdCompleter },
    }),
    {
      title: 'Run report (markdown scorecard)',
      description:
        'Human-readable markdown scorecard for one run: winner and margin, a ranked table, ' +
        'and per-scenario criterion breakdowns for every model. This is the version to show a ' +
        'person, or to embed when explaining a run in plain language. Free, local, no API ' +
        'calls. Notes clearly when the run was interrupted and has no leaderboard. Throws an ' +
        'actionable error naming recent run IDs if runId is invalid or unknown.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildReport(readRun(ctx, String(variables.runId))),
      }],
    }),
  );
}
