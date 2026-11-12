/**
 * The comment a promote writes on an Issue / PR, and how its outcome is told
 * (Issue #4225, design §3.2・§3.4).
 *
 * - Every call names the destination's host with `--hostname` (design ⑤).
 * - The poster is fixed (re-review R2・R3): the token is read once with
 *   `gh auth token --hostname`, and the check of the poster and the POST both run
 *   with that token in **all four** variables gh reads (`GH_TOKEN`, `GITHUB_TOKEN`,
 *   `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`). gh picks the pair by its own
 *   classification of the host (github.com and `*.ghe.com` read the first pair, an
 *   Enterprise Server the second); E keeps no classification, so no branch of it can
 *   disagree with gh's. The token stays in the child's environment: never in an
 *   argument, the database, a log or an answer.
 * - The body goes as JSON on stdin (`--input -`), never as an argument.
 * - The outcome: a definite failure (a 4xx but 408 / 429, gh missing) is not sent;
 *   a timeout, an abort, a 5xx, 408 / 429, no status at all or an unreadable answer is
 *   unknown — never read as not sent (§3.1).
 *
 * This is the one place under `src/` that passes `--method` to `gh`
 * (`tests/unit/guards/mem-promote-no-git-write-4225.test.ts`).
 *
 * @module lib/promote/github-write
 */

import { execFile } from 'child_process';
import { repoPath } from '@/lib/mem/github-query';
import type { ExecResult } from '@/lib/mem/query-plan';
import { PROMOTE_GH_TIMEOUT_MS, type IssueCommentDestination } from './model';

export interface GhCall {
  args: string[];
  /** Written to the child's stdin. */
  input?: string;
  /** Added to the child's environment (the fixed token). */
  env?: Record<string, string>;
}

export type GhRun = (call: GhCall) => Promise<ExecResult>;

const MAX_BUFFER = 8 * 1024 * 1024;

/** `execFile('gh', …)`, no shell, no prompt. */
export const defaultGhRun: GhRun = (call) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      'gh',
      call.args,
      {
        timeout: PROMOTE_GH_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', ...(call.env ?? {}) },
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false, aborted: false, missing: false, overflow: false });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout: out,
          stderr: err,
          timedOut: e.killed === true,
          aborted: e.name === 'AbortError',
          missing: e.code === 'ENOENT',
          overflow: e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(call.input ?? '');
  });

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** The four variables gh reads a token from, all set to the one token (R3). */
export const GH_TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

export function fixedTokenEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GH_TOKEN_VARIABLES) env[name] = token;
  return env;
}

function parseJson(result: ExecResult): unknown {
  if (result.code !== 0 || result.timedOut || result.aborted || result.missing || result.overflow) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

/** `gh auth token --hostname <host>`: the token, or null. */
export async function readGhToken(run: GhRun, host: string): Promise<string | null> {
  if (!HOST.test(host)) return null;
  const result = await run({ args: ['auth', 'token', '--hostname', host] });
  if (result.code !== 0 || result.missing || result.timedOut) return null;
  const token = result.stdout.trim();
  return token.length > 0 && !/\s/.test(token) ? token : null;
}

export interface GhUser {
  id: number;
  login: string;
}

/** `gh api --hostname <host> user` (with the fixed token when given). */
export async function readGhUser(run: GhRun, host: string, env?: Record<string, string>): Promise<GhUser | null> {
  if (!HOST.test(host)) return null;
  const json = parseJson(await run({ args: ['api', '--hostname', host, 'user'], env })) as { id?: unknown; login?: unknown } | undefined;
  return json && typeof json.id === 'number' && typeof json.login === 'string' ? { id: json.id, login: json.login } : null;
}

const issuePath = (dest: IssueCommentDestination): string | null => {
  const repo = repoPath(dest.owner, dest.repo);
  return repo ? `${repo}/issues/${dest.number}` : null;
};

/** `gh api --hostname <host> repos/<o>/<r>/issues/<N>`: the Issue's JSON, or null. */
export async function readGhIssue(run: GhRun, dest: IssueCommentDestination, env?: Record<string, string>): Promise<unknown> {
  const path = issuePath(dest);
  if (!path || !HOST.test(dest.host)) return null;
  return parseJson(await run({ args: ['api', '--hostname', dest.host, path], env })) ?? null;
}

export type CommentPostOutcome =
  | { outcome: 'success'; commentId: number; url: string; userId: number | null }
  | { outcome: 'failure'; reason: string }
  | { outcome: 'unknown'; reason: 'timeout' | 'remote_error' | 'unexpected_response' };

/** Which outcome a POST's result is (design §3.2's table). */
export function classifyCommentPost(result: ExecResult): CommentPostOutcome {
  if (result.missing) return { outcome: 'failure', reason: 'gh_unavailable' };
  if (result.timedOut || result.aborted) return { outcome: 'unknown', reason: 'timeout' };
  if (result.overflow) return { outcome: 'unknown', reason: 'unexpected_response' };
  if (result.code === 0) {
    const json = parseJson(result) as { id?: unknown; html_url?: unknown; node_id?: unknown; user?: { id?: unknown } } | undefined;
    if (json && typeof json.id === 'number' && typeof json.html_url === 'string' && typeof json.node_id === 'string') {
      return { outcome: 'success', commentId: json.id, url: json.html_url, userId: typeof json.user?.id === 'number' ? json.user.id : null };
    }
    return { outcome: 'unknown', reason: 'unexpected_response' };
  }
  const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
  if (status && status.startsWith('4') && status !== '408' && status !== '429') return { outcome: 'failure', reason: `http_${status}` };
  return { outcome: 'unknown', reason: 'remote_error' };
}

/** POST the comment, with the fixed token. */
export async function postGhComment(
  run: GhRun,
  dest: IssueCommentDestination,
  body: string,
  env: Record<string, string>
): Promise<CommentPostOutcome> {
  const path = issuePath(dest);
  if (!path || !HOST.test(dest.host)) return { outcome: 'failure', reason: 'invalid_destination' };
  const result = await run({
    args: ['api', '--method', 'POST', '--hostname', dest.host, `${path}/comments`, '--input', '-'],
    input: JSON.stringify({ body }),
    env,
  });
  return classifyCommentPost(result);
}

export interface ListedComment {
  id: number;
  url: string;
  userId: number | null;
  body: string;
}

/** Every comment of the Issue (GET, `--paginate`), one JSON object a line; null when it could not be read. */
export async function listGhComments(run: GhRun, dest: IssueCommentDestination): Promise<ListedComment[] | null> {
  const path = issuePath(dest);
  if (!path || !HOST.test(dest.host)) return null;
  const result = await run({
    args: [
      'api',
      '--hostname',
      dest.host,
      '--paginate',
      `${path}/comments?per_page=100`,
      '--jq',
      '.[] | {id: .id, html_url: .html_url, body: .body, user: {id: .user.id}}',
    ],
  });
  if (result.code !== 0 || result.timedOut || result.aborted || result.missing || result.overflow) return null;
  const out: ListedComment[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const json = JSON.parse(line) as { id?: unknown; html_url?: unknown; body?: unknown; user?: { id?: unknown } };
      if (typeof json.id !== 'number') return null;
      out.push({
        id: json.id,
        url: typeof json.html_url === 'string' ? json.html_url : '',
        userId: typeof json.user?.id === 'number' ? json.user.id : null,
        body: typeof json.body === 'string' ? json.body : '',
      });
    } catch {
      return null;
    }
  }
  return out;
}
