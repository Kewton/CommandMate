/**
 * API Route: GET /api/repositories/clone/[jobId]
 * Gets the status of a clone job
 * Issue #71: Clone URL registration feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getEnv } from '@/lib/env';
import { CloneManager } from '@/lib/clone-manager';
import type { CloneJobStatus } from '@/types/clone';

const LOG_PREFIX = '[Clone Status API]';

/**
 * Response type for clone job status
 */
interface CloneStatusResponse {
  success: true;
  jobId: string;
  status: CloneJobStatus;
  progress: number;
  repositoryId?: string;
  error?: {
    category: string;
    code: string;
    message: string;
  };
}

/**
 * Response type for error
 */
interface ErrorResponse {
  success: false;
  error: string;
}

/**
 * GET /api/repositories/clone/[jobId]
 *
 * Response:
 * - 200: Job status returned
 * - 404: Job not found
 * - 500: Server error
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse<CloneStatusResponse | ErrorResponse>> {
  try {
    const { jobId } = await params;

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    // [D2-003] getCloneJobStatus() does not use basePath, but we pass it for
    // code consistency and to prevent unnecessary deprecation warnings from
    // WORKTREE_BASE_PATH when basePath is not provided.
    const { CM_ROOT_DIR } = getEnv();
    const cloneManager = new CloneManager(db, { basePath: CM_ROOT_DIR });

    const status = cloneManager.getCloneJobStatus(jobId);

    if (!status) {
      return NextResponse.json(
        { success: false, error: 'Clone job not found' },
        { status: 404 }
      );
    }

    const response: CloneStatusResponse = {
      success: true,
      jobId: status.jobId,
      status: status.status,
      progress: status.progress,
      repositoryId: status.repositoryId,
    };

    if (status.error) {
      response.error = status.error;
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error: unknown) {
    console.error(`${LOG_PREFIX} Unexpected error:`, error);

    return NextResponse.json(
      { success: false, error: 'Failed to get clone job status' },
      { status: 500 }
    );
  }
}
