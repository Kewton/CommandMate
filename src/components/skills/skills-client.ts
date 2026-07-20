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

import type { SkillApiErrorResponse, SkillDetailResponse, SkillListResponse } from './types';

/** Code used when the request never produced a JSON error body. */
export const SKILL_CATALOG_UNREACHABLE = 'SKILL_CATALOG_UNREACHABLE';

export interface SkillFetchFailure {
  code: string;
  message: string;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
}

export type SkillFetchResult<T> = { ok: true; data: T } | { ok: false; failure: SkillFetchFailure };

function isApiError(value: unknown): value is SkillApiErrorResponse {
  if (!value || typeof value !== 'object') return false;
  const { error, code } = value as Record<string, unknown>;
  return typeof error === 'string' && typeof code === 'string';
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<SkillFetchResult<T>> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      failure: {
        code: isApiError(body) ? body.code : SKILL_CATALOG_UNREACHABLE,
        message: isApiError(body) ? body.error : '',
        status: response.status,
      },
    };
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
async function request<T>(url: string, signal?: AbortSignal): Promise<SkillFetchResult<T>> {
  try {
    return await getJson<T>(url, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ok: false,
      failure: {
        code: SKILL_CATALOG_UNREACHABLE,
        message: error instanceof Error ? error.message : '',
        status: null,
      },
    };
  }
}

export function fetchSkillList(signal?: AbortSignal): Promise<SkillFetchResult<SkillListResponse>> {
  return request<SkillListResponse>('/api/skills', signal);
}

export function fetchSkillDetail(
  skillId: string,
  signal?: AbortSignal
): Promise<SkillFetchResult<SkillDetailResponse>> {
  return request<SkillDetailResponse>(`/api/skills/${encodeURIComponent(skillId)}`, signal);
}
