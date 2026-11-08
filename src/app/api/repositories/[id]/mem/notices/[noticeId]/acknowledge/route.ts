/**
 * `POST /api/repositories/:id/mem/notices/:noticeId/acknowledge` — `{ ifVersion }`. A
 * person takes a notice no session could, from the screen only (a request without the
 * screen's mark is 403 `screen_only`; a check, not a guarantee: see
 * `lib/security/screen-request.ts`). Issue #4222, design §3.3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memAcknowledgeNotice, memError, memInternalError, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; noticeId: string }> }) {
  try {
    const { id, noticeId } = await params;
    if (!isScreenRequest(request)) {
      const refused = memError('screen_only');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const body = await readMemBody(request);
    const outcome = body ? await memAcknowledgeNotice(getDbInstance(), id, noticeId, body) : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-notice-acknowledge-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
