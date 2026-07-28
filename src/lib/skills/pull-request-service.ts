/**
 * `gh` invocation for Skill install PRs (Issue #1247)
 *
 * The only place in the Skill stack that runs the GitHub CLI. Keeping it to one
 * module is what makes "no shell, argv only" a property that can be read off a
 * single file instead of audited across every call site: every invocation here
 * is `execFile('gh', [...])` with a fixed argument list, and the repository is
 * resolved from the working directory rather than from anything a client sent.
 *
 * Failures are returned, not thrown. Whether a missing `gh` is a 409 and a
 * rejected `pr create` is a 502 is a policy the caller owns; this module only
 * reports which of the two happened, with the raw text left for the caller to
 * redact before it goes anywhere.
 *
 * @module lib/skills/pull-request-service
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** `gh` reaches GitHub, so it gets more room than a local git write. */
export const SKILL_GH_TIMEOUT_MS = 30000;

export interface CreateDraftPullRequestInput {
  /** Registered worktree path; `gh` resolves the repository from it. */
  worktreePath: string;
  /** Branch the PR merges from. Already pushed. */
  head: string;
  /** Branch the PR merges into, or null to let `gh` use the repository default. */
  base: string | null;
  title: string;
  body: string;
}

export type CreateDraftPullRequestResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'tool_missing' | 'failed'; detail: string };

/**
 * URL of an open PR whose head is `branch`, or null.
 *
 * Best-effort by design: a lookup that fails answers "unknown, assume none", and
 * the caller falls through to `gh pr create`, which refuses to open a duplicate
 * itself. Treating a transient lookup failure as "a PR exists" would silently
 * skip creating the one the user asked for.
 */
export async function findOpenPullRequest(
  worktreePath: string,
  branch: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'],
      { cwd: worktreePath, timeout: SKILL_GH_TIMEOUT_MS }
    );
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const url = (parsed[0] as { url?: unknown }).url;
      if (typeof url === 'string' && url.startsWith('https://')) return url;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Open a draft PR.
 *
 * Draft is not configurable. A Skill install introduces third-party instructions
 * and scripts into the repository, so the PR exists to be read before it merges;
 * a ready-for-merge PR would invite the auto-merge this feature explicitly
 * excludes.
 */
export async function createDraftPullRequest(
  input: CreateDraftPullRequestInput
): Promise<CreateDraftPullRequestResult> {
  const args = [
    'pr',
    'create',
    '--draft',
    '--head',
    input.head,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
  if (input.base !== null) args.push('--base', input.base);

  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: input.worktreePath,
      timeout: SKILL_GH_TIMEOUT_MS,
    });
    const url = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('https://'));
    if (url === undefined) {
      return { ok: false, reason: 'failed', detail: 'gh pr create printed no pull request URL' };
    }
    return { ok: true, url };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, reason: 'tool_missing', detail: 'gh is not installed' };
    }
    return {
      ok: false,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
