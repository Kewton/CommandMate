/**
 * The approval of a hand-off is a person's request on the screen, never an answer typed into
 * the agent's terminal (Issue #4227 G-PR2, design `mem-ui-4227.md` §5.3・§7.3
 * `handoff-approval-not-from-auto-yes-4227`): no module of Auto-Yes, the polling, the answer
 * routes (`prompt-response`, `respond`, `special-keys`) reaches the hand-off's decide,
 * rebase or end/observe (read off the import graph), and `decide.ts` is imported by its
 * route alone.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createModuleGraph, REPO_ROOT, repoRelative, type ModuleGraph } from './route-tmux-reach';

const APPROVAL_MODULES = ['src/lib/handoff/decide.ts', 'src/lib/handoff/proposals.ts', 'src/lib/handoff/end.ts'];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The answering side: Auto-Yes, the polling and the routes that type an answer. */
function answeringSources(): string[] {
  const lib = path.join(REPO_ROOT, 'src', 'lib');
  const routes = path.join(REPO_ROOT, 'src', 'app', 'api', 'worktrees', '[id]');
  return [
    ...files(path.join(lib, 'polling')),
    ...readdirSync(lib).filter((name) => /^auto-yes.*\.ts$/.test(name)).map((name) => path.join(lib, name)),
    ...files(path.join(routes, 'prompt-response')),
    ...files(path.join(routes, 'respond')),
    ...files(path.join(routes, 'special-keys')),
  ];
}

export function approvalReach(graph: ModuleGraph, entry: string): string[] {
  return [...graph.closure(entry)].map(repoRelative).filter((module) => APPROVAL_MODULES.includes(module));
}

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('the hand-off’s approval is not an answer in the terminal (Issue #4227)', () => {
  it('no answering module reaches decide, rebase or end', () => {
    const graph = createModuleGraph();
    const sources = answeringSources();
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.some((file) => file.includes('prompt-response'))).toBe(true);
    for (const file of sources) expect([repoRelative(file), approvalReach(graph, file)]).toEqual([repoRelative(file), []]);
  });

  it('decide.ts is imported by its route alone', () => {
    const importers = files(path.join(REPO_ROOT, 'src'))
      .filter((file) => /from\s+['"]@\/lib\/handoff\/decide['"]|from\s+['"]\.\/decide['"]/.test(readFileSync(file, 'utf8')))
      .map(repoRelative);
    expect(importers).toEqual(['src/app/api/worktrees/[id]/mem/handoff/requests/[rid]/decide/route.ts']);
  });

  it('(positive control) an answering module importing decide is found', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'handoff-approval-4227-'));
    const file = path.join(scratch, 'auto-yes-careless.ts');
    writeFileSync(file, "import { handoffDecide } from '@/lib/handoff/decide';\nexport const x = handoffDecide;\n");
    expect(approvalReach(createModuleGraph(), file)).toContain('src/lib/handoff/decide.ts');
  });
});
