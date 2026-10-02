import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProgressNotification, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { describeBenches, readRun, type BenchInfo, type McpContext, type RunFailure } from './data.js';
import {
  formatBenchesMarkdown,
  formatCreateBenchMarkdown,
  formatLeaderboardMarkdown,
  formatOptionsMarkdown,
  formatPlanPreviewMarkdown,
  formatRunResultMarkdown,
  formatRunSummaryMarkdown,
  toLeaderboardRows,
} from './format.js';
import { assertRoutesReady, evaluateTournament, quickTest, readLeaderboard, type EvaluateProgress } from '../pipeline.js';
import { logWarn } from '../utils/logger.js';
import { JUDGES, PARTICIPANT_AGENT_MODEL, resolveRoleModel } from '../config/judges.js';
import { buildShortlist, closestModelIds, getCatalog, type Catalog } from '../catalog.js';
import { routeHasCredentials, routeSetupHint } from '../clients/index.js';
import { parseModelRef } from '../config/model-ref.js';
import { applyReasoningCatalog, seatRef } from '../config/reasoning.js';
import { DEFAULT_SEAT_ORDER, PERSONAS } from '../config/personas.js';
import { estimateRunCost, type CostEstimate } from '../estimate.js';
import { getPlugin } from '../plugins/index.js';
import {
  describePlan, JudgeSeatSchema, normalizeRunPlan, PLAN_LIMITS, RunPlanError, RunPlanSchema,
  type LegacyJudgeOptions, type ResolvedRunPlan, type RunPlanInput,
} from '../run-plan.js';
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
  status: z.enum(['completed', 'cancelled']),
  message: z.string().optional(),
  runId: z.string(),
  plugin: z.string(),
  entries: z.array(LeaderboardRowSchema),
  failures: z.array(RunFailureSchema),
  judgeFailures: z.array(RunFailureSchema),
  resultsDir: z.string(),
  judges: z.array(JudgeInfoSchema),
};

const ShortlistEntrySchema = z.object({
  ref: z.string(), name: z.string(), notes: z.string(),
  inputPrice: z.number().nullable(), outputPrice: z.number().nullable(),
});

const OptionsSchema = z.object({
  benches: z.array(BenchInfoSchema.extend({
    scenarios: z.array(z.object({
      id: z.string(), name: z.string(), description: z.string(), defaultTurns: z.number(),
    })),
  })),
  models: z.object({
    source: z.enum(['live', 'curated-fallback']), liveCount: z.number(),
    shortlist: z.object({
      budget: z.array(ShortlistEntrySchema), mid: z.array(ShortlistEntrySchema),
      premium: z.array(ShortlistEntrySchema), wildcards: z.array(ShortlistEntrySchema),
    }),
    note: z.string(),
  }),
  providers: z.array(z.object({
    id: z.enum(['openrouter', 'anthropic', 'chatgpt']), label: z.string(),
    status: z.enum(['ready', 'not_set_up']), appliesTo: z.string(), setupHint: z.string(),
  })),
  personas: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), defaultModel: z.string() })),
  defaults: z.object({
    judgePanel: z.array(z.object({ persona: z.string(), model: z.string() })),
    synthesizer: z.string(), participant: z.string(), turns: z.string(),
  }),
  limits: z.object({ candidates: z.string(), judges: z.string(), turns: z.string(), customLens: z.string() }),
});

export type TournamentOptions = z.infer<typeof OptionsSchema>;

const RefSummarySchema = z.object({ ref: z.string(), route: z.enum(['openrouter', 'anthropic', 'chatgpt']) });
const PlanPreviewSchema = z.object({
  plan: z.object({
    bench: z.string(),
    scenarios: z.array(z.object({ id: z.string(), name: z.string(), turns: z.number() })),
    candidates: z.array(RefSummarySchema),
    judges: z.array(JudgeInfoSchema.extend({ persona: z.string(), route: RefSummarySchema.shape.route })),
    synthesizer: RefSummarySchema, participant: RefSummarySchema, turns: z.number().nullable(),
  }),
  summary: z.string(),
  estimate: z.object({ usd: z.number().nullable(), display: z.string(), excluded: z.array(z.string()), assumptions: z.string() }),
  warnings: z.array(z.string()),
  readyToRun: z.boolean(),
});

