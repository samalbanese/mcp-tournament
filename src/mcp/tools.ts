import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProgressNotification, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { describeBenches, readRun, type McpContext, type RunFailure } from './data.js';
import {
  formatBenchesMarkdown,
  formatLeaderboardMarkdown,
  formatRunResultMarkdown,
  formatRunSummaryMarkdown,
  toLeaderboardRows,
} from './format.js';
import { evaluateTournament, quickTest, readLeaderboard, type EvaluateProgress } from '../pipeline.js';

const FinalCriterionSchema = z.object({
  score: z.number(),
  confidence: z.enum(['high', 'medium', 'contested']),
  outliers: z.array(z.string()),
});

const ScenarioScoreSchema = z.object({
  scenarioId: z.string(),
  scenarioName: z.string(),
  average: z.number(),
  scores: z.record(z.string(), FinalCriterionSchema),
  ruleErrors: z.array(z.string()),
  flags: z.array(z.string()),
});

const LeaderboardEntrySchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  tier: z.string(),
  overallAverage: z.number(),
  scenarioScores: z.array(ScenarioScoreSchema),
});

const RunFailureSchema = z.object({
  model: z.string(),
  scenario: z.string(),
  error: z.string(),
});

const RunSummarySchema = z.object({
  runId: z.string(),
  plugin: z.string(),
  createdAt: z.string(),
  candidates: z.array(z.object({ id: z.string(), name: z.string(), tier: z.string() })),
  judges: z.array(z.object({ role: z.string(), name: z.string(), model: z.string() })),
  scenarios: z.array(z.object({ id: z.string(), name: z.string() })),
  leaderboard: z.array(LeaderboardEntrySchema).nullable(),
  failures: z.array(RunFailureSchema),
});

const BenchInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  scenarios: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
});

const LeaderboardRowSchema = z.object({
  rank: z.number(),
  modelId: z.string(),
  modelName: z.string(),
  tier: z.string(),
  score: z.number(),
});

const RunResultSchema = {
  runId: z.string(),
  plugin: z.string(),
  entries: z.array(LeaderboardRowSchema),
  failures: z.array(RunFailureSchema),
  judgeFailures: z.array(RunFailureSchema),
  resultsDir: z.string(),
};

/**
 * getPlugin's "Unknown plugin" error already lists the valid names; point the
 * agent at the discovery tool too so its next call can succeed.
 */
async function withBenchHint<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Unknown plugin')) throw error;
    throw new Error(`${message}. Call tournament_list_benches to see every bench and its scenario IDs.`);
  }
}

/** Forwards pipeline progress as MCP `notifications/progress`, only when the caller asked for it. */
function makeProgressForwarder(extra: {
  _meta?: RequestMeta;
  sendNotification: (notification: ProgressNotification) => Promise<void>;
}): ((progress: EvaluateProgress) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (progress: EvaluateProgress) => {
    void extra.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: progress.completed,
        total: progress.total,
        message: progress.message,
      },
    });
  };
}

function runResultPayload(run: {
  runId: string;
  runDir: string;
  leaderboard: Array<{ modelId: string; modelName: string; tier: string; overallAverage: number }>;
  failures?: RunFailure[];
  judgeFailures?: RunFailure[];
}, plugin: string) {
  return {
    runId: run.runId,
    plugin,
    entries: toLeaderboardRows(run.leaderboard),
    failures: run.failures ?? [],
    judgeFailures: run.judgeFailures ?? [],
    resultsDir: run.runDir,
  };
}

