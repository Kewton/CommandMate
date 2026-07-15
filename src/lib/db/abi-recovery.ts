/**
 * better-sqlite3 ABI mismatch detection and automatic rebuild recovery
 *
 * Issue #1263: switching Node.js versions (nvm etc.) leaves the compiled
 * better-sqlite3 addon built against the previous NODE_MODULE_VERSION, which
 * makes the server unable to open the database.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import Database from 'better-sqlite3';

/** A rebuild compiles SQLite from source in the worst case, which is slow. */
const REBUILD_TIMEOUT_MS = 300_000;

/** Guards against re-running a failing rebuild on every database open. */
let rebuildAttempted = false;

export interface RebuildResult {
  success: boolean;
  /** The npm prefix is not writable by the current user (e.g. root-owned global install). */
  permissionDenied: boolean;
  output: string;
}

/**
 * Detect the "compiled against a different Node.js version" load failure.
 *
 * Node reports `ERR_DLOPEN_FAILED` for *every* dlopen failure — a missing file,
 * a corrupt binary, or a wrong architecture all share that code — so the code
 * alone cannot identify an ABI mismatch. Node's own error format string
 * (`node_binding.cc`) is the only place `NODE_MODULE_VERSION` appears, so the
 * two together are the narrowest signal available. There is no structured field
 * carrying the ABI numbers; this was verified against Node 20 and Node 24.
 */
export function isAbiMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') {
    return false;
  }
  return error.message.includes('NODE_MODULE_VERSION');
}

/**
 * Rebuild the addon against the running Node.js version.
 *
 * Runs from `process.cwd()`, which is the package root for every path that
 * opens the database: the CLI spawns `npm run start` / `npm run dev` with the
 * install root as its cwd.
 *
 * npm resolves `node` from PATH, which is not necessarily the interpreter
 * running this process — when they differ the rebuild targets the wrong ABI and
 * "recovers" into the same mismatch. Putting process.execPath first pins the
 * rebuild to the Node.js version that actually needs the addon.
 */
export function rebuildBetterSqlite3(): RebuildResult {
  const result = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: REBUILD_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error || result.status !== 0) {
    return {
      success: false,
      permissionDenied: /EACCES|permission denied/i.test(output),
      output,
    };
  }

  return { success: true, permissionDenied: false, output };
}

function formatFailure(reason: string, permissionDenied: boolean): string {
  const lines = [
    'better-sqlite3 could not be loaded: it was built for a different Node.js version.',
    'This usually happens after switching Node.js versions (nvm, fnm, Homebrew, ...).',
    '',
    `Automatic recovery failed: ${reason}`,
    '',
    'How to fix it manually:',
  ];

  if (permissionDenied) {
    // Deliberately no sudo: root-owned files inside a user's npm prefix break
    // every later install/update, and the supported fix is a writable prefix.
    lines.push(
      '  The install directory is not writable by the current user, so the addon',
      '  cannot be rebuilt in place. Do not re-run this with sudo — root-owned',
      '  files there will break future installs and updates.',
      '',
      '  Either switch back to the Node.js version CommandMate was installed with:',
      `    node -v   (currently ${process.version}, NODE_MODULE_VERSION ${process.versions.modules})`,
      '',
      '  Or reinstall CommandMate under a Node.js version manager, which keeps',
      '  global packages in a user-owned directory:',
      '    nvm use <version> && npm install -g commandmate'
    );
  } else {
    lines.push(
      `  1. cd ${process.cwd()}`,
      '  2. npm rebuild better-sqlite3',
      '  3. Start CommandMate again',
      '',
      '  If that fails, reinstalling picks up the current Node.js version:',
      '    npm install -g commandmate'
    );
  }

  return lines.join('\n');
}

/**
 * Open the database, recovering from an ABI mismatch by rebuilding once.
 *
 * On a healthy install this is a plain `new Database(...)` inside a try/catch,
 * so it adds no startup cost.
 */
export function openDatabaseWithAbiRecovery(dbPath: string): Database.Database {
  try {
    return new Database(dbPath);
  } catch (error) {
    if (!isAbiMismatchError(error)) {
      throw error;
    }

    if (rebuildAttempted) {
      throw new Error(formatFailure('a rebuild was already attempted in this process.', false));
    }
    rebuildAttempted = true;

    console.error(
      '[commandmate] better-sqlite3 was built for a different Node.js version.\n' +
        '[commandmate] Rebuilding it automatically — this can take a few minutes...'
    );

    const result = rebuildBetterSqlite3();
    if (!result.success) {
      throw new Error(formatFailure('npm rebuild better-sqlite3 failed.', result.permissionDenied));
    }

    console.error('[commandmate] Rebuild succeeded. Continuing startup.');

    try {
      return new Database(dbPath);
    } catch (retryError) {
      if (isAbiMismatchError(retryError)) {
        throw new Error(
          formatFailure('the addon still reports a version mismatch after rebuilding.', false)
        );
      }
      throw retryError;
    }
  }
}

/** Test-only: reset the once-per-process rebuild guard. */
export function resetAbiRecoveryStateForTests(): void {
  rebuildAttempted = false;
}
