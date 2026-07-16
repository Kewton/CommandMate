/**
 * Worktree Server Enumeration
 * Issue #1194: listRunningWorktreeServers (D-16 / S3-004)
 *
 * The only pre-existing enumeration lives inline inside the private
 * `showAllStatus()` of `status.ts:74-92` and is not reusable. Per D-16 this
 * module adds a reusable helper and deliberately does NOT refactor `status.ts`
 * (the duplication is accepted; unification is a separate issue).
 *
 * @module worktree-servers
 */

import { readdirSync } from 'fs';
import { getPidsDir } from './env-setup';
import { getDaemonManagerFactory } from './daemon-factory';

/**
 * List issue numbers of currently running worktree servers.
 *
 * Enumerates `*.pid` files under `getPidsDir()`, extracts the issue number from
 * each file name and checks PID liveness through `IDaemonManager.isRunning()`.
 *
 * @returns Ascending list of issue numbers with a running server (empty if none
 *          or if the pids directory does not exist yet)
 */
export async function listRunningWorktreeServers(): Promise<number[]> {
  let files: string[];

  try {
    files = readdirSync(getPidsDir()).filter((file) => file.endsWith('.pid'));
  } catch {
    // pids directory may not exist yet
    return [];
  }

  const factory = getDaemonManagerFactory();
  const running: number[] = [];

  for (const file of files) {
    const issueNo = parseInt(file.replace('.pid', ''), 10);
    if (isNaN(issueNo)) {
      continue;
    }

    try {
      if (await factory.create(issueNo).isRunning()) {
        running.push(issueNo);
      }
    } catch {
      // A single unreadable PID file must not break the warning path
      continue;
    }
  }

  return running.sort((a, b) => a - b);
}
