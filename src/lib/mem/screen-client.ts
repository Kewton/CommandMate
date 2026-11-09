/**
 * The mem settings API as the screen calls it (Issue #4221, design §11), and the
 * items of a branch (Issue #4227, design §2: `memItemsApi`). Every write
 * carries the screen's mark; the CLI has no copy of this. Answers a result rather
 * than throwing. Nothing here reaches the database or `fs`.
 *
 * @module lib/mem/screen-client
 */

import { screenRequestHeaders } from '@/lib/security/screen-request';
import type {
  MemBranchOverride,
  MemBranchRule,
  MemFeatures,
  MemItemView,
  MemKind,
  MemListResponse,
  MemModeResponse,
  MemNoticeView,
  MemRepositorySettings,
} from '@/types/mem';

export const MEM_SETTINGS_TIMEOUT_MS = 15000;

export type MemSettingsResult =
  | { ok: true; settings: MemRepositorySettings }
  | { ok: false; status: number; code?: string; settings?: MemRepositorySettings };

async function call(url: string, init?: RequestInit): Promise<MemSettingsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEM_SETTINGS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as { ok?: boolean; settings?: MemRepositorySettings; code?: string };
    if (response.ok && body.ok === true && body.settings) return { ok: true, settings: body.settings };
    return { ok: false, status: response.status ?? 0, code: body.code, settings: body.settings };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const base = (repositoryId: string) => `/api/repositories/${encodeURIComponent(repositoryId)}/mem-settings`;
const writeHeaders = () => ({ 'Content-Type': 'application/json', ...screenRequestHeaders() });

export const memSettingsApi = {
  read: (repositoryId: string) => call(base(repositoryId)),
  save: (repositoryId: string, input: { version: number; features: MemFeatures; rules: MemBranchRule[] }) =>
    call(base(repositoryId), { method: 'PUT', headers: writeHeaders(), body: JSON.stringify(input) }),
  saveOverride: (repositoryId: string, version: number, override: MemBranchOverride) =>
    call(`${base(repositoryId)}/branches`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ version, ...override }),
    }),
  removeOverride: (repositoryId: string, version: number, branch: string) =>
    call(
      `${base(repositoryId)}/branches?branch=${encodeURIComponent(branch)}&version=${encodeURIComponent(String(version))}`,
      { method: 'DELETE', headers: writeHeaders() }
    ),
};

// ---------------------------------------------------------------------------
// The items of a branch, as the screen reads and writes them (Issue #4227, design §2)
// ---------------------------------------------------------------------------

export const MEM_ITEMS_TIMEOUT_MS = 30000;

/**
 * One call's answer. A refusal keeps its code (and, for a version conflict, the item
 * stored now), so the screen can show what changed without reading again.
 */
export type MemItemsResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code?: string; reason?: string; mode?: string; item?: MemItemView; currentVersion?: number };

async function callItems<T>(url: string, init?: RequestInit): Promise<MemItemsResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEM_ITEMS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as Record<string, unknown> & { ok?: unknown };
    if (response.ok && body.ok !== false) return { ok: true, status: response.status, body: body as T };
    return {
      ok: false,
      status: response.status ?? 0,
      code: typeof body.code === 'string' ? body.code : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
      item: (body.item as MemItemView | undefined) ?? undefined,
      currentVersion: typeof body.currentVersion === 'number' ? body.currentVersion : undefined,
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** A worktree as the items screen needs it: where it is, its branch and its roster. */
export interface MemScreenWorktree {
  id: string;
  name: string;
  repositoryPath: string;
  branch?: string;
  agentInstances?: Array<{ id: string; cliTool: string; alias?: string }>;
}

export interface MemScreenWorktreesBody {
  worktrees: MemScreenWorktree[];
  repositories: Array<{ id?: string; path: string; name: string }>;
}

export interface MemScreenAddInput {
  instanceId: string;
  kind: Exclude<MemKind, 'now'>;
  text: string;
  closeWhen?: string;
  evidence?: string[];
  promoteTo?: string;
  /** Made once per press: a resend is the same item. */
  key: string;
  /** The branch the screen shows; null for a detached HEAD. */
  expectBranch: string | null;
}

export interface MemScreenUpdateInput {
  instanceId: string;
  ifVersion: number;
  text?: string;
  closeWhen?: string;
  evidence?: string[];
}

export interface MemScreenCloseInput {
  instanceId: string;
  ifVersion: number;
  reason?: string;
  /** Only for a recorded decision, after the person's two-step confirmation. */
  confirmUnreflected?: boolean;
}

const enc = encodeURIComponent;
const itemsBase = (worktreeId: string) => `/api/worktrees/${enc(worktreeId)}/mem/screen/items`;

/** Reads need no mark; every write carries it (the CLI has no copy of these). */
export const memItemsApi = {
  /** Through the worktree when there is one (its roster can write), else the repository's read. */
  list: (where: { worktreeId: string | null; repositoryId: string }, branch: string, all: boolean) =>
    callItems<MemListResponse>(
      where.worktreeId
        ? `/api/worktrees/${enc(where.worktreeId)}/mem?branch=${enc(branch)}${all ? '&all=1' : ''}`
        : `/api/repositories/${enc(where.repositoryId)}/mem?branch=${enc(branch)}${all ? '&all=1' : ''}`
    ),
  mode: (repositoryId: string, branch: string) =>
    callItems<MemModeResponse>(`/api/repositories/${enc(repositoryId)}/mem/mode?branch=${enc(branch)}`),
  notices: (repositoryId: string, branch: string) =>
    callItems<{ ok: true; notices: MemNoticeView[] }>(`/api/repositories/${enc(repositoryId)}/mem/notices?branch=${enc(branch)}`),
  acknowledgeNotice: (repositoryId: string, noticeId: string, ifVersion: number) =>
    callItems<{ ok: true }>(`/api/repositories/${enc(repositoryId)}/mem/notices/${enc(noticeId)}/acknowledge`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ ifVersion }),
    }),
  /** The worktrees and their rosters, without the session status (no tmux is asked). */
  worktrees: () => callItems<MemScreenWorktreesBody>('/api/worktrees?includeStatus=false'),
  add: (worktreeId: string, input: MemScreenAddInput) =>
    callItems<{ ok: true; item: MemItemView; replayed: boolean }>(itemsBase(worktreeId), {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),
  update: (worktreeId: string, itemId: string, input: MemScreenUpdateInput) =>
    callItems<{ ok: true; item: MemItemView }>(`${itemsBase(worktreeId)}/${enc(itemId)}`, {
      method: 'PATCH',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),
  close: (worktreeId: string, itemId: string, input: MemScreenCloseInput) =>
    callItems<{ ok: true; item: MemItemView }>(`${itemsBase(worktreeId)}/${enc(itemId)}/close`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(input),
    }),
};
