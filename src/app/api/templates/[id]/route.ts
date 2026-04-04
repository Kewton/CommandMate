/**
 * Report Templates API Route (individual template)
 * PUT: Update a template
 * DELETE: Delete a template
 *
 * Issue #618: Report template system
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from '@/lib/db/template-db';
import type { ReportTemplate } from '@/lib/db/template-db';
import {
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_CONTENT_LENGTH,
} from '@/config/review-config';

/** UUID v4 format regex */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Serialize a ReportTemplate to a plain JSON-safe object (Date -> ISO string) */
function serializeTemplate(template: ReportTemplate) {
  return {
    id: template.id,
    name: template.name,
    content: template.content,
    sortOrder: template.sortOrder,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

// =============================================================================
// PUT: Update a template
// =============================================================================

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // UUID v4 format check
    if (!UUID_V4_REGEX.test(id)) {
      return NextResponse.json({ error: 'Invalid template ID format' }, { status: 400 });
    }

    const body = await request.json();

    // Body shape validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { name, content } = body;

    // Validate name (if provided)
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      }
      if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
        return NextResponse.json(
          { error: `name exceeds maximum length (${MAX_TEMPLATE_NAME_LENGTH})` },
          { status: 400 }
        );
      }
    }

    // Validate content (if provided)
    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim() === '') {
        return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 });
      }
      if (content.length > MAX_TEMPLATE_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: `content exceeds maximum length (${MAX_TEMPLATE_CONTENT_LENGTH})` },
          { status: 400 }
        );
      }
    }

    const db = getDbInstance();

    // Check existence
    const existing = getTemplateById(db, id);
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const updates: { name?: string; content?: string } = {};
    if (name !== undefined) updates.name = name.trim();
    if (content !== undefined) updates.content = content.trim();

    updateTemplate(db, id, updates);

    const updated = getTemplateById(db, id)!;

    return NextResponse.json({
      template: serializeTemplate(updated),
    });
  } catch (error) {
    console.error('PUT /api/templates/[id] error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// DELETE: Delete a template
// =============================================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // UUID v4 format check
    if (!UUID_V4_REGEX.test(id)) {
      return NextResponse.json({ error: 'Invalid template ID format' }, { status: 400 });
    }

    const db = getDbInstance();

    // Check existence
    const existing = getTemplateById(db, id);
    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    deleteTemplate(db, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/templates/[id] error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
