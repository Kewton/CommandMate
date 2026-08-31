/**
 * A missing repository directory must be reported as a missing directory
 * (Issue #2165).
 *
 * `scanWorktrees` handed `git worktree list` a `cwd` that no longer existed.
 * Node reports that as `spawn /bin/sh ENOENT` — the errno belongs to the shell
 * it failed to launch, not to the directory — and since the message is neither
 * `not a git repository` nor exit 128, the scan re-threw it and
 * `scanMultipleRepositories` logged `repository:scan-failed` at ERROR. Three
 * such lines came out of every boot for seven months, and the text was actively
 * misleading: the reader goes looking at `/bin/sh` and `PATH`, which are fine.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

vi.mock('child_process', () => ({ exec: vi.fn() }));

const logs = vi.hoisted(() => ({
  info: [] as Array<[string, unknown]>,
  warn: [] as Array<[string, unknown]>,
  error: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (event: string, meta?: unknown) => logs.info.push([event, meta]),
    warn: (event: string, meta?: unknown) => logs.warn.push([event, meta]),
    error: (event: string, meta?: unknown) => logs.error.push([event, meta]),
    debug: () => {},
  }),
}));

import { scanWorktrees, scanMultipleRepositories } from '@/lib/git/worktrees';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

let sandbox: string;

/** Reproduce what Node throws when `cwd` does not exist. */
function spawnEnoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn /bin/sh ENOENT'), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'spawn /bin/sh',
  });
}

const events = (entries: Array<[string, unknown]>): string[] => entries.map(([e]) => e);

beforeEach(() => {
  sandbox = makeTempDir('scan-missing-dir-2165-');
  logs.info.length = 0;
  logs.warn.length = 0;
  logs.error.length = 0;
  vi.mocked(exec).mockImplementation(
    ((
      _cmd: string,
      _opts: unknown,
      callback: (err: Error | null, stdout: unknown, stderr: string) => void
    ) => {
      callback(null, { stdout: '', stderr: '' }, '');
      return {} as never;
    }) as never
  );
});

afterEach(() => {
  removeTempDir(sandbox);
});

describe('scanWorktrees on a directory that is gone (Issue #2165)', () => {
  it('says what is actually wrong, below ERROR, and does not spawn', async () => {
    const gone = path.join(sandbox, 'collected-by-the-os');

    const result = await scanWorktrees(gone);

    expect(result).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(logs.warn).toEqual([['repository:scan-skipped-missing-dir', { repoPath: gone }]]);
    expect(logs.error).toEqual([]);
  });

  it('never emits the misleading spawn /bin/sh ENOENT line for it', async () => {
    const gone = path.join(sandbox, 'collected-by-the-os');

    await scanMultipleRepositories([gone]);

    const rendered = JSON.stringify([...logs.error, ...logs.warn, ...logs.info]);
    expect(rendered).not.toContain('spawn /bin/sh');
    expect(events(logs.error)).not.toContain('repository:scan-failed');
  });

  it('does not abandon the other repositories in the same scan', async () => {
    const gone = path.join(sandbox, 'gone');
    const live = path.join(sandbox, 'live');
    fs.mkdirSync(live, { recursive: true });
    vi.mocked(exec).mockImplementation(
      ((
        _cmd: string,
        _opts: unknown,
        callback: (err: Error | null, stdout: unknown, stderr: string) => void
      ) => {
        callback(null, { stdout: `${live}/main abc123 [main]\n`, stderr: '' }, '');
        return {} as never;
      }) as never
    );

    const result = await scanMultipleRepositories([gone, live]);

    expect(result.map(w => w.path)).toEqual([path.join(live, 'main')]);
    expect(events(logs.error)).toEqual([]);
  });

  it('still reports a genuine git failure at ERROR', async () => {
    // The guard must not turn every scan failure into a shrug: a repository
    // that is present and fails for a real reason is still an error.
    const live = path.join(sandbox, 'live');
    fs.mkdirSync(live, { recursive: true });
    vi.mocked(exec).mockImplementation(
      ((
        _cmd: string,
        _opts: unknown,
        callback: (err: Error | null, stdout: unknown, stderr: string) => void
      ) => {
        callback(Object.assign(new Error('permission denied'), { code: 1 }), '', 'denied');
        return {} as never;
      }) as never
    );

    await scanMultipleRepositories([live]);

    expect(events(logs.error)).toEqual(['repository:scan-failed']);
  });

  it('still reports a spawn failure at ERROR when the directory really is there', async () => {
    // `spawn /bin/sh ENOENT` from a repository that exists is the case the old
    // message described — a broken shell — and must keep surfacing as an error.
    const live = path.join(sandbox, 'live');
    fs.mkdirSync(live, { recursive: true });
    vi.mocked(exec).mockImplementation(
      ((
        _cmd: string,
        _opts: unknown,
        callback: (err: Error | null, stdout: unknown, stderr: string) => void
      ) => {
        callback(spawnEnoent(), '', '');
        return {} as never;
      }) as never
    );

    await scanMultipleRepositories([live]);

    expect(events(logs.error)).toEqual(['repository:scan-failed']);
    expect(JSON.stringify(logs.error)).toContain('spawn /bin/sh ENOENT');
  });
});
