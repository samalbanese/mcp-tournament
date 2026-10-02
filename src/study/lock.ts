import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StudyError } from './schema.js';

const LOCK_FILE = '.lock';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): { pid: number; token: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value?.pid === 'number' && typeof value?.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Claims a study folder for one run or repair at a time, so two processes never write the same
 * batches, failure lists or spend totals. A lock left by a process that has exited is replaced.
 * Returns a function that releases the lock; it only removes a lock this call created.
 */
export function acquireStudyLock(studyDir: string): () => void {
  const file = path.join(studyDir, LOCK_FILE);
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, contents, { flag: 'wx' });
      return () => {
        if (readLock(file)?.token === token) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readLock(file);
    if (holder && isAlive(holder.pid)) {
      throw new StudyError(`Another run or repair of this study is in progress (process ${holder.pid}). Wait for it to finish.`);
    }
    // An unreadable lock may be one another process is still writing; only an old one is abandoned.
    if (!holder && Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 10_000) {
      throw new StudyError('Another run or repair of this study is starting. Wait for it to finish.');
    }
    // Stale or unreadable: re-check right before removing, so a lock another process just took is kept.
    if (readLock(file)?.token === holder?.token) fs.rmSync(file, { force: true });
  }
  throw new StudyError(`Could not claim the study folder: ${file} keeps reappearing.`);
}

/** The current contents of these files (`null` for a missing one), to check later with assertUnchanged. */
export function snapshotFiles(files: string[]): Array<string | null> {
  return files.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
}

/** Refuses to go on when any of these files changed after the snapshot the plan was built from. */
export function assertUnchanged(files: string[], before: Array<string | null>): void {
  if (snapshotFiles(files).some((now, index) => now !== before[index])) {
    throw new StudyError('Another run or repair changed this study while waiting for confirmation. Run the command again to see the current state.');
  }
}