const planInputShape = {
  bench: RunPlanSchema.shape.bench.describe('Bench name. Defaults to "dnd". Call tournament_options for choices.'),
  scenarios: RunPlanSchema.shape.scenarios.describe('Scenario IDs. Omit for every scenario in the bench.'),
  candidates: RunPlanSchema.shape.candidates.describe('1-4 model refs. Bare IDs use OpenRouter. Use anthropic:claude-... for your Anthropic API key.'),
  judgePanel: RunPlanSchema.shape.judgePanel.describe('1-5 judge seats. Each may set model and either persona or customPersona with a lens (1-1000 characters) and optional name (1-60 characters).'),
  synthesizer: RunPlanSchema.shape.synthesizer.describe('Model ref used to reconcile judge scores. Omit for the default. Not used for one judge.'),
  participant: RunPlanSchema.shape.participant.describe('Model ref for the simulated user who sends follow-up messages. Omit for the default.'),
  turns: RunPlanSchema.shape.turns.describe('1-10 turns for every scenario. Omit to use each scenario\'s own default.'),
};

export interface PlanPreview {
  plan: ResolvedRunPlan;
  catalog: Catalog;
  summary: string;
  estimate: CostEstimate;
  warnings: string[];
}

function planModelRefs(plan: ResolvedRunPlan) {
  return [
    ...plan.candidates.map(candidate => parseModelRef(candidate.id)),
    ...plan.judges.map(judge => parseModelRef(seatRef(judge.route, judge.model, judge.reasoning))),
    plan.synthesizer, plan.participant,
  ];
}

export async function buildPlanPreview(ctx: McpContext, input: RunPlanInput, legacy?: LegacyJudgeOptions): Promise<PlanPreview> {
  const plan = normalizeRunPlan(input, legacy);
  const catalog = await getCatalog(ctx.fetch);
  const check = applyReasoningCatalog(plan, catalog);
  if (check.errors.length) throw new RunPlanError(check.errors.join('\n'));
  const catalogIds = catalog.models.map(model => model.id);
  const knownIds = new Set(catalogIds);
  const warnings = new Set([...plan.warnings, ...check.warnings]);
  for (const ref of planModelRefs(plan)) {
    if (catalog.source === 'live' && ref.route === 'openrouter' && !knownIds.has(ref.model)) {
      throw new Error(`Unknown OpenRouter model "${ref.model}". Closest matches: ${closestModelIds(ref.model, catalogIds).join(', ')}.`);
    }
    if (ref.route === 'anthropic' && !routeHasCredentials('anthropic')) {
      warnings.add(`"${ref.ref}" needs ANTHROPIC_API_KEY before the run starts.`);
    }
    if (ref.route === 'openrouter' && !routeHasCredentials('openrouter')) {
      warnings.add(routeSetupHint('openrouter'));
    }
  }
  if (catalog.source === 'curated-fallback') {
    warnings.add('Model catalog offline. Model IDs could not be checked and the cost estimate is unavailable.');
  }
  return { plan, catalog, summary: describePlan(plan), estimate: estimateRunCost(plan, catalog), warnings: [...warnings] };
}

