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
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

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

/** Where the writers are defined. */
const DEFINERS = new Set(['src/lib/session/waiting-episode-state.ts', 'src/lib/session/waiting-episode-binding.ts']);

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

describe('[#3798] the observers register the binding resolver themselves', () => {
  it('the detector sees a call and an import, and not a comment', () => {
    expect(scan(`// observeWaitingEdge({})\nimport { x } from './waiting-episode-binding';`)).toEqual({
      calls: [],
      imports: ['./waiting-episode-binding'],
    });
    expect(scan(`observeWaiting({});`).calls).toEqual(['observeWaiting']);
  });

  it('every module outside the store that writes an episode imports waiting-episode-binding', () => {
    const writers: string[] = [];
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(process.cwd(), file);
      if (DEFINERS.has(rel)) continue;
      const { calls, imports } = scan(readFileSync(file, 'utf8'));
      if (calls.length === 0) continue;
      writers.push(rel);
      if (!imports.some((spec) => spec.endsWith(BINDING))) offenders.push(rel);
    }
    // The three observers of design §2.5. A new writer is added here on purpose.
    expect(writers.sort()).toEqual([
      'src/lib/auto-yes-poller.ts',
      'src/lib/polling/response-checker.ts',
      'src/lib/session/worktree-status-helper.ts',
    ]);
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
