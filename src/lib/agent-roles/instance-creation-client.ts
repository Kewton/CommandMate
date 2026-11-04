/**
 * The screen's conditional role requests (Issue #4132): a create with its key, and a
 * rename saying which name it replaces. Each is `roleApi`'s call plus a header, and answers
 * the same result. Free of the database and of `fs`, so a client component can import it.
 *
 * @module lib/agent-roles/instance-creation-client
 */
import type { RoleApiResult } from '@/lib/api-client-agent-roles';
import {
  EXPECTED_ROLE_NAME_HEADER,
  INSTANCE_CREATION_KEY_HEADER,
  type AgentRoleEditResponse,
  type AgentRoleErrorResponse,
  type InstanceCreationSettleResponse,
  type InstanceRoleCreateResponse,
  type RoleAssignmentInput,
} from '@/types/agent-roles';

const REQUEST_TIMEOUT_MS = 15000;

async function sendWithHeader<T>(
  url: string,
  method: 'POST' | 'PUT',
  body: unknown,
  header: Record<string, string>,
): Promise<RoleApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...header },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const answer = (await response.json()) as Record<string, unknown> | null;
    if (response.ok && answer?.success === true) return { ok: true, data: answer as T };
    return {
      ok: false,
      status: response.status ?? 0,
      error: answer?.error as AgentRoleErrorResponse['error'] | undefined,
      message: typeof answer?.message === 'string' ? answer.message : undefined,
      body: answer,
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** `roleApi.createInstance` with a key, which {@link settleInstanceCreation} can ask about. */
export function createInstanceWithKey(
  worktreeId: string,
  input: {
    instance: { id: string; cliTool: string; alias: string };
    role: RoleAssignmentInput;
    expectedRosterRevision?: string;
  },
  idempotencyKey: string,
): Promise<RoleApiResult<InstanceRoleCreateResponse>> {
  return sendWithHeader(`/api/worktrees/${worktreeId}/instances/roles`, 'POST', input, {
    [INSTANCE_CREATION_KEY_HEADER]: idempotencyKey,
  });
}

/** `roleApi.update` for an edit that renames: refused if the name is no longer `expectedName`. */
export function updateRoleExpectingName(
  id: string,
  input: { name: string; body?: string; expectedBodyVersion?: number },
  expectedName: string,
): Promise<RoleApiResult<AgentRoleEditResponse>> {
  return sendWithHeader(`/api/roles/${encodeURIComponent(id)}`, 'PUT', input, {
    [EXPECTED_ROLE_NAME_HEADER]: encodeURIComponent(expectedName),
  });
}

/**
 * A key for one create request. `getRandomValues` because `randomUUID` exists only in a
 * secure context, and this screen is also served over plain http on a LAN.
 */
export function newInstanceCreationKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What a create or a roster PATCH whose answer was lost came to. A `cancelled` holds from
 * then on: the request makes nothing, even if it is still on its way.
 *
 * @returns null when the server gave no usable answer: nothing has been settled
 */
export async function settleInstanceCreation(
  worktreeId: string,
  idempotencyKey: string,
): Promise<InstanceCreationSettleResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/worktrees/${worktreeId}/instances/roles/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<InstanceCreationSettleResponse> | null;
    return body?.outcome === 'committed' || body?.outcome === 'cancelled'
      ? (body as InstanceCreationSettleResponse)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
