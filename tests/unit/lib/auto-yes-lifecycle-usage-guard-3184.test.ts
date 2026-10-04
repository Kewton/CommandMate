/**
 * Nothing releases Auto-Yes state behind the lifecycle table's back
 * (Issue #3184, design §4.2).
 *
 * Every call to the functions that disable or drop a grant, or stop pollers in
 * bulk, must sit in a file that is allowed to make it — and each allowance says
 * why. A new cleanup path that calls `deleteAutoYesStateByWorktree` directly
 * fails here and has to go through `releaseAutoYes` instead.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

/** Repo-relative path -> why it may call the release functions directly. */
const ALLOWED: Record<string, string> = {
  'src/lib/auto-yes-state.ts':
    'defines them; expiry / stop pattern / manual disable are Auto-Yes’s own conditions, not lifecycle events',
  'src/lib/auto-yes-poller.ts':
    'defines the poller half; its consecutive-errors path restates the table row (importing the table would be a cycle)',
  'src/lib/auto-yes-lifecycle.ts': 'the table itself',
  'src/app/api/worktrees/[id]/auto-yes/route.ts': 'the manual disable — a user action, not a lifecycle event',
};

const CALL = /(?<!function\s)\b(disableAutoYes|deleteAutoYesState|deleteAutoYesStateByWorktree|stopAutoYesPollingByWorktree|stopAllAutoYesPolling)\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Calls on code lines (comment lines are skipped) outside the allowlist. */
function findUnlistedCalls(files: { rel: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { rel, text } of files) {
    if (rel in ALLOWED) continue;
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (CALL.test(line)) hits.push(`${rel}:${index + 1}: ${trimmed}`);
    });
  }
  return hits;
}

function repoFiles(): { rel: string; text: string }[] {
  return [...sourceFiles(path.join(ROOT, 'src')), path.join(ROOT, 'server.ts')].map((full) => ({
    rel: path.relative(ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

describe('Auto-Yes release calls go through the lifecycle table (#3184)', () => {
  it('has no direct release call outside the allowlist', () => {
    expect(findUnlistedCalls(repoFiles())).toEqual([]);
  });

  it('every allowlisted file exists (a stale entry would hide nothing)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(() => statSync(path.join(ROOT, rel))).not.toThrow();
    }
  });

  it('positive control: a direct call in another file is reported', () => {
    const hits = findUnlistedCalls([
      { rel: 'src/lib/some-new-cleanup.ts', text: 'export function f() {\n  deleteAutoYesStateByWorktree(id);\n}' },
      { rel: 'src/lib/commented.ts', text: '// deleteAutoYesStateByWorktree(id) is not a call' },
    ]);
    expect(hits).toEqual(['src/lib/some-new-cleanup.ts:2: deleteAutoYesStateByWorktree(id);']);
  });
});
