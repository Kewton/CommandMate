import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getActiveSchedulesForWorktree } from '@/lib/schedule-manager';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/schedules/active');

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  void request;

  try {
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const schedules = getActiveSchedulesForWorktree(id);
    return NextResponse.json({ schedules }, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-active-schedules:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to fetch active schedules' }, { status: 500 });
  }
}
