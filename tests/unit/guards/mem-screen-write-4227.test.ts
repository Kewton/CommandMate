/**
 * A person's writes of mem items happen from the screen only (Issue #4227, design
 * `mem-ui-4227.md` §7.3):
 *
 * - `memWriteFromScreen` is called by the screen's item routes (`…/mem/screen/**`) and,
 *   later, the hand-off's decide (`src/lib/handoff/decide.ts`) only; each route asks
 *   for the screen's mark before it calls;
 * - `closeMemItemVersioned` (the only close of a recorded decision) is called by the
 *   service alone, inside `memWriteFromScreen`;
 * - the CLI names neither the screen's item routes nor the `withdraw-recorded`
 *   transition, so `mem close` keeps refusing a recorded decision.
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

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const toPosix = (path: string) => path.split(sep).join('/');

/** Callers allowed for the screen's entrance, relative to `src/`. */
function screenWriteCallerAllowed(rel: string): boolean {
  return (
    rel === 'lib/mem/service.ts' ||
    rel === 'lib/handoff/decide.ts' ||
    /^app\/api\/worktrees\/\[id\]\/mem\/screen\/.+\/route\.ts$/.test(rel)
  );
}

/** What a tree breaks, as `<file>: <finding>`. */
export function screenWriteFindings(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const rel = toPosix(relative(root, file));
    const source = code(readFileSync(file, 'utf8'));
    if (/\bmemWriteFromScreen\(/.test(source)) {
      if (!screenWriteCallerAllowed(rel)) out.push(`${rel}: calls memWriteFromScreen`);
      else if (rel.startsWith('app/') && !/isScreenRequest\(request\)/.test(source)) out.push(`${rel}: calls memWriteFromScreen without asking for the mark`);
    }
    if (/\bcloseMemItemVersioned\(/.test(source) && rel !== 'lib/db/mem-db.ts' && rel !== 'lib/mem/service.ts') {
      out.push(`${rel}: calls closeMemItemVersioned`);
    }
    if (rel.startsWith('cli/')) {
      if (/withdraw-recorded/.test(source)) out.push(`${rel}: names withdraw-recorded`);
      if (/mem\/screen/.test(source)) out.push(`${rel}: names the screen's item routes`);
    }
    if (rel === 'lib/handoff/proposals.ts' && /withdraw-recorded/.test(source)) out.push(`${rel}: a proposal names withdraw-recorded`);
  }
  return out.sort();
}

/** Inside the service, the versioned close is reached from `memWriteFromScreen` alone. */
export function versionedCloseOutsideScreenEntrance(service: string): boolean {
  const starts = [...service.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  return starts.some((match, i) => {
    const body = service.slice(match.index, starts[i + 1]?.index ?? service.length);
    return match[1] !== 'memWriteFromScreen' && /\bcloseMemItemVersioned\(/.test(code(body));
  });
}

describe('a person’s mem writes are the screen’s only (Issue #4227)', () => {
  let fixture: string;
  const put = (rel: string, source: string) => {
    const full = join(fixture, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  };

  beforeEach(() => {
    fixture = mkdtempSync(join(os.tmpdir(), 'mem-screen-guard-4227-'));
  });
  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('(positive control) flags a CLI caller, a route without the mark, a stray close and the CLI naming the transition', () => {
    put('cli/commands/mem.ts', "await client.post(`/api/worktrees/${id}/mem/screen/items`, body);\nconst t = 'withdraw-recorded';\n");
    put('lib/other/sneak.ts', 'memWriteFromScreen(db, request, id, input);\ncloseMemItemVersioned(db, actor, id, close);\n');
    put('app/api/worktrees/[id]/mem/screen/items/route.ts', 'await memWriteFromScreen(getDbInstance(), request, id, input);\n');
    put('lib/handoff/proposals.ts', "const transition = 'withdraw-recorded';\n");
    expect(screenWriteFindings(fixture)).toEqual([
      'app/api/worktrees/[id]/mem/screen/items/route.ts: calls memWriteFromScreen without asking for the mark',
      'cli/commands/mem.ts: names the screen\'s item routes',
      'cli/commands/mem.ts: names withdraw-recorded',
      'lib/handoff/proposals.ts: a proposal names withdraw-recorded',
      'lib/other/sneak.ts: calls closeMemItemVersioned',
      'lib/other/sneak.ts: calls memWriteFromScreen',
    ]);
    expect(versionedCloseOutsideScreenEntrance('function sweep() {\n  closeMemItemVersioned(db, a, b, c);\n}\n')).toBe(true);
  });

  it('(negative control) the allowed callers, a route that asks for the mark, and comments pass', () => {
    put('app/api/worktrees/[id]/mem/screen/items/route.ts', 'if (!isScreenRequest(request)) return;\nawait memWriteFromScreen(getDbInstance(), request, id, input);\n');
    put('lib/handoff/decide.ts', 'await memWriteFromScreen(db, request, id, input);\n');
    put('cli/commands/mem.ts', "// mem/screen is the screen's, not ours\nawait client.post('/api/worktrees/w/mem/items', body);\n");
    expect(screenWriteFindings(fixture)).toEqual([]);
    expect(versionedCloseOutsideScreenEntrance('export async function memWriteFromScreen() {\n  closeMemItemVersioned(db, a, b, c);\n}\n')).toBe(false);
  });

  it('the source keeps it', () => {
    expect(files(join(SRC, 'cli')).some((file) => file.endsWith(join('commands', 'mem.ts')))).toBe(true);
    expect(screenWriteFindings(SRC)).toEqual([]);
    const service = readFileSync(join(SRC, 'lib/mem/service.ts'), 'utf8');
    expect(/\bcloseMemItemVersioned\(/.test(service)).toBe(true);
    expect(versionedCloseOutsideScreenEntrance(service)).toBe(false);
    // The three routes exist and each asks for the mark (checked above by the scan).
    const routes = files(join(SRC, 'app/api/worktrees/[id]/mem/screen')).map((file) => toPosix(relative(SRC, file))).sort();
    expect(routes).toEqual([
      'app/api/worktrees/[id]/mem/screen/items/[itemId]/close/route.ts',
      'app/api/worktrees/[id]/mem/screen/items/[itemId]/route.ts',
      'app/api/worktrees/[id]/mem/screen/items/route.ts',
    ]);
  });
});
