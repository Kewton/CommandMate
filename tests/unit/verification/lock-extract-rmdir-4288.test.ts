/**
 * Issue #4288 — the Codex re-review of 58ec40349 (workspace runs/2026-11-09 review-4288b.md):
 *
 *   - P1: every step INSIDE a three-valued observation is three-valued too. bash's lock_obs_owner
 *     looked at cat's exit code and not at the awk that extracted the pgid after it: an extraction
 *     that failed (a non-zero exit, nothing printed) came back as an empty pgid — "no group" — and a
 *     dead runner's lock was recovered past its live gate. An extraction that failed is unknown
 *     (EUNKNOWN); a pgid key whose value is not a number is unknown (EINVAL) in the three
 *     implementations; an older owner WITHOUT a pgid key is judged by its pid alone, as before. The
 *     same for a queue ticket's fields. The scan (lock-observation-scan-4288.ts) now also finds a call
 *     inside an observer whose failure nothing reads.
 *   - P2: the rmdir of an empty <lock> left by a put-back that stopped half way, when it fails
 *     (EACCES, EIO), keeps the moved-aside record AND carries its reason — point reclaim-rmdir, the
 *     path, the errno — to the timeout, as the lock-list branch next to it does. Shown from an
 *     injected and a real failure in the three implementations, through to the product's log tail
 *     (gate-runner.ts) and precheck's "not run" line.
 *
 * Every root is a directory under os.tmpdir(); positive controls run copies of the implementation
 * with the fix taken out, written under the same directory.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { MUTEX_LOG_PREFIX, startVerification, waitForVerification } from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
import { EXIT_HELD, HEAVY_MUTEX, HEAVY_TEST_FILES, HELD, acquireMachineLockSync, main } from '../../../scripts/orchestrate/precheck.mjs';
import { OBSERVER_FUNCTIONS, scanUncheckedCalls } from './lock-observation-scan-4288';
import {
  HOST,
  IMPLS,
  REPO,
  VERIFY_RUN,
  deadPid,
  goneEntries,
  isRoot,
  killStarted,
  liveGroup,
  lockOf,
  mutatedBash,
  mutatedSync,
  readOwnerToken,
  removeRoot,
  take,
  writeOwner,
} from './lock-4288-harness';

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

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-extract-4288-')));
});
afterEach(() => {
  killStarted();
  removeRoot(root);
});

const SOURCES = {
  bash: '.claude/skills/cmate-verify/scripts/verify-run.sh',
  ts: 'src/lib/verification/machine-lock.ts',
  sync: 'scripts/orchestrate/machine-lock-sync.mjs',
} as const;
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');
const deadOwner = (token: string, extra: Record<string, unknown> = {}) => ({ pid: deadPid(), host: HOST, token, acquiredAt: 0, ...extra });

/**
 * A PATH directory whose `awk` fails — exit 1, nothing printed — when it is asked for the key `pgid`
 * (`-v key=pgid`), and is the real awk otherwise: the extraction of that one field fails, nothing else.
 */
