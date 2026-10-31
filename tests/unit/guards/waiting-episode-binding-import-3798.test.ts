/**
 * Every production module that opens or closes a waiting episode imports
 * `waiting-episode-binding` itself (Issue #3798, PR 1a review P3-2).
 *
 * The episode store (`waiting-episode-state`) is a leaf: what a new episode is
 * bound to is decided by a resolver `waiting-episode-binding` registers when it
 * is loaded. PR 1a left that registration to a transitive import
 * (`agent-event-state` imports the binding module), so an observer reached in
 * a bundle without `agent-event-state` would open every wait as
 * "unattributed, generation none" — a wait the turn transitions can never end —
 * with no error anywhere. This guard reads the observers' imports, and the
 * runtime case below loads the status probe in a fresh module graph and asks
 * whether the resolver is there.
 *
 * The definers and the observers are named by their original file; a piece
 * split off one (`<dir>/<base>-*.ts`) counts as that file (Issue #3903,
 * `split-family.ts`), so a split may move a writer without loosening the set.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, sep } from 'path';
import ts from 'typescript';
import { inFamily, originsOf } from './split-family';

const SRC = join(process.cwd(), 'src');
const BINDING = 'waiting-episode-binding';

/** The calls that write an episode (or plan the write). */
const WRITERS = new Set([
  'observeWaitingEdge',
  'observeWaiting',
  'planWaitingObservation',
  'commitWaitingObservation',
  'openEpisode',
  'closeEpisode',
  'replaceEpisode',
  'rebindEpisode',
]);

/** Where the writers are defined: these modules and the pieces split off them (#3903). */
const DEFINERS = ['src/lib/session/waiting-episode-state.ts', 'src/lib/session/waiting-episode-binding.ts'];

