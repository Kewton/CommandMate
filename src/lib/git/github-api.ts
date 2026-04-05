/**
 * GitHub API utilities via gh CLI
 * Issue #630: Issue context in report
 *
 * Security:
 * - Uses execFile (not exec) to prevent command injection
 * - Repository path (cwd) is from DB only (trusted source)
 * - Graceful degradation: all errors return null / empty array
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@/lib/logger';
import type { IssueInfo } from '@/types/git';
import {
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUES_PER_REPORT,
  ISSUE_FETCH_TIMEOUT_MS,
} from '@/config/review-config';
import { extractIssueNumbers } from '@/lib/git/git-utils';

const logger = createLogger('github-api');
const execFileAsync = promisify(execFile);

/**
 * Check whether gh CLI is available on the current system.
 */
async function isGhCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a single GitHub Issue's information via gh CLI.
 *
 * @param issueNumber - Issue number to fetch
 * @param repoPath - Repository path (cwd for gh command)
 * @param repositoryName - Human-readable repository name for display
 * @returns IssueInfo or null on any error (graceful degradation)
 */
export async function getIssueInfo(
  issueNumber: number,
  repoPath: string,
  repositoryName: string
): Promise<IssueInfo | null> {
  try {
    const available = await isGhCliAvailable();
    if (!available) {
      logger.debug('gh-cli-unavailable', { issueNumber });
      return null;
    }

    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,state'],
      { cwd: repoPath, timeout: ISSUE_FETCH_TIMEOUT_MS }
    );

    const parsed = JSON.parse(stdout) as {
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string } | string>;
      state: string;
    };

    const labels = parsed.labels.map((l) =>
      typeof l === 'string' ? l : l.name
    );

    const bodySummary = (parsed.body ?? '').slice(0, MAX_ISSUE_BODY_LENGTH);

    return {
      repositoryName,
      number: parsed.number,
      title: parsed.title,
      labels,
      state: parsed.state,
      bodySummary,
    };
  } catch (err) {
    logger.debug('get-issue-info-failed', { issueNumber, repositoryName, error: String(err) });
    return null;
  }
}

/**
 * Collect Issue information for all issue numbers referenced in commit messages,
 * across all provided repositories.
 *
 * @param repositories - List of repositories to search issues in
 * @param commitMessages - Array of commit message strings
 * @returns Array of IssueInfo (partial failures are silently skipped)
 */
export async function collectIssueInfos(
  repositories: Array<{ id: string; name: string; path: string }>,
  commitMessages: string[]
): Promise<IssueInfo[]> {
  const issueNumbers = extractIssueNumbers(commitMessages).slice(0, MAX_ISSUES_PER_REPORT);

  if (issueNumbers.length === 0 || repositories.length === 0) {
    return [];
  }

  // Fetch issues in parallel across all repos x issue numbers
  const tasks: Array<Promise<IssueInfo | null>> = [];
  for (const repo of repositories) {
    for (const num of issueNumbers) {
      tasks.push(getIssueInfo(num, repo.path, repo.name));
    }
  }

  const results = await Promise.allSettled(tasks);

  const infos: IssueInfo[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      infos.push(result.value);
    }
  }

  return infos;
}
