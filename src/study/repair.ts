import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runJudge, type JudgeResult } from '../agents/judge-agent.js';
import { runSynthesis } from '../agents/synthesizer.js';
import type { JudgeConfig } from '../config/judges.js';
import type { CandidateModel } from '../config/models.js';
import { buildLeaderboard } from '../phases/aggregator.js';
import { runScenario } from '../phases/executor.js';
import { evaluateWithJudges } from '../phases/judge-runner.js';
import { assertRoutesReady, defaultResultsRoot } from '../pipeline.js';
import { modelSlug, scenarioSlug, type TestCase, type Turn } from '../plugins/base.js';
import { effectiveScenario, normalizeRunPlan, type ResolvedRunPlan } from '../run-plan.js';
import { JudgeScoreSchema } from '../schemas/judge-score.js';
import type { StudyAnalysis } from './analyze.js';
import { planBatches, validateStudyAgainstBenches } from './batches.js';
import { acquireStudyLock, assertUnchanged, snapshotFiles } from './lock.js';
import { defaultFetchUsage, ProgressSchema, readUsage, reanalyzeStudy } from './runner.js';
import { parseStudy, StudyError, type Study } from './schema.js';

export interface RepairStudyOptions {
  resultsRoot?: string;
  /** Shown the repair summary; return false to stop before any model call or file change. */
  confirm: (summary: string) => Promise<boolean>;
  onProgress?: (message: string) => void;
  fetchUsage?: () => Promise<number | null>;
}
export interface RepairGap { runId: string; model: string; scenario: string; error: string }
export interface RepairOutcome {
  studyDir: string;
  answersRerun: number;
  judgeSeatsFilled: number;
  remaining: RepairGap[];
  cancelled: boolean;
  analysis: StudyAnalysis | null;
}

