/**
 * `lint-sh` passing without shellcheck reaches the user (Issue #3478).
 *
 * The decision is "warn and continue": a machine without shellcheck still
 * passes the gate. The defect was that the warning went to the gate's log, and
 * `commandmate verify` / `wait --verify` print no log for a PASS — so a pass
 * that linted nothing looked exactly like one that linted everything.
 *
 * This drives the product path end to end: the real script as a verify.yaml
 * gate, run by the real gate runner (real processes, as gate-flaky.test.ts),
 * stored in the DB, then handed — as the run route returns it — to the CLI's
 * `runVerification`, whose stderr is what the user reads.
 *
 * shellcheck is kept off the gate's PATH by a bin directory holding only `node`
 * and `git` wrappers, so the "not installed" branch is taken on every machine.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
import { runVerification } from '@/cli/utils/verify-runner';
import type { ApiClient } from '@/cli/utils/api-client';
import type { VerificationRunView } from '@/cli/types/api-responses';
import { VerifyExitCode } from '@/cli/types';
import { removeTempDir } from '@tests/helpers/temp-dir';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

const SCRIPT = join(process.cwd(), 'scripts', 'run-lint-sh-if-changed.mjs');
const GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

let db: Database.Database;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A PATH with node and git on it and nothing else (so: no shellcheck). */
function binWithoutShellcheck(): string {
  const bin = tempDir('lint-sh-notice-bin-');
  for (const [name, target] of [
    ['node', process.execPath],
    ['git', GIT],
  ]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${target}" "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

/** `main` plus a `work` branch that commits `files`, and the lint-sh gate. */
function createRepo(files: Record<string, string>): string {
  const dir = tempDir('lint-sh-notice-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'lint-sh-notice@example.test'], dir);
  git(['config', 'user.name', 'Lint Sh Notice'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    [
      'version: 1',
      'gates:',
      '  - id: lint-sh',
      `    command: "node ${SCRIPT} --base main"`,
      '    timeoutSec: 60',
      'options:',
      '  baseRef: main',
      '',
    ].join('\n')
  );
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(['add', '-A'], dir);
  git(['commit', '-m', 'work'], dir);
  return dir;
}

/** Run the gates, then read the run back through the CLI as the route serves it. */
async function verifyThroughCli(worktreeId: string, repo: string) {
  upsertWorktree(db, {
    id: worktreeId,
    name: `feature/${worktreeId}`,
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
  const { runId } = await startVerification({ worktreeId, worktreePath: repo, trigger: 'api' });
  await waitForVerification(runId);
  // The run route answers `{ run: getVerificationRun(...) }` as JSON.
  const run = JSON.parse(JSON.stringify(getVerificationRun(db, runId))) as VerificationRunView;

  const client = {
    post: vi.fn().mockResolvedValue({ runId }),
    get: vi.fn().mockResolvedValue({ run }),
  } as unknown as ApiClient;
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const outcome = await runVerification(client, { worktreeId, trigger: 'manual' });
  const lines = stderr.mock.calls.map((call) => String(call[0]));
  return { outcome, lines };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, tempDir('lint-sh-notice-locks-'));
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('lint-sh-notice-index-'));
  vi.stubEnv('PATH', binWithoutShellcheck());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('lint-sh without shellcheck, through the runner and the CLI (Issue #3478)', () => {
  it('passes, and says beside the PASS that the .sh change was not linted', async () => {
    const repo = createRepo({ 'scripts/bad.sh': '#!/bin/sh\nunused=1\n' });
    const { outcome, lines } = await verifyThroughCli('wt-lint-sh-missing', repo);

    // The decision stands: warn and continue, not fail and not "no verdict".
    expect(outcome.exitCode).toBe(VerifyExitCode.SUCCESS);
    expect(lines.some((line) => line.startsWith('GATE lint-sh PASS'))).toBe(true);

    const notices = lines.filter((line) => line.startsWith('NOTICE lint-sh: '));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('shellcheck is not installed');
    expect(notices[0]).toContain('NOT linted');
    // Right after its GATE line, so it reads as part of that verdict.
    const gateAt = lines.findIndex((line) => line.startsWith('GATE lint-sh PASS'));
    expect(lines[gateAt + 1]).toBe(notices[0]);
  });

  it('prints no notice when no .sh changed (negative control)', async () => {
    const repo = createRepo({ 'docs/readme.md': 'docs only\n' });
    const { outcome, lines } = await verifyThroughCli('wt-lint-sh-none', repo);

    expect(outcome.exitCode).toBe(VerifyExitCode.SUCCESS);
    expect(lines.some((line) => line.startsWith('GATE lint-sh PASS'))).toBe(true);
    expect(lines.filter((line) => line.startsWith('NOTICE '))).toEqual([]);
  });
});
