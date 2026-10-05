/**
 * Route handlers must not parse a JSON body bare (Issue #3295).
 * @vitest-environment node
 *
 * `await request.json()` inside a route's outer try turns a syntax error into a
 * 500 plus an error-level log: a client mistake that reads as a server fault.
 * Reading the body through `readJsonBody` (src/lib/api/read-json-body.ts) answers
 * 400 instead. A bare read is allowed only with a `.catch(` right behind it, or
 * in the files below, which already turn the failure into a 400 in their own
 * try/catch (their wording differs, so they were left as they are).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const API_DIR = join(process.cwd(), 'src/app/api');

/** Files with their own try/catch → 400, and how many bare reads each holds. */
const OWN_TRY_CATCH_400: Record<string, number> = {
  'worktrees/[id]/auto-yes/route.ts': 1,
  'worktrees/[id]/direct-input/route.ts': 1,
  'worktrees/[id]/env/route.ts': 1,
  'worktrees/[id]/interrupt/route.ts': 1,
  'worktrees/[id]/marp-render/route.ts': 1,
  'worktrees/[id]/opencode/diff/route.ts': 1,
  'worktrees/[id]/opencode/session/route.ts': 1,
  'worktrees/[id]/opencode/share/route.ts': 1,
  'remote/pair/route.ts': 1,
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Number of `await req|request.json()` reads NOT followed by `.catch(`. */
function countBareJsonReads(source: string): number {
  const code = stripComments(source);
  const re = /\bawait\s+(?:req|request)\s*\.json\(\)(\s*\.catch\()?/g;
  let count = 0;
  for (const m of code.matchAll(re)) {
    if (!m[1]) count++;
  }
  return count;
}

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

describe('countBareJsonReads (scanner controls)', () => {
  it('flags a bare await request.json() (positive control)', () => {
    expect(countBareJsonReads('const body = await request.json();')).toBe(1);
    expect(countBareJsonReads('const b = (await req.json()) as X;')).toBe(1);
  });

  it('ignores a read followed by .catch( (negative control)', () => {
    expect(countBareJsonReads('const body = await request.json().catch(() => ({}));')).toBe(0);
    expect(countBareJsonReads('const body = (await request.json().catch(() => null)) as X;')).toBe(0);
  });

  it('ignores mentions in comments', () => {
    expect(countBareJsonReads('// await request.json() throws\n/* await req.json() */')).toBe(0);
  });
});

describe('src/app/api route bodies', () => {
  const files = collectRouteFiles(API_DIR);

  it('scans a real set of routes (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('reads a JSON body bare only in the allow-listed files, with the pinned counts', () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = countBareJsonReads(readFileSync(file, 'utf-8'));
      if (n > 0) found[relative(API_DIR, file)] = n;
    }
    const offenders = Object.keys(found).filter((f) => !(f in OWN_TRY_CATCH_400));
    expect(offenders, `use readJsonBody (src/lib/api/read-json-body.ts) instead of a bare req.json() in: ${offenders.join(', ')}`).toEqual([]);
    expect(found).toEqual(OWN_TRY_CATCH_400);
  });
});