const FailuresSchema = z.array(z.object({ model: z.string(), scenario: z.string(), error: z.string() }));
interface AnswerGaps {
  candidate: CandidateModel;
  scenario: TestCase;
  pair: boolean;
  /** Only the synthesis needs refreshing; the answer and its judge seats are fine. */
  synthesis: boolean;
  judges: JudgeConfig[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerDirs(runDir: string, plan: ResolvedRunPlan, candidate: CandidateModel, scenario: TestCase) {
  const scenarioCase = effectiveScenario(scenario, plan.turns);
  return {
    scenarioCase,
    candidateDir: path.join(runDir, 'candidates', modelSlug(candidate.id), scenarioSlug(scenarioCase)),
    judgeDir: path.join(runDir, 'judges', modelSlug(candidate.id), scenarioSlug(scenarioCase)),
  };
}

/** A saved, valid score for this judge seat, or null when the seat is empty. */
function savedScore(judgeDir: string, judge: JudgeConfig): JudgeResult | null {
  const file = path.join(judgeDir, `${judge.role}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JudgeScoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      judgeName: judge.name, judgeRole: judge.role, judgeModel: judge.model, judgeFamily: judge.family,
      raw, parsed: parsed.data, parseSuccess: true,
      metrics: { inputTokens: 0, outputTokens: 0, timeMs: 0 },
    };
  } catch {
    return null;
  }
}

function savedJudges(judgeDir: string, plan: ResolvedRunPlan): JudgeResult[] {
  return plan.judges.flatMap(judge => savedScore(judgeDir, judge) ?? []);
}

export async function repairStudy(input: Study, options: RepairStudyOptions): Promise<RepairOutcome> {
  const study = parseStudy(input);
  validateStudyAgainstBenches(study);
  const batches = planBatches(study);
  const plans = batches.map(batch => normalizeRunPlan(batch.plan));
  for (const plan of plans) assertRoutesReady(plan);

  const root = path.resolve(options.resultsRoot ?? defaultResultsRoot());
  const studyDir = path.join(root, 'studies', study.id);
  const progressFile = path.join(studyDir, 'progress.json');
  if (!fs.existsSync(progressFile)) throw new StudyError('No progress for this study');
  const progress = ProgressSchema.parse(JSON.parse(fs.readFileSync(progressFile, 'utf8')));
  if (progress.study && JSON.stringify(progress.study) !== JSON.stringify(study)) {
    throw new StudyError('The saved study differs from this input. Use a new study ID for a changed study.');
  }
  if (progress.done.some(id => !batches.some(batch => batch.batchId === id))) {
    throw new StudyError('Progress contains a batch that is not in this study.');
  }

  const work = batches.flatMap((batch, index) => {
    if (!progress.done.includes(batch.batchId)) return [];
    const plan = plans[index];
    const runDir = path.join(root, batch.runId);
    const file = path.join(runDir, 'failures.json');
    const failures = fs.existsSync(file)
      ? FailuresSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
    const groups = new Map<string, AnswerGaps>();
    const unmatched: RepairGap[] = [];
    for (const entry of failures) {
      const candidate = plan.candidates.find(candidate => candidate.id === entry.model);
      const scenario = plan.scenarios.find(scenario => scenario.id === entry.scenario);
      if (!candidate || !scenario) {
        unmatched.push({ runId: batch.runId, ...entry });
        continue;
      }
      const key = JSON.stringify([entry.model, entry.scenario]);
      let group = groups.get(key);
      if (!group) {
        group = { candidate, scenario, pair: false, synthesis: false, judges: [] };
        groups.set(key, group);
      }
      // A synthesis gap is only ever written by a previous repair; rerunning the answer would be wasteful.
      if (entry.error.startsWith('synthesis: ')) {
        group.synthesis = true;
        continue;
      }
      const judge = plan.judges.find(judge => entry.error.startsWith(`judge ${judge.name}: `));
      if (!judge) group.pair = true;
      else if (!group.judges.includes(judge)) group.judges.push(judge);
    }
    // Trust the files over the failure list: an answer that was saved but failed in judging
    // (or a seat filled by a repair that was then interrupted) must not be paid for twice.
    for (const group of groups.values()) {
      const { candidateDir, judgeDir } = answerDirs(runDir, plan, group.candidate, group.scenario);
      if (group.pair && fs.existsSync(path.join(candidateDir, 'turns.json'))
        && !fs.existsSync(path.join(candidateDir, 'error.json'))) {
        group.pair = false;
        group.judges = [...plan.judges];
        group.synthesis = true;
      }
      if (group.pair) continue;
      const open = group.judges.filter(judge => !savedScore(judgeDir, judge));
      if (open.length < group.judges.length) group.synthesis = true;
      group.judges = open;
    }
    const answers = [...groups.values()];
    return [{ batch, plan, runDir, file, failures, unmatched, answers,
      pairs: answers.filter(answer => answer.pair).length,
      seats: answers.reduce((sum, answer) => sum + (answer.pair ? 0 : answer.judges.length), 0),
    }];
  });
  const outcome: RepairOutcome = {
    studyDir, answersRerun: 0, judgeSeatsFilled: 0,
    remaining: work.flatMap(item => item.unmatched), cancelled: false, analysis: null,
  };
  // Everything the gap list was built from, checked again once this repair holds the study lock.
  const inputs = [progressFile, ...work.map(item => item.file)];
  const inputsBefore = snapshotFiles(inputs);
  const pending = work.filter(item => item.answers.length);
  const interrupted = progress.repairing === true;
  if (!pending.length && !interrupted) return outcome;
  const summary = [
    ...(interrupted ? ['A previous repair stopped early; this one finishes it and refreshes the report.'] : []),
    `Repair "${study.title}": ${pending.reduce((sum, item) => sum + item.pairs, 0)} answer(s) to rerun and ${pending.reduce((sum, item) => sum + item.seats, 0)} judge seat(s) to fill across ${pending.length} batch(es). Only these pieces are re-run; nothing that succeeded is touched.`,
    ...pending.map(item => `${item.batch.batchId}: ${item.pairs} answer(s), ${item.seats} judge seat(s)`),
  ].join('\n');
  if (!await options.confirm(summary)) {
    return { ...outcome, cancelled: true,
      remaining: work.flatMap(item => item.failures.map(gap => ({ runId: item.batch.runId, ...gap }))),
    };
  }

  const previousEffort = process.env.TOURNAMENT_REASONING_EFFORT;
  const report = (text: string) => options.onProgress?.(text);
  const release = acquireStudyLock(studyDir);
  try {
    // The gap list above came from files another run or repair may have changed during the prompt.
    assertUnchanged(inputs, inputsBefore);
    if (study.reasoningEffort) process.env.TOURNAMENT_REASONING_EFFORT = study.reasoningEffort;
    const fetchUsage = options.fetchUsage ?? defaultFetchUsage;
    const saveProgress = () => {
      fs.writeFileSync(`${progressFile}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
      fs.renameSync(`${progressFile}.tmp`, progressFile);
    };
    // Same rule as runStudy: spend since the last saved reading belongs to this study, so an
    // interrupted repair's calls are still counted. An unknown reading makes the total unknown.
    const addSpend = (usage: number | null, since: number | null | undefined) => {
      progress.spentUsd = usage === null || since === null || progress.spentUsd === null
        ? null : (progress.spentUsd ?? 0) + (since === undefined ? 0 : usage - since);
      progress.lastUsage = usage;
    };
    let lastUsage = await readUsage(fetchUsage);
    // A run or repair that stopped early never recorded its last calls; count them, as a resume would.
    // After a clean finish, usage since then is other activity on the key and is left out.
    const unsettled = interrupted || batches.some(batch => !progress.done.includes(batch.batchId));
    if (unsettled) addSpend(lastUsage, progress.lastUsage);
    else progress.lastUsage = lastUsage;
    progress.repairing = true;
    saveProgress();
    for (const item of pending) {
      const { batch, plan, runDir } = item;
      const useSynthesizer = !plan.quick && plan.judges.length >= 2;
      report(`Repairing batch ${batch.batchId}`);
      const repaired: RepairGap[][] = new Array(item.answers.length);
      const repairAnswer = async (answer: AnswerGaps): Promise<RepairGap[]> => {
        const { candidate, scenario } = answer;
        const { scenarioCase, candidateDir, judgeDir } = answerDirs(runDir, plan, candidate, scenario);
        const gaps: RepairGap[] = [];
        const gap = (error: string) => gaps.push({ runId: batch.runId, model: candidate.id, scenario: scenario.id, error });
        const label = `${batch.batchId} ${candidate.id} ${scenario.id}`;
        if (answer.pair) {
          report(`Starting answer ${label}`);
          try {
            // Scores left from an earlier attempt belong to a different answer; never mix them in.
            fs.rmSync(judgeDir, { recursive: true, force: true });
            const execution = await runScenario(candidate, scenarioCase, plan.plugin, runDir, {
              participant: { route: plan.participant.route, model: plan.participant.model },
            });
            if (!execution.success) throw new Error(execution.error ?? 'Scenario execution failed');
            fs.rmSync(path.join(candidateDir, 'error.json'), { force: true });
            const result = await evaluateWithJudges(plan.plugin, scenarioCase, execution.turns, candidate.id,
              runDir, plan.judges, useSynthesizer, plan.synthesizer.model, plan.synthesizer.route);
            result.failedJudges.forEach(failure => gap(`judge ${failure.judge}: ${failure.error}`));
            outcome.answersRerun++;
          } catch (error) {
            gap(message(error));
          }
          report(`Finished answer ${label}: ${gaps.length ? `${gaps.length} gap(s) remain` : 'repaired'}`);
          return gaps;
        }

        let filled = false;
        for (const judge of answer.judges) {
          report(`Starting judge ${judge.name} for ${label}`);
          let succeeded = false;
          try {
            const turns = JSON.parse(fs.readFileSync(path.join(candidateDir, 'turns.json'), 'utf8')) as Turn[];
            const result = await runJudge(judge, plan.plugin, scenarioCase, turns);
            fs.mkdirSync(judgeDir, { recursive: true });
            if (!result.parsed) {
              fs.writeFileSync(path.join(judgeDir, `${judge.role}.failed.txt`), result.raw);
              throw new Error(`${judge.name} returned invalid score JSON`);
            }
            fs.writeFileSync(path.join(judgeDir, `${judge.role}.json`), JSON.stringify(result.parsed, null, 2));
            fs.rmSync(path.join(judgeDir, `${judge.role}.failed.txt`), { force: true });
            outcome.judgeSeatsFilled++;
            filled = true;
            succeeded = true;
          } catch (error) {
            gap(`judge ${judge.name}: ${message(error)}`);
          }
          report(`Finished judge ${judge.name} for ${label}: ${succeeded ? 'filled' : 'still missing'}`);
        }
        if ((filled || answer.synthesis) && useSynthesizer) {
          try {
            const result = await runSynthesis(scenarioCase, savedJudges(judgeDir, plan),
              plan.synthesizer.model, plan.synthesizer.route);
            if (!result.synthesis) throw new Error(result.raw);
            fs.writeFileSync(path.join(judgeDir, 'synthesis.json'), JSON.stringify(result.synthesis, null, 2));
          } catch (error) {
            gap(`synthesis: ${message(error)}`);
          }
        }
        return gaps;
      };
      let next = 0;
      const workers = await Promise.allSettled(Array.from({ length: Math.min(4, item.answers.length) }, async () => {
        while (next < item.answers.length) {
          const index = next++;
          repaired[index] = await repairAnswer(item.answers[index]);
        }
      }));
      const failed = workers.find(worker => worker.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const remaining = [...item.unmatched, ...repaired.flat()];
      if (remaining.length) {
        fs.writeFileSync(item.file, JSON.stringify(remaining.map(({ model, scenario, error }) => ({ model, scenario, error })), null, 2));
      } else fs.rmSync(item.file, { force: true });
      buildLeaderboard(runDir, plan.candidates, plan.scenarios);
      outcome.remaining.push(...repaired.flat());
      const usage = await readUsage(fetchUsage);
      addSpend(usage, lastUsage);
      lastUsage = usage;
      saveProgress();
      report(`Finished batch ${batch.batchId}: ${remaining.length} gap(s) remain`);
    }
    // An interrupted repair may have stopped between clearing a batch's gaps and rebuilding its leaderboard.
    if (interrupted) for (const item of work) buildLeaderboard(item.runDir, item.plan.candidates, item.plan.scenarios);
    const outputFile = path.join(studyDir, 'study.json');
    if (fs.existsSync(outputFile)) {
      const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      output.meta.actualUsd = progress.spentUsd ?? null;
      fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    }
    outcome.analysis = await reanalyzeStudy(study.id, root);
    delete progress.repairing;
    saveProgress();
    return outcome;
  } finally {
    release();
    if (previousEffort === undefined) delete process.env.TOURNAMENT_REASONING_EFFORT;
    else process.env.TOURNAMENT_REASONING_EFFORT = previousEffort;
  }
}
