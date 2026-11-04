/**
 * The role API as the screen calls it (Issue #4117). Types come from
 * `@/types/agent-roles`; nothing here reaches the database or `fs`.
 *
 * Every call answers a result rather than throwing, because each refusal means
 * something different to the form that sent it (a name taken, a stale edit, a role in
 * use). The deadline covers the body as well as the headers, so a stalled answer
 * cannot hold a dialog open.
 *
 * The two reads of the worktree route at the end answer null when they cannot tell,
 * so "could not read" is never taken for "no revision needed" or "nothing is running".
 *
 * @module lib/api-client-agent-roles
 */
import type { AgentInstance } from '@/lib/cli-tools/types';
import { INSTANCE_CREATION_KEY_HEADER } from '@/types/agent-roles';
import type {
  AgentRoleDeleteConflictResponse,
  AgentRoleDeleteResponse,
  AgentRoleDetail,
  AgentRoleDetailResponse,
  AgentRoleEditResponse,
  AgentRoleErrorResponse,
  AgentRoleListResponse,
  InstanceRoleCreateResponse,
  InstanceRoleSettingsResponse,
  RepositoryRoleDefaultsResponse,
  RoleAssignmentInput,
  SystemRoleDefaultsResponse,
} from '@/types/agent-roles';

const ROLE_REQUEST_TIMEOUT_MS = 15000;

export type RoleApiFailure = {
  ok: false;
  /** 0: the request never got an answer. */
  status: number;
  error?: AgentRoleErrorResponse['error'];
  message?: string;
  /** The whole body, for a refusal that carries more than its code. */
  body?: unknown;
};

export type RoleApiResult<T> = { ok: true; data: T } | RoleApiFailure;

/**
 * Only a refusal (4xx) says nothing was written. A route commits before it builds its
 * answer, so a 5xx, no answer, an expired deadline or an unreadable body may all follow
 * a write that happened.
 */
