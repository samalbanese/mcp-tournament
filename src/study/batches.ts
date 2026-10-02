import { getPlugin } from '../plugins/index.js';
import { normalizeRunPlan, PLAN_LIMITS, type RunPlanInput } from '../run-plan.js';
import { StudyError, type Study } from './schema.js';

export interface StudyBatch {
  batchId: string;
  runId: string;
  bench: string;
  candidates: string[];
  plan: RunPlanInput;
}

export function validateStudyAgainstBenches(study: Study): void {
  const seen = new Set<string>();
  study.benches.forEach((bench, index) => {
    let plugin;
    try {
      plugin = getPlugin(bench.bench);
    } catch (error) {
      throw new StudyError(`benches.${index}.bench: ${error instanceof Error ? error.message : String(error)}`);
    }
    const available = new Set(plugin.scenarios.map(scenario => scenario.id));
    bench.scenarios.forEach((scenario, scenarioIndex) => {
      const field = `benches.${index}.scenarios.${scenarioIndex}`;
      if (!available.has(scenario)) {
        throw new StudyError(`${field}: bench "${bench.bench}" has no scenario "${scenario}"`);
      }
      const key = JSON.stringify([bench.bench, scenario]);
      if (seen.has(key)) {
        throw new StudyError(`${field}: duplicate scenario "${scenario}" in bench "${bench.bench}"`);
      }
      seen.add(key);
    });
  });
}

export function planBatches(study: Study): StudyBatch[] {
  validateStudyAgainstBenches(study);
  const chunkCount = Math.ceil(study.candidates.length / PLAN_LIMITS.candidates[1]);
  const chunkSize = Math.floor(study.candidates.length / chunkCount);
  const remainder = study.candidates.length % chunkCount;
  return study.benches.flatMap((bench, benchIndex) => {
    let offset = 0;
    return Array.from({ length: chunkCount }, (_, chunkIndex) => {
      const size = chunkSize + (chunkIndex < remainder ? 1 : 0);
      const candidates = study.candidates.slice(offset, offset + size).map(candidate => candidate.ref);
      offset += size;
      const batchId = `${benchIndex + 1}-${chunkIndex + 1}`;
      const plan: RunPlanInput = {
        bench: bench.bench,
        scenarios: [...bench.scenarios],
        candidates: [...candidates],
        judgePanel: study.judges.map(judge => ({
          model: judge.ref,
          customPersona: { name: `${judge.family} judge`, lens: study.judgeLens },
        })),
        participant: study.participant,
        synthesizer: study.synthesizer,
      };
      try {
        normalizeRunPlan(plan);
      } catch (error) {
        throw new StudyError(`batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { batchId, runId: `run-study-${study.id}-${batchId}`, bench: bench.bench, candidates, plan };
    });
  });
}
