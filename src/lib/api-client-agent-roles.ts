/**
 * The role API as the screen calls it (Issue #4117). Types come from
 * `@/types/agent-roles`; nothing here reaches the database or `fs`.
 *
 * Every call answers a result rather than throwing, because each refusal means
 * something different to the form that sent it (a name taken, a stale edit, a role in
 * use). The deadline covers the body as well as the headers, so a stalled answer
 * cannot hold a dialog open.
 *
 * @module lib/api-client-agent-roles
 */
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
  update: (id: string, input: { name: string; body: string; expectedBodyVersion: number }) =>
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
  setInstanceRole: (worktreeId: string, instanceId: string, role: RoleAssignmentInput) =>
    sendJson<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`, 'PUT', {
      instanceId,
      role,
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
