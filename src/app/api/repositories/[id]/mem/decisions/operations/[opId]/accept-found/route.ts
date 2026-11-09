/**
 * `POST /api/repositories/:id/mem/decisions/operations/:opId/accept-found` — a person compared
 * what the reconcile found of the operation's own mark with what was meant, and judged it written.
 * Screen only: the service refuses a request without the screen's mark (403
 * `screen_only`; a check, not a guarantee: `lib/security/screen-request.ts`).
 * Issue #4225, design §3.4・§4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError, readMemBody } from '@/lib/mem/service';
import { promoteAcceptFound, promoteInvalidBody } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; opId: string }> }) {
  try {
    const { id, opId } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await promoteAcceptFound(getDbInstance(), request, id, opId, body) : promoteInvalidBody();
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-accept-found-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