/** The three observers of design §2.5, with the pieces split off them (#3903). A new writer is added here on purpose. */
const OBSERVERS = [
  'src/lib/auto-yes-poller.ts',
  'src/lib/polling/response-checker.ts',
  'src/lib/session/worktree-status-helper.ts',
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The writer calls in `code` (comments and strings do not count), and its import specifiers. */
function scan(code: string): { calls: string[]; imports: string[] } {
  const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  const imports: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) imports.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && WRITERS.has(n.expression.text)) {
      calls.push(n.expression.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return { calls, imports };
}

/**
 * The writers under `root/src` outside the definers, and those of them that do
 * not import waiting-episode-binding. Paths are repo-relative with `/`.
 */
function auditWriters(root: string): { writers: string[]; offenders: string[] } {
  const writers: string[] = [];
  const offenders: string[] = [];
  for (const file of tsFiles(join(root, 'src'))) {
    const rel = relative(root, file).split(sep).join('/');
    if (DEFINERS.some((d) => inFamily(rel, d))) continue;
    const { calls, imports } = scan(readFileSync(file, 'utf8'));
    if (calls.length === 0) continue;
    writers.push(rel);
    if (!imports.some((spec) => spec.endsWith(BINDING))) offenders.push(rel);
  }
  return { writers: writers.sort(), offenders: offenders.sort() };
}

describe('[#3798] the observers register the binding resolver themselves', () => {
  it('the detector sees a call and an import, and not a comment', () => {
    expect(scan(`// observeWaitingEdge({})\nimport { x } from './waiting-episode-binding';`)).toEqual({
      calls: [],
      imports: ['./waiting-episode-binding'],
    });
    expect(scan(`observeWaiting({});`).calls).toEqual(['observeWaiting']);
  });

  it('every module outside the store that writes an episode imports waiting-episode-binding', () => {
    const { writers, offenders } = auditWriters(dirname(SRC));
    // The three observers of design §2.5 (a split piece counts as its observer).
    expect(originsOf(writers, OBSERVERS)).toEqual([...OBSERVERS].sort());
    expect(offenders).toEqual([]);
  });

  it('loading the status probe alone registers the resolver', async () => {
    vi.resetModules();
    const saved = globalThis.__sessionWaitingEpisodeBindingResolver;
    globalThis.__sessionWaitingEpisodeBindingResolver = undefined;
    try {
      await import('@/lib/session/worktree-status-helper');
      expect(globalThis.__sessionWaitingEpisodeBindingResolver).toBeTypeOf('function');
    } finally {
      globalThis.__sessionWaitingEpisodeBindingResolver = saved;
    }
  }, 60_000);
});

describe('[#3903] a split may move a writer, and only within the definers and the observers', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** A repo under os.tmpdir() holding `files` (repo-relative path → source). */
  function repo(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'guard-3903-'));
    for (const [rel, code] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), code);
    }
    return root;
  }

  const IMPORTS_BINDING = "import '@/lib/session/waiting-episode-binding';\n";
  /** The three observers as they are before a split: each writes and imports the binding. */
  const OBSERVED = Object.fromEntries(OBSERVERS.map((o) => [o, `${IMPORTS_BINDING}observeWaiting({});\n`]));

  function verdict(files: Record<string, string>): { strangers: string[]; offenders: string[] } {
    const { writers, offenders } = auditWriters(repo(files));
    return { strangers: originsOf(writers, OBSERVERS).filter((o) => !OBSERVERS.includes(o)), offenders };
  }

  it('positive: commitWaitingObservation moved to waiting-episode-binding-*.ts is a definer, not a writer', () => {
    // Before #3903 the definer was the one file, so this piece was a writer that does not import the binding.
    const v = verdict({
      ...OBSERVED,
      'src/lib/session/waiting-episode-binding-commit.ts':
        'export function commitWaitingObservation(p: unknown) { return replaceEpisode(p); }\n',
    });
    expect(v).toEqual({ strangers: [], offenders: [] });
  });

  it('positive: observeWaiting moved to auto-yes-poller-*.ts counts as the Auto-Yes poller', () => {
    // Before #3903 the writer list was pinned to auto-yes-poller.ts and this piece was a fourth writer.
    const v = verdict({
      ...OBSERVED,
      'src/lib/auto-yes-poller.ts': "import { observeFromTick } from './auto-yes-poller-observe';\n",
      'src/lib/auto-yes-poller-observe.ts': `${IMPORTS_BINDING}export function observeFromTick() { observeWaiting({}); }\n`,
    });
    expect(v).toEqual({ strangers: [], offenders: [] });
  });

  it('negative: a writer outside every family still fails, also one only named like a piece', () => {
    const v = verdict({
      ...OBSERVED,
      'src/lib/other.ts': `${IMPORTS_BINDING}commitWaitingObservation({});\n`,
      'src/lib/auto-yes-poller2.ts': `${IMPORTS_BINDING}observeWaiting({});\n`,
      'src/lib/polling/auto-yes-poller-elsewhere.ts': `${IMPORTS_BINDING}observeWaiting({});\n`,
      'src/lib/session/waiting-episode-bindingx.ts': `${IMPORTS_BINDING}openEpisode({});\n`,
    });
    expect(v.strangers).toEqual([
      'src/lib/auto-yes-poller2.ts',
      'src/lib/other.ts',
      'src/lib/polling/auto-yes-poller-elsewhere.ts',
      'src/lib/session/waiting-episode-bindingx.ts',
    ]);
  });

  it('negative: a piece of an observer that writes without importing the binding is an offender', () => {
    const v = verdict({
      ...OBSERVED,
      'src/lib/auto-yes-poller-observe.ts': 'export function f() { observeWaiting({}); }\n',
    });
    expect(v).toEqual({ strangers: [], offenders: ['src/lib/auto-yes-poller-observe.ts'] });
  });

  it('negative: an observer whose family stopped writing is missing from the set', () => {
    const { writers } = auditWriters(repo({ ...OBSERVED, 'src/lib/polling/response-checker.ts': 'export {};\n' }));
    expect(originsOf(writers, OBSERVERS)).not.toEqual([...OBSERVERS].sort());
  });
});
