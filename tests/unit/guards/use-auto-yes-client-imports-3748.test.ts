/**
 * `src/hooks/useAutoYes.ts` reaches no server-only module (Issue #3748).
 *
 * ## What happened
 *
 * `useAutoYes` runs in the client bundle (`worktrees/[id]/page.tsx` →
 * `WorktreeDetailRefactored` → `useWorktreeDetailController` → `useAutoYes`).
 * #3748 had it import the server's confirm-page predicate, which reaches
 * `detection/tools/frame` → `cli-patterns` → `logger` → `env` →
 * `db/db-path-resolver` → `fs`. Every unit test, lint and tsc passed; `next
 * build` failed with `Module not found: Can't resolve 'fs'`, and the local
 * verify gates do not run the build.
 *
 * ## The rule
 *
 * The files `useAutoYes.ts` reaches through value imports (relative and `@/`,
 * `import … from`, `export … from`, `import(…)`, `require(…)`; `import type`
 * is erased and not followed) include none of `src/lib/logger.ts`,
 * `src/lib/env.ts`, `src/lib/db/**`, and none of them names `fs` / `node:fs`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

/** Value imports; `import type` / `export type` lines are skipped by the caller. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s/;

function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null; // a package: not ours to walk
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Each file statement whose specifier is spelled on one line or across a multi-line `{ … }`. */
function valueSpecifiers(source: string): string[] {
  const out: string[] = [];
  // Join a multi-line import onto one line so TYPE_ONLY sees its head.
  const statements = source.split(/;\s*\n|\n(?=\s*(?:import|export)\b)/);
  for (const statement of statements) {
    if (TYPE_ONLY.test(statement)) continue;
    for (const match of statement.matchAll(SPECIFIER)) out.push(match[1]);
  }
  return out;
}

interface Walk {
  files: Set<string>;
  bareFs: string[];
}

function walk(entry: string): Walk {
  const files = new Set<string>();
  const bareFs: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of valueSpecifiers(readFileSync(file, 'utf-8'))) {
      if (specifier === 'fs' || specifier === 'node:fs' || specifier.startsWith('fs/') || specifier.startsWith('node:fs/')) {
        bareFs.push(relative(REPO_ROOT, file));
        continue;
      }
      const next = resolveModule(file, specifier);
      if (next) queue.push(next);
    }
  }
  return { files, bareFs };
}

function serverOnly(files: Set<string>): string[] {
  return [...files]
    .map((f) => relative(REPO_ROOT, f))
    .filter(
      (f) => f === 'src/lib/logger.ts' || f === 'src/lib/env.ts' || f.startsWith('src/lib/db/'),
    )
    .sort();
}

describe('useAutoYes reaches no server-only module (Issue #3748)', () => {
  it('陽性対照: the walker finds logger → env → fs from the server confirm-page predicate', () => {
    const { files } = walk(join(SRC, 'lib/polling/auto-yes-confirm-page.ts'));
    expect(serverOnly(files)).toEqual(
      expect.arrayContaining(['src/lib/logger.ts', 'src/lib/env.ts']),
    );
    expect(walk(join(SRC, 'lib/db/db-path-resolver.ts')).bareFs).not.toEqual([]);
  });

  it('陽性対照: a type-only import is not followed, a mixed one is', () => {
    expect(valueSpecifiers("import type { A } from '@/lib/logger';\n")).toEqual([]);
    expect(valueSpecifiers("import {\n  type A,\n  b,\n} from '@/lib/logger';\n")).toEqual([
      '@/lib/logger',
    ]);
    expect(valueSpecifiers("export { x } from './a';\nconst m = await import('./b');\n")).toEqual([
      './a',
      './b',
    ]);
  });

  it('useAutoYes.ts and what it imports reach no logger / env / db / fs', () => {
    const { files, bareFs } = walk(join(SRC, 'hooks/useAutoYes.ts'));
    expect(files.size).toBeGreaterThan(5);
    expect(serverOnly(files)).toEqual([]);
    expect(bareFs).toEqual([]);
  });
});
