import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProgressNotification, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { describeBenches, readRun, type BenchInfo, type McpContext, type RunFailure } from './data.js';
import {
  formatBenchesMarkdown,
  formatCreateBenchMarkdown,
  formatLeaderboardMarkdown,
  formatRunResultMarkdown,
  formatRunSummaryMarkdown,
  toLeaderboardRows,
} from './format.js';
import { evaluateTournament, quickTest, readLeaderboard, type EvaluateProgress } from '../pipeline.js';
import { JUDGES } from '../config/judges.js';
import {
  BenchDefinitionSchema,
  BenchSaveError,
  CriterionSchema,
  ScenarioSchema,
  saveBench,
  type BenchDefinition,
} from '../plugins/custom.js';

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

const JudgeInfoSchema = z.object({ role: z.string(), name: z.string(), model: z.string() });

const RunResultSchema = {
  runId: z.string(),
  plugin: z.string(),
  entries: z.array(LeaderboardRowSchema),
  failures: z.array(RunFailureSchema),
  judgeFailures: z.array(RunFailureSchema),
  resultsDir: z.string(),
  judges: z.array(JudgeInfoSchema),
};

/**
 * The judge panel actually used for a run, read back from the saved manifest. Tolerant of a
 * missing or malformed run.json (returns []) so a run result is never blocked on this detail.
 */
function readRunJudges(ctx: McpContext, runId: string): Array<{ role: string; name: string; model: string }> {
  try {
    return readRun(ctx, runId).judges;
  } catch {
    return [];
  }
}

/**
 * Zod pieces reused from the bench definition schema (src/plugins/custom.ts), with
 * agent-facing `.describe()` text layered on top of the same validators (length limits, ID
 * formats) that saveBench enforces, so the limits stated here can never drift from reality.
 */
const criterionInputShape = {
  name: CriterionSchema.shape.name.describe(
    'Short snake_case criterion ID, e.g. "resolution_quality". 1-60 characters, lowercase ' +
      'letters, numbers, and underscores only (must match ^[a-z0-9_]+$). Shown to the judge ' +
      'panel and in reports.',
  ),
  description: CriterionSchema.shape.description.describe(
    'What strong performance on this criterion looks like, written for the judge models to ' +
      'score against, e.g. "Fully resolves the customer\'s billing issue without deflecting or ' +
      'asking them to call back." 1-500 characters.',
  ),
};

const scenarioInputShape = {
  id: ScenarioSchema.shape.id.describe(
    'Lowercase slug ID for this scenario, e.g. "double-charge-refund". Lowercase letters, ' +
      'numbers, and hyphens only (must match ^[a-z0-9-]+$). Used as the scenario ID in ' +
      'tournament_evaluate/tournament_quick_test.',
  ),
  name: ScenarioSchema.shape.name.describe(
    'Short human-readable scenario name, e.g. "Double Charge Refund Request". 1-100 characters.',
  ),
  description: ScenarioSchema.shape.description.describe(
    'Optional one-line summary of what this scenario tests, up to 500 characters. Shown in ' +
      'tournament_list_benches; also used as the judges\' goal statement if you do not write one.',
  ),
  prompt: ScenarioSchema.shape.prompt.describe(
    'The exact task given to the candidate model as the opening message, e.g. "A customer says ' +
      'they were charged twice for the same order and wants a refund today. Handle it." ' +
      '1-20,000 characters.',
  ),
  rounds: ScenarioSchema.shape.rounds.describe(
    'Number of back-and-forth turns with the simulated participant, 1-5. 1 means the candidate ' +
      'gives a single answer and the scenario ends there; higher values add follow-up messages ' +
      'from a simulated participant reacting to the candidate\'s answer. Defaults to 1.',
  ),
  participantPersona: ScenarioSchema.shape.participantPersona.describe(
    'Who the candidate is talking to, used to drive realistic follow-up questions when rounds ' +
      'is greater than 1, e.g. "an impatient customer who was double-charged". Optional; only ' +
      'matters when rounds > 1. 1-1,000 characters.',
  ),
  criteria: z.array(z.object(criterionInputShape)).min(1).max(6).describe(
    '1-6 scoring criteria the judge panel evaluates this scenario against.',
  ),
};

const benchScenariosInputShape = z.array(z.object(scenarioInputShape)).min(1).max(10).describe(
  '1-10 scenarios that make up this bench. Each scenario is one task the candidate model is ' +
    'given and scored on.',
);

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

