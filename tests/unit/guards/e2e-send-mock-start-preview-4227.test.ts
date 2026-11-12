/**
 * Issue #4227 (G-PR6 follow-up): an E2E file that mocks the worktree API must also mock
 * `GET …/mem/start-preview`.
 *
 * Why: G-PR6's plain send reads the start preview first and, if it cannot be read, sends nothing
 * and keeps the draft. A mock of the worktree API that answers `/send` (explicitly, or through its
 * catch-all) but not the preview makes every send in the spec a silent no-op — the 2nd time this
 * hole opened (the first was tests/setup.ts's default unit mock).
 *
 * Rule (static): a file under tests/e2e that registers a route (`.route(`) AND either handles
 * `/send` or answers `/current-output` (i.e. mocks the worktree detail API wholesale, whose
 * catch-all would take a `/send`) must call the shared `mockStartPreview(` from
 * tests/e2e/fixtures/start-preview-helpers.ts. A spec that mocks only through a fixture helper
 * has no `.route(` of its own, so it is judged by the helper's file. The helper itself is exempt.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const E2E_DIR = path.resolve(__dirname, '../../e2e');
const HELPER = path.join('fixtures', 'start-preview-helpers.ts');

export function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

export function filesMissingStartPreview(files: { name: string; text: string }[]): string[] {
  return files
    .filter(({ name, text }) => {
      if (name === HELPER) return false;
      if (!/\.route\(/.test(text)) return false;
      const mocksSend = /['"`]\/send['"`]|startsWith\(['"`]\/send/.test(text);
      const mocksWorktreeApi = /\/current-output/.test(text);
      if (!mocksSend && !mocksWorktreeApi) return false;
      return !/\bmockStartPreview\(/.test(text);
    })
    .map((f) => f.name)
    .sort();
}

const read = (dir: string) => walk(dir).map((p) => ({ name: path.relative(dir, p), text: fs.readFileSync(p, 'utf8') }));

describe('e2e send mocks carry the start-preview route (#4227)', () => {
  it('every e2e file that mocks the worktree API / /send calls mockStartPreview', () => {
    expect(filesMissingStartPreview(read(E2E_DIR))).toEqual([]);
  });

  it('control: a mock without the call is named', () => {
    const files = [
      { name: 'fixtures/a-helpers.ts', text: "await page.route(u => u, r => { if (sub.startsWith('/current-output')) {} });" },
      { name: 'b.spec.ts', text: "await page.route(u => u, r => { if (sub === '/send') {} }); await mockStartPreview(page);" },
      { name: 'c.spec.ts', text: "await expect(page).toHaveURL('/current-output');" },
    ];
    expect(filesMissingStartPreview(files)).toEqual(['fixtures/a-helpers.ts']);
  });

  it('the shared helper answers the unattended production body', () => {
    const text = fs.readFileSync(path.join(E2E_DIR, HELPER), 'utf8');
    expect(text).toContain('ok: true, show: false, attended: false');
    expect(text).toContain('/mem/start-preview');
  });
});
