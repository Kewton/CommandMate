/**
 * The temp directories a #4288 test file leaves behind (pr1af-impl-9; impl-10 A11: by the paths it made,
 * not by a count). A file lists the prefixes it makes directories with directly under os.tmpdir(); from its
 * first test to its last, every `fs.mkdtempSync` of the process under one of those prefixes is remembered,
 * and after its last test each remembered directory must be gone. Another run with the same prefix at the
 * same time (another worktree, a precheck beside it) neither moves nor hides the answer, as a count did. A
 * row that makes a root of its own and overwrites the shared `root` (the afterEach removes only the last one)
 * shows up as a remembered path that is still there.
 */
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll, beforeAll, expect } from 'vitest';

type MkdtempSync = typeof fsDefault.mkdtempSync;

const realTmp = (): string[] => {
  const t = os.tmpdir();
  try {
    return [t, fs.realpathSync(t)];
  } catch {
    return [t];
  }
};

/**
 * Remember the directories made by `fs.mkdtempSync` directly under os.tmpdir() with one of `prefixes`
 * (every import form of node:fs sees the wrapper: the module's exports are synced). `stop()` puts the real
 * function back; `left()` lists the remembered directories that still exist.
 */
export function trackTmpDirs(prefixes: readonly string[]): { stop: () => void; made: () => string[]; left: () => string[] } {
  const made: string[] = [];
  const original: MkdtempSync = fsDefault.mkdtempSync;
  const tmps = realTmp();
  const wrapped = function (this: unknown, prefix: string, ...rest: unknown[]): string {
    const out = (original as (p: string, ...r: unknown[]) => string).call(fsDefault, prefix, ...rest);
    const dir = path.dirname(String(prefix));
    if (tmps.includes(dir) && prefixes.some((p) => path.basename(String(out)).startsWith(p))) made.push(String(out));
    return out;
  } as unknown as MkdtempSync;
  fsDefault.mkdtempSync = wrapped;
  syncBuiltinESMExports();
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (fsDefault.mkdtempSync === wrapped) fsDefault.mkdtempSync = original;
      syncBuiltinESMExports();
    },
    made: () => [...made],
    left: () => made.filter((d) => fs.existsSync(d)),
  };
}

/** The guard of a test file (the name of impl-9 kept: every #4288 file calls it). */
export function guardTmpDirCount(prefixes: readonly string[]): { made: () => string[] } {
  let tracker: ReturnType<typeof trackTmpDirs> | null = null;
  beforeAll(() => {
    tracker = trackTmpDirs(prefixes);
  });
  afterAll(() => {
    const t = tracker;
    if (!t) return;
    t.stop();
    expect({ prefixes, left: t.left() }, 'the temp directories this file made are all removed').toEqual({ prefixes, left: [] });
  });
  return { made: () => tracker?.made() ?? [] };
}
