/**
 * Issue #4559 PR-2 (案 F, the human decision of #4559 comment 7177395611): machine-lock.ts imports the
 * core of scripts/orchestrate/machine-lock-sync.mjs through its byte copy
 * src/lib/verification/machine-lock-sync-core.generated.ts. These are the copy's invariants, each counted:
 *
 *   1. the copy is the two fixed header lines and then the core's bytes — the whole file compared, no
 *      range left out (a range left out would be a place to hide a difference)
 *   2. the core imports node built-ins only (their names counted), and has no `import.meta` and no
 *      top-level await (the copy compiles as a CommonJS module of dist/server)
 *   3. the names machine-lock.ts types at its boundary are exactly the core's exports
 *   4. the header's exception (`@ts-nocheck`, the `ban-ts-comment` disable) is in this one file of src/
 *   5. after `npm run build:server`, dist/server holds the copy's output and machine-lock.js requires it
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const REPO = path.resolve(__dirname, '../../..');
const CORE = 'scripts/orchestrate/machine-lock-sync.mjs';
const COPY = 'src/lib/verification/machine-lock-sync-core.generated.ts';
const TS = 'src/lib/verification/machine-lock.ts';
// The copy's first line, as data. It is a string here, not a directive of this file; it is written in two
// pieces so that scripts/count-suppressions.mjs (a text match) counts the one suppression it is — the copy's own
// line 1, the exception of #4559 comment 7177395611 — and not this test's literal of it.
const DISABLE = ['eslint', 'disable'].join('-');
export const HEADER = [
  `/* ${DISABLE} @typescript-eslint/ban-ts-comment -- byte copy of scripts/orchestrate/machine-lock-sync.mjs, pinned by tests/unit/verification/machine-lock-sync-core-copy-4559.test.ts */`,
  '// @ts-nocheck',
];
const REMAKE = `{ printf '%s\\n%s\\n' '${HEADER[0]}' '${HEADER[1]}'; cat ${CORE}; } > ${COPY}`;
const read = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');

/** The copy the core should have: the header and the core's bytes. */
export const expectedCopy = (core: string): string => `${HEADER.join('\n')}\n${core}`;

/** The `export`ed names of a module's source (const / let / function / function* / async function / class). */
export function exportNames(source: string): string[] {
  return [...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).sort();
}

/** The keys of `interface MachineLockSyncCore { … }` in machine-lock.ts (its boundary with the core). */
export function boundaryNames(source: string): string[] {
  const m = /interface MachineLockSyncCore \{\n([\s\S]*?)\n\}/.exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((k) => k[1]).sort();
}

/** The specifiers of the static imports of a source. */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import\s[^'"]*?from\s+['"]([^'"]+)['"];?$/gm), ...source.matchAll(/^import\s+['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);
}

describe('#4559 案 F: the byte copy of the core', () => {
  it('1: the copy is the two header lines and the core, byte for byte (the whole file)', () => {
    const copy = read(COPY);
    const core = read(CORE);
    expect(core.length).toBeGreaterThan(10_000);
    expect(copy === expectedCopy(core), `the copy differs from the core; remake it with:\n${REMAKE}`).toBe(true);
  });

  it('1 (self-test): a copy with one byte changed, or with the header changed, is told apart', () => {
    const core = read(CORE);
    const good = expectedCopy(core);
    const byte = good.replace('LINK_TRIES_PER_POLL = 32', 'LINK_TRIES_PER_POLL = 33');
    expect(byte).not.toBe(good);
    expect(byte === expectedCopy(core)).toBe(false);
    expect(good.replace('// @ts-nocheck', '// @ts-nocheck ') === expectedCopy(core)).toBe(false);
  });

  it('2: the core imports node built-ins only, and has no import.meta and no top-level await', () => {
    const core = read(CORE);
    const specs = importSpecifiers(core);
    expect(specs.sort()).toEqual(['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path']);
    for (const s of specs) expect(builtinModules.includes(s.replace(/^node:/, '')), s).toBe(true);
    expect([...core.matchAll(/import\.meta/g)].length).toBe(0);
    expect([...core.matchAll(/^await\s|^\s{0,1}\S.*=\s*await\s/gm)].length).toBe(0);
    expect([...core.matchAll(/\bimport\s*\(/g)].length).toBe(0);
    expect([...core.matchAll(/\brequire\s*\(/g)].length).toBe(0);
  });

  it('2 (self-test): an import of a module that is not built in, import.meta and a dynamic import are counted', () => {
    const bad = `import x from 'yaml';\n${read(CORE)}\nconst u = import.meta.url;\nconst m = import('x');\n`;
    expect(importSpecifiers(bad)).toContain('yaml');
    expect([...bad.matchAll(/import\.meta/g)].length).toBe(1);
    expect([...bad.matchAll(/\bimport\s*\(/g)].length).toBe(1);
  });

  it('3: the names machine-lock.ts types at its boundary are the core\'s exports, exactly', () => {
    const exported = exportNames(read(CORE));
    expect(exported.length).toBeGreaterThanOrEqual(40);
    expect(boundaryNames(read(TS))).toEqual(exported);
    // and machine-lock.ts reaches the core through the copy only
    expect(importSpecifiers(read(TS)).filter((s) => /machine-lock-sync/.test(s))).toEqual(['@/lib/verification/machine-lock-sync-core.generated']);
  });

  it('3 (self-test): an export added to the core, or a name dropped from the boundary, is a difference', () => {
    const exported = exportNames(`${read(CORE)}\nexport const EXTRA = 1;\n`);
    expect(exported).toContain('EXTRA');
    expect(boundaryNames(read(TS))).not.toEqual(exported);
    expect(boundaryNames(read(TS).replace(/^ {2}readHolder:.*\n/m, ''))).not.toContain('readHolder');
  });

  it('4: in src/, @ts-nocheck and the ban-ts-comment disable are in the copy only', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && /@ts-nocheck|ban-ts-comment/.test(read(rel))) hits.push(rel);
      }
    };
    walk('src');
    expect(hits).toEqual([COPY]);
  });

  const DIST = path.join(REPO, 'dist/server/src/lib/verification');
  const built = fs.existsSync(path.join(DIST, 'machine-lock.js'));
  // Run after `npm run build:server` (a heavy run, not part of the unit gate's build): skipped, by name, when
  // dist/server is not there.
  it.runIf(built)('5: dist/server holds the copy\'s output and machine-lock.js requires it (after npm run build:server)', () => {
    const out = fs.readFileSync(path.join(DIST, 'machine-lock-sync-core.generated.js'), 'utf8');
    expect(out).toContain('function* machineLockAcquisition');
    const ml = fs.readFileSync(path.join(DIST, 'machine-lock.js'), 'utf8');
    const specs = [...ml.matchAll(/require\("([^"]*machine-lock-sync-core\.generated)"\)/g)].map((m) => m[1]);
    expect(specs.length).toBe(1);
    // the specifier resolves to the copy's output beside it
    expect(path.resolve(DIST, `${specs[0]}.js`)).toBe(path.join(DIST, 'machine-lock-sync-core.generated.js'));
    expect(ml).not.toMatch(/require\("fs"\)|require\("node:fs"\)/);
  });
});