function runResultPayload(ctx: McpContext, run: {
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
    judges: readRunJudges(ctx, run.runId),
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
      const payload = runResultPayload(ctx, run, plugin);
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
        'discover valid `plugin` and `scenario` IDs. Judges are picked by number (`judges`) by ' +
        'default; pass `judgeModels` to choose the exact model for each judge seat instead, and ' +
        '`synthesizerModel` to choose the model that reconciles judge scores into a final number.',
      inputSchema: {
        models: z.array(z.string()).min(1).max(4).describe('1-4 OpenRouter model IDs to compare, e.g. ["deepseek/deepseek-v3.2", "openai/gpt-5.4-mini"].'),
        plugin: z.string().default('dnd').describe('Bench to run, e.g. "dnd" or "coding". Defaults to "dnd".'),
        scenarios: z.array(z.string()).optional().describe('Scenario IDs to run. Omit to run every scenario in the bench.'),
        judges: z.number().int().min(1).max(5).default(3).describe('Number of judges on the scoring panel, 1-5. Defaults to 3. Ignored when `judgeModels` is provided.'),
        judgeModels: z.array(z.string()).min(1).max(5).optional().describe(
          `1-5 OpenRouter model IDs, one per judge seat, filled in this fixed order: ${
            JUDGES.map((judge, index) => `${index + 1}. ${judge.name} (${judge.focus.join(', ')})`).join('; ')
          }. When provided, the panel size equals the length of this list and overrides \`judges\`. ` +
            'Omit to use the default model for each seat.',
        ),
        synthesizerModel: z.string().optional().describe('OpenRouter model ID that reconciles the judges\' scores into one final score. Omit to use the default synthesizer model.'),
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
    async ({ models, plugin, scenarios, judges, judgeModels, synthesizerModel }, extra) => withBenchHint(async () => {
      const judgeModelsByRole = judgeModels
        ? Object.fromEntries(judgeModels.map((model, index) => [JUDGES[index].role, model]))
        : undefined;
      const run = await evaluateTournament({
        models,
        plugin,
        scenarios,
        judges: judgeModels?.length ?? judges,
        judgeModels: judgeModelsByRole,
        synthesizerModel,
        outputRoot: ctx.resultsRoot,
        onProgress: makeProgressForwarder(extra),
      });
      const payload = runResultPayload(ctx, run, plugin);
      return {
        structuredContent: payload,
        content: [{ type: 'text', text: formatRunResultMarkdown(payload) }],
      };
    }),
  );

  server.registerTool(
    'tournament_create_bench',
    {
      title: 'Create a reusable evaluation bench',
      description:
        'Free, local, no model calls. Saves a new reusable bench (a named set of scenarios and ' +
        'scoring criteria) to disk. Once saved, it is immediately usable by tournament_evaluate ' +
        'and tournament_quick_test as `plugin: "<name>"`, and it appears in ' +
        'tournament_list_benches. Bench names must be unique among registered benches. Draft the ' +
        'scenarios and criteria first and confirm them with the user before calling this tool, ' +
        'since saving registers the bench immediately.',
      inputSchema: {
        name: BenchDefinitionSchema.shape.name.describe(
          'Unique bench name, e.g. "customer-support-escalations". 1-60 characters, must contain ' +
            'at least one letter or number. Fails if a bench with this name already exists.',
        ),
        description: BenchDefinitionSchema.shape.description.describe(
          'One-sentence description of what this bench tests, e.g. "Tests how well a model ' +
            'handles frustrated customers who feel wronged." 1-200 characters.',
        ),
        scenarios: benchScenariosInputShape,
      },
      outputSchema: { bench: BenchInfoSchema, file: z.string() },
      annotations: {
        title: 'Create a reusable evaluation bench',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, description, scenarios }) => {
      const definition: BenchDefinition = { name, description, scenarios };
      try {
        const { file } = saveBench(ctx.benchesDir, definition);
        const bench: BenchInfo = {
          name: definition.name,
          description: definition.description,
          scenarios: definition.scenarios.map(scenario => ({
            id: scenario.id,
            name: scenario.name,
            description: scenario.description,
          })),
        };
        return {
          structuredContent: { bench, file },
          content: [{ type: 'text', text: formatCreateBenchMarkdown(bench, file, definition.scenarios) }],
        };
      } catch (error) {
        if (error instanceof BenchSaveError && error.code === 'conflict') {
          throw new Error(
            `A bench named "${definition.name}" already exists. Pick a different name, or run ` +
              `the existing one with plugin: "${definition.name}".`,
          );
        }
        throw error;
      }
    },
  );
}
