/**
 * Update Command
 * Issue #1194: bundle `stop` -> `npm install -g commandmate@latest` -> `start`
 * into a single command for globally installed users.
 *
 * Design constraints (see Issue #1194 決定事項):
 * - All dependencies are imported statically at the top level (S3-011). After
 *   step 7 npm replaces the package directory, so a dynamic import()/require()
 *   at that point would fail with MODULE_NOT_FOUND.
 * - isGlobalInstall / npm execution / daemon operations are reached through
 *   separate modules so tests can seam them with vi.mock (D-9).
 * - startCommand()/stopCommand() are never called: they process.exit() on every
 *   path, which would kill this process mid-update (D-6 / S1-002).
 * - process.exit is only reached at the end of a branch, each followed by
 *   `return;` (tests stub process.exit, so execution continues).
 *
 * @module commands/update
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'fs';
import { ExitCode, getErrorMessage, type UpdateOptions } from '../types';
import { CLILogger } from '../utils/logger';
import { getPackageJsonPath } from '../utils/paths';
import { isGlobalInstall, isNpxExecution } from '../utils/install-context';
import { getEnvPath } from '../utils/env-setup';
import { getDaemonManagerFactory } from '../utils/daemon-factory';
import { viewLatestVersion, installGlobalLatest } from '../utils/npm-runner';
import { compareVersions, isComparableVersion } from '../utils/semver';
import { waitForReady } from '../utils/health-check';
import { listRunningWorktreeServers } from '../utils/worktree-servers';
import { confirm, isInteractive, closeReadline } from '../utils/prompt';
import { resolveAuthToken } from '../utils/api-client';

const logger = new CLILogger();

/** npm package name (kept as a literal: never build it from a dynamic path) */
const PACKAGE_NAME = 'commandmate';

/**
 * Execute the update command.
 *
 * @param options - `--check` (report only) and `--yes` (skip confirmation)
 */
