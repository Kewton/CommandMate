/**
 * API Route: GET /api/asks/:askId (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §4).
 *
 * One ask's attribution, by its id — never "the newest reply". `matched`
 * carries the reply (the assistant rows the ledger names); every other state
 * carries `reply: null` and its reason. A `pending` row is refreshed once from
 * its tool's transcript reader (claude's or codex's, `refreshAskFromReader`)
 * before it is answered (§3.5), so the ask can settle while no poller is reading.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { readAskAttribution } from '@/lib/ask/ask-correlation';
import { isAskId } from '@/lib/ask/envelope';
import { refreshAskFromReader } from '@/lib/ask/ask-refresh';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/asks');

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ askId: string }> }
) {
  try {
    const { askId } = await params;
    if (!isAskId(askId)) {
      return NextResponse.json({ error: 'Invalid ask ID format' }, { status: 400 });
    }
    const db = getDbInstance();
    const answer = await readAskAttribution(db, askId, (row) => refreshAskFromReader(db, row));
    if (!answer) {
      return NextResponse.json({ error: 'Ask not found' }, { status: 404 });
    }
    return NextResponse.json(answer, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    logger.error('error-reading-ask:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read ask' }, { status: 500 });
  }
}
