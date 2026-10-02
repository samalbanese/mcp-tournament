import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importRun } from './run-import-lib.mjs';
import { mergeStudyIndex, validateStudyImport } from './study-import-lib.mjs';

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(guiDir, '..');
const dataDir = path.join(guiDir, 'public', 'data');
const studyId = process.argv[2];
if (!studyId || process.argv.length !== 3) {
  console.error('Usage: node scripts/import-study.mjs <studyId>');
  process.exit(1);
}

try {
  if (!/^[a-z0-9-]{3,40}$/.test(studyId)) throw new Error('Invalid study id.');
  const source = path.join(repoDir, 'results', 'studies', studyId);
  const document = JSON.parse(await readFile(path.join(source, 'study.json'), 'utf8'));
  const runIds = validateStudyImport(studyId, document);
  await access(path.join(source, 'scores.csv'));
  // Check all batch identities before invoking the existing run importer.
  for (const runId of runIds) {
    const manifest = JSON.parse(await readFile(path.join(repoDir, 'results', runId, 'run.json'), 'utf8'));
    if (manifest.runId !== runId) throw new Error(`Run identity does not match ${runId}.`);
  }
  const indexFile = path.join(dataDir, 'index.json');
  let index = { runs: [] };
  try { index = JSON.parse(await readFile(indexFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    for (const runId of runIds) await importRun(runId);
  } finally {
    // The legacy importer writes a run-only index. Preserve study metadata even after a partial import.
    if (runIds.length) {
      const latest = JSON.parse(await readFile(indexFile, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return JSON.stringify(index);
      }));
      index = { ...index, runs: latest.runs };
      await mkdir(dataDir, { recursive: true });
      await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
    }
  }
  const target = path.join(dataDir, 'studies', studyId);
  await mkdir(target, { recursive: true });
  for (const file of ['study.json', 'scores.csv']) await copyFile(path.join(source, file), path.join(target, file));
  await writeFile(indexFile, `${JSON.stringify(mergeStudyIndex(index, studyId), null, 2)}\n`);
  console.log(`Imported study ${studyId} into ${path.relative(repoDir, target)}`);
} catch (error) {
  console.error(`Study import failed: ${error.message}`);
  process.exitCode = 1;
}
