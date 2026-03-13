/**
 * API Route: GET /api/repositories/excluded
 * Returns list of excluded (disabled) repositories
 * Issue #190: Repository exclusion on sync
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getExcludedRepositories } from '@/lib/db-repository';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-excluded');

export async function GET() {
  try {
    const db = getDbInstance();
    const repositories = getExcludedRepositories(db);

    return NextResponse.json({
      success: true,
      repositories,
    });
  } catch (error: unknown) {
    // SEC-SF-003: Fixed error message - do not expose internal details
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to get excluded repositories' },
      { status: 500 }
    );
  }
}
