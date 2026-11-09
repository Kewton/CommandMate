/**
 * `POST /api/repositories/:id/mem/decisions/operations/:opId/abandon` — a person checked that an unknown write is not there.
 * Screen only: the service refuses a request without the screen's mark (403
 * `screen_only`; a check, not a guarantee: `lib/security/screen-request.ts`).
 * Issue #4225, design §3.4・§4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError, readMemBody } from '@/lib/mem/service';
import { promoteAbandon, promoteInvalidBody } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; opId: string }> }) {
  try {
    const { id, opId } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await promoteAbandon(getDbInstance(), request, id, opId, body) : promoteInvalidBody();
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-abandon-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
