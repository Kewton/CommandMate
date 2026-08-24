/**
 * Env Manager — browser-side API client (Issue #1968).
 *
 * Kept out of `env-file-service.ts` so the pane never transitively imports
 * `fs/promises`. Mirrors the plain-`fetch` style of `src/lib/api/*`.
 */

import type { EnvFileDetail, EnvFileSummary } from './types';
import type { EnvIssue } from './env-parser';

/** What the pane holds after a load. */
export interface EnvManagerSnapshot {
  files: EnvFileSummary[];
  selected: EnvFileDetail | null;
}

/**
 * An API refusal, carrying the machine-readable code and — for a validation
 * failure — the value-free issue list, so the pane can point at the bad line.
 */
export class EnvApiError extends Error {
  readonly code: string;
  readonly issues: EnvIssue[];

  constructor(code: string, message: string, issues: EnvIssue[] = []) {
    super(message);
    this.name = 'EnvApiError';
    this.code = code;
    this.issues = issues;
  }
}

async function toApiError(response: Response, fallback: string): Promise<EnvApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; issues?: EnvIssue[] } }
    | null;
  return new EnvApiError(
    body?.error?.code ?? `HTTP_${response.status}`,
    body?.error?.message ?? fallback,
    body?.error?.issues ?? [],
  );
}

function envUrl(worktreeId: string, file?: string): string {
  const base = `/api/worktrees/${encodeURIComponent(worktreeId)}/env`;
  return file === undefined ? base : `${base}?file=${encodeURIComponent(file)}`;
}

/**
 * Load the file list and, when `file` is given, that file's content.
 *
 * `cache: 'no-store'` matters here: the response carries secrets, and the
 * default fetch cache would let a bfcache restore repaint them.
 */
export async function fetchEnvSnapshot(
  worktreeId: string,
  file?: string,
): Promise<EnvManagerSnapshot> {
  const response = await fetch(envUrl(worktreeId, file), { cache: 'no-store' });
  if (!response.ok) {
    throw await toApiError(response, 'Failed to load env files');
  }
  const data = (await response.json()) as { files?: EnvFileSummary[]; selected?: EnvFileDetail };
  return { files: data.files ?? [], selected: data.selected ?? null };
}

/** Save one env file. Rejects with {@link EnvApiError} carrying the issues. */
export async function saveEnvFile(
  worktreeId: string,
  file: string,
  content: string,
): Promise<{ file: EnvFileSummary; issues: EnvIssue[] }> {
  const response = await fetch(envUrl(worktreeId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, content }),
  });
  if (!response.ok) {
    throw await toApiError(response, 'Failed to save env file');
  }
  const data = (await response.json()) as { file: EnvFileSummary; issues?: EnvIssue[] };
  return { file: data.file, issues: data.issues ?? [] };
}
