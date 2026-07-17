/**
 * POST /api/app/update
 * Issue #1198: one-click self-update from the update notification banner.
 *
 * Security constraints (Issue #1198 決定1 / 決定2):
 * - Authentication is middleware's job (`src/middleware.ts` matches every
 *   non-asset path). This route implements no auth check of its own, and
 *   `/api/app/update` must never be added to AUTH_EXCLUDED_PATHS.
 * - Auth is OFF by default (`isAuthEnabled()` is `!!storedTokenHash`), so auth
 *   alone is not the control. The real controls are: a fixed argv that no part
 *   of the request can influence, the global-install gate, and the lock.
 * - POST takes no Request parameter, so request-derived command building is
 *   structurally impossible rather than merely avoided.
 *
 * @module api/app/update
 */

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { join } from 'path';
import { NextResponse } from 'next/server';
// Cross-layer import from the CLI utils, matching the update-check route [CONS-001].
import { ensureConfigDir, isGlobalInstall } from '@/cli/utils/install-context';
import { getDaemonManagerFactory } from '@/cli/utils/daemon-factory';
import { acquireUpdateLock, releaseUpdateLock } from '@/lib/app-update/update-lock';

// The response depends on runtime state (install type, PID file), so it must
// never be prerendered at build time — same rationale as update-check [FIX-270].
export const dynamic = 'force-dynamic';

/** Log file name for the detached update process */
const UPDATE_LOG_FILENAME = 'update.log';

/** Success payload (HTTP 202) */
export interface UpdateStartResponse {
  status: 'started';
  /**
   * Whether the update will stop and restart this server.
   *
   * `commandmate update` only touches the server when a PID file exists
   * (update.ts:154). A server started by `npm start` / build-and-start.sh has
   * none, so the update installs the new version and leaves this process
   * running the old one. The client MUST NOT wait for a restart in that case.
   */
  willRestart: boolean;
  /** Absolute path of the update log, surfaced for troubleshooting */
  logPath: string;
}

/** Failure payload */
export interface UpdateErrorResponse {
  error: string;
  code: 'not_global' | 'in_progress' | 'spawn_failed';
}

type UpdateResponse = UpdateStartResponse | UpdateErrorResponse;

/**
 * Global-install detection that treats a detection failure as "not global".
 * Failing closed keeps the spawn off any install we could not positively
 * identify.
 */
function isGlobalInstallSafe(): boolean {
  try {
    return isGlobalInstall();
  } catch {
    return false;
  }
}

/**
 * Whether `commandmate update` will stop and restart this server.
 * A detection failure reports false, which sends the client down the
 * "restart manually" path instead of waiting forever for a restart.
 */
async function willUpdateRestartServer(): Promise<boolean> {
  try {
    return await getDaemonManagerFactory().create().isRunning();
  } catch {
    return false;
  }
}

/**
 * Launch `commandmate update --yes` detached from this process.
 *
 * The server is the thing being replaced, so the child must outlive it:
 * `detached: true` + `unref()` + a log file instead of inherited pipes.
 *
 * The binary is addressed as `<cwd>/bin/commandmate.js` run by the current
 * node: the daemon spawns the server with `cwd = getPackageRoot()`
 * (daemon.ts:102-107), `bin/commandmate.js` is the package's declared bin
 * entry, and process.execPath avoids depending on PATH. No shell is involved.
 *
 * @param logPath - File the child's stdout/stderr are appended to
 */
function spawnUpdate(logPath: string): void {
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'bin', 'commandmate.js'), 'update', '--yes'],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: process.cwd(),
      }
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

/**
 * POST handler.
 *
 * Deliberately parameterless: see the module header. Do not add a `request`
 * parameter — the fixed-command guarantee rests on it.
 */
export async function POST(): Promise<NextResponse<UpdateResponse>> {
  if (!isGlobalInstallSafe()) {
    return NextResponse.json(
      {
        error: 'CommandMate is not installed globally and cannot update itself.',
        code: 'not_global' as const,
      },
      { status: 400 }
    );
  }

  if (!acquireUpdateLock()) {
    return NextResponse.json(
      { error: 'An update is already in progress.', code: 'in_progress' as const },
      { status: 409 }
    );
  }

  // Everything from here to the spawn runs under the lock, so every failure
  // path in between must release it — ensureConfigDir() throws on an
  // unwritable config dir, and a lock left behind blocks retries for
  // UPDATE_LOCK_TIMEOUT_MS [FIX-1345].
  let willRestart: boolean;
  let logPath: string;

  try {
    // Resolved before the spawn: once the child stops the server, this process
    // can be gone before it would have had a chance to answer.
    willRestart = await willUpdateRestartServer();
    logPath = join(ensureConfigDir(), UPDATE_LOG_FILENAME);
    spawnUpdate(logPath);
  } catch (error) {
    // Nothing was started, so the lock must not sit until it expires.
    releaseUpdateLock();
    return NextResponse.json(
      {
        error: `Failed to start the update process: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        code: 'spawn_failed' as const,
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { status: 'started' as const, willRestart, logPath },
    { status: 202 }
  );
}
