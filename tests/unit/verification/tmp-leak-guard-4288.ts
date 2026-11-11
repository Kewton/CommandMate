/**
 * The temp directories a #4288 test file leaves behind (pr1af-impl-9). A file lists the prefixes it makes
 * directories with under os.tmpdir(); the directories with those prefixes are counted before its first test
 * and after its last, and the counts must be the same. A row that makes a root of its own and overwrites
 * the shared `root` (the afterEach removes only the last one) shows up here as a count that grew.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { afterAll, beforeAll, expect } from 'vitest';

export const countTmpDirs = (prefixes: readonly string[]): number =>
  fs.readdirSync(os.tmpdir()).filter((n) => prefixes.some((p) => n.startsWith(p))).length;

export function guardTmpDirCount(prefixes: readonly string[]): { before: () => number } {
  let before = -1;
  beforeAll(() => {
    before = countTmpDirs(prefixes);
  });
  afterAll(() => {
    const after = countTmpDirs(prefixes);
    expect({ prefixes, after }, 'the temp directories this file made are all removed').toEqual({ prefixes, after: before });
  });
  return { before: () => before };
}
