/**
 * Browser client for the Skill Catalog API (Issue #1232)
 *
 * The UI reads the Catalog only through `GET /api/skills` and
 * `GET /api/skills/[id]` (#1231); it never fetches or parses the upstream
 * Catalog itself, so server and client can never disagree about what a Skill is
 * or whether it is compatible.
 *
 * A failed retrieval is a distinct result from an empty Catalog: `ok: false`
 * carries the machine code so the UI can say "could not load" rather than
 * rendering a reassuring empty list (受入条件: Catalog errorを空Catalogとして誤表示しない).
 *
 * @module components/skills/skills-client
 */

import type {
  SkillApiErrorResponse,
  SkillDetailResponse,
  SkillInstallApplyResponse,
  SkillInstallPlanResponse,
  SkillListResponse,
  SkillUninstallApplyResponse,
  SkillUninstallBlocker,
  SkillUninstallPlanResponse,
} from './types';

/** Code used when the request never produced a JSON error body. */
export const SKILL_CATALOG_UNREACHABLE = 'SKILL_CATALOG_UNREACHABLE';

/**
 * Fallback code for a write request that failed without a typed code.
 *
 * The shared worktree guard answers `{ error }` with no `code`, so a write can
 * legitimately fail without naming a Skill error. Reporting it as a Catalog
 * problem would send the user looking in the wrong place.
 */
export const SKILL_REQUEST_FAILED = 'SKILL_REQUEST_FAILED';

export interface SkillFetchFailure {
  code: string;
  message: string;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /**
   * Paths a refused uninstall named as responsible. Present only when the API
   * supplied them; the UI must not invent a reason the server did not give.
   */
  blockers?: SkillUninstallBlocker[];
  /** i18n key naming what to do next, when the refusal carried one. */
  nextActionKey?: string;
}

export type SkillFetchResult<T> = { ok: true; data: T } | { ok: false; failure: SkillFetchFailure };

function isApiError(value: unknown): value is SkillApiErrorResponse {
  if (!value || typeof value !== 'object') return false;
  const { error, code } = value as Record<string, unknown>;
  return typeof error === 'string' && typeof code === 'string';
}

/**
 * Turn an error body into a failure, keeping whatever the server actually said.
 *
 * `blockers` and `nextActionKey` only survive when the response carried them,
 * so a screen rendering them is always rendering a server fact.
 */
function toFailure(body: unknown, status: number, fallbackCode: string): SkillFetchFailure {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const failure: SkillFetchFailure = {
    code: isApiError(body) ? body.code : fallbackCode,
    message: typeof record.error === 'string' ? record.error : '',
    status,
  };
  if (Array.isArray(record.blockers)) {
    failure.blockers = record.blockers as SkillUninstallBlocker[];
  }
  if (typeof record.nextActionKey === 'string') {
    failure.nextActionKey = record.nextActionKey;
  }
  return failure;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<SkillFetchResult<T>> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    return { ok: false, failure: toFailure(body, response.status, SKILL_CATALOG_UNREACHABLE) };
  }
  return { ok: true, data: body as T };
}

async function postJson<T>(
  url: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<SkillFetchResult<T>> {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    return { ok: false, failure: toFailure(body, response.status, SKILL_REQUEST_FAILED) };
  }
  return { ok: true, data: body as T };
}

/**
 * Run a Catalog request, turning transport failures into a result.
 *
 * An abort is rethrown rather than reported: a cancelled request has no
 * outcome to show, and rendering it as an error would flash a false failure
 * whenever the user navigates away mid-fetch.
 */
async function request<T>(
  perform: () => Promise<SkillFetchResult<T>>,
  fallbackCode: string,
  signal?: AbortSignal
): Promise<SkillFetchResult<T>> {
  try {
    return await perform();
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ok: false,
      failure: {
        code: fallbackCode,
        message: error instanceof Error ? error.message : '',
        status: null,
      },
    };
  }
}

