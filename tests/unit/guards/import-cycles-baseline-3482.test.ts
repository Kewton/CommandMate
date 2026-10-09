/**
 * No module-scope import cycle in `src/` beyond the checked-in baseline
 * (Issue #3482).
 *
 * ## What happened
 *
 * #3374 split `src/lib/polling/response-checker.ts`. The new module
 * `response-checker-extraction-steps.ts` imported a constant from
 * `./response-poller-core`, which imports `response-checker`, which imports the
 * new module — a new cycle. lint, typecheck and the related unit tests were all
 * green; the orchestrator found it by reading the diff. A cycle keeps working
 * while every binding is read at call time, and turns into an `undefined`
 * somewhere else the day the load order changes (a new import, a partial
 * `vi.mock`). Only `no-ws-server-manager-cycle-1984.test.ts` looked at cycles,
 * and only through two modules.
 *
 * ## What this guards
 *
 * `scripts/import-cycles.mjs` builds the value-level import graph of `src/`
 * with the TypeScript compiler API (tsconfig `paths` resolved; `import type`,
 * all-`type` specifier lists and dynamic `import()` are not edges) and lists
 * every elementary cycle. A cycle that `import-cycles-baseline.json` does not
 * hold fails this test. Cycles that disappear are fine.
 *
 * The cycles in the baseline are NOT fixed here; that is separate work.
 *
 * ## Updating the baseline
 *
 *   node scripts/import-cycles.mjs --write-baseline
 *
 * Do it only to record cycles that went away, or a new cycle you decided to
 * accept — and write the reason in the commit message body.
 *
 * ## Why the synthetic graphs
 *
 * "No new cycle" is also what a parser that reads no edges reports. The
 * controls below build small trees under `os.tmpdir()` (the repository is never
 * written) and show that the same functions catch #3374's shape — a new module
 * joining an existing cycle — and do not count type-only or dynamic imports.
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  BASELINE_RELATIVE_PATH,
  UPDATE_BASELINE_COMMAND,
  buildImportGraph,
  compareWithBaseline,
  findCycles,
  formatNewCycles,
  normalizeCycle,
  readBaseline,
} from '../../../scripts/import-cycles.mjs';

const REPO_ROOT = process.cwd();

const TSCONFIG = JSON.stringify({
  compilerOptions: { module: 'esnext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] } },
});

const tempRoots: string[] = [];

/** A throwaway repository under os.tmpdir(): tsconfig.json plus the given src files. */
function synthRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-cycles-3482-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** The pre-split state of #3374: checker <-> core is already a cycle (the baseline). */
const BEFORE_SPLIT = {
  'src/lib/polling/response-checker.ts':
    "import { pollCore } from './response-poller-core';\nexport const check = () => pollCore();\n",
  'src/lib/polling/response-poller-core.ts':
    "import { check } from '@/lib/polling/response-checker';\n" +
    "export const GEMINI_LOADING_INDICATORS = ['x'];\nexport const pollCore = () => check;\n",
};
const BASELINE_BEFORE_SPLIT = [['src/lib/polling/response-checker.ts', 'src/lib/polling/response-poller-core.ts']];

/** #3374's first commit: the new module takes a value from core, and checker imports it. */
function afterSplit(stepsImport: string): Record<string, string> {
  return {
    ...BEFORE_SPLIT,
    'src/lib/polling/response-checker.ts':
      "import { pollCore } from './response-poller-core';\n" +
      "import { extract } from './response-checker-extraction-steps';\n" +
      'export const check = () => [pollCore(), extract()];\n',
    'src/lib/polling/response-checker-extraction-steps.ts': `${stepsImport}\nexport const extract = () => 1;\n`,
  };
}

const cyclesOf = (root: string) => findCycles(buildImportGraph({ root }));

