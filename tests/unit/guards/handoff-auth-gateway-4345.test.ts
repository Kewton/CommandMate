/**
 * Issue #4345 1a: the session's expiry has one gateway. In `src/`, `reportHandoffPageAuth` (the
 * registry's low-level adoption) is referenced only inside `src/lib/handoff/page-registration.ts`;
 * every page reports through `beginHandoffPageRequest` → `reportHandoffPageResponse` /
 * `reportHandoffPageAuthenticated`, which fix the owner and the order when the request leaves.
 *
 * Positive control: a copy of the page's hook under `os.tmpdir()` that calls `reportHandoffPageAuth`
 * directly is found; the real tree passes.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const GATEWAY = path.join('src', 'lib', 'handoff', 'page-registration.ts');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The files under `root/src` (relative to `root`) that name `reportHandoffPageAuth`, the gateway's own excepted. */
function bypasses(root: string): string[] {
  return sources(path.join(root, 'src'))
    .map((file) => path.relative(root, file))
    .filter((rel) => rel !== GATEWAY)
    .filter((rel) => /\breportHandoffPageAuth\b/.test(fs.readFileSync(path.join(root, rel), 'utf8')));
}

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('[#4345 1a] one gateway to the session’s expiry', () => {
  it('no source but the registry names reportHandoffPageAuth', () => {
    expect(bypasses(ROOT)).toEqual([]);
  });

  it('(positive control) a copy of the hook that reports directly is found', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-auth-gateway-'));
    const hook = path.join('src', 'hooks', 'useWorktreeDetailController.ts');
    fs.mkdirSync(path.join(tmp, 'src', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'lib', 'handoff'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, GATEWAY), path.join(tmp, GATEWAY));
    const copy = fs.readFileSync(path.join(ROOT, hook), 'utf8');
    fs.writeFileSync(path.join(tmp, hook), copy);
    expect(bypasses(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, hook), `${copy}\nimport { reportHandoffPageAuth } from '@/lib/handoff/page-registration';\nreportHandoffPageAuth(null, 'expired', 1);\n`);
    expect(bypasses(tmp)).toEqual([hook]);
  });
});
