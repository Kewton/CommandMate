/**
 * API Route: /api/worktrees/:id/env — Env Manager (Issue #1968)
 *
 * The dedicated, masked surface for `.env` files. It exists precisely BECAUSE
 * the general file APIs must not serve them: `.env*` stays in
 * `EXCLUDED_PATTERNS` (`src/lib/file-tree.ts`) so it never appears in the file
 * tree, and it stays out of `EDITABLE_EXTENSIONS` so the general PUT refuses
 * it. Nothing in this file relaxes either of those — the isolation is pinned by
 * `tests/integration/api-env-manager.test.ts`.
 *
 * Methods:
 *   - GET  ?file=<name>  read the file list, plus one file when named
 *   - PUT  { file, content }  save one file
 *
 * The `file` parameter is checked against a SERVER-side allow-list
 * (`isAllowedEnvFileName`), then through `isPathSafe` [SF-002] and
 * `resolveAndValidateRealPath` [SEC-394] — see `env-file-service.ts` for why
 * all three layers are present.
 *
 * NOTE ON EXPORTS: an App Router route entry may only export HTTP method
 * handlers and the route segment config. Types and constants live in
 * `src/lib/env-manager/` — `scripts/check-route-exports.mjs` fails the build
 * for anything else (Issue #1946).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';
import {
  listEnvFiles,
  readEnvFile,
  writeEnvFile,
  type EnvServiceErrorCode,
} from '@/lib/env-manager/env-file-service';
import type { EnvIssue } from '@/lib/env-manager/env-parser';

const logger = createLogger('api/env');

/** Service/route error codes mapped to HTTP status, mirroring the files API. */
const ERROR_CODE_TO_HTTP_STATUS: Record<string, number> = {
  WORKTREE_NOT_FOUND: 404,
  INVALID_ENV_FILE: 400,
  INVALID_PATH: 400,
  INVALID_REQUEST: 400,
  INVALID_CONTENT: 400,
  ENV_FILE_NOT_FOUND: 404,
  NOT_A_FILE: 400,
  INTERNAL_ERROR: 500,
};

/**
 * Build an error body.
 *
 * `issues` is the value-free list from the validator (line + code + key name),
 * so a 400 can tell the user which line to fix without echoing a secret into a
 * response body, a browser devtools pane or a proxy log.
 */
function errorResponse(
  code: EnvServiceErrorCode | 'WORKTREE_NOT_FOUND' | 'INVALID_REQUEST',
  message: string,
  issues?: EnvIssue[],
): NextResponse {
  const status = ERROR_CODE_TO_HTTP_STATUS[code] ?? 500;
  return NextResponse.json(
    { success: false, error: { code, message, ...(issues ? { issues } : {}) } },
    { status },
  );
}

/** Resolve the route id to a worktree, or the 404 to return. */
function resolveWorktree(requestedId: string): { path: string } | NextResponse {
  const db = getDbInstance();
  const worktree = getWorktreeById(db, canonicalWorktreeId(requestedId));
  if (!worktree) {
    return errorResponse('WORKTREE_NOT_FOUND', 'Worktree not found');
  }
  return worktree;
}

/**
 * GET /api/worktrees/:id/env
 * GET /api/worktrees/:id/env?file=.env
 *
 * Without `file`: the picker list only.
 * With `file`: the same list plus that file's content, parsed entries,
 * validation issues and the keys a template defines but it does not.
 *
 * Values are returned in the clear — the browser needs them to let the user
 * edit — and are masked at render time by `env-masking.ts`. What guards the
 * response is the app's authentication plus the allow-list, not obfuscation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const worktree = resolveWorktree(id);
    if (worktree instanceof NextResponse) return worktree;

    const files = await listEnvFiles(worktree.path);
    const requestedFile = request.nextUrl.searchParams.get('file');

    if (requestedFile === null) {
      return NextResponse.json(
        { success: true, files },
        { headers: { 'Cache-Control': 'no-store, private' } },
      );
    }

    const detail = await readEnvFile(worktree.path, requestedFile);
    if (!detail.success) {
      return errorResponse(detail.code, 'Env file could not be read');
    }

    return NextResponse.json(
      { success: true, files, selected: detail.data },
      // no-store: an env payload must never sit in a shared or disk cache.
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch (error) {
    // Codes only. An fs error message embeds the absolute path, and any body we
    // touched here could contain secrets.
    logger.error('env-get-failed', { code: (error as NodeJS.ErrnoException).code });
    return errorResponse('INTERNAL_ERROR', 'Failed to read env file');
  }
}

/**
 * PUT /api/worktrees/:id/env
 * Body: `{ file: string, content: string }`
 *
 * Creates the file when it does not exist (an allow-listed name that is absent
 * is offered in the picker precisely so it can be created).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const worktree = resolveWorktree(id);
    if (worktree instanceof NextResponse) return worktree;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse('INVALID_REQUEST', 'Body must be JSON');
    }

    const { file, content } = (body ?? {}) as { file?: unknown; content?: unknown };
    if (typeof content !== 'string') {
      return errorResponse('INVALID_REQUEST', 'content is required');
    }

    const result = await writeEnvFile(worktree.path, file, content);
    if (!result.success) {
      return errorResponse(result.code, 'Env file could not be written', result.issues);
    }

    return NextResponse.json({ success: true, file: result.data, issues: result.issues });
  } catch (error) {
    logger.error('env-put-failed', { code: (error as NodeJS.ErrnoException).code });
    return errorResponse('INTERNAL_ERROR', 'Failed to write env file');
  }
}
