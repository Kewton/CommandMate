/**
 * `POST /api/repositories/:id/mem/decisions/operations/:opId/reconcile` — look for the mark of an unknown write (reads only, never writes outside).
 * Screen only: the service refuses a request without the screen's mark (403
 * `screen_only`; a check, not a guarantee: `lib/security/screen-request.ts`).
 * Issue #4225, design §3.4・§4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError } from '@/lib/mem/service';
import { promoteReconcile } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; opId: string }> }) {
  try {
    const { id, opId } = await params;
    const outcome = await promoteReconcile(getDbInstance(), request, id, opId);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-reconcile-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
