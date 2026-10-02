import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getCatalog, type Catalog } from '../catalog.js';
import { estimateRunCost } from '../estimate.js';
import { assertRoutesReady, defaultResultsRoot, evaluateTournament } from '../pipeline.js';
import { normalizeRunPlan, type ResolvedRunPlan } from '../run-plan.js';
import { analyzeStudy, type StudyAnalysis } from './analyze.js';
import { planBatches, validateStudyAgainstBenches } from './batches.js';
import { collectScores } from './collect.js';
import { writeStudyOutputs, type StudyMeta } from './export.js';
import { parseStudy, StudyError, StudySchema, type Study } from './schema.js';

export interface StudyProgress { batch: number; batches: number; message: string }
export interface RunStudyOptions {
  resultsRoot?: string;
  confirm: (summary: string) => Promise<boolean>;
  onProgress?: (p: StudyProgress) => void;
  catalog?: Catalog;
  fetchUsage?: () => Promise<number | null>;
  /** Original input path, saved for reanalysis of interrupted CLI runs. */
  studyFile?: string;
}
export interface StudyOutcome {
  studyDir: string;
  analysis: StudyAnalysis;
  batchesRun: number;
  batchesSkipped: number;
  cancelled: boolean;
}

export const ProgressSchema = z.object({
  done: z.array(z.string().regex(/^\d+-\d+$/)),
  studyFile: z.string().optional(),
  study: StudySchema.optional(),
  startedAt: z.string().optional(),
  // OpenRouter spend summed across invocations, recovering gaps on resume; null once any usage reading failed.
  spentUsd: z.number().nullable().optional(),
  lastUsage: z.number().nullable().optional(),
});
const MetaSchema = z.object({
  runIds: z.array(z.string().regex(/^run-[a-zA-Z0-9-]+$/)),
  estimateUsd: z.number().nullable(), actualUsd: z.number().nullable(),
  startedAt: z.string(), finishedAt: z.string(),
  headlines: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
}).passthrough();

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function defaultFetchUsage(): Promise<number | null> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_DICE_ORACLE_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { data?: { usage?: unknown } };
    const usage = body?.data?.usage;
    return typeof usage === 'number' && Number.isFinite(usage) ? usage : null;
  } catch {
    return null;
  }
}

export async function readUsage(fetchUsage: () => Promise<number | null>): Promise<number | null> {
  try {
    const usage = await fetchUsage();
    return typeof usage === 'number' && Number.isFinite(usage) ? usage : null;
  } catch {
    return null;
  }
}

function estimateSubscriptionRun(plan: ResolvedRunPlan, catalog: Catalog) {
  // Keep every workload in the estimate, but give subscription roles an unpriced ID.
  // The shared estimator otherwise looks up Claude's API price in the catalog.
  const model = 'claude-study-subscription-excluded';
  const ref = `anthropic:${model}`;
  const pricedPlan: ResolvedRunPlan = {
    ...plan,
    candidates: plan.candidates.map(candidate => candidate.route === 'anthropic' ? { ...candidate, id: ref } : candidate),
    judges: plan.judges.map(judge => judge.route === 'anthropic' ? { ...judge, model } : judge),
    participant: plan.participant.route === 'anthropic' ? { ...plan.participant, ref, model } : plan.participant,
    synthesizer: plan.synthesizer.route === 'anthropic' ? { ...plan.synthesizer, ref, model } : plan.synthesizer,
  };
  const estimate = estimateRunCost(pricedPlan, {
    ...catalog, models: catalog.models.filter(entry => entry.id !== `anthropic/${model}`),
  });
  return { ...estimate, excluded: estimate.excluded.filter(entry => entry !== ref) };
}

