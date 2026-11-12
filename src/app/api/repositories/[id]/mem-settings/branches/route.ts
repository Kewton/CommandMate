/**
 * `PUT /api/repositories/:id/mem-settings/branches` — one branch's own mode and switches.
 * `DELETE ?branch=<name>&version=<n>` — remove it. Both from the screen only (403
 * `screen_only` otherwise) and against the settings version. Issue #4221, design §11.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { removeMemBranchOverride, writeMemBranchOverride } from '@/lib/mem/settings-service';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    const outcome = body ? writeMemBranchOverride(getDbInstance(), id, request, body) : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-override-write-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const outcome = removeMemBranchOverride(getDbInstance(), id, request, query.get('branch'), query.get('version'));
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-override-delete-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
