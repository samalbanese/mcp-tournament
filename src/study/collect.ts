import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseModelRef } from '../config/model-ref.js';
import { modelSlug, scenarioSlug } from '../plugins/base.js';
import type { ScoreRow } from './analyze.js';
import { StudyError, type Study } from './schema.js';

const ManifestSchema = z.object({
  runId: z.string().regex(/^run-[a-zA-Z0-9-]+$/),
  plugin: z.string(),
  candidates: z.array(z.object({ id: z.string() })),
  scenarios: z.array(z.object({ id: z.string(), name: z.string() })),
  judges: z.array(z.object({
    role: z.string(), model: z.string(), route: z.enum(['anthropic', 'openrouter']).optional(),
  })).optional(),
});
const ScoresSchema = z.object({
  scores: z.record(z.string(), z.object({ score: z.number().finite().min(0).max(10) })),
});

export function collectScores(study: Study, runDirs: string[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const runDir of runDirs) {
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')));
    if (manifest.runId !== path.basename(runDir)) throw new StudyError(`Run ID mismatch in ${runDir}`);
    if (manifest.judges) {
      if (manifest.judges.length !== study.judges.length) {
        throw new StudyError(`Judge count mismatch in ${manifest.runId}`);
      }
      study.judges.forEach((judge, index) => {
        const seat = manifest.judges![index];
        const expected = parseModelRef(judge.ref);
        if (seat.role !== `custom_${index + 1}` || seat.model !== expected.model
          || (seat.route !== undefined && seat.route !== expected.route)) {
          throw new StudyError(`Judge seat ${index + 1} mismatch in ${manifest.runId}`);
        }
      });
    }
    for (const candidate of manifest.candidates) {
      const source = study.candidates.find(item => parseModelRef(item.ref).ref === candidate.id);
      if (!source) throw new StudyError(`Unknown candidate "${candidate.id}" in ${manifest.runId}`);
      for (const scenario of manifest.scenarios) {
        const bench = study.benches.find(item => item.bench === manifest.plugin && item.scenarios.includes(scenario.id));
        if (!bench) throw new StudyError(`Unknown bench/scenario "${manifest.plugin}/${scenario.id}" in ${manifest.runId}`);
        for (const [index, judge] of study.judges.entries()) {
          // Batch judgePanel order fixes the seat, even when the manifest has no judges list.
          const judgeRole = `custom_${index + 1}`;
          const file = path.join(runDir, 'judges', modelSlug(candidate.id), scenarioSlug(scenario), `${judgeRole}.json`);
          if (!fs.existsSync(file)) continue;
          const result = ScoresSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
          for (const [criterion, value] of Object.entries(result.scores)) {
            rows.push({
              runId: manifest.runId, bench: bench.bench, benchLabel: bench.label,
              scenarioId: scenario.id, scenarioName: scenario.name,
              candidateRef: source.ref, candidateFamily: source.family, candidateLabel: source.label,
              judgeRole, judgeRef: judge.ref, judgeFamily: judge.family, criterion, score: value.score,
            });
          }
        }
      }
    }
  }
  return rows;
}