export function isOutcomeUnknown(failure: RoleApiFailure): boolean {
  return !(failure.status >= 400 && failure.status < 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function request<T>(url: string, init?: RequestInit): Promise<RoleApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROLE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json();
    if (response.ok && isRecord(body) && body.success === true) {
      return { ok: true, data: body as T };
    }
    const refusal = isRecord(body) ? body : {};
    return {
      ok: false,
      status: response.status ?? 0,
      error: refusal.error as AgentRoleErrorResponse['error'] | undefined,
      message: typeof refusal.message === 'string' ? refusal.message : undefined,
      body,
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<RoleApiResult<T>> {
  return request<T>(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const roleApi = {
  list: () => request<AgentRoleListResponse>('/api/roles'),
  get: (id: string) => request<AgentRoleDetailResponse>(`/api/roles/${encodeURIComponent(id)}`),
  create: (input: { name: string; body: string }) =>
    sendJson<{ success: true; role: AgentRoleDetail }>('/api/roles', 'POST', input),
  /** Send only what changed: the version guards the body, and a name sent along would overwrite a rename. */
  update: (id: string, input: { name?: string; body?: string; expectedBodyVersion?: number }) =>
    sendJson<AgentRoleEditResponse>(`/api/roles/${encodeURIComponent(id)}`, 'PUT', input),
  remove: (id: string, options: { force?: boolean } = {}) =>
    request<AgentRoleDeleteResponse>(
      `/api/roles/${encodeURIComponent(id)}${options.force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),
  systemDefaults: () => request<SystemRoleDefaultsResponse>('/api/settings/agent-role-defaults'),
  setSystemDefault: (cliToolId: string, roleId: string | null) =>
    sendJson<SystemRoleDefaultsResponse>('/api/settings/agent-role-defaults', 'PUT', { cliToolId, roleId }),
  repositoryDefaults: (repositoryId: string) =>
    request<RepositoryRoleDefaultsResponse>(`/api/repositories/${encodeURIComponent(repositoryId)}/role-defaults`),
  setRepositoryDefault: (repositoryId: string, cliToolId: string, role: RoleAssignmentInput) =>
    sendJson<RepositoryRoleDefaultsResponse>(
      `/api/repositories/${encodeURIComponent(repositoryId)}/role-defaults`,
      'PUT',
      { cliToolId, role },
    ),
  instanceSettings: (worktreeId: string) =>
    request<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`),
  /** @param expectedRosterRevision - Refused with `roster_changed` if the roster has moved since (#4132). */
  setInstanceRole: (worktreeId: string, instanceId: string, role: RoleAssignmentInput, expectedRosterRevision?: string) =>
    sendJson<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`, 'PUT', {
      instanceId,
      role,
      ...(expectedRosterRevision === undefined ? {} : { expectedRosterRevision }),
    }),
  createInstance: (
    worktreeId: string,
    input: {
      instance: { id: string; cliTool: string; alias: string };
      role: RoleAssignmentInput;
      expectedRosterRevision?: string;
    },
  ) => sendJson<InstanceRoleCreateResponse>(`/api/worktrees/${worktreeId}/instances/roles`, 'POST', input),
};

/** The references a 409 `role_in_use` carries, or null for any other refusal. */
export function roleInUseReferences(
  failure: RoleApiFailure,
): AgentRoleDeleteConflictResponse['references'] | null {
  if (failure.error !== 'role_in_use' || !isRecord(failure.body)) return null;
  return (failure.body as unknown as AgentRoleDeleteConflictResponse).references ?? null;
}

/** What a saving roster PATCH confirmed, where it says. An older server says nothing. */
export interface RosterPatchBody {
  roster?: AgentInstance[];
  revision?: string;
}

/**
 * How a roster PATCH was answered. `saved` has only seen the headers: the body is read
 * apart, because a caller who already knows the answer is old need not wait for it.
 */
export type RosterPatchAnswer =
  | { kind: 'conflict' }
  | { kind: 'refused' }
  | { kind: 'unknown' }
  | {
      kind: 'saved';
      /** Null: the body could not be read, or the deadline passed. */
      readBody: () => Promise<RosterPatchBody | null>;
      /** Nobody will read the body: end the deadline and the connection. */
      abandon: () => void;
    };

/**
 * The roster PATCH, with one deadline over the headers and the body, as {@link request} has.
 *
 * @param idempotencyKey - What `settleInstanceCreation` asks about if the answer is lost (#4132)
 */
export async function sendRosterPatch(
  worktreeId: string,
  body: { agentInstances: AgentInstance[]; expectedRosterRevision: string },
  idempotencyKey: string,
): Promise<RosterPatchAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROLE_REQUEST_TIMEOUT_MS);
  const abandon = (): void => {
    clearTimeout(timer);
    controller.abort();
  };
  let response: Response;
  try {
    response = await fetch(`/api/worktrees/${worktreeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', [INSTANCE_CREATION_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { kind: 'unknown' };
  }
  if (!response.ok) {
    abandon();
    if (response.status === 409) return { kind: 'conflict' };
    return response.status >= 400 && response.status < 500 ? { kind: 'refused' } : { kind: 'unknown' };
  }
  return {
    kind: 'saved',
    abandon,
    readBody: async () => {
      try {
        const answer = (await response.json()) as { agentInstances?: unknown; rosterRevision?: unknown } | null;
        return {
          roster: Array.isArray(answer?.agentInstances) ? (answer.agentInstances as AgentInstance[]) : undefined,
          revision: typeof answer?.rosterRevision === 'string' ? answer.rosterRevision : undefined,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readWorktree(worktreeId: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROLE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/worktrees/${worktreeId}`, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The roster and the revision it was read with, or null when they cannot be had. Only
 * the roster's own fields: the route adds `sessionName`, which a save must not send back.
 */
export async function readWorktreeRoster(
  worktreeId: string,
): Promise<{ roster: AgentInstance[]; revision: string } | null> {
  const body = await readWorktree(worktreeId);
  if (!body || typeof body.rosterRevision !== 'string' || !Array.isArray(body.agentInstances)) return null;
  const roster = (body.agentInstances as AgentInstance[]).map(({ id, cliTool, alias, order }) => ({
    id,
    cliTool,
    alias,
    order,
  }));
  return { roster, revision: body.rosterRevision };
}

/** The instances with a running session, or null when that cannot be told. */
export async function readRunningInstances(worktreeId: string): Promise<Record<string, boolean> | null> {
  const body = await readWorktree(worktreeId);
  if (!body || !isRecord(body.sessionStatusByInstance)) return null;
  const running: Record<string, boolean> = {};
  for (const [instanceId, status] of Object.entries(body.sessionStatusByInstance)) {
    if (isRecord(status) && status.isRunning === true) running[instanceId] = true;
  }
  return running;
}
