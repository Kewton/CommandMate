/**
 * Issue #4488: vitest must not collect copies of the repository under `workspace/`.
 *
 * `npm run test:unit` is `vitest run tests/unit`; the path filter is a substring
 * match, so a gitignored copy such as `workspace/.../tests/unit/**` was collected
 * too (15409 files, red). `vitest.config.ts` therefore excludes `workspace/**`.
 *
 * The fake copy is created under `<repo>/workspace/` (not os.tmpdir()) because that
 * is exactly the location the exclude has to cover. Only the unique directory this
 * test created is removed; real contents of `workspace/` are never touched.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = process.cwd();
const WORKSPACE = path.join(REPO_ROOT, 'workspace');

let createdWorkspace = false;
let fakeCopy: string | null = null;

function makeFakeCopy(): string {
  if (!fs.existsSync(WORKSPACE)) {
    fs.mkdirSync(WORKSPACE);
    createdWorkspace = true;
  }
  const dir = fs.mkdtempSync(path.join(WORKSPACE, 'fake-copy-4488-'));
  fakeCopy = dir;
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tests', 'unit', 'fake-copy.test.ts'),
    "import { it } from 'vitest';\nit('fake', () => {});\n"
  );
  return dir;
}

function listCollectedFiles(): string[] {
  const res = spawnSync(
    'npx',
    ['vitest', 'list', '--filesOnly', '--config', 'vitest.config.ts', 'tests/unit'],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  );
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.test.ts'));
}

afterEach(() => {
  if (fakeCopy) fs.rmSync(fakeCopy, { recursive: true, force: true });
  fakeCopy = null;
  if (createdWorkspace) {
    try {
      fs.rmdirSync(WORKSPACE); // only succeeds if empty
    } catch {
      /* non-empty: someone else's content, leave it */
    }
    createdWorkspace = false;
  }
});

describe('vitest excludes workspace/ (Issue #4488)', () => {
  it('does not collect a fake repository copy under workspace/', () => {
    const dir = makeFakeCopy();
    const files = listCollectedFiles();
    const leaked = files.filter((f) => f.includes(path.basename(dir)));
    expect(leaked).toEqual([]);
  }, 120_000);

  it('still collects the real tests/unit files (negative control)', () => {
    makeFakeCopy();
    const files = listCollectedFiles();
    expect(files.some((f) => f.includes('tests/unit/guards/vitest-workspace-exclude-4488.test.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  }, 120_000);
});
