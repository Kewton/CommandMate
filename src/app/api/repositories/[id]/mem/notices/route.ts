/**
 * `GET /api/repositories/:id/mem/notices?branch=<name>` — the "it ended" notices of a
 * branch that no session has taken (the screen's undelivered list). Read only, any
 * mode. Issue #4222, design §3.3・§4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memError, memInternalError, memUndeliveredNotices } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const branch = new URL(request.url).searchParams.get('branch');
    const outcome = branch ? await memUndeliveredNotices(getDbInstance(), id, branch) : memError('target_required', { field: 'branch' });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-notices-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
