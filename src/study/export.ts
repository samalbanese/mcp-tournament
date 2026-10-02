import fs from 'node:fs';
import path from 'node:path';
import type { ScoreRow, StudyAnalysis } from './analyze.js';
import type { Study } from './schema.js';

export interface StudyMeta {
  runIds: string[];
  estimateUsd: number | null;
  actualUsd: number | null;
  startedAt: string;
  finishedAt: string;
  headlines?: Array<{ title: string; body: string }>;
}

const columns: Array<keyof ScoreRow> = [
  'runId', 'bench', 'benchLabel', 'scenarioId', 'scenarioName',
  'candidateRef', 'candidateFamily', 'candidateLabel', 'judgeRole', 'judgeRef', 'judgeFamily', 'criterion', 'score',
];

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Writes through a temporary file and a rename, so a reader or a crash never sees half a file. */
export function writeFileAtomic(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

export function writeStudyOutputs(
  studyDir: string, study: Study, analysis: StudyAnalysis, rows: ScoreRow[], meta: StudyMeta,
): void {
  fs.mkdirSync(studyDir, { recursive: true });
  writeFileAtomic(path.join(studyDir, 'study.json'), `${JSON.stringify({ study, meta, analysis }, null, 2)}\n`);
  const records = [columns.join(','), ...rows.map(row => columns.map(key => csvField(row[key])).join(','))];
  writeFileAtomic(path.join(studyDir, 'scores.csv'), `${records.join('\r\n')}\r\n`);
}