function awkFailingOnPgid(): Record<string, string> {
  const dir = path.join(root, 'shim-bin');
  fs.mkdirSync(dir, { recursive: true });
  const realAwk = spawnSync('sh', ['-c', 'command -v awk'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(dir, 'awk'),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in key=pgid) exit 1;; esac; done\nexec ${realAwk} "$@"\n`,
    { mode: 0o755 },
  );
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/** Both layers of the P1 fix taken out of bash: the extraction's exit code and the pgid key's check. */
const UNCHECKED_EXTRACTION = (s: string) =>
  s
    .replace('LOB_PGID=$(lock_json_text_field "$lob_out" pgid) || { lock_obs_owner_fail EUNKNOWN; return 0; }', 'LOB_PGID=$(lock_json_text_field "$lob_out" pgid)')
    .replace('  if [ "$LOB_CLASS" = record ] && ! lock_pgid_field_ok "$lob_out" "$LOB_PGID"; then lock_obs_owner_fail EINVAL; fi\n', '');

describe('P1 (bash): an owner\'s pgid whose extraction failed is unknown, never "no group"', () => {
  it('the shim is not vacuous: under it the pgid extraction exits non-zero with nothing printed, the pid does not', () => {
    const script = `
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"
lock_json_text_field '{"pid":12,"pgid":34}' pgid; echo "pgid rc=$?"
lock_json_text_field '{"pid":12,"pgid":34}' pid; echo "pid rc=$?"
`;
    const run = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', script, 'bash', VERIFY_RUN], { encoding: 'utf8', env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, ...env } }).stdout.trim().split('\n');
    expect(run(awkFailingOnPgid())).toEqual(['pgid rc=1', '12', 'pid rc=0']);
    expect(run({})).toEqual(['34', 'pgid rc=0', '12', 'pid rc=0']);
  });

  it('fixed: a dead runner whose gate group lives keeps its lock, and the unknown is named (lock-owner, EUNKNOWN)', async () => {
    const name = 'extract';
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: liveGroup() }));
    const r = await take('bash', root, name, { env: awkFailingOnPgid() });
    expect(r.acquired).toBe(false);
    expect(readOwnerToken(lockOf(root, name))).toBe('t1-live-group');
    expect(r.unknown).toBe(`point=lock-owner path=${lockOf(root, name)}/owner errno=EUNKNOWN`);
  }, 30000);

  it('positive control: the extraction\'s exit code unread, the same failure recovers the live gate\'s lock', async () => {
    const name = 'extract';
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: liveGroup() }));
    const legacy = mutatedBash(root, UNCHECKED_EXTRACTION);
    const r = await take('bash', root, name, { env: awkFailingOnPgid(), bashScript: legacy, keep: true });
    expect(r.acquired, 'an empty pgid was read as "no group"').toBe(true);
  }, 30000);

  it('negative control: without the failure the same copy holds — the failure is what made the difference', async () => {
    const name = 'extract';
    writeOwner(lockOf(root, name), deadOwner('t1-live-group', { pgid: liveGroup() }));
    const r = await take('bash', root, name, { bashScript: mutatedBash(root, UNCHECKED_EXTRACTION) });
    expect(r.acquired).toBe(false);
  }, 30000);

  it('the release reads the same observation: a failed extraction defers it (the gate may still be writing)', async () => {
    const name = 'extract-release';
    const g = liveGroup();
    const r = await take('bash', root, name, {
      // Between the acquisition and the release: the owner names a live group, and the pgid cannot be extracted.
      between: { fn: () => {}, sh: `printf '{"pid":%s,"host":"%s","token":"%s","acquiredAt":0,"pgid":${g}}\\n' "$$" "$LOCK_HOST" "$LOCK_TOKEN" > "$LOCK_PATH/owner"; PATH="${awkFailingOnPgid().PATH}"` },
    });
    expect(r.acquired).toBe(true);
    expect(r.release).toBe('kept');
    expect(r.log).toContain('machine-lock-release-deferred');
  }, 30000);
});

describe('P1 (bash): a ticket\'s fields are extracted with their exit codes too', () => {
  const script = `
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$1")"
lock_ticket_retirable "$2" "$(lock_now_ms)" || echo kept
`;
  const setup = (t: Record<string, unknown>) => {
    const queue = path.join(root, 'q.queue');
    fs.mkdirSync(queue, { recursive: true });
    const ticket = path.join(queue, '000000000001');
    fs.writeFileSync(ticket, JSON.stringify(t));
    return ticket;
  };
  const run = (script_: string, ticket: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', script, 'bash', script_, ticket], { encoding: 'utf8', env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, ...env } }).stdout.trim();
  const live = () => ({ pid: deadPid(), host: HOST, token: 'a', createdAt: Date.now(), deadline: Date.now() + 60000, pgid: liveGroup() });

  it('fixed: a dead waiter whose group lives is not retired when the pgid cannot be extracted', () => {
    expect(run(VERIFY_RUN, setup(live()), awkFailingOnPgid())).toBe('kept');
  }, 30000);

  it('positive control: the extraction\'s exit code and the key check unread, the same ticket is retired as gone', () => {
    const legacy = mutatedBash(root, (s) =>
      s
        .replace('ltr_pgid=$(lock_json_text_field "$ltr_text" pgid) || return 1', 'ltr_pgid=$(lock_json_text_field "$ltr_text" pgid)')
        .replace('  lock_pgid_field_ok "$ltr_text" "$ltr_pgid" || ltr_pgid=invalid\n', ''),
    );
    expect(run(legacy, setup(live()), awkFailingOnPgid())).toBe('gone');
    expect(run(legacy, setup(live())), 'without the failure the copy keeps it too').toBe('kept');
  }, 30000);

  it('negative control: an older ticket without a pgid, its waiter dead, is retired as before', () => {
    expect(run(VERIFY_RUN, setup({ pid: deadPid(), host: HOST, token: 'a', createdAt: Date.now(), deadline: Date.now() + 60000 }))).toBe('gone');
  }, 30000);

  it('a pgid key with no number in it is not "no group": kept while the deadline lasts', () => {
    for (const pgid of ['x', -5, null]) {
      expect(run(VERIFY_RUN, setup({ pid: deadPid(), host: HOST, token: 'a', createdAt: Date.now(), deadline: Date.now() + 60000, pgid })), String(pgid)).toBe('kept');
    }
  }, 30000);
});

describe('P1 (three implementations): a pgid that is not a number is unknown; an owner without one is judged by its pid', () => {
  it.each(IMPLS.flatMap((impl) => (['x', -5, null] as unknown[]).map((pgid) => [impl, pgid] as const)))('%s: pgid %j — not taken, unknown at lock-owner with EINVAL', async (impl, pgid) => {
    const name = 'bad-pgid';
    writeOwner(lockOf(root, name), deadOwner('t1-bad', { pgid }));
    const r = await take(impl, root, name);
    expect(r.acquired).toBe(false);
    expect(readOwnerToken(lockOf(root, name))).toBe('t1-bad');
    expect(r.unknown).toBe(`point=lock-owner path=${path.join(lockOf(root, name), 'owner')} errno=EINVAL`);
  }, 30000);

  it.each(IMPLS)('%s negative: an older owner (no pgid key) whose pid is dead is recovered, as before', async (impl) => {
    const name = 'old-owner';
    writeOwner(lockOf(root, name), deadOwner('t0-old'));
    expect((await take(impl, root, name)).acquired).toBe(true);
  }, 30000);

  it.each(IMPLS)('%s negative: an older owner whose pid lives is not', async (impl) => {
    const name = 'old-owner-live';
    writeOwner(lockOf(root, name), { pid: process.pid, host: HOST, token: 't0-live', acquiredAt: 0 });
    expect((await take(impl, root, name)).acquired).toBe(false);
  }, 30000);

  it('positive control (sync JS): without the number check a pgid "x" reads as "no group" and the lock is recovered', async () => {
    const name = 'bad-pgid';
    writeOwner(lockOf(root, name), deadOwner('t1-bad', { pgid: 'x' }));
    const legacy = await mutatedSync(root, (s) =>
      s
        .replace("return pgidFieldOk(owner) ? { state: 'record', owner } : { state: 'unknown', point, code: 'EINVAL' };", "return { state: 'record', owner };")
        .replace("  if (!pgidFieldOk(record)) return { state: 'unknown', point: 'group', code: 'EINVAL' };\n", ''),
    );
    expect((await take('sync', root, name, { syncModule: legacy, keep: true })).acquired).toBe(true);
  }, 30000);
});

describe('P2: a failed rmdir of the empty <lock> keeps the moved-aside record and names point, path and errno', () => {
  const setup = (name: string) => {
    // A put-back that stopped after its mkdir (§2.7 A): an empty <lock>, and the dead holder's record aside.
    fs.mkdirSync(lockOf(root, name));
    writeOwner(path.join(root, `${name}.lock.gone-111-1`), deadOwner('dead-gone'));
  };

  it.each(IMPLS)('%s: reclaim-rmdir EIO (injected) — kept, named; once the fault clears the lock is taken', async (impl) => {
    const name = 'half-rmdir';
    setup(name);
    const injected = await take(impl, root, name, { fault: 'reclaim-rmdir=EIO' });
    expect(injected.acquired).toBe(false);
    expect(fs.existsSync(lockOf(root, name))).toBe(true);
    expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    expect(injected.unknown).toBe(`point=reclaim-rmdir path=${lockOf(root, name)} errno=EIO`);
    const after = await take(impl, root, name);
    expect(after.acquired, 'the fault cleared: taken').toBe(true);
    expect(goneEntries(root, name)).toEqual([]);
  }, 30000);

  it.skipIf(isRoot).each(IMPLS)('%s: a REAL failure (a lock root that cannot be written: EACCES) is named the same way', async (impl) => {
    const name = 'half-real';
    setup(name);
    fs.mkdirSync(path.join(root, `${name}.queue`));
    fs.chmodSync(root, 0o555);
    let r;
    try {
      r = await take(impl, root, name);
    } finally {
      fs.chmodSync(root, 0o755);
    }
    expect(r.acquired).toBe(false);
    expect(goneEntries(root, name)).toEqual([`${name}.lock.gone-111-1`]);
    expect(r.unknown).toBe(`point=reclaim-rmdir path=${lockOf(root, name)} errno=EACCES`);
  }, 30000);

  it('positive control (sync JS): the reason dropped (the code before this fix), the timeout names nothing', async () => {
    const name = 'half-rmdir';
    setup(name);
    const legacy = await mutatedSync(root, (s) =>
      s.replace("if (removed.state === 'unknown') return { kept: true, unknown: { point: 'reclaim-rmdir', path: ctx.lockPath, code: removed.code } };", "if (removed.state === 'unknown') return { kept: true };"),
    );
    const r = await take('sync', root, name, { fault: 'reclaim-rmdir=EIO', syncModule: legacy });
    expect(r.acquired).toBe(false);
    expect(r.unknown).toBeNull();
    expect(r.heldBy).toBe(`restore pending: ${path.join(root, `${name}.lock.gone-111-1`)}`);
  }, 30000);

  it('positive control (bash): the same', async () => {
    const name = 'half-rmdir';
    setup(name);
    const legacy = mutatedBash(root, (s) => s.replace('LRG_HALF="unknown:reclaim-rmdir:$1:$rmdir_err"', 'LRG_HALF=""'));
    const r = await take('bash', root, name, { fault: 'reclaim-rmdir=EIO', bashScript: legacy });
    expect(r.acquired).toBe(false);
    expect(r.unknown).toBeNull();
  }, 30000);
});

describe('P2: the rmdir\'s reason reaches what the product shows', () => {
  const tempDirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  };
  let db: Database.Database;
  let lockRoot: string;
  const halfPutBack = (name: string) => {
    fs.mkdirSync(path.join(lockRoot, `${name}.lock`));
    writeOwner(path.join(lockRoot, `${name}.lock.gone-111-1`), deadOwner('dead-gone'));
    fs.mkdirSync(path.join(lockRoot, `${name}.queue`));
  };
  const LINE = (name: string) => `unknown point=reclaim-rmdir path=${path.join(lockRoot, `${name}.lock`)} errno=EACCES`;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    lockRoot = tempDir('lock-extract-display-4288-');
    vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
    vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('lock-extract-display-index-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    for (const dir of tempDirs.splice(0)) removeRoot(dir);
  });

  it.skipIf(isRoot)('gate-runner.ts: the log tail (saved, and returned by the API) carries reclaim-rmdir, the path and EACCES', async () => {
    const repo = tempDir('lock-extract-display-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'lock-4288@example.test');
    git('config', 'user.name', 'Lock 4288');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    fs.mkdirSync(path.join(repo, '.commandmate'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.commandmate', 'verify.yaml'),
      'version: 1\ngates:\n  - id: blocked\n    command: "true"\n    timeoutSec: 60\n    mutexWaitSec: 1\n    mutex: halfway\noptions:\n  baseRef: main\n',
    );
    git('add', '-A');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'work');
    fs.writeFileSync(path.join(repo, 'work.txt'), 'agent output\n');
    upsertWorktree(db, { id: 'wt-4288r', name: 'feature/wt-4288r', path: repo, repositoryPath: repo, repositoryName: 'fixture' });
    halfPutBack('halfway');
    fs.chmodSync(lockRoot, 0o555);
    try {
      const { runId } = await startVerification({ worktreeId: 'wt-4288r', worktreePath: repo, trigger: 'api' });
      await waitForVerification(runId);
      const gate = (getVerificationRun(db, runId)?.gates ?? []).find((g) => g.gateId === 'blocked');
      expect(gate?.status).toBe('skipped');
      expect(gate?.logTail).toContain(`${MUTEX_LOG_PREFIX} ${LINE('halfway')}`);
    } finally {
      fs.chmodSync(lockRoot, 0o755);
    }
  }, 30000);

  it.skipIf(isRoot)('precheck.mjs: the "not run" line carries it', () => {
    const HEAD = 'a'.repeat(40);
    const events: string[] = [];
    const tmp = tempDir('lock-extract-display-precheck-');
    const changed = ['scripts/orchestrate/precheck.mjs'];
    halfPutBack(HEAVY_MUTEX);
    let library: ReturnType<typeof acquireMachineLockSync> | null = null;
    const deps = {
      run: (command: string, args: string[]) => {
        if (command === 'git') {
          const sub = args.slice(2);
          if (sub[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
          if (sub[0] === 'status') return { status: 0, stdout: '', stderr: '' };
          if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: changed.join('\n'), stderr: '' };
          if (sub.includes('--diff-filter=D')) return { status: 0, stdout: '', stderr: '' };
          if (sub.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
          if (sub[0] === 'log' && sub.includes('--first-parent')) return { status: 0, stdout: `${HEAD} ${'f'.repeat(40)}\n`, stderr: '' };
          if (sub[0] === 'diff-tree') return { status: 0, stdout: `${changed[0]}\n`, stderr: '' };
          throw new Error(`unexpected git ${sub.join(' ')}`);
        }
        events.push(`run ${command} ${args.slice(0, 2).join(' ')}`);
        return { status: 0, stdout: '', stderr: '' };
      },
      findTestsNaming: () => Array.from({ length: HEAVY_TEST_FILES }, (_, i) => `tests/unit/many/t${i}.test.ts`),
      estimateRelatedTests: () => 0,
      acquireHeavyLock: () => {
        fs.chmodSync(lockRoot, 0o555);
        try {
          library = acquireMachineLockSync(HEAVY_MUTEX, { root: lockRoot, timeoutMs: 0 });
        } finally {
          fs.chmodSync(lockRoot, 0o755);
        }
        return library;
      },
      home: tmp,
      now: () => new Date(Date.UTC(2026, 10, 9, 2, 0)),
      log: (line: string) => events.push(`log ${line}`),
      error: (line: string) => events.push(`error ${line}`),
    };
    const argv = ['--run-dir', path.join(tmp, 'runs', '2026-11-09'), '--issues', '4288', '--issue', '4288', '--worktree', '/wt'];
    expect(main(argv, deps)).toBe(EXIT_HELD);
    const lib = library as unknown as { unknown?: { point: string; path: string; code: string } };
    expect(lib.unknown).toEqual({ point: 'reclaim-rmdir', path: path.join(lockRoot, `${HEAVY_MUTEX}.lock`), code: 'EACCES' });
    const line = events.find((e) => e.includes(`tests ${HELD} (not run:`)) ?? '';
    expect(line).toContain(LINE(HEAVY_MUTEX));
  });
});

describe('the scan: a call inside an observer whose failure nothing reads (P1)', () => {
  it.each(IMPLS)('%s: none today', (impl) => {
    expect(scanUncheckedCalls(impl, read(SOURCES[impl]))).toEqual([]);
  });

  it('self-test (bash): the extraction of 58ec40349 — cat checked, awk not — is found, four fields of it', () => {
    const legacy = read(SOURCES.bash).replace(/ \|\| \{ lock_obs_owner_fail EUNKNOWN; return 0; \}/g, '');
    expect(legacy).not.toBe(read(SOURCES.bash));
    const found = scanUncheckedCalls('bash', legacy);
    expect(found.filter((f) => f.startsWith('lock_obs_owner:'))).toHaveLength(4);
    expect(found.some((f) => /LOB_PGID=\$\(lock_json_text_field/.test(f))).toBe(true);
  });

  it('self-test (bash): a new observer with an unchecked awk is found; the same line checked is not', () => {
    const unchecked = `${read(SOURCES.bash)}\nlock_obs_new() { # <point> <dir>\n  lon_v=$(awk -F: '{print $2}' "$2/owner")\n  echo "$lon_v"\n}\n`;
    expect(scanUncheckedCalls('bash', unchecked)).toEqual([`lock_obs_new:${unchecked.split('\n').findIndex((l) => l.startsWith('  lon_v=')) + 1}: lon_v=$(awk -F: '{print $2}' "$2/owner")`]);
    const checked = unchecked.replace(`"$2/owner")\n`, `"$2/owner") || { echo unknown; return 0; }\n`);
    expect(scanUncheckedCalls('bash', checked)).toEqual([]);
    expect(OBSERVER_FUNCTIONS.bash('lock_obs_new')).toBe(true);
  });

  it('self-test (bash): a multi-line substitution (an awk program) is checked at its closing line', () => {
    const legacy = read(SOURCES.bash).replace(`    }') || lps_val=""\n`, `    }')\n`);
    expect(legacy).not.toBe(read(SOURCES.bash));
    expect(scanUncheckedCalls('bash', legacy).map((f) => f.split(':')[0])).toEqual(['lock_pid_start_ms']);
  });

  it.each(['ts', 'sync'] as const)('self-test (%s): a throwing call moved out of the observer\'s try is found', (impl) => {
    const source = read(SOURCES[impl]);
    const marker = impl === 'ts' ? '      let text: string;\n' : '      let text;\n';
    const legacy = source.replace(marker, `${marker}      ${impl === 'ts' ? '' : 'fs.'}readFileSync(file, 'utf8');\n`);
    expect(legacy).not.toBe(source);
    const found = scanUncheckedCalls(impl, legacy);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^makeObserver:\d+: (fs\.)?readFileSync\(file, 'utf8'\);$/);
  });
});
