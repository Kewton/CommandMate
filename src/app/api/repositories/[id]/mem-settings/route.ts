/**
 * `GET /api/repositories/:id/mem-settings` — the root's mem rules, switches and version.
 * `PUT` — `{ version, features, rules }`, from the screen only: a request without the
 * screen's mark is 403 `screen_only`. That is a check, not a guarantee; see
 * `lib/security/screen-request.ts` and design §11.3. Issue #4221.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { readMemSettings, writeMemSettings } from '@/lib/mem/settings-service';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const outcome = readMemSettings(getDbInstance(), id);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-settings-read-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    const outcome = body ? writeMemSettings(getDbInstance(), id, request, body) : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-settings-write-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
