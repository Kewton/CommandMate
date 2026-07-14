/**
 * GET /api/push/vapid — Web Push public key + configured flag (Issue #1125).
 *
 * Returns the VAPID public application-server key the client needs to subscribe.
 * The private key and subject are never exposed. Auth is enforced globally by
 * middleware.
 */

import { NextResponse } from 'next/server';
import { getVapidPublicKey } from '@/lib/push';

export const dynamic = 'force-dynamic';

export function GET() {
  const publicKey = getVapidPublicKey();
  return NextResponse.json({ configured: publicKey !== null, publicKey });
}
