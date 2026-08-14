/**
 * Push reminder settings (Issue #1790).
 *
 *   GET   /api/push/escalation — the current reminder threshold / on-off
 *   PATCH /api/push/escalation — change it
 *
 * Install-wide rather than per-device, because the check that reads it runs in a
 * background timer with no browser attached — see `lib/push/escalation-settings`.
 * Auth is enforced globally by middleware.
 */

import { NextResponse } from 'next/server';
import {
  DEFAULT_ESCALATION_SETTINGS,
  ESCALATION_THRESHOLD_CHOICES,
  getPushEscalationSettings,
  setPushEscalationSettings,
} from '@/lib/push';
import { createLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/push-escalation');

export function GET() {
  // `getPushEscalationSettings` is total — a database that cannot answer yields
  // the defaults, which is also what the background check would use.
  return NextResponse.json({
    settings: getPushEscalationSettings(),
    choices: ESCALATION_THRESHOLD_CHOICES,
    defaults: DEFAULT_ESCALATION_SETTINGS,
  });
}

export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'settings object is required' }, { status: 400 });
    }

    // Normalization happens in the store, field by field, so a partial or
    // malformed body falls back per field instead of being rejected wholesale.
    const settings = setPushEscalationSettings((body as { settings?: unknown }).settings ?? body);
    return NextResponse.json({ settings });
  } catch (error) {
    logger.warn('escalation-settings-update-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
