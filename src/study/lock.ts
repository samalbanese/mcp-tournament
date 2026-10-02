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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Claims a study folder for one run, repair or reanalysis at a time, so two processes never write
 * the same batches, failure lists, spend totals or reports. A lock left by a process that has
 * exited is replaced. Returns a function that releases the lock; it only removes this call's lock.
 *
 * Every claim happens inside a short exclusive guard (`.lock.guard`), so checking the lock and
 * creating or replacing it is one step that no other process can interleave with. Releasing needs
 * no guard: it removes only this call's own token, which no other process may replace while this
 * process is alive.
 */
export function acquireStudyLock(studyDir: string): () => void {
  const file = path.join(studyDir, LOCK_FILE);
  const guard = `${file}.guard`;
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
  const release = () => {
    if (readLock(file)?.token === token) fs.rmSync(file, { force: true });
  };
  // The guard is held for a few file operations, so a short wait covers two commands started together.
  let guarded = createExclusive(guard, String(process.pid));
  for (let waited = 0; !guarded && waited < 2_000; waited += 25) {
    sleepSync(25);
    guarded = createExclusive(guard, String(process.pid));
  }
  if (!guarded) {
    throw new StudyError(`Another process is claiming this study. Try again in a moment; if no run is active, delete ${guard}.`);
  }
  let claimed = false;
  try {
    if (!createExclusive(file, contents)) {
      // Only guard holders write the lock, so an unreadable one was left by a crash mid-write.
      const holder = readLock(file);
      if (holder && isAlive(holder.pid)) {
        throw new StudyError(`Another run or repair of this study is in progress (process ${holder.pid}). Wait for it to finish.`);
      }
      fs.rmSync(file, { force: true });
      if (!createExclusive(file, contents)) throw new StudyError(`Could not claim the study folder: ${file} reappeared.`);
    }
    claimed = true;
  } finally {
    try {
      fs.rmSync(guard, { force: true });
    } catch (error) {
      // A guard that cannot be removed must not also leave this process holding the study.
      if (claimed) release();
      throw error;
    }
  }
  return release;
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
