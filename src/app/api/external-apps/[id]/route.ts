/**
 * API Route: External App by ID
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * GET /api/external-apps/[id] - Get external app by ID
 * PATCH /api/external-apps/[id] - Update external app
 * DELETE /api/external-apps/[id] - Delete external app
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import {
  getExternalAppById,
  updateExternalApp,
  deleteExternalApp,
} from '@/lib/external-apps/db';
import { getExternalAppCache } from '@/lib/external-apps/cache';
import type { UpdateExternalAppInput } from '@/types/external-apps';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/** Valid port range */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Valid hosts */
const VALID_HOSTS = ['localhost', '127.0.0.1'];

/**
 * Validation error response type
 */
interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate update input
 */
function validateUpdateInput(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== 'object') {
    return errors; // Empty update is allowed (no-op)
  }

  const data = input as Record<string, unknown>;

  // Optional fields validation
  if (data.targetPort !== undefined) {
    if (typeof data.targetPort !== 'number') {
      errors.push({ field: 'targetPort', message: 'targetPort must be a number' });
    } else if (data.targetPort < MIN_PORT || data.targetPort > MAX_PORT) {
      errors.push({ field: 'targetPort', message: `targetPort must be between ${MIN_PORT} and ${MAX_PORT}` });
    }
  }

  if (data.targetHost !== undefined && typeof data.targetHost === 'string') {
    if (!VALID_HOSTS.includes(data.targetHost)) {
      errors.push({ field: 'targetHost', message: `targetHost must be one of: ${VALID_HOSTS.join(', ')}` });
    }
  }

  return errors;
}

/**
 * GET /api/external-apps/[id]
 * Get external app by ID
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

    return NextResponse.json({ app }, { status: 200 });
  } catch (error) {
    console.error('Error fetching external app:', error);
    return NextResponse.json(
      { error: 'Failed to fetch external app' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/external-apps/[id]
 * Update external app
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    // Check if app exists
    const existing = getExternalAppById(db, id);
    if (!existing) {
      return NextResponse.json(
        { error: `External app not found: ${id}` },
        { status: 404 }
      );
    }

    const body = await request.json();

    // Validate input
    const errors = validateUpdateInput(body);
    if (errors.length > 0) {
      return NextResponse.json(
        {
          error: errors.map(e => `${e.field}: ${e.message}`).join('; '),
          validationErrors: errors,
        },
        { status: 400 }
      );
    }

    const input: UpdateExternalAppInput = {};

    if (body.displayName !== undefined) input.displayName = body.displayName;
    if (body.description !== undefined) input.description = body.description;
    if (body.targetPort !== undefined) input.targetPort = body.targetPort;
    if (body.targetHost !== undefined) input.targetHost = body.targetHost;
    if (body.websocketEnabled !== undefined) input.websocketEnabled = body.websocketEnabled;
    if (body.websocketPathPattern !== undefined) input.websocketPathPattern = body.websocketPathPattern;
    if (body.enabled !== undefined) input.enabled = body.enabled;

    const app = updateExternalApp(db, id, input);

    // Invalidate cache
    try {
      const cache = getExternalAppCache(db);
      cache.invalidate();
    } catch {
      // Cache not initialized, that's OK
    }

    return NextResponse.json({ app }, { status: 200 });
  } catch (error) {
    console.error('Error updating external app:', error);
    return NextResponse.json(
      { error: 'Failed to update external app' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/external-apps/[id]
 * Delete external app
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    // Check if app exists
    const existing = getExternalAppById(db, id);
    if (!existing) {
      return NextResponse.json(
        { error: `External app not found: ${id}` },
        { status: 404 }
      );
    }

    deleteExternalApp(db, id);

    // Invalidate cache
    try {
      const cache = getExternalAppCache(db);
      cache.invalidate();
    } catch {
      // Cache not initialized, that's OK
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('Error deleting external app:', error);
    return NextResponse.json(
      { error: 'Failed to delete external app' },
      { status: 500 }
    );
  }
}