// Callers register benches first (loadDiscoveredBenches); registering twice warns for every bench.
export async function runStudy(input: Study, options: RunStudyOptions): Promise<StudyOutcome> {
  const study = parseStudy(input);
  validateStudyAgainstBenches(study);
  const batches = planBatches(study);
  const plans = batches.map(batch => normalizeRunPlan(batch.plan));
  for (const plan of plans) assertRoutesReady(plan);

  const root = path.resolve(options.resultsRoot ?? defaultResultsRoot());
  const studyDir = path.join(root, 'studies', study.id);
  const progressFile = path.join(studyDir, 'progress.json');
  const progress = fs.existsSync(progressFile) ? ProgressSchema.parse(readJson(progressFile)) : { done: [] as string[] };
  if (progress.study && JSON.stringify(progress.study) !== JSON.stringify(study)) {
    throw new StudyError('The saved study differs from this input. Use a new study ID for a changed study.');
  }
  if (progress.done.some(id => !batches.some(batch => batch.batchId === id))) {
    throw new StudyError('Progress contains a batch that is not in this study.');
  }
  const catalog = options.catalog ?? await getCatalog();
  const estimates = plans.map(plan => estimateSubscriptionRun(plan, catalog));
  const estimateUsd = estimates.some(estimate => estimate.usd === null)
    ? null : estimates.reduce((sum, estimate) => sum + estimate.usd!, 0);
  const excluded = [...new Set(estimates.flatMap(estimate => estimate.excluded))];
  const answers = plans.reduce((sum, plan) => sum + plan.candidates.length * plan.scenarios.length, 0);
  const summary = [
    `${study.title}: ${batches.length} batch(es), ${study.candidates.length} models, ${study.judges.length} judges, ${answers} answers.`,
    `Models: ${study.candidates.map(candidate => candidate.ref).join(', ')}`,
    estimateUsd === null ? 'Cost estimate unavailable (model catalog offline).' : `≈ $${estimateUsd.toFixed(2)} (rough, could be ±50%).`,
    'anthropic: refs are excluded from the estimate because they run on the subscription.',
    ...(study.reasoningEffort
      ? [`Reasoning effort "${study.reasoningEffort}" adds reasoning tokens the estimate does not count; expect actual spend above it.`]
      : []),
    ...(excluded.length ? [`Other unpriced refs excluded: ${excluded.join(', ')}`] : []),
    `${progress.done.length} completed batch(es) will be skipped. The estimate covers the full study.`,
    estimates[0].assumptions,
  ].join('\n');
  if (!await options.confirm(summary)) {
    return { studyDir, analysis: analyzeStudy([]), batchesRun: 0, batchesSkipped: 0, cancelled: true };
  }

  fs.mkdirSync(studyDir, { recursive: true });
  progress.study = study;
  progress.startedAt ??= new Date().toISOString();
  if (options.studyFile) progress.studyFile = path.resolve(options.studyFile);
  const saveProgress = () => {
    const temporary = `${progressFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(progress, null, 2)}\n`);
    fs.renameSync(temporary, progressFile);
  };
  saveProgress();
  const previousEffort = process.env.TOURNAMENT_REASONING_EFFORT;
  let batchesRun = 0;
  let batchesSkipped = 0;
  try {
    if (study.reasoningEffort) process.env.TOURNAMENT_REASONING_EFFORT = study.reasoningEffort;
    const fetchUsage = options.fetchUsage ?? defaultFetchUsage;
    const hasPending = batches.some(batch => !progress.done.includes(batch.batchId));
    let lastUsage = hasPending ? await readUsage(fetchUsage) : null;
    if (hasPending) {
      progress.spentUsd = lastUsage === null || progress.spentUsd === null
        ? null : (progress.spentUsd ?? 0) + (typeof progress.lastUsage === 'number' ? lastUsage - progress.lastUsage : 0);
      progress.lastUsage = lastUsage;
      saveProgress();
    }
    // Read usage after every batch, failed ones included, so a crash and resume keeps earlier spend.
    const recordSpend = async () => {
      const usage = await readUsage(fetchUsage);
      progress.spentUsd = lastUsage === null || usage === null || progress.spentUsd === null
        ? null : (progress.spentUsd ?? 0) + usage - lastUsage;
      lastUsage = usage;
      progress.lastUsage = usage;
      saveProgress();
    };
    for (const [index, batch] of batches.entries()) {
      const report = (message: string) => options.onProgress?.({ batch: index + 1, batches: batches.length, message });
      if (progress.done.includes(batch.batchId)) {
        batchesSkipped++;
        report(`Skipping completed batch ${batch.batchId}`);
        continue;
      }
      const runDir = path.join(root, batch.runId);
      if (fs.existsSync(runDir)) {
        let epoch = Date.now();
        while (fs.existsSync(`${runDir}-abandoned-${epoch}`)) epoch++;
        fs.renameSync(runDir, `${runDir}-abandoned-${epoch}`);
      }
      report(`Running batch ${batch.batchId}`);
      try {
        await evaluateTournament({
          models: batch.candidates, plugin: batch.bench, scenarios: batch.plan.scenarios,
          judgePanel: batch.plan.judgePanel, participantModel: study.participant,
          synthesizerModel: study.synthesizer, runId: batch.runId, outputRoot: root,
          onProgress: event => report(event.message),
        });
      } catch (error) {
        await recordSpend();
        throw error;
      }
      progress.done.push(batch.batchId);
      await recordSpend();
      batchesRun++;
    }
    const runIds = batches.map(batch => batch.runId);
    const rows = collectScores(study, runIds.map(id => path.join(root, id)));
    const analysis = analyzeStudy(rows);
    const previousFile = path.join(studyDir, 'study.json');
    const previous = fs.existsSync(previousFile)
      ? z.object({ meta: MetaSchema }).parse(readJson(previousFile)).meta : undefined;
    writeStudyOutputs(studyDir, study, analysis, rows, {
      runIds, estimateUsd,
      actualUsd: progress.spentUsd ?? null,
      startedAt: progress.startedAt, finishedAt: new Date().toISOString(),
      ...(previous?.headlines ? { headlines: previous.headlines } : {}),
    });
    return { studyDir, analysis, batchesRun, batchesSkipped, cancelled: false };
  } finally {
    if (previousEffort === undefined) delete process.env.TOURNAMENT_REASONING_EFFORT;
    else process.env.TOURNAMENT_REASONING_EFFORT = previousEffort;
  }
}

export async function reanalyzeStudy(studyId: string, resultsRoot = defaultResultsRoot()): Promise<StudyAnalysis> {
  StudySchema.shape.id.parse(studyId);
  const root = path.resolve(resultsRoot);
  const studyDir = path.join(root, 'studies', studyId);
  const outputFile = path.join(studyDir, 'study.json');
  let study: Study;
  let meta: StudyMeta;
  if (fs.existsSync(outputFile)) {
    const output = z.object({ study: StudySchema, meta: MetaSchema }).parse(readJson(outputFile));
    study = parseStudy(output.study);
    meta = output.meta;
  } else {
    const progress = ProgressSchema.parse(readJson(path.join(studyDir, 'progress.json')));
    if (!progress.study && !progress.studyFile) throw new StudyError('Progress has no saved study or study file path.');
    study = parseStudy(progress.study ?? readJson(progress.studyFile!));
    meta = {
      runIds: progress.done.map(batchId => `run-study-${study.id}-${batchId}`),
      estimateUsd: null, actualUsd: null,
      startedAt: progress.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
  }
  if (study.id !== studyId) throw new StudyError('Saved study ID does not match the requested study.');
  const rows = collectScores(study, meta.runIds.map(id => path.join(root, id)));
  const analysis = analyzeStudy(rows);
  writeStudyOutputs(studyDir, study, analysis, rows, meta);
  return analysis;
}
