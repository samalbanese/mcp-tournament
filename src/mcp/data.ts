/**
 * Read-only access to tournament results and bench metadata for the MCP layer.
 *
 * Tools, resources, and prompts all read through this module so they agree on
 * what a "run" is, how run IDs are validated, and how missing data is reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LeaderboardEntry } from '../phases/aggregator.js';
import { modelSlug, scenarioSlug, type Turn } from '../plugins/base.js';
import { listPlugins } from '../plugins/index.js';
import { getPackageBenchesDir } from '../plugins/custom.js';
import { defaultResultsRoot } from '../pipeline.js';
import { slugify } from '../utils/slug.js';

export interface McpContext {
  /** Absolute path of the directory that holds `run-*` result folders. */
  resultsRoot: string;
  /** Absolute path of the directory new benches are saved into. */
  benchesDir: string;
}

export interface RunFailure {
  model: string;
  scenario: string;
  error: string;
}

export interface RunSummary {
  runId: string;
  plugin: string;
  createdAt: string;
  candidates: Array<{ id: string; name: string; tier: string }>;
  judges: Array<{ role: string; name: string; model: string }>;
  scenarios: Array<{ id: string; name: string }>;
  /** Null when the run was interrupted before a leaderboard was written. */
  leaderboard: LeaderboardEntry[] | null;
  failures: RunFailure[];
}

export interface BenchInfo {
  name: string;
  description: string;
  scenarios: Array<{ id: string; name: string; description: string }>;
}

export const RUN_ID_PATTERN = /^run-[a-zA-Z0-9-]+$/;

export function createContext(resultsRoot?: string, benchesDir?: string): McpContext {
  return {
    resultsRoot: resultsRoot ? path.resolve(resultsRoot) : defaultResultsRoot(),
    benchesDir: benchesDir ? path.resolve(benchesDir) : getPackageBenchesDir(),
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function loadRun(runDir: string): RunSummary | null {
  const manifest = readJson<Omit<RunSummary, 'leaderboard' | 'failures'>>(path.join(runDir, 'run.json'));
  if (!manifest?.runId) return null;
  return {
    runId: manifest.runId,
    plugin: manifest.plugin,
    createdAt: manifest.createdAt,
    candidates: manifest.candidates ?? [],
    judges: manifest.judges ?? [],
    scenarios: manifest.scenarios ?? [],
    leaderboard: readJson<LeaderboardEntry[]>(path.join(runDir, 'leaderboard.json')),
    failures: readJson<RunFailure[]>(path.join(runDir, 'failures.json')) ?? [],
  };
}

/** All readable runs, newest first. Malformed or unrelated folders are skipped. */
export function listRuns(
  ctx: McpContext,
  options: { plugin?: string; limit?: number } = {},
): RunSummary[] {
  if (!fs.existsSync(ctx.resultsRoot)) return [];
  const runs: RunSummary[] = [];
  for (const entry of fs.readdirSync(ctx.resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const run = loadRun(path.join(ctx.resultsRoot, entry.name));
    if (run && (!options.plugin || run.plugin === options.plugin)) runs.push(run);
  }
  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return options.limit ? runs.slice(0, options.limit) : runs;
}

/** Run IDs starting with `prefix`, newest first: autocomplete for run ID arguments. */
export function completeRunIds(ctx: McpContext, prefix = ''): string[] {
  return listRuns(ctx).map(run => run.runId).filter(id => id.startsWith(prefix)).slice(0, 100);
}

/** One run by ID. Throws an error that names real run IDs the caller can retry with. */
export function readRun(ctx: McpContext, runId: string): RunSummary {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`"${runId}" is not a valid run ID. Run IDs look like "run-2026-07-20-235500".`);
  }
  const run = loadRun(path.join(ctx.resultsRoot, runId));
  if (run) return run;
  const recent = listRuns(ctx, { limit: 5 }).map(candidate => candidate.runId);
  throw new Error(recent.length
    ? `Run "${runId}" not found. Most recent runs: ${recent.join(', ')}.`
    : `Run "${runId}" not found. No runs exist yet; call tournament_evaluate to create one.`);
}

/**
 * Locate a result subfolder by slug. Runs written before slug hashing was
 * introduced used plain truncated slugs, so fall back to a prefix match.
 */
function findSlugDir(parent: string, preferred: string, fullValue: string): string | null {
  if (fs.existsSync(path.join(parent, preferred))) return path.join(parent, preferred);
  if (!fs.existsSync(parent)) return null;
  const full = slugify(fullValue);
  const match = fs.readdirSync(parent).find(name => full.startsWith(name));
  return match ? path.join(parent, match) : null;
}

/** Full candidate conversation for one model on one scenario of a run. */
export function readTranscript(
  ctx: McpContext,
  runId: string,
  modelId: string,
  scenarioId: string,
): Turn[] {
  const run = readRun(ctx, runId);
  const model = run.candidates.find(candidate => candidate.id === modelId);
  if (!model) {
    throw new Error(`Model "${modelId}" was not in ${runId}. Models in this run: ${
      run.candidates.map(candidate => candidate.id).join(', ')}.`);
  }
  const scenario = run.scenarios.find(item => item.id === scenarioId);
  if (!scenario) {
    throw new Error(`Scenario "${scenarioId}" was not in ${runId}. Scenarios in this run: ${
      run.scenarios.map(item => item.id).join(', ')}.`);
  }
  const runDir = path.join(ctx.resultsRoot, runId);
  const modelDir = findSlugDir(path.join(runDir, 'candidates'), modelSlug(model.id), model.id);
  const scenarioDir = modelDir && findSlugDir(modelDir, scenarioSlug(scenario), scenario.name);
  const turns = scenarioDir && readJson<Turn[]>(path.join(scenarioDir, 'turns.json'));
  if (!turns) {
    const failure = run.failures.find(item => item.model === modelId && item.scenario === scenarioId);
    throw new Error(failure
      ? `No transcript: ${modelId} failed on ${scenarioId} (${failure.error}).`
      : `No transcript was saved for ${modelId} on ${scenarioId} in ${runId}.`);
  }
  return turns;
}

/** Every registered bench (built-in plugins plus JSON benches) and its scenarios. */
export function describeBenches(): BenchInfo[] {
  return listPlugins().map(plugin => ({
    name: plugin.name,
    description: plugin.description,
    scenarios: plugin.scenarios.map(({ id, name, description }) => ({ id, name, description })),
  }));
}
