/**
 * `POST /api/repositories/:id/mem/decisions/:itemId/confirm-reflected` — a person checked the reflection (`recorded → promoted`).
 * Screen only: the service refuses a request without the screen's mark (403
 * `screen_only`; a check, not a guarantee: `lib/security/screen-request.ts`).
 * Issue #4225, design §4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError, readMemBody } from '@/lib/mem/service';
import { promoteConfirmReflected, promoteInvalidBody } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await promoteConfirmReflected(getDbInstance(), request, id, itemId, body) : promoteInvalidBody();
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-confirm-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
