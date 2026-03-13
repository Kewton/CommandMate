/**
 * API Route: POST /api/repositories/clone
 * Starts a clone job for a git repository URL
 * Issue #71: Clone URL registration feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getEnv } from '@/lib/env';
import { CloneManager } from '@/lib/git/clone-manager';
import type { CloneError } from '@/types/clone';
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
 * POST /api/repositories/clone
 *
 * Request body:
 * {
 *   cloneUrl: string  // Git clone URL (HTTPS or SSH)
 *   targetDir?: string  // Optional custom target directory (P3 feature)
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
    const { cloneUrl, targetDir } = body;

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

    const result = await cloneManager.startCloneJob(cloneUrl.trim(), trimmedTargetDir);

    if (!result.success) {
      // Determine HTTP status based on error type
      let status = 400;
      if (result.error?.code === 'DUPLICATE_CLONE_URL' || result.error?.code === 'CLONE_IN_PROGRESS') {
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
