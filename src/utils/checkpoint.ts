// checkpoint.ts — Save and restore tournament progress for resume support.

import fs from 'node:fs';
import path from 'node:path';
import { modelSlug } from '../plugins/base.js';

export interface Checkpoint {
  completedScenarios: Record<string, boolean>;
}

export function loadCheckpoint(outputDir: string): Checkpoint {
  const cpPath = path.join(outputDir, 'checkpoint.json');
  if (!fs.existsSync(cpPath)) return { completedScenarios: {} };
  return JSON.parse(fs.readFileSync(cpPath, 'utf-8')) as Checkpoint;
}

export function saveCheckpoint(outputDir: string, checkpoint: Checkpoint): void {
  fs.writeFileSync(path.join(outputDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
}

export function isScenarioComplete(
  checkpoint: Checkpoint,
  modelId: string,
  scenarioId: string,
): boolean {
  return checkpoint.completedScenarios[`${modelSlug(modelId)}:${scenarioId}`] === true;
}

export function markScenarioComplete(
  checkpoint: Checkpoint,
  modelId: string,
  scenarioId: string,
): void {
  checkpoint.completedScenarios[`${modelSlug(modelId)}:${scenarioId}`] = true;
}