describe('import cycles against the baseline (Issue #3482)', () => {
  describe('the detector is not vacuous (synthetic trees under os.tmpdir())', () => {
    it('reports the existing cycle, resolving the @/ path alias', () => {
      expect(cyclesOf(synthRepo(BEFORE_SPLIT))).toEqual(BASELINE_BEFORE_SPLIT);
    });

    it("fails on #3374's shape: a new module joining an existing cycle", () => {
      const root = synthRepo(
        afterSplit("import { GEMINI_LOADING_INDICATORS } from './response-poller-core';\nvoid GEMINI_LOADING_INDICATORS;")
      );
      const { added } = compareWithBaseline(cyclesOf(root), BASELINE_BEFORE_SPLIT);

      expect(added).toEqual([
        [
          'src/lib/polling/response-checker-extraction-steps.ts',
          'src/lib/polling/response-poller-core.ts',
          'src/lib/polling/response-checker.ts',
        ],
      ]);
      const message = formatNewCycles(added);
      expect(message).toContain(
        'src/lib/polling/response-checker-extraction-steps.ts -> src/lib/polling/response-poller-core.ts -> ' +
          'src/lib/polling/response-checker.ts -> src/lib/polling/response-checker-extraction-steps.ts'
      );
      expect(message).toContain(UPDATE_BASELINE_COMMAND);
    });

    it.each([
      ['import type', "import type { Indicator } from './response-poller-core';"],
      ['all-type specifiers', "import { type Indicator } from './response-poller-core';"],
      ['export type ... from', "export type { Indicator } from './response-poller-core';"],
      ['dynamic import()', "export const load = () => import('./response-poller-core');"],
    ])('does not count a %s edge', (_label, stepsImport) => {
      const root = synthRepo(afterSplit(stepsImport));

      expect(compareWithBaseline(cyclesOf(root), BASELINE_BEFORE_SPLIT).added).toEqual([]);
    });

    it('counts re-exports and side-effect imports as edges', () => {
      for (const stepsImport of [
        "export { GEMINI_LOADING_INDICATORS } from './response-poller-core';",
        "export * from './response-poller-core';",
        "import './response-poller-core';",
      ]) {
        const root = synthRepo(afterSplit(stepsImport));
        expect(compareWithBaseline(cyclesOf(root), BASELINE_BEFORE_SPLIT).added, stepsImport).toHaveLength(1);
      }
    });

    it('treats a vanished baseline cycle as removed, never as a failure', () => {
      const root = synthRepo({ 'src/a.ts': 'export const a = 1;\n' });

      expect(compareWithBaseline(cyclesOf(root), BASELINE_BEFORE_SPLIT)).toEqual({
        added: [],
        removed: BASELINE_BEFORE_SPLIT,
      });
    });

    it('identifies a ring by its rotation from the smallest path', () => {
      expect(normalizeCycle(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
      expect(normalizeCycle(['b', 'a', 'c'])).toEqual(['a', 'c', 'b']);
    });
  });

  describe('the real src/ graph', () => {
    const graph = buildImportGraph({ root: REPO_ROOT });
    const current = findCycles(graph);
    const baseline = readBaseline(join(REPO_ROOT, BASELINE_RELATIVE_PATH));

    it('reads real edges, including through a re-export-only barrel', () => {
      expect([...graph.get('src/lib/polling/response-poller.ts')!]).toContain(
        'src/lib/polling/response-poller-core.ts'
      );
      expect([...graph.get('src/lib/ws-server.ts')!]).toContain('src/lib/security/auth.ts');
      // `@/` alias edge (resolving it depends on tsconfig's `paths`, not on the cwd).
      expect([...graph.get('src/lib/polling/response-checker.ts')!]).toContain('src/lib/session/cli-session.ts');
    });

    it('keeps the baseline file in its normalized form', () => {
      const raw = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_RELATIVE_PATH), 'utf-8'));
      expect(raw.cycles).toEqual(baseline);
      for (const ring of baseline) expect(ring).toEqual(normalizeCycle(ring));
    });

    it('has no import cycle that the baseline does not hold', () => {
      const { added } = compareWithBaseline(current, baseline);

      // On failure: break the cycle, or (only if it is intended) run
      // `node scripts/import-cycles.mjs --write-baseline` and give the reason in the commit body.
      expect(added, added.length > 0 ? formatNewCycles(added) : '').toEqual([]);
    });
  });
});
