/**
 * What mem asks GitHub, and how a failure is told apart (Issue #4222, design §1.2〜§1.4).
 *
 * `gh api` through the evaluation's {@link QueryPlan}. The exit code and the `HTTP <3
 * digits>` word of stderr decide the reason; stderr itself is dropped (§1.1: no raw
 * output reaches a result or a log). `lib/git/github-api.ts` folds every failure into
 * null, which cannot say "unknown, and why", so it is not used here.
 *
 * @module lib/mem/github-query
 */

import type { MemUnknownReason } from '@/types/mem';
import type { ExecResult, QueryOutcome, QueryPlan } from './query-plan';

export type GhAnswer = { ok: true; json: unknown } | { ok: false; reason: MemUnknownReason };

/** The reason of a failed `gh` run, from its exit and stderr only. */
export function classifyGhFailure(result: ExecResult): MemUnknownReason {
  if (result.missing) return 'gh_unavailable';
  if (result.timedOut || result.aborted) return 'query_timeout';
  if (result.overflow) return 'unexpected_response';
  const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
  if (status === '404') return 'not_found';
  if (status === '401') return 'unauthenticated';
  if (status === '403' || status === '429') return /rate limit/i.test(result.stderr) || status === '429' ? 'rate_limited' : 'forbidden';
  if (status && status.startsWith('5')) return 'remote_error';
  if (status) return 'remote_error';
  if (/gh auth login|not logged|authentication/i.test(result.stderr)) return 'unauthenticated';
  if (/rate limit/i.test(result.stderr)) return 'rate_limited';
  return 'offline';
}

export function readGhOutcome(outcome: QueryOutcome): GhAnswer {
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const { result } = outcome;
  if (result.code !== 0 || result.timedOut || result.aborted || result.missing || result.overflow) {
    return { ok: false, reason: classifyGhFailure(result) };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, reason: 'unexpected_response' };
  }
}

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** `gh api --hostname <host> <path>`, keyed by `key`. Refuses a value that is not a plain segment. */
export async function ghApi(plan: QueryPlan, key: string, host: string, path: string): Promise<GhAnswer> {
  if (!HOST.test(host) || path.startsWith('-') || /\s/.test(path)) return { ok: false, reason: 'unexpected_response' };
  return readGhOutcome(await plan.run({ class: 'external', key, file: 'gh', args: ['api', '--hostname', host, path] }));
}

export function repoPath(owner: string, repo: string): string | null {
  return SEGMENT.test(owner) && SEGMENT.test(repo) ? `repos/${owner}/${repo}` : null;
}

/**
 * The host allow-list (S5): `github.com`, or the host of the item's repository's
 * `origin`. Compared in lower case. Any other host is never sent the server's token.
 */
export function hostAllowed(host: string, originHost: string | null): boolean {
  const lower = host.toLowerCase();
  return lower === 'github.com' || (originHost !== null && lower === originHost.toLowerCase());
}