export async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  try {
    // --- Step 0: npx gate (Issue #1319) -------------------------------------
    // `npx commandmate` runs from the npx cache, which isGlobalInstall() reports
    // as global (Issue #1195). Without this gate step 1 lets a throwaway process
    // rewrite the user's global install, and step 8 then fails its own check by
    // re-reading the npx cache's package.json instead of the new global one.
    // The gate covers --check too: "current version" under npx is whatever npx
    // happened to cache, which says nothing about the user's install.
    if (isNpxExecution()) {
      printNpxGuidance();
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // --- Step 1: install type gate -----------------------------------------
    // Known limitation (D-17 / S3-009): isGlobalInstall() also returns true for
    // a project-local `npm install commandmate`. Step 8 catches that case.
    const globalInstall = isGlobalInstall();

    if (!globalInstall && !options.check) {
      printManualUpgradeSteps();
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // --- Step 2: current version -------------------------------------------
    // Read from disk, never require('../../package.json'): that is cached at
    // module load and would still report the pre-update version at step 8
    // (S1-007). version-checker.getCurrentVersion() is also unusable here (it
    // depends on NEXT_PUBLIC_APP_VERSION and returns '0.0.0' in a plain CLI).
    const currentVersion = readInstalledVersion();

    // --- Step 3: latest version from the registry (D-15) --------------------
    const view = viewLatestVersion(PACKAGE_NAME);
    if (!view.success || !view.version) {
      logger.error(`Failed to query the npm registry: ${view.error ?? 'unknown error'}`);
      logger.info('Check your network connection and npm configuration, then try again.');
      process.exit(ExitCode.UPDATE_FAILED);
      return;
    }
    const latestVersion = view.version;

    // --- Step 4: semver comparison (3-way, never equality) ------------------
    const comparable =
      isComparableVersion(currentVersion) && isComparableVersion(latestVersion);
    const comparison = comparable ? compareVersions(currentVersion, latestVersion) : null;

    if (options.check) {
      console.log(`Current: v${currentVersion}`);
      console.log(`Latest: v${latestVersion}`);
      console.log(`Update available: ${comparison !== null && comparison < 0 ? 'yes' : 'no'}`);
      if (!globalInstall) {
        printManualUpgradeSteps();
      }
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // (d) prerelease: not comparable, do not update (D-3 / S3-005)
    if (!isComparableVersion(currentVersion)) {
      console.log(`Local version v${currentVersion} is a prerelease. Skipping update.`);
      process.exit(ExitCode.SUCCESS);
      return;
    }
    if (!isComparableVersion(latestVersion)) {
      console.log(`npm latest v${latestVersion} is a prerelease. Skipping update.`);
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // (b) up to date
    if (comparison === 0) {
      logger.success(`Already up to date (v${currentVersion})`);
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // (c) local is newer: never downgrade (migrations only move forward)
    if (comparison !== null && comparison > 0) {
      console.log(
        `Local version v${currentVersion} is newer than npm latest v${latestVersion}. Skipping update.`
      );
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // --- Step 5: warnings + confirmation ------------------------------------
    logger.info(`Update available: v${currentVersion} -> v${latestVersion}`);
    printStartupOptionsWarning();

    const worktreeServers = await listRunningWorktreeServers();
    if (worktreeServers.length > 0) {
      printWorktreeServerWarning(worktreeServers);
    }

    if (!options.yes) {
      if (!isInteractive()) {
        logger.error('Non-interactive環境では --yes が必要です');
        logger.info(`Run "${PACKAGE_NAME} update --yes" to update without a confirmation prompt.`);
        process.exit(ExitCode.CONFIG_ERROR);
        return;
      }

      const approved = await confirm(`Update ${PACKAGE_NAME} to v${latestVersion}?`, {
        default: false,
      });
      closeReadline();

      if (!approved) {
        logger.info('Update cancelled');
        process.exit(ExitCode.SUCCESS);
        return;
      }
    }

    // --- Step 6: record state and stop the main server ----------------------
    // .env must be loaded before getStatus() so protocol/bind/port resolve
    // correctly (D-13, mirroring status.ts:24-30).
    dotenvConfig({ path: getEnvPath() });

    const daemonManager = getDaemonManagerFactory().create();
    const wasRunning = await daemonManager.isRunning();

    if (wasRunning) {
      logger.info('Stopping the main server...');
      const stopped = await daemonManager.stop();
      if (!stopped) {
        logger.error('Failed to stop the server. Update aborted (nothing was changed).');
        logger.info(`Run "${PACKAGE_NAME} stop --force" and try again.`);
        process.exit(ExitCode.STOP_FAILED);
        return;
      }
      logger.success('Server stopped');
    }

    // --- Step 7: npm install -g --------------------------------------------
    logger.info(`Installing ${PACKAGE_NAME}@latest (this may take a minute)...`);
    const install = installGlobalLatest(PACKAGE_NAME);

    if (!install.success) {
      if (install.permissionDenied) {
        printPermissionDeniedGuidance();
        printRestartHint(wasRunning);
        process.exit(ExitCode.UPDATE_FAILED);
        return;
      }
      logger.error(`npm install failed: ${install.error ?? 'unknown error'}`);
      printRollbackGuidance(currentVersion, wasRunning);
      process.exit(ExitCode.UPDATE_FAILED);
      return;
    }

    // --- Step 8: verify the installed version ------------------------------
    const installedVersion = tryReadInstalledVersion();

    if (stripV(installedVersion) !== stripV(latestVersion)) {
      logger.error('npm install は成功したがバージョンを確認できませんでした');
      console.log(`  Expected: v${latestVersion}`);
      console.log(`  Found:    ${installedVersion ? `v${installedVersion}` : 'unknown'}`);
      console.log('');
      console.log(
        'グローバル以外（プロジェクトローカル）にインストールされている可能性があります。'
      );
      console.log('次のコマンドで確認してください:');
      console.log(`  npm ls -g ${PACKAGE_NAME}`);
      console.log(`  npm ls ${PACKAGE_NAME}`);
      printRollbackGuidance(currentVersion, wasRunning);
      // The server is deliberately NOT restarted here.
      process.exit(ExitCode.UPDATE_FAILED);
      return;
    }

    logger.success(`Updated to v${installedVersion}`);

    // --- Step 9: restart + health check ------------------------------------
    if (!wasRunning) {
      logger.info('The server was not running before the update, so it was not started.');
      logger.info(`Run "${PACKAGE_NAME} start --daemon" when you need it.`);
      process.exit(ExitCode.SUCCESS);
      return;
    }

    logger.info('Restarting the server...');
    // The daemon spawns `npm run start` with cwd = getPackageRoot()
    // (daemon.ts:102-107), so the restarted server uses the updated dist.
    await daemonManager.start({ dev: false });

    // (a) PID liveness is a precondition for the HTTP probe
    if (!(await daemonManager.isRunning())) {
      logger.error('サーバプロセスが再起動後に検出できませんでした');
      printManualRestartGuidance();
      process.exit(ExitCode.START_FAILED);
      return;
    }

    // (b) base URL comes from getStatus(), never re-derived here (D-13)
    const status = await daemonManager.getStatus();
    const baseUrl = status?.url;
    if (!baseUrl) {
      logger.error('サーバは起動しましたが応答を確認できませんでした');
      printManualRestartGuidance();
      process.exit(ExitCode.START_FAILED);
      return;
    }

    // (c) poll until readiness is proven
    logger.info('Waiting for the server to become ready...');
    const readiness = await waitForReady(baseUrl, { token: resolveAuthToken() });

    if (readiness === 'ready') {
      logger.success(`CommandMate v${installedVersion} is ready at ${baseUrl}`);
      printPostUpdateNotes();
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // (d) degrade: the server answers but readiness cannot be proven (D-12)
    if (readiness === 'degraded') {
      logger.warn(
        'サーバは応答していますが、マイグレーション完了は確認できませんでした（認証有効時はトークンが必要です）。'
      );
      logger.info(`"${PACKAGE_NAME} status" で確認してください。`);
      logger.info(
        'CM_AUTH_TOKEN を設定して再実行すると、厳密な確認ができます（IP 制限・自己署名証明書でも degrade します）。'
      );
      printPostUpdateNotes();
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // (e) timeout: the update itself succeeded, so no rollback guidance
    logger.error('サーバは起動しましたが応答を確認できませんでした');
    printManualRestartGuidance();
    process.exit(ExitCode.START_FAILED);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Update failed: ${message}`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}

/**
 * Read the version from the installed package.json.
 * @throws if package.json cannot be read or has no version
 */
function readInstalledVersion(): string {
  const raw = readFileSync(getPackageJsonPath(), 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const version = (parsed as { version?: unknown }).version;

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Could not read a version from ${getPackageJsonPath()}`);
  }

  return version;
}

/**
 * Read the installed version, returning '' instead of throwing.
 * Used at step 8 where an unreadable package.json is itself a failed
 * verification rather than an unexpected error.
 */
function tryReadInstalledVersion(): string {
  try {
    return readInstalledVersion();
  } catch {
    return '';
  }
}

/**
 * Strip an optional leading `v` for comparison.
 */
function stripV(version: string): string {
  return version.replace(/^v/, '');
}

/**
 * Guidance for an `npx commandmate update` run (Issue #1319).
 *
 * Nothing is changed: npx already fetched the requested version, and updating
 * the user's global install from here would be a side effect they never asked
 * this throwaway process to perform.
 */
function printNpxGuidance(): void {
  console.log('');
  console.log(`This is an npx run, so "${PACKAGE_NAME} update" will not change anything.`);
  console.log('npx fetches the requested version every time, so it has nothing to update.');
  console.log('');
  console.log(`To update a globally installed ${PACKAGE_NAME}, run:`);
  console.log(`  npm install -g ${PACKAGE_NAME}@latest`);
  console.log('');
  console.log(`Once it is installed globally, "${PACKAGE_NAME} update" handles this for you`);
  console.log('(stop the server -> install -> restart).');
  console.log('');
}

/**
 * Manual upgrade steps for non-global (development checkout) installs.
 *
 * Must say `npm run build:all`: `npm run build` is `next build` only and would
 * leave dist/server (used by `npm start`) and dist/cli stale (D-8 / S1-006).
 */
function printManualUpgradeSteps(): void {
  console.log('');
  console.log(`${PACKAGE_NAME} is not installed globally, so this command will not modify it.`);
  console.log('This looks like a git clone / development environment.');
  console.log('');
  console.log('To upgrade it manually:');
  console.log('  git pull');
  console.log('  npm install');
  console.log('  npm run build:all');
  console.log(`  ${PACKAGE_NAME} stop && ${PACKAGE_NAME} start --daemon   # or: npm start`);
  console.log('');
}

/**
 * Warn that CLI startup flags are not restored after the restart (D-4 / S1-003).
 * They are passed through process.env and are persisted nowhere
 * (pid-manager.ts:63-85 stores only the PID).
 */
function printStartupOptionsWarning(): void {
  console.log('');
  console.log('[WARN] 再起動後は .env の設定のみで起動します。');
  console.log(
    '  --auth / --auth-expire / --cert / --key / --allow-http / --allowed-ips / --trust-proxy / --port / --dev'
  );
  console.log('  を付けて起動していた場合は、update 後に手動で起動し直してください。');
  console.log(
    '  （--auth は再起動のたびに新トークンが生成されるため、既存トークンは無効化されます）'
  );
  console.log('');
}

/**
 * Warn about running worktree servers (D-10 / D-16 / S3-008).
 *
 * `npm install -g` replaces dist/ and .next/ in the shared package directory.
 * A running worktree server lazily requires route chunks from .next/server/ on
 * demand, so an untouched route hit after the swap throws MODULE_NOT_FOUND and
 * the uncaughtException handler exits the process. Hence: stop them BEFORE.
 */
function printWorktreeServerWarning(issueNumbers: number[]): void {
  console.log('');
  for (const issueNo of issueNumbers) {
    console.log(`[WARN] Issue #${issueNo} のサーバが稼働中です。`);
  }
  console.log(
    '  npm install -g はパッケージディレクトリ（dist/ / .next/）を置換するため、'
  );
  console.log('  稼働中の worktree サーバは異常終了する可能性があります。');
  console.log('  update 前に停止し、update 後に再起動することを推奨します:');
  for (const issueNo of issueNumbers) {
    console.log(
      `    ${PACKAGE_NAME} stop --issue ${issueNo}   # update 前`
    );
    console.log(
      `    ${PACKAGE_NAME} start --issue ${issueNo}  # update 後`
    );
  }
  console.log('');
}

/**
 * EACCES guidance. Never re-runs the install with elevated privileges and never
 * tells the user to do so; points at the cli-setup-guide instead.
 */
function printPermissionDeniedGuidance(): void {
  logger.error('npm install -g failed with a permission error (EACCES).');
  console.log('');
  console.log('Do not re-run this command with elevated privileges.');
  console.log('Fix the npm global directory permissions instead - see the EACCES section of');
  console.log('the CLI setup guide (docs/user-guide/cli-setup-guide.md):');
  console.log('  https://github.com/Kewton/CommandMate/blob/main/docs/user-guide/cli-setup-guide.md');
  console.log('');
}

/**
 * Step 10: rollback guidance naming the pre-update version.
 */
function printRollbackGuidance(previousVersion: string, wasRunning: boolean): void {
  console.log('');
  console.log('To roll back to the version you had before this update:');
  console.log(`  npm install -g ${PACKAGE_NAME}@${previousVersion}`);
  printRestartHint(wasRunning);
  console.log('');
}

/**
 * Remind the user to start the server again when it was stopped for the update.
 */
function printRestartHint(wasRunning: boolean): void {
  if (wasRunning) {
    console.log('');
    console.log('The server was stopped for this update. Start it again with:');
    console.log(`  ${PACKAGE_NAME} start --daemon`);
  }
}

/**
 * Guidance when the restarted server cannot be verified (no rollback: the
 * update itself succeeded).
 */
function printManualRestartGuidance(): void {
  console.log('');
  console.log('Check the server manually:');
  console.log(`  ${PACKAGE_NAME} status`);
  console.log(`  ${PACKAGE_NAME} start --daemon`);
  console.log('');
}

/**
 * Completion notes: repeat the startup-options warning (step 9(f)).
 */
function printPostUpdateNotes(): void {
  console.log('');
  console.log('Note: 再起動後は .env の設定のみで起動しています。');
  console.log(`  ${PACKAGE_NAME} status で構成を確認してください。`);
  console.log('');
}
