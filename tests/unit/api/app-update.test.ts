/**
 * Unit tests for POST /api/app/update
 * Issue #1198: one-click self-update
 *
 * Covers the four security invariants from the Issue's 決定2:
 * - the global-install gate
 * - the in-progress lock
 * - a fixed argv that no request input can reach
 * - no route-level auth (and no AUTH_EXCLUDED_PATHS entry)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn().mockReturnValue(true),
  isNpxExecution: vi.fn().mockReturnValue(false),
  ensureConfigDir: vi.fn().mockReturnValue('/home/tester/.commandmate'),
}));

vi.mock('@/lib/app-update/update-lock', () => ({
  acquireUpdateLock: vi.fn().mockReturnValue(true),
  releaseUpdateLock: vi.fn(),
}));

vi.mock('@/cli/utils/daemon-factory', () => ({
  getDaemonManagerFactory: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  openSync: vi.fn().mockReturnValue(42),
  closeSync: vi.fn(),
}));

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { POST, dynamic } from '@/app/api/app/update/route';
import { ensureConfigDir, isGlobalInstall, isNpxExecution } from '@/cli/utils/install-context';
import { acquireUpdateLock, releaseUpdateLock } from '@/lib/app-update/update-lock';
import { getDaemonManagerFactory } from '@/cli/utils/daemon-factory';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';

const unref = vi.fn();

/** Point the daemon factory at a manager reporting the given PID-file state. */
function mockDaemon(isRunning: boolean | Error) {
  vi.mocked(getDaemonManagerFactory).mockReturnValue({
    create: () => ({
      isRunning: isRunning instanceof Error
        ? vi.fn().mockRejectedValue(isRunning)
        : vi.fn().mockResolvedValue(isRunning),
    }),
  } as unknown as ReturnType<typeof getDaemonManagerFactory>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isGlobalInstall).mockReturnValue(true);
  vi.mocked(isNpxExecution).mockReturnValue(false);
  // Re-set here, not only at the vi.mock factory: clearAllMocks keeps
  // implementations, so a test that makes this throw would leak into the next.
  vi.mocked(ensureConfigDir).mockReturnValue('/home/tester/.commandmate');
  vi.mocked(acquireUpdateLock).mockReturnValue(true);
  vi.mocked(openSync).mockReturnValue(42);
  vi.mocked(spawn).mockReturnValue({ unref } as unknown as ReturnType<typeof spawn>);
  mockDaemon(true);
});

