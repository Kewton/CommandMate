/**
 * API Route: POST /api/repositories/clone
 * Starts a clone job for a git repository URL
 * Issue #71: Clone URL registration feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getEnv } from '@/lib/env';
import { CloneManager } from '@/lib/git/clone-manager';
import { forkRepository, ForkError, type ForkErrorCode } from '@/lib/git/fork-manager';
import type { CloneError, CloneErrorCategory } from '@/types/clone';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-clone');



/**
 * [S1-003][S4-007] Maximum allowed length for targetDir input.
 * DoS defense: prevents excessive memory consumption in path.resolve() / decodeURIComponent().
 */
const MAX_TARGET_DIR_LENGTH = 1024;

/**
 * Response type for successful clone start
 */
interface CloneStartResponse {
  success: true;
  jobId: string;
  status: 'pending';
  message: string;
}

/**
 * Response type for clone error
 */
interface CloneErrorResponse {
  success: false;
  error: CloneError;
  jobId?: string;
}

/**
 * Map a ForkError to an HTTP status and a CloneError-shaped body so the UI can
 * render `error.message` uniformly with clone errors (Issue #1480).
 */
function forkErrorToResponse(err: ForkError): { status: number; error: CloneError } {
  const map: Record<
    ForkErrorCode,
    { status: number; category: CloneErrorCategory; suggestedAction: string }
  > = {
    GH_NOT_AVAILABLE: {
      status: 400,
      category: 'system',
      suggestedAction: 'Install the GitHub CLI (gh) and try again.',
    },
    GH_NOT_AUTHENTICATED: {
      status: 401,
      category: 'auth',
      suggestedAction: 'Run `gh auth login` and try again.',
    },
    INVALID_SOURCE_URL: {
      status: 400,
      category: 'validation',
      suggestedAction: 'Provide a GitHub repository URL (https or ssh).',
    },
    FORK_FAILED: {
      status: 422,
      category: 'git',
      suggestedAction: 'Check your permissions to fork this repository, then retry.',
    },
  };
  const meta = map[err.code];
  return {
    status: meta.status,
    error: {
      category: meta.category,
      code: err.code,
      message: err.message,
      recoverable: true,
      suggestedAction: meta.suggestedAction,
    },
  };
}

/**
 * POST /api/repositories/clone
 *
 * Request body:
 * {
 *   cloneUrl: string  // Git clone URL (HTTPS or SSH)
 *   targetDir?: string  // Optional custom target directory (P3 feature)
 *   fork?: boolean  // Issue #1480: fork into the authenticated user's namespace first
 * }
 *
 * Response:
 * - 202: Clone job started (returns jobId)
 * - 400: Invalid URL or validation error
 * - 409: Duplicate repository or clone in progress
 * - 500: Server error
 */
export async function POST(request: NextRequest): Promise<NextResponse<CloneStartResponse | CloneErrorResponse>> {
  try {
    const body = await request.json();
    const { cloneUrl, targetDir, fork } = body;

    // Validate cloneUrl is provided
    if (!cloneUrl || typeof cloneUrl !== 'string' || cloneUrl.trim() === '') {
      return NextResponse.json(
        {
          success: false,
          error: {
            category: 'validation',
            code: 'EMPTY_URL',
            message: 'Clone URL is required',
            recoverable: true,
            suggestedAction: 'Please enter a valid git clone URL',
          },
        },
        { status: 400 }
      );
    }

    // Issue #1480: validate fork flag type (prevent object/array injection)
    if (fork !== undefined && typeof fork !== 'boolean') {
      return NextResponse.json(
        {
          success: false,
          error: {
            category: 'validation',
            code: 'INVALID_FORK_FLAG',
            message: 'fork must be a boolean',
            recoverable: true,
            suggestedAction: 'Provide a boolean value for fork',
          },
        },
        { status: 400 }
      );
    }

    // [D4-002] Validate targetDir type (prevent object/array injection)
    if (targetDir !== undefined && typeof targetDir !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: {
            category: 'validation',
            code: 'INVALID_TARGET_PATH',
            message: 'targetDir must be a string',
            recoverable: true,
            suggestedAction: 'Provide a valid string path for targetDir',
          },
        },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    // [D2-001] getEnv().CM_ROOT_DIR is already an absolute path via path.resolve() in env.ts L234.
    // Do not apply additional path.resolve() to avoid double resolution.
    const { CM_ROOT_DIR } = getEnv();
    const cloneManager = new CloneManager(db, { basePath: CM_ROOT_DIR });

    logger.info('clone:start', { cloneUrl });

    // [S1-003] Trim and validate targetDir length before passing to startCloneJob().
    const trimmedTargetDir = targetDir?.trim() || undefined;
    if (trimmedTargetDir && trimmedTargetDir.length > MAX_TARGET_DIR_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: {
            category: 'validation',
            code: 'INVALID_TARGET_PATH',
            message: 'Target directory path is too long',
            recoverable: true,
            suggestedAction: 'Use a path within the configured base directory',
          },
        },
        { status: 400 }
      );
    }

    // Issue #1480: when fork is requested, create (or reuse) a fork in the
    // authenticated user's namespace and clone THAT, registering the original URL
    // as upstream. Done synchronously so gh auth / fork failures surface as a
    // clear error before the background clone job starts.
    let effectiveCloneUrl = cloneUrl.trim();
    let upstreamUrl: string | undefined;
    if (fork === true) {
      try {
        const forkResult = await forkRepository(cloneUrl.trim());
        effectiveCloneUrl = forkResult.forkUrl;
        upstreamUrl = forkResult.upstreamUrl;
        logger.info('clone:fork-resolved', { forkFullName: forkResult.forkFullName });
      } catch (forkErr) {
        if (forkErr instanceof ForkError) {
          const { status, error } = forkErrorToResponse(forkErr);
          logger.warn('clone:fork-failed', { code: forkErr.code });
          return NextResponse.json({ success: false, error }, { status });
        }
        throw forkErr;
      }
    }

    const result = await cloneManager.startCloneJob(effectiveCloneUrl, trimmedTargetDir, {
      upstreamUrl,
    });

    if (!result.success) {
      // Determine HTTP status based on error type
      let status = 400;
      if (
        result.error?.code === 'DUPLICATE_CLONE_URL' ||
        result.error?.code === 'CLONE_IN_PROGRESS' ||
        // Issue #1340: 既存 repositories 行が targetPath を占有している状態も競合
        result.error?.code === 'DUPLICATE_REPOSITORY_PATH'
      ) {
        status = 409;
      }

      logger.warn('clone-job-failed:-');

      return NextResponse.json(
        {
          success: false,
          error: result.error!,
          jobId: result.jobId,
        },
        { status }
      );
    }

    logger.info('clone:job-created', { jobId: result.jobId });

    return NextResponse.json(
      {
        success: true,
        jobId: result.jobId!,
        status: 'pending',
        message: 'Clone job started',
      },
      { status: 202 }
    );
  } catch (error: unknown) {
    logger.error('unexpected-error:', { error: error instanceof Error ? error.message : String(error) });

    return NextResponse.json(
      {
        success: false,
        error: {
          category: 'system',
          code: 'INTERNAL_ERROR',
          message: 'Failed to start clone job',
          recoverable: false,
          suggestedAction: 'Please try again later',
        },
      },
      { status: 500 }
    );
  }
}
