/**
 * `GET /api/repositories/:id/mem/mode?branch=<name>` — the mode of a branch named
 * outright, and the rule that decided it. Read-only. Issue #4221, design §9.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memError, memInternalError, memMode } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const branch = new URL(request.url).searchParams.get('branch');
    const outcome = branch
      ? await memMode(getDbInstance(), { via: 'repository', repositoryId: id, branch })
      : memError('target_required', { field: 'branch' });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-mode-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