export function fetchSkillList(signal?: AbortSignal): Promise<SkillFetchResult<SkillListResponse>> {
  return request(
    () => getJson<SkillListResponse>('/api/skills', signal),
    SKILL_CATALOG_UNREACHABLE,
    signal
  );
}

export function fetchSkillDetail(
  skillId: string,
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillDetailResponse>> {
  return request(
    () => getJson<SkillDetailResponse>(`/api/skills/${encodeURIComponent(skillId)}`, signal),
    SKILL_CATALOG_UNREACHABLE,
    signal
  );
}

/**
 * Route for an operation on one Skill in one worktree.
 *
 * The worktree ID is the only location input any of these routes accept: the
 * server resolves it to a trusted path. Nothing the browser holds — no
 * filesystem path, no artifact URL — is ever part of the request.
 */
function operationUrl(worktreeId: string, skillId: string, operation: string): string {
  return `/api/worktrees/${encodeURIComponent(worktreeId)}/skills/${encodeURIComponent(skillId)}/${operation}`;
}

export interface SkillInstallPlanRequest {
  /** Omitted to plan the recommended version. */
  version?: string;
  acknowledgeRisk?: boolean;
}

/**
 * Build an Install Plan.
 *
 * Optional fields are omitted rather than sent as `null`: the route rejects a
 * body key it does not expect, and `undefined` would be dropped by
 * `JSON.stringify` anyway, so building the object explicitly keeps the wire
 * body and the accepted key list in step.
 */
export function createSkillInstallPlan(
  worktreeId: string,
  skillId: string,
  options: SkillInstallPlanRequest = {},
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillInstallPlanResponse>> {
  const payload: Record<string, unknown> = {};
  if (options.version) payload.version = options.version;
  if (options.acknowledgeRisk) payload.acknowledgeRisk = true;

  return request(
    () =>
      postJson<SkillInstallPlanResponse>(
        operationUrl(worktreeId, skillId, 'plan'),
        payload,
        signal
      ),
    SKILL_REQUEST_FAILED,
    signal
  );
}

export interface SkillInstallApplyRequest {
  planToken: string;
  /** Must equal the version the plan was built for, or the token is refused. */
  version: string;
  acknowledgeRisk?: boolean;
  idempotencyKey?: string;
}

export function applySkillInstall(
  worktreeId: string,
  skillId: string,
  apply: SkillInstallApplyRequest,
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillInstallApplyResponse>> {
  const payload: Record<string, unknown> = {
    planToken: apply.planToken,
    version: apply.version,
  };
  if (apply.acknowledgeRisk) payload.acknowledgeRisk = true;
  if (apply.idempotencyKey) payload.idempotencyKey = apply.idempotencyKey;

  return request(
    () =>
      postJson<SkillInstallApplyResponse>(
        operationUrl(worktreeId, skillId, 'install'),
        payload,
        signal
      ),
    SKILL_REQUEST_FAILED,
    signal
  );
}

/** Build an Uninstall Plan. The route accepts no body parameters at all. */
export function createSkillUninstallPlan(
  worktreeId: string,
  skillId: string,
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillUninstallPlanResponse>> {
  return request(
    () =>
      postJson<SkillUninstallPlanResponse>(
        operationUrl(worktreeId, skillId, 'uninstall-plan'),
        {},
        signal
      ),
    SKILL_REQUEST_FAILED,
    signal
  );
}

export interface SkillUninstallApplyRequest {
  planToken: string;
  idempotencyKey?: string;
}

export function applySkillUninstall(
  worktreeId: string,
  skillId: string,
  apply: SkillUninstallApplyRequest,
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillUninstallApplyResponse>> {
  const payload: Record<string, unknown> = { planToken: apply.planToken };
  if (apply.idempotencyKey) payload.idempotencyKey = apply.idempotencyKey;

  return request(
    () =>
      postJson<SkillUninstallApplyResponse>(
        operationUrl(worktreeId, skillId, 'uninstall'),
        payload,
        signal
      ),
    SKILL_REQUEST_FAILED,
    signal
  );
}
