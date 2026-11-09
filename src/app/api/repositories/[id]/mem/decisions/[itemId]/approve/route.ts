/**
 * `POST /api/repositories/:id/mem/decisions/:itemId/approve` — a person approves the diff; checked again, then written.
 * Screen only: the service refuses a request without the screen's mark (403
 * `screen_only`; a check, not a guarantee: `lib/security/screen-request.ts`).
 * Issue #4225, design §4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError, readMemBody } from '@/lib/mem/service';
import { promoteApprove, promoteInvalidBody } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await promoteApprove(getDbInstance(), request, id, itemId, body) : promoteInvalidBody();
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-approve-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