describe('Route configuration', () => {
  it('is force-dynamic so the runtime state is never prerendered', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  /**
   * 決定1: auth is middleware's job. Listing this path would hand an
   * unauthenticated caller the self-update trigger.
   */
  it('is not exempted from authentication', () => {
    expect(AUTH_EXCLUDED_PATHS).not.toContain('/api/app/update');
  });
});

describe('POST /api/app/update - fixed command guarantee', () => {
  /**
   * 決定2: the handler takes no Request, so there is no request object to build
   * a command from. This pins that structurally rather than by inspection.
   */
  it('accepts no request argument', () => {
    expect(POST.length).toBe(0);
  });

  it('spawns a fixed argv with no shell', async () => {
    await POST();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];

    expect(command).toBe(process.execPath);
    expect(args).toEqual([`${process.cwd()}/bin/commandmate.js`, 'update', '--yes']);
    expect(options).not.toHaveProperty('shell', true);
  });

  it('detaches the child and unrefs it so it survives the server it replaces', async () => {
    await POST();

    const options = vi.mocked(spawn).mock.calls[0][2];
    expect(options?.detached).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('redirects child output to the update log instead of inheriting pipes', async () => {
    await POST();

    expect(openSync).toHaveBeenCalledWith('/home/tester/.commandmate/update.log', 'a');
    expect(vi.mocked(spawn).mock.calls[0][2]?.stdio).toEqual(['ignore', 42, 42]);
    // The fd is handed to the child; leaving it open would leak it per request.
    expect(closeSync).toHaveBeenCalledWith(42);
  });
});

describe('POST /api/app/update - npx relaunch branch (Issue #1395)', () => {
  /**
   * A server started with `npx commandmate` runs from the npx cache, which
   * isGlobalInstall() reports as global (Issue #1195). It cannot rewrite a
   * global install, so instead of refusing (#1394) it now takes a dedicated
   * relaunch path: the detached child fetches a fresh npx cache and restarts
   * the daemon (§2.1). npx is checked first so the global gate cannot misroute
   * it (§5.1).
   */
  it('starts the update (202) for an npx run', async () => {
    vi.mocked(isNpxExecution).mockReturnValue(true);
    vi.mocked(isGlobalInstall).mockReturnValue(true);

    const response = await POST();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'started' });
  });

  it('spawns the hidden --relaunch-npx command with a fixed argv and no shell', async () => {
    vi.mocked(isNpxExecution).mockReturnValue(true);

    await POST();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      `${process.cwd()}/bin/commandmate.js`,
      'update',
      '--yes',
      '--relaunch-npx',
    ]);
    expect(options).not.toHaveProperty('shell', true);
    expect(options?.detached).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('takes the update lock for an npx run (concurrency is guarded)', async () => {
    vi.mocked(isNpxExecution).mockReturnValue(true);

    await POST();

    expect(acquireUpdateLock).toHaveBeenCalledTimes(1);
  });

  it('reports willRestart: true when the npx daemon is running', async () => {
    vi.mocked(isNpxExecution).mockReturnValue(true);
    mockDaemon(true);

    const response = await POST();

    await expect(response.json()).resolves.toMatchObject({ willRestart: true });
  });

  it('falls through to the global gate when npx detection fails (fails to "not npx")', async () => {
    vi.mocked(isNpxExecution).mockImplementation(() => {
      throw new Error('__dirname not available');
    });
    vi.mocked(isGlobalInstall).mockReturnValue(false);

    const response = await POST();

    // Not treated as npx; the ordinary non-global gate answers instead.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_global' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('POST /api/app/update - install type gate', () => {
  it('returns 400 for a non-global install and spawns nothing', async () => {
    vi.mocked(isGlobalInstall).mockReturnValue(false);

    const response = await POST();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_global' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed when the install type cannot be determined', async () => {
    vi.mocked(isGlobalInstall).mockImplementation(() => {
      throw new Error('realpath failed');
    });

    const response = await POST();

    expect(response.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('checks the install type before taking the lock', async () => {
    vi.mocked(isGlobalInstall).mockReturnValue(false);

    await POST();

    // Otherwise a rejected request would leave a lock behind for 10 minutes.
    expect(acquireUpdateLock).not.toHaveBeenCalled();
  });
});

describe('POST /api/app/update - concurrency lock', () => {
  it('returns 409 when an update is already in progress', async () => {
    vi.mocked(acquireUpdateLock).mockReturnValue(false);

    const response = await POST();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'in_progress' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the lock on the success path (the restart outlives this process)', async () => {
    await POST();
    expect(releaseUpdateLock).not.toHaveBeenCalled();
  });

  it('releases the lock when the spawn fails, so a retry is not blocked', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'spawn_failed' });
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #1345: the log path is resolved after the lock is taken. When
   * ensureConfigDir() throws (unwritable config dir), the lock used to be left
   * behind and every retry was refused until it expired.
   */
  it('releases the lock when the log path cannot be resolved', async () => {
    vi.mocked(ensureConfigDir).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'spawn_failed' });
    expect(releaseUpdateLock).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('surfaces the underlying reason when the log path cannot be resolved', async () => {
    vi.mocked(ensureConfigDir).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const response = await POST();

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('EACCES: permission denied') as unknown as string,
    });
  });
});

describe('POST /api/app/update - restart branch (決定3)', () => {
  it('reports willRestart: true when a PID file identifies a running daemon', async () => {
    mockDaemon(true);

    const response = await POST();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: 'started',
      willRestart: true,
      logPath: '/home/tester/.commandmate/update.log',
    });
  });

  /**
   * The regression this Issue calls out: `npm start` / build-and-start.sh leave
   * no PID file, so `commandmate update` never stops this server. Reporting
   * willRestart: true there would hang the UI until its 5-minute timeout.
   */
  it('reports willRestart: false when no PID file exists, and still spawns', async () => {
    mockDaemon(false);

    const response = await POST();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ willRestart: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports willRestart: false when the daemon check throws', async () => {
    mockDaemon(new Error('pid read failed'));

    const response = await POST();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ willRestart: false });
  });

  it('resolves willRestart before spawning, while the server can still answer', async () => {
    const order: string[] = [];
    vi.mocked(getDaemonManagerFactory).mockReturnValue({
      create: () => ({
        isRunning: vi.fn().mockImplementation(async () => {
          order.push('isRunning');
          return true;
        }),
      }),
    } as unknown as ReturnType<typeof getDaemonManagerFactory>);
    vi.mocked(spawn).mockImplementation(() => {
      order.push('spawn');
      return { unref } as unknown as ReturnType<typeof spawn>;
    });

    await POST();

    expect(order).toEqual(['isRunning', 'spawn']);
  });
});
