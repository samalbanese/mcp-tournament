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
/** Creates the file only if it does not exist yet; false when it already does. */
function createExclusive(file: string, contents: string): boolean {
  try {
    fs.writeFileSync(file, contents, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Throws unless the lock is gone or was left by a process that has exited. */
function assertAbandoned(file: string): void {
  if (!fs.existsSync(file)) return;
  const holder = readLock(file);
  if (holder && isAlive(holder.pid)) {
    throw new StudyError(`Another run or repair of this study is in progress (process ${holder.pid}). Wait for it to finish.`);
  }
  // An unreadable lock may be one another process is still writing; only an old one is abandoned.
  if (!holder && Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 10_000) {
    throw new StudyError('Another run or repair of this study is starting. Wait for it to finish.');
  }
}

export function acquireStudyLock(studyDir: string): () => void {
  const file = path.join(studyDir, LOCK_FILE);
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  const release = () => {
    if (readLock(file)?.token === token) fs.rmSync(file, { force: true });
  };
  if (createExclusive(file, contents)) return release;
  assertAbandoned(file);
  // Replacing an abandoned lock is exclusive too: only the process that creates the takeover file
  // may remove it, so two processes recovering at once can never both end up holding the study.
  const takeover = `${file}.takeover`;
  if (!createExclusive(takeover, String(process.pid))) {
    throw new StudyError(`Another process is taking over this study. Wait a moment and try again; if no run is active, delete ${takeover}.`);
  }
  try {
    // Re-check: the lock may have been replaced by a live run before this process got the takeover file.
    assertAbandoned(file);
    fs.rmSync(file, { force: true });
    if (!createExclusive(file, contents)) {
      throw new StudyError('Another run or repair of this study is starting. Wait for it to finish.');
    }
    return release;
  } finally {
    fs.rmSync(takeover, { force: true });
  }
}

/** The current contents of these files (`null` for a missing one), to check later with assertUnchanged. */
function snapshotFiles(files: string[]): Array<string | null> {
  return files.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
}

/** Refuses to go on when any of these files changed after the snapshot the plan was built from. */
export function assertUnchanged(files: string[], before: Array<string | null>): void {
  if (snapshotFiles(files).some((now, index) => now !== before[index])) {
    throw new StudyError('Another run or repair changed this study while waiting for confirmation. Run the command again to see the current state.');
  }
}