function planPreviewPayload(preview: PlanPreview): z.infer<typeof PlanPreviewSchema> {
  const { plan, summary, estimate, warnings } = preview;
  return {
    plan: {
      bench: plan.bench,
      scenarios: plan.scenarios.map(scenario => ({ id: scenario.id, name: scenario.name, turns: plan.turns ?? scenario.maxTurns })),
      candidates: plan.candidates.map(candidate => ({ ref: candidate.id, route: candidate.route ?? 'openrouter' })),
      judges: plan.judges.map(judge => ({ role: judge.role, name: judge.name, persona: judge.persona ?? judge.role, model: judge.model, route: judge.route })),
      synthesizer: { ref: plan.synthesizer.ref, route: plan.synthesizer.route },
      participant: { ref: plan.participant.ref, route: plan.participant.route },
      turns: plan.turns,
    },
    summary, estimate, warnings,
    readyToRun: planModelRefs(plan).every(ref => routeHasCredentials(ref.route)),
  };
}

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
    status: 'completed' as const,
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
    'tournament_options',
    {
      title: 'Explore tournament options',
      description: 'Free discovery. Lists benches, scenarios, model tiers with prices per million tokens, ' +
        'judge personas, provider setup, defaults, and limits. Fetches the model catalog but makes no paid model calls.',
      inputSchema: { bench: z.string().optional().describe('Show scenarios for just this bench. Omit for all benches.') },
      outputSchema: OptionsSchema.shape,
      annotations: { title: 'Explore tournament options', readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ bench }) => withBenchHint(async () => {
      if (bench !== undefined) getPlugin(bench);
      const benches = describeBenches().filter(item => bench === undefined || item.name === bench).map(item => ({
        ...item,
        scenarios: getPlugin(item.name).scenarios.map(scenario => ({
          id: scenario.id, name: scenario.name, description: scenario.description, defaultTurns: scenario.maxTurns,
        })),
      }));
      const catalog = await getCatalog(ctx.fetch);
      const shortlist = buildShortlist(catalog);
      const payload: TournamentOptions = {
        benches,
        models: {
          source: catalog.source, liveCount: catalog.source === 'live' ? catalog.models.length : 0,
          shortlist,
          note: 'Any OpenRouter model ID works, not just this list. Prefix with "anthropic:" ' +
            '(e.g. "anthropic:claude-sonnet-5-5") to bill an Anthropic model to your own Anthropic API key instead.',
        },
        providers: [
          { id: 'openrouter', label: 'OpenRouter', status: routeHasCredentials('openrouter') ? 'ready' : 'not_set_up',
            appliesTo: 'every model', setupHint: routeSetupHint('openrouter') },
          { id: 'anthropic', label: 'Anthropic', status: routeHasCredentials('anthropic') ? 'ready' : 'not_set_up',
            appliesTo: 'Anthropic (Claude) models only, billed per use to your Anthropic API key', setupHint: routeSetupHint('anthropic') },
          { id: 'chatgpt', label: 'ChatGPT plan', status: 'not_set_up', appliesTo: 'OpenAI models',
            setupHint: 'Coming soon: run OpenAI models on your ChatGPT plan.' },
        ],
        personas: Object.values(PERSONAS).map(persona => ({
          id: persona.id, name: persona.label, description: persona.description, defaultModel: resolveRoleModel(persona.defaultModelRole),
        })),
        defaults: {
          judgePanel: DEFAULT_SEAT_ORDER.slice(0, 3).map(persona => ({ persona, model: resolveRoleModel(PERSONAS[persona].defaultModelRole) })),
          synthesizer: resolveRoleModel('synthesizer'), participant: PARTICIPANT_AGENT_MODEL,
          turns: "each scenario's own default (shown per scenario)",
        },
        limits: {
          candidates: PLAN_LIMITS.candidates.join('-'), judges: PLAN_LIMITS.judges.join('-'),
          turns: PLAN_LIMITS.turns.join('-'), customLens: `${PLAN_LIMITS.lens.join('-')} characters`,
        },
      };
      return { structuredContent: payload, content: [{ type: 'text', text: formatOptionsMarkdown(payload) }] };
    }),
  );

  server.registerTool(
    'tournament_plan_run',
    {
      title: 'Preview a tournament run',
      description: 'Free preview. Checks your choices against the model catalog, fills in defaults, and shows ' +
        'the plan, rough cost, and any provider setup still needed. Makes no model calls and creates no run folder. ' +
        'Show the preview and get the user\'s yes before tournament_evaluate.',
      inputSchema: planInputShape,
      outputSchema: PlanPreviewSchema.shape,
      annotations: { title: 'Preview a tournament run', readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async input => withBenchHint(async () => {
      const preview = await buildPlanPreview(ctx, input);
      return {
        structuredContent: planPreviewPayload(preview),
        content: [{ type: 'text', text: formatPlanPreviewMarkdown(preview) }],
      };
    }),
  );

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
        'The cheap check: one model, one scenario, one judge. Makes real, paid model calls and writes ' +
        'a result to disk. OpenRouter is the default. An anthropic: ref bills your Anthropic API key. ' +
        'Optional judge picks the judge model and persona; turns sets 1-10 turns. No confirm form. ' +
        'Call tournament_options if you need bench or scenario IDs.',
      inputSchema: {
        model: z.string().describe('Model ref, e.g. "deepseek/deepseek-v3.2" or "anthropic:claude-haiku-4-5".'),
        plugin: z.string().default('dnd').describe('Bench to test against, e.g. "dnd" or "coding". Defaults to "dnd".'),
        scenario: z.string().optional().describe('Scenario ID within the plugin. Defaults to the plugin\'s first scenario.'),
        judge: JudgeSeatSchema.optional().describe('One judge seat with an optional model and either persona or customPersona (lens and optional name).'),
        turns: planInputShape.turns,
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
    async ({ model, plugin, scenario, judge, turns }, extra) => withBenchHint(async () => {
      const run = await quickTest({
        model,
        plugin,
        scenario,
        judge,
        turns,
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
        'Costs money. Makes paid model calls and writes results to disk. Call tournament_plan_run first ' +
        'and get the user\'s yes in chat. Clients that support forms will also get a confirm form. ' +
        'Runs 1-4 models across a bench\'s scenarios and saves a leaderboard. Can take several minutes. ' +
        'judgePanel picks judge models and personas per seat and overrides judges and judgeModels. ' +
        'turns sets one turn count for every scenario. participantModel picks the simulated user model. ' +
        'synthesizerModel reconciles judge scores. OpenRouter is the default; anthropic: refs bill ' +
        'the user\'s Anthropic API key. Use tournament_quick_test for a cheap check.',
      inputSchema: {
        models: z.array(z.string()).min(1).max(4).describe('1-4 model refs to compare. Bare IDs use OpenRouter. anthropic: refs use your Anthropic API key.'),
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
        judgePanel: planInputShape.judgePanel,
        turns: planInputShape.turns,
        participantModel: planInputShape.participant,
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
    async ({ models, plugin, scenarios, judges, judgeModels, synthesizerModel, judgePanel, turns, participantModel }, extra) => withBenchHint(async () => {
      const judgeModelsByRole = judgeModels
        ? Object.fromEntries(judgeModels.map((model, index) => [JUDGES[index].role, model]))
        : undefined;
      const caps = server.server.getClientCapabilities();
      let catalog: Catalog | undefined;
      if (caps?.elicitation) {
        const preview = await buildPlanPreview(ctx, {
          bench: plugin, scenarios, candidates: models, judgePanel,
          synthesizer: synthesizerModel, participant: participantModel, turns,
        }, { judges: judgeModels?.length ?? judges, judgeModels: judgeModelsByRole });
        // Fail on a missing provider key before asking, so the user never confirms a run that cannot start.
        assertRoutesReady(preview.plan);
        catalog = preview.catalog;
        let confirmed = false;
        try {
          const result = await server.server.elicitInput({
            mode: 'form',
            message: `${preview.summary}\n\nEstimated cost: ${preview.estimate.display}\n\nStart this paid run?`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', title: 'Start the run', description: 'Makes real, paid model calls.', default: false },
              },
              required: ['confirm'],
            },
          }, { timeout: 10 * 60 * 1000 });
          confirmed = result.action === 'accept' && result.content?.confirm === true;
        } catch (error) {
          // A timeout, unsupported form, or client failure never authorizes a paid run.
          logWarn(`Confirm form failed, treating as cancel: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!confirmed) {
          const message = 'Cancelled. Nothing was run and nothing was charged.';
          return {
            structuredContent: { status: 'cancelled' as const, message, runId: '', plugin,
              entries: [], failures: [], judgeFailures: [], resultsDir: '', judges: [] },
            content: [{ type: 'text', text: message }],
          };
        }
      }
      const run = await evaluateTournament({
        models,
        // Reuse the preview's catalog so the run checks levels against what the user confirmed.
        catalog: catalog ?? await getCatalog(ctx.fetch),
        plugin,
        scenarios,
        judges: judgeModels?.length ?? judges,
        judgeModels: judgeModelsByRole,
        synthesizerModel,
        judgePanel,
        turns,
        participantModel,
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
