/**
 * The hand-off's writes a person makes are the screen's only (Issue #4227 G-PR2, design
 * `mem-ui-4227.md` §7.3 `handoff-screen-only-4227`):
 *
 * - `src/cli/**` names none of the screen's hand-off routes (create, decide, rebase, cancel,
 *   extend, end, end/observe, sent, send-failed) and does not send the screen's mark
 *   (`X-CommandMate-Client` / `screenRequestHeaders`): the CLI has `propose` and `done` only;
 * - every screen route of the hand-off asks for the mark (`isScreenRequest(request)`) before it
 *   calls its service, and every screen entrance of the service asks for it too (not only the
 *   route); the agent's routes (`proposals`, `done`) and the read (`GET`) need none.
 *
 * Positive controls run the same scan over a fixture tree under `os.tmpdir()`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { dirname, join, relative, sep } from 'path';

const SRC = join(process.cwd(), 'src');
const toPosix = (path: string) => path.split(sep).join('/');
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

function files(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const SCREEN_PATH = /handoff\/requests(?:\/[^'"`\s]*)?\/(?:decide|rebase|cancel|extend|end|observe|sent|send-failed)\b|handoff\/requests['"`]/;
/** The routes of the agent and the read: no mark asked (it adds no right). */
const UNMARKED_ROUTES = new Set(['[rid]/route.ts', '[rid]/proposals/route.ts', '[rid]/done/route.ts']);
/** The service's screen entrances, by file. */
const SCREEN_ENTRANCES: Record<string, string[]> = {
  'lib/handoff/request.ts': ['handoffCreate', 'handoffCancel', 'screenStep'],
  'lib/handoff/proposals.ts': ['handoffRebase'],
  'lib/handoff/decide.ts': ['handoffDecide'],
  'lib/handoff/end.ts': ['handoffEnd', 'handoffObserve'],
};

function bodyOf(source: string, name: string): string | null {
  const start = source.search(new RegExp(`(?:function|const) ${name}\\b`));
  if (start < 0) return null;
  const next = source.slice(start + 1).search(/\n(?:export )?(?:async )?function |\n(?:export )?const \w+ =/);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

/** What a tree breaks, as `<file>: <finding>`. */
export function handoffScreenFindings(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const rel = toPosix(relative(root, file));
    const source = code(readFileSync(file, 'utf8'));
    if (rel.startsWith('cli/')) {
      if (SCREEN_PATH.test(source)) out.push(`${rel}: names a screen route of the hand-off`);
      if (/X-CommandMate-Client|screenRequestHeaders/.test(source)) out.push(`${rel}: sends the screen's mark`);
    }
    const route = /^app\/api\/worktrees\/\[id\]\/mem\/handoff\/requests\/(.*route\.ts)$/.exec(rel);
    if (route && !UNMARKED_ROUTES.has(route[1]) && !/isScreenRequest\(request\)/.test(source)) {
      out.push(`${rel}: a screen route of the hand-off without the mark`);
    }
    for (const name of SCREEN_ENTRANCES[rel] ?? []) {
      const body = bodyOf(source, name);
      if (!body || !/isScreenRequest\(request\)/.test(body)) out.push(`${rel}: ${name} does not ask for the mark`);
    }
  }
  return out.sort();
}

describe('the hand-off’s screen writes are the screen’s only (Issue #4227)', () => {
  let fixture: string;
  const put = (rel: string, source: string) => {
    const full = join(fixture, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  };
  beforeEach(() => {
    fixture = mkdtempSync(join(os.tmpdir(), 'handoff-screen-guard-4227-'));
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it('(positive control) flags a CLI decide, a CLI mark, a route without the mark and a service entrance without it', () => {
    put('cli/commands/handoff.ts', "await client.post(`/api/worktrees/${w}/mem/handoff/requests/${r}/decide`, body);\nconst h = { 'X-CommandMate-Client': 'screen' };\n");
    put('cli/commands/other.ts', "await client.post(`/api/worktrees/${w}/mem/handoff/requests/${r}/end/observe`, body);\n");
    put('app/api/worktrees/[id]/mem/handoff/requests/[rid]/cancel/route.ts', 'return answer(handoffCancel(db, request, id, rid));\n');
    put('lib/handoff/end.ts', 'export function handoffEnd(db, request) {\n  return write(db);\n}\nexport function handoffObserve(db, request) {\n  if (!isScreenRequest(request)) return no;\n}\n');
    expect(handoffScreenFindings(fixture)).toEqual([
      'app/api/worktrees/[id]/mem/handoff/requests/[rid]/cancel/route.ts: a screen route of the hand-off without the mark',
      'cli/commands/handoff.ts: names a screen route of the hand-off',
      "cli/commands/handoff.ts: sends the screen's mark",
      'cli/commands/other.ts: names a screen route of the hand-off',
      'lib/handoff/end.ts: handoffEnd does not ask for the mark',
    ]);
  });

  it('(negative control) the CLI’s propose / done, the unmarked routes and comments pass', () => {
    put('cli/commands/handoff.ts', "// not handoff/requests/x/decide: the screen's\nawait client.post(`/api/worktrees/${w}/mem/handoff/requests/${r}/proposals`, b);\nawait client.post(`/api/worktrees/${w}/mem/handoff/requests/${r}/done`, b);\n");
    put('app/api/worktrees/[id]/mem/handoff/requests/[rid]/done/route.ts', 'return answer(await handoffDone(db, id, rid, body));\n');
    put('app/api/worktrees/[id]/mem/handoff/requests/[rid]/decide/route.ts', 'if (!isScreenRequest(request)) return no;\n');
    expect(handoffScreenFindings(fixture)).toEqual([]);
  });

  it('the source keeps it', () => {
    expect(files(join(SRC, 'app/api/worktrees/[id]/mem/handoff')).length).toBeGreaterThanOrEqual(12);
    for (const file of Object.keys(SCREEN_ENTRANCES)) expect(files(join(SRC, dirname(file))).map((f) => toPosix(relative(SRC, f)))).toContain(file);
    expect(handoffScreenFindings(SRC)).toEqual([]);
  });
});