export function registerTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'tournament_list_benches',
    {
      title: 'List evaluation benches',
      description:
        'Free local read (no API calls, no network). Lists every registered evaluation bench ' +
        '(plugin) and its scenarios, with IDs and descriptions. Call this first to discover ' +
        'valid `plugin` and `scenario` IDs before calling tournament_evaluate or ' +
        'tournament_quick_test.',
      inputSchema: {},
      outputSchema: { benches: z.array(BenchInfoSchema) },
      annotations: {
        title: 'List evaluation benches',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const benches = describeBenches();
      return {
        structuredContent: { benches },
        content: [{ type: 'text', text: formatBenchesMarkdown(benches) }],
      };
    },
  );

  server.registerTool(
    'tournament_leaderboard',
    {
      title: 'Read the model leaderboard',
      description:
        'Free local read (no API calls, no network). Reads the best score per model across all ' +
        'saved tournament runs on disk, sorted highest first. Optionally filter to one bench with ' +
        '`plugin`. Returns an empty list if no runs have been saved yet; run tournament_quick_test ' +
        'to create one.',
      inputSchema: {
        plugin: z.string().optional().describe('Only include runs for this bench, e.g. "dnd" or "coding". Omit for all benches.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of models to return, 1-50. Defaults to 10.'),
      },
      outputSchema: { entries: z.array(LeaderboardRowSchema) },
      annotations: {
        title: 'Read the model leaderboard',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ plugin, limit }) => {
      const entries = readLeaderboard({ plugin, limit, outputRoot: ctx.resultsRoot });
      const rows = toLeaderboardRows(entries);
      return {
        structuredContent: { entries: rows },
        content: [{ type: 'text', text: formatLeaderboardMarkdown(rows, plugin) }],
      };
    },
  );

  server.registerTool(
    'tournament_get_run',
    {
      title: 'Get a saved tournament run',
      description:
        'Free local read (no API calls, no network). Reads the full detail of one saved tournament ' +
        'run by ID: plugin, models, judges, scenarios, per-model per-scenario scores, and any ' +
        'failures. Use tournament_leaderboard or the tournament://runs resource to find run IDs.',
      inputSchema: {
        runId: z.string().describe('A run ID, e.g. "run-2026-07-20-235500". Must match a saved run folder.'),
      },
      outputSchema: { run: RunSummarySchema },
      annotations: {
        title: 'Get a saved tournament run',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      const run = readRun(ctx, runId);
      return {
        structuredContent: { run },
        content: [{ type: 'text', text: formatRunSummaryMarkdown(run) }],
      };
    },
  );

  server.registerTool(
    'tournament_quick_test',
    {
      title: 'Quick sanity-check a model',
      description:
        'Makes a real, paid model call through OpenRouter (requires OPENROUTER_API_KEY) and writes ' +
        'a result to disk. Runs ONE candidate model against ONE scenario with a single judge: a ' +
        'cheap, fast sanity check (usually well under a minute) before committing to a full ' +
        'tournament_evaluate run. Call tournament_list_benches first if you are not sure which ' +
        '`plugin`/`scenario` IDs are valid.',
      inputSchema: {
        model: z.string().describe('OpenRouter model ID, e.g. "deepseek/deepseek-v3.2".'),
        plugin: z.string().default('dnd').describe('Bench to test against, e.g. "dnd" or "coding". Defaults to "dnd".'),
        scenario: z.string().optional().describe('Scenario ID within the plugin. Defaults to the plugin\'s first scenario.'),
      },
      outputSchema: RunResultSchema,
      annotations: {
        title: 'Quick sanity-check a model',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, plugin, scenario }, extra) => withBenchHint(async () => {
      const run = await quickTest({
        model,
        plugin,
        scenario,
        outputRoot: ctx.resultsRoot,
        onProgress: makeProgressForwarder(extra),
      });
      const payload = runResultPayload(run, plugin);
      return {
        structuredContent: payload,
        content: [{ type: 'text', text: formatRunResultMarkdown(payload) }],
      };
    }),
  );

  server.registerTool(
    'tournament_evaluate',
    {
      title: 'Run a full tournament',
      description:
        'Makes real, paid model calls through OpenRouter (requires OPENROUTER_API_KEY) and writes ' +
        'results to disk. Runs 1-4 candidate models across one bench\'s scenarios, scored by a ' +
        'multi-judge panel, and saves a leaderboard. Takes minutes, not seconds. Suggest ' +
        'tournament_quick_test first for a cheap sanity check, and tournament_list_benches to ' +
        'discover valid `plugin` and `scenario` IDs.',
      inputSchema: {
        models: z.array(z.string()).min(1).max(4).describe('1-4 OpenRouter model IDs to compare, e.g. ["deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"].'),
        plugin: z.string().default('dnd').describe('Bench to run, e.g. "dnd" or "coding". Defaults to "dnd".'),
        scenarios: z.array(z.string()).optional().describe('Scenario IDs to run. Omit to run every scenario in the bench.'),
        judges: z.number().int().min(1).max(5).default(3).describe('Number of judges on the scoring panel, 1-5. Defaults to 3.'),
      },
      outputSchema: RunResultSchema,
      annotations: {
        title: 'Run a full tournament',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ models, plugin, scenarios, judges }, extra) => withBenchHint(async () => {
      const run = await evaluateTournament({
        models,
        plugin,
        scenarios,
        judges,
        outputRoot: ctx.resultsRoot,
        onProgress: makeProgressForwarder(extra),
      });
      const payload = runResultPayload(run, plugin);
      return {
        structuredContent: payload,
        content: [{ type: 'text', text: formatRunResultMarkdown(payload) }],
      };
    }),
  );
}
