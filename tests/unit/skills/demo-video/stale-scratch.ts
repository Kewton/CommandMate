/**
 * Sweeping of `.commandmate-demo-vitest-<pid>` scratch dirs left in $HOME (#3025).
 *
 * `env-scripts.test.ts` has to create its scratch dir under the real $HOME and
 * removes it in `afterAll`. A killed or timed-out run never reaches `afterAll`,
 * so the dir stays behind. The next run collects the ones whose owner is gone.
 */
import fs from 'node:fs';
import path from 'node:path';

const SCRATCH_NAME = /^\.commandmate-demo-vitest-(\d+)$/;

/** The pid encoded in a scratch dir name, or null when the name does not match. */
export function scratchDirPid(name: string): number | null {
  const match = SCRATCH_NAME.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a process with this pid exists (EPERM means it exists but is not ours). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True only for a matching name whose owning pid is no longer running. */
export function isStaleScratchDir(name: string): boolean {
  const pid = scratchDirPid(name);
  return pid !== null && !isPidAlive(pid);
}

/** Remove stale scratch dirs directly under `home`; returns the names removed. */
export function sweepStaleScratchDirs(home: string): string[] {
  const removed: string[] = [];
  for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isStaleScratchDir(entry.name)) continue;
    fs.rmSync(path.join(home, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
