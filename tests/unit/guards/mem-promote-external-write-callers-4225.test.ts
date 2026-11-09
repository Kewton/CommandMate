/**
 * Who may write outside on the promote path (Issue #4225, PM review P3-6, design §11).
 *
 * The two functions that write outside — the comment's POST (`postGhComment`,
 * `lib/promote/github-write.ts`) and the document's append (`writeDocBlock`,
 * `lib/promote/doc-write.ts`) — are called by `src/lib/promote/service.ts` only, where
 * every entrance asks for the screen's mark first and an approval is checked right before
 * the write. A new caller anywhere under `src/` (a direct call, an alias, a namespace
 * import, a relative path or a re-export) fails here until this table says why it may.
 *
 * The same shape as the brief's caller guard (#4274・#4288): every caller is enumerated
 * from the sources, not listed by name, and a self-test shows the reader sees each way in.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { ROOT, SRC, sourcesUnder, specifiersOf, usesOf } from '../lib/promote/promote-write-chain-4225.helpers';

const GITHUB_WRITE = path.join(SRC, 'lib/promote/github-write.ts');
const DOC_WRITE = path.join(SRC, 'lib/promote/doc-write.ts');

/** The function that writes outside → its module and the files allowed to call it, with the reason. */
const EXTERNAL_WRITES: Record<string, { module: string; callers: string[]; reason: string }> = {
  postGhComment: {
    module: GITHUB_WRITE,
    callers: ['src/lib/promote/service.ts'],
    reason: 'promoteApprove, after the screen mark and the checks of the synchronous stretch (design §2.3)',
  },
  writeDocBlock: {
    module: DOC_WRITE,
    callers: ['src/lib/promote/service.ts'],
    reason: 'promoteApprove, in the synchronous stretch of the checks (design §3.3)',
  },
};

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

/** The files of `files` (other than the module itself) that call or re-export `name` of `module`. */
export function callersIn(files: Array<{ file: string; source: string }>, name: string, module: string): string[] {
  return files
    .filter(({ file }) => file !== module)
    .filter(({ file, source }) => usesOf(source, specifiersOf(file, module), new Set([name])).length > 0)
    .map(({ file }) => rel(file))
    .sort();
}

const allSources = () => sourcesUnder(SRC).map((file) => ({ file, source: readFileSync(file, 'utf8') }));

describe('[#4225 P3-6] the writes outside have one caller', () => {
  it.each(Object.entries(EXTERNAL_WRITES))('%s is called by the named files only', (name, entry) => {
    expect(callersIn(allSources(), name, entry.module)).toEqual(entry.callers);
  });

  it('the modules exist and export the functions (the table is not stale)', () => {
    for (const [name, entry] of Object.entries(EXTERNAL_WRITES)) {
      expect(readFileSync(entry.module, 'utf8')).toMatch(new RegExp(`export (?:async )?function ${name}\\b`));
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('the service does call both (the reader finds a real caller)', () => {
    const service = { file: path.join(SRC, 'lib/promote/service.ts'), source: readFileSync(path.join(SRC, 'lib/promote/service.ts'), 'utf8') };
    expect(callersIn([service], 'postGhComment', GITHUB_WRITE)).toEqual(['src/lib/promote/service.ts']);
    expect(callersIn([service], 'writeDocBlock', DOC_WRITE)).toEqual(['src/lib/promote/service.ts']);
  });
});

describe('(self-test) a new way in is caught', () => {
  const SYNTHETIC = path.join(SRC, 'lib/promote/auto.ts');
  const OTHER_DIR = path.join(SRC, 'lib/schedule/promote-job.ts');

  it.each([
    ['a direct call', SYNTHETIC, "import { postGhComment } from '@/lib/promote/github-write';\nexport async function x() { await postGhComment(run, dest, body, env); }", 'postGhComment', GITHUB_WRITE],
    ['an alias', SYNTHETIC, "import { postGhComment as send } from '@/lib/promote/github-write';\nexport async function x() { await send(run, dest, body, env); }", 'postGhComment', GITHUB_WRITE],
    ['a namespace import', SYNTHETIC, "import * as gh from './github-write';\nexport async function x() { await gh.postGhComment(run, dest, body, env); }", 'postGhComment', GITHUB_WRITE],
    ['a relative path from another directory', OTHER_DIR, "import { writeDocBlock } from '../promote/doc-write';\nexport function x() { writeDocBlock(input); }", 'writeDocBlock', DOC_WRITE],
    ['a re-export', SYNTHETIC, "export { writeDocBlock } from './doc-write';", 'writeDocBlock', DOC_WRITE],
  ])('(positive control) %s', (_name, file, source, fn, module) => {
    expect(callersIn([{ file, source }], fn, module)).toEqual([rel(file)]);
  });

  it('(control) a read of the same modules, or the name in a comment, is not a caller', () => {
    const sources = [
      { file: SYNTHETIC, source: "import { listGhComments } from '@/lib/promote/github-write';\nexport const x = () => listGhComments(run, dest);" },
      { file: SYNTHETIC, source: "import { reconcileDocBlock } from './doc-write';\n// writeDocBlock(input) is not called here\nexport const y = () => reconcileDocBlock(a, b, c, d, e);" },
    ];
    expect(callersIn(sources, 'postGhComment', GITHUB_WRITE)).toEqual([]);
    expect(callersIn(sources, 'writeDocBlock', DOC_WRITE)).toEqual([]);
  });
});
