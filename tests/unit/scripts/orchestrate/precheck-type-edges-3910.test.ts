/**
 * scripts/orchestrate/precheck.mjs — estimateRelatedTests keeps every edge of a
 * file that does not parse, and drops type-position imports (Issue #3910).
 * The trees are under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEAVY_TEST_FILES, estimateRelatedTests, planSteps } from '../../../../scripts/orchestrate/precheck.mjs';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-precheck-3910-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string) {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const heavy = (count: number) => planSteps({ changed: ['src/lib/types.ts'], deleted: [] }, { base: 'origin/develop', relatedTests: count }).related.heavy;

/** HEAVY_TEST_FILES tests, each reading `src/lib/m<i % modules.length>`. */
function readers(modules: string[]) {
  for (let i = 0; i < HEAVY_TEST_FILES; i++) {
    write(`tests/unit/many/t${i}.test.ts`, `import { m } from '@/lib/${modules[i % modules.length]}';\n`);
  }
}

describe('a file that does not parse keeps every reference (item 3)', () => {
  it('counts the type import of a file with a syntax error, so the estimate is not too small', () => {
    write('src/lib/types.ts', 'export interface T { a: number }\n');
    write('src/lib/broken.ts', "import type { T } from './types';\nexport const m = (: T;\n");
    readers(['broken']);
    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    expect(count).toBe(HEAVY_TEST_FILES);
    expect(heavy(count)).toBe(true);
  });

  it('negative control: the same file without the syntax error is not an edge', () => {
    write('src/lib/types.ts', 'export interface T { a: number }\n');
    write('src/lib/ok.ts', "import type { T } from './types';\nexport const m = (t: T) => t;\n");
    readers(['ok']);
    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    expect(count).toBe(0);
    expect(heavy(count)).toBe(false);
  });
});

describe('type-position imports are not runtime edges (item 4)', () => {
  it('does not become heavy for readers that only import in type positions', () => {
    write('src/lib/types.ts', 'export interface T { a: number }\nexport const KIND = 1;\n');
    write('src/lib/a.ts', "export const a = (t: import('./types').T) => t;\n");
    write('src/lib/b.ts', "export type K = typeof import('./types');\nexport const b = 1;\n");
    write('src/lib/c.ts', "import type X = require('./types');\nexport const c = 1;\n");
    readers(['a', 'b', 'c']);
    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    expect(count).toBe(0);
    expect(heavy(count)).toBe(false);
  });

  it('stays heavy for runtime readers, with type-position imports beside them', () => {
    write('src/lib/types.ts', 'export interface T { a: number }\nexport const KIND = 1;\n');
    write('src/lib/r1.ts', "import { KIND } from './types';\nexport const r = (t: import('./types').T) => KIND;\n");
    write('src/lib/r2.ts', "export const load = () => import('./types');\nexport type K = typeof import('./types');\n");
    write('src/lib/r3.ts', "import K = require('./types');\nexport const r = K;\n");
    readers(['r1', 'r2', 'r3']);
    const count = estimateRelatedTests(tmp, ['src/lib/types.ts']);
    expect(count).toBe(HEAVY_TEST_FILES);
    expect(heavy(count)).toBe(true);
  });
});
