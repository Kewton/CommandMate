/**
 * What mem asks git when it evaluates a condition (Issue #4222, design §1.4).
 *
 * Every call goes through the evaluation's {@link QueryPlan} as a `local` query
 * (`ls-remote` is `external`). Nothing here writes to the repository: no `fetch`,
 * no ref is created or moved.
 *
 * @module lib/mem/git-query
 */

import type { MemUnknownReason } from '@/types/mem';
import type { ExecResult, QueryPlan } from './query-plan';

const SHA = /^[0-9a-f]{40}$/;
const REF_NAME = /^[A-Za-z0-9._/-]{1,250}$/;

export type GitFailure = { ok: false; reason: MemUnknownReason };

function localFailure(result: ExecResult): MemUnknownReason {
  if (result.timedOut || result.aborted) return 'query_timeout';
  return 'repository_unavailable';
}

/** The commit `refs/heads/<name>` names; `null` when the ref is absent (exit 1). */
export async function readLocalRef(
  plan: QueryPlan,
  repositoryId: string,
  root: string,
  ref: string
): Promise<{ ok: true; tip: string | null } | GitFailure> {
  if (!REF_NAME.test(ref)) return { ok: false, reason: 'unexpected_response' };
  const outcome = await plan.run({
    class: 'local',
    key: `rev-parse:${repositoryId}:${ref}`,
    file: 'git',
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    cwd: root,
  });
  if (!outcome.ok) return outcome;
  const { result } = outcome;
  if (result.code === 0 && SHA.test(result.stdout.trim())) return { ok: true, tip: result.stdout.trim() };
  if (result.code === 1 && !result.timedOut && !result.aborted) return { ok: true, tip: null };
  return { ok: false, reason: localFailure(result) };
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(
  plan: QueryPlan,
  repositoryId: string,
  root: string,
  ancestor: string,
  descendant: string
): Promise<{ ok: true; ancestor: boolean } | GitFailure> {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) return { ok: false, reason: 'unexpected_response' };
  if (ancestor === descendant) return { ok: true, ancestor: true };
  const outcome = await plan.run({
    class: 'local',
    key: `merge-base:${repositoryId}:${ancestor}:${descendant}`,
    file: 'git',
    args: ['merge-base', '--is-ancestor', ancestor, descendant],
    cwd: root,
  });
  if (!outcome.ok) return outcome;
  const { result } = outcome;
  if (result.timedOut || result.aborted) return { ok: false, reason: 'query_timeout' };
  if (result.code === 0) return { ok: true, ancestor: true };
  if (result.code === 1) return { ok: true, ancestor: false };
  if (/not a valid commit|bad object|unknown revision|no such commit|not a valid object/i.test(result.stderr)) {
    return { ok: false, reason: 'objects_missing' };
  }
  return { ok: false, reason: 'repository_unavailable' };
}

/**
 * When the ref was created, in unix seconds, from its reflog's oldest entry (P1-4):
 * the time the ref was written, not a commit's time. null when the oldest entry is
 * not a creation (renamed, expired) or there is no reflog: the time is unknown.
 * `%gd` is `<name>@{<seconds>}` (git 2.49, measured); only the trailing `@{n}` is read.
 */
export async function readRefCreatedSeconds(
  plan: QueryPlan,
  repositoryId: string,
  root: string,
  name: string
): Promise<{ ok: true; seconds: number | null } | GitFailure> {
  if (!REF_NAME.test(name)) return { ok: false, reason: 'unexpected_response' };
  const outcome = await plan.run({
    class: 'local',
    key: `reflog:${repositoryId}:${name}`,
    file: 'git',
    args: ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/heads/${name}`],
    cwd: root,
  });
  if (!outcome.ok) return outcome;
  const { result } = outcome;
  if (result.timedOut || result.aborted) return { ok: false, reason: 'query_timeout' };
  if (result.code !== 0) return { ok: true, seconds: null };
  return { ok: true, seconds: parseReflogCreation(result.stdout) };
}

/** The creation second of a `reflog show --date=unix --format=%gd%x09%gs` output, or null. */
export function parseReflogCreation(stdout: string): number | null {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const oldest = lines[lines.length - 1];
  if (!oldest) return null;
  const [selector, ...rest] = oldest.split('\t');
  const subject = rest.join('\t');
  const seconds = /@\{(\d{1,12})\}$/.exec(selector ?? '')?.[1];
  if (!seconds || !subject.startsWith('branch: Created from')) return null;
  return Number(seconds);
}

/** Every head of `origin`, asked once per repository (P1-1: the key covers the whole answer). */
export async function listRemoteHeads(
  plan: QueryPlan,
  repositoryId: string,
  root: string
): Promise<{ ok: true; heads: Map<string, string> } | GitFailure> {
  const outcome = await plan.run({
    class: 'external',
    key: `ls-remote-heads:${repositoryId}`,
    file: 'git',
    args: ['ls-remote', '--heads', 'origin'],
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!outcome.ok) return outcome;
  const { result } = outcome;
  if (result.timedOut || result.aborted) return { ok: false, reason: 'query_timeout' };
  if (result.overflow) return { ok: false, reason: 'unexpected_response' };
  if (result.code === 128) return { ok: false, reason: 'offline' };
  if (result.code !== 0) return { ok: false, reason: 'remote_error' };
  const heads = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line.trim());
    if (match) heads.set(match[2], match[1]);
  }
  return { ok: true, heads };
}

/** `origin`'s URL, once per repository. */
export async function readOrigin(plan: QueryPlan, repositoryId: string, root: string): Promise<string | null> {
  const outcome = await plan.run({
    class: 'local',
    key: `origin:${repositoryId}`,
    file: 'git',
    args: ['remote', 'get-url', 'origin'],
    cwd: root,
  });
  if (!outcome.ok || outcome.result.code !== 0) return null;
  return outcome.result.stdout.split('\n')[0]?.trim() || null;
}
