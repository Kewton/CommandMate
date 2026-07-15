/**
 * Tests for the root tsconfig type-check scope (Issue #1265).
 *
 * `npm run lint` is scoped to `eslint src`, so a stray .ts outside src/ is
 * invisible to it and only surfaces when CI runs `npx tsc --noEmit`. Issue #1200
 * (website/) and #1201 (scripts/spike/) both hit this. The fix anchors `include`
 * to the directories the app actually owns; these tests are the CI guard on it,
 * since no linter covers this file.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSCONFIG = path.join(REPO_ROOT, 'tsconfig.json');

const raw = JSON.parse(fs.readFileSync(TSCONFIG, 'utf-8')) as {
  include: string[];
  exclude: string[];
};

/** The files `tsc --noEmit` would actually load, via TypeScript's own resolution. */
function resolvedFiles(): string[] {
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, REPO_ROOT);
  return parsed.fileNames.map((f) => path.relative(REPO_ROOT, f));
}

describe('Issue #1265: tsconfig include is anchored, not repo-wide', () => {
  it('declares no repo-wide glob', () => {
    // `**/*.ts` is what pulled website/ and scripts/spike/ into the type-check.
    // Any pattern rooted at the repo top re-opens the whole class of bug.
    const repoWide = raw.include.filter((p) => p.startsWith('**/'));
    expect(repoWide).toEqual([]);
  });

  it('anchors every include entry to a directory the app owns', () => {
    const allowedRoots = ['src/', 'tests/', 'scripts/', '.next/types/'];
    const allowedFiles = [
      'next-env.d.ts',
      'server.ts',
      'vitest.config.ts',
      'playwright.config.ts',
    ];
    const unanchored = raw.include.filter(
      (p) => !allowedRoots.some((r) => p.startsWith(r)) && !allowedFiles.includes(p),
    );
    expect(unanchored).toEqual([]);
  });

  it('excludes the throwaway spike directory', () => {
    expect(raw.exclude).toContain('scripts/spike');
  });
});

describe('Issue #1265: resolved type-check scope', () => {
  const files = resolvedFiles();

  it('keeps src/ under the type-check', () => {
    expect(files.some((f) => f.startsWith('src/'))).toBe(true);
  });

  it('keeps tests/ under the type-check', () => {
    expect(files.some((f) => f.startsWith('tests/'))).toBe(true);
  });

  it('keeps the real scripts/ entrypoints under the type-check', () => {
    // scripts/init-db.ts runs via `npm run db:init`; it is maintained code and
    // must not lose type coverage just because the spikes next to it did.
    expect(files).toContain(path.join('scripts', 'init-db.ts'));
  });

  it('keeps server.ts under the type-check', () => {
    expect(files).toContain('server.ts');
  });

  it('leaves scripts/spike/ out of the type-check', () => {
    // These files exist on disk, so this assertion is not vacuous.
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts/spike/02-migrations.ts'))).toBe(true);
    expect(files.filter((f) => f.startsWith(path.join('scripts', 'spike')))).toEqual([]);
  });

  it('leaves website/ out of the type-check even when it holds TypeScript', () => {
    // The LP is deployed as static files with no build step, but the type-check
    // must not be what enforces that -- #1200 was forced into an HTML-only
    // constraint precisely because `**/*.ts` reached in here.
    const probe = path.join(REPO_ROOT, 'website', '__scope_probe__.ts');
    fs.writeFileSync(probe, 'export const broken: number = "not a number";\n');
    try {
      expect(resolvedFiles().some((f) => f.startsWith('website/'))).toBe(false);
    } finally {
      fs.unlinkSync(probe);
    }
  });
});
