/**
 * API Route: External App Health Check
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * GET /api/external-apps/[id]/health - Check health of external app
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getExternalAppById } from '@/lib/external-apps/db';
import type { ExternalAppHealth } from '@/types/external-apps';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/** Health check timeout in milliseconds */
const HEALTH_CHECK_TIMEOUT = 5000;

/**
 * Check if a port is reachable by attempting a fetch request
 *
 * @param host - The host to check
 * @param port - The port to check
 * @returns Promise with health status and response time
 */
async function checkPortHealth(
  host: string,
  port: number
): Promise<{ healthy: boolean; responseTime?: number; error?: string }> {
  const url = `http://${host}:${port}/`;
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    return { healthy: true, responseTime };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    if (error instanceof Error) {
      // Abort means timeout
      if (error.name === 'AbortError') {
        return {
          healthy: false,
          responseTime,
          error: 'Connection timeout',
        };
      }

      return {
        healthy: false,
        responseTime,
        error: error.message,
      };
    }

    return {
      healthy: false,
      responseTime,
      error: 'Unknown error',
    };
  }
}

/**
 * GET /api/external-apps/[id]/health
 * Check health of external app (port connectivity)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();
    const app = getExternalAppById(db, id);

    if (!app) {
      return NextResponse.json(
        { error: `External app not found: ${id}` },
        { status: 404 }
      );
    }

    const result = await checkPortHealth(app.targetHost, app.targetPort);

    const health: ExternalAppHealth = {
      id: app.id,
      healthy: result.healthy,
      responseTime: result.responseTime,
      lastChecked: Date.now(),
      error: result.error,
    };

    return NextResponse.json({ health }, { status: 200 });
  } catch (error) {
    console.error('Error checking external app health:', error);
    return NextResponse.json(
      { error: 'Failed to check external app health' },
      { status: 500 }
    );
  }
}
