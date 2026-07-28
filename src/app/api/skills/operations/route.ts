/**
 * GET /api/skills/operations — the append-only Skill operation log (Issue #1248)
 *
 * Serves the audit trail the dashboard reads: what was installed or removed,
 * where it came from, who asked, and how it ended. Filters narrow; none of them
 * widen what a caller can see, and omitting `worktreeId` reads across every
 * worktree because a log kept per worktree cannot answer "what failed today".
 *
 * The rows are served exactly as stored. Redaction already happened at write
 * time (#1234), which is what makes that safe: there is no signed URL or home
 * directory in the table to leak on the way out.
 *
 * Unknown filter values are rejected with the accepted set rather than silently
 * ignored — a typo'd `result=faild` that returned the whole log would read as
 * "no failures".
 *
 * @module api/skills/operations
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import {
  SKILL_AUDIT_DEFAULT_LIMIT,
  SKILL_AUDIT_MAX_LIMIT,
  querySkillOperationAudit,
} from '@/lib/skills/operation-audit';
import type {
  SkillOperationAuditCursor,
  SkillOperationAuditRecord,
  SkillOperationAuditResult,
} from '@/lib/skills/operation-audit';
import type { SkillOperationKind } from '@/lib/skills/operation-journal';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/skills/operations');

const OPERATION_VALUES: readonly SkillOperationKind[] = ['install', 'uninstall', 'update'];
const RESULT_VALUES: readonly SkillOperationAuditResult[] = ['succeeded', 'failed', 'reconciled'];

/** One page of the operation log. */
export interface SkillOperationsResponse {
  operations: SkillOperationAuditRecord[];
  hasMore: boolean;
  /** Opaque token to pass back as `cursor`, or null at the end of the feed. */
  nextCursor: string | null;
}

function encodeCursor(cursor: SkillOperationAuditCursor): string {
  return `${cursor.recordedAt}:${cursor.id}`;
}

/**
 * Decode a `<recordedAt>:<id>` cursor.
 *
 * Split on the first separator only: an audit ID is a UUID today, but a cursor
 * that broke the moment an ID contained a colon would be a latent paging bug.
 */
function decodeCursor(raw: string): SkillOperationAuditCursor | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const recordedAt = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isSafeInteger(recordedAt) || id.length === 0) return null;
  return { recordedAt, id };
}

function readTimestamp(raw: string | null): number | null | 'invalid' {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 'invalid';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const worktreeId = url.searchParams.get('worktreeId');
    const skillId = url.searchParams.get('skillId');
    const operation = url.searchParams.get('operation');
    const result = url.searchParams.get('result');
    const cursorParam = url.searchParams.get('cursor');
    const limitParam = url.searchParams.get('limit');

    if (operation !== null && !OPERATION_VALUES.includes(operation as SkillOperationKind)) {
      return skillApiError(
        'SKILL_OPERATIONS_INVALID_OPERATION',
        `operation must be one of: ${OPERATION_VALUES.join(', ')}.`,
        400
      );
    }
    if (result !== null && !RESULT_VALUES.includes(result as SkillOperationAuditResult)) {
      return skillApiError(
        'SKILL_OPERATIONS_INVALID_RESULT',
        `result must be one of: ${RESULT_VALUES.join(', ')}.`,
        400
      );
    }

    const since = readTimestamp(url.searchParams.get('since'));
    const until = readTimestamp(url.searchParams.get('until'));
    if (since === 'invalid' || until === 'invalid') {
      return skillApiError(
        'SKILL_OPERATIONS_INVALID_TIME_RANGE',
        'since and until must be non-negative epoch millisecond integers.',
        400
      );
    }

    let after: SkillOperationAuditCursor | undefined;
    if (cursorParam !== null) {
      const decoded = decodeCursor(cursorParam);
      if (decoded === null) {
        return skillApiError(
          'SKILL_OPERATIONS_INVALID_CURSOR',
          'cursor must be a token returned as nextCursor by a previous page.',
          400
        );
      }
      after = decoded;
    }

    let limit = SKILL_AUDIT_DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return skillApiError(
          'SKILL_OPERATIONS_INVALID_LIMIT',
          `limit must be an integer between 1 and ${SKILL_AUDIT_MAX_LIMIT}.`,
          400
        );
      }
      limit = Math.min(parsed, SKILL_AUDIT_MAX_LIMIT);
    }

    const page = querySkillOperationAudit(getDbInstance(), {
      ...(worktreeId !== null ? { worktreeId } : {}),
      ...(skillId !== null ? { skillId } : {}),
      ...(operation !== null ? { operation: operation as SkillOperationKind } : {}),
      ...(result !== null ? { result: result as SkillOperationAuditResult } : {}),
      ...(since !== null ? { since } : {}),
      ...(until !== null ? { until } : {}),
      ...(after !== undefined ? { after } : {}),
      limit,
    });

    const body: SkillOperationsResponse = {
      operations: page.records,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
    };
    return NextResponse.json(body, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-operations-list-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError(
      'SKILL_OPERATIONS_INTERNAL_ERROR',
      'Failed to list Skill operations.',
      500
    );
  }
}
