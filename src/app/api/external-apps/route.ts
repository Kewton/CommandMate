/**
 * API Route: External Apps
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * GET /api/external-apps - List all external apps
 * POST /api/external-apps - Create a new external app
 *
 * @module api/external-apps
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import {
  getAllExternalApps,
  createExternalApp,
  getExternalAppByPathPrefix,
} from '@/lib/external-apps/db';
import { getExternalAppCache } from '@/lib/external-apps/cache';
import { validateCreateInput } from '@/lib/external-apps/validation';
import type { CreateExternalAppInput } from '@/types/external-apps';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/**
 * GET /api/external-apps
 * List all external apps
 */
export async function GET() {
  try {
    const db = getDbInstance();
    const apps = getAllExternalApps(db);

    return NextResponse.json({ apps }, { status: 200 });
  } catch (error) {
    console.error('Error fetching external apps:', error);
    return NextResponse.json(
      { error: 'Failed to fetch external apps' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/external-apps
 * Create a new external app
 */
export async function POST(request: Request) {
  try {
    const db = getDbInstance();
    const body = await request.json();

    // Validate input
    const errors = validateCreateInput(body);
    if (errors.length > 0) {
      return NextResponse.json(
        {
          error: errors.map(e => `${e.field}: ${e.message}`).join('; '),
          validationErrors: errors,
        },
        { status: 400 }
      );
    }

    const input: CreateExternalAppInput = {
      name: body.name,
      displayName: body.displayName,
      description: body.description,
      pathPrefix: body.pathPrefix,
      targetPort: body.targetPort,
      targetHost: body.targetHost || 'localhost',
      appType: body.appType,
      websocketEnabled: body.websocketEnabled || false,
      websocketPathPattern: body.websocketPathPattern,
    };

    // Check for duplicate name or pathPrefix
    try {
      const existingByPrefix = getExternalAppByPathPrefix(db, input.pathPrefix);
      if (existingByPrefix) {
        return NextResponse.json(
          { error: `An app with pathPrefix "${input.pathPrefix}" already exists` },
          { status: 409 }
        );
      }

      const app = createExternalApp(db, input);

      // Invalidate cache
      try {
        const cache = getExternalAppCache(db);
        cache.invalidate();
      } catch {
        // Cache not initialized, that's OK
      }

      return NextResponse.json({ app }, { status: 201 });
    } catch (dbError) {
      // Check for unique constraint violation (duplicate name)
      if (dbError instanceof Error && dbError.message.includes('UNIQUE constraint')) {
        return NextResponse.json(
          { error: `An app with name "${input.name}" or pathPrefix "${input.pathPrefix}" already exists` },
          { status: 409 }
        );
      }
      throw dbError;
    }
  } catch (error) {
    console.error('Error creating external app:', error);
    return NextResponse.json(
      { error: 'Failed to create external app' },
      { status: 500 }
    );
  }
}
