/**
 * Report Templates API Route (individual template)
 * PUT: Update a template
 * DELETE: Delete a template
 *
 * Issue #618: Report template system
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getTemplateById, updateTemplate, deleteTemplate } from '@/lib/db/template-db';
import {
  UUID_V4_REGEX,
  serializeTemplate,
  validateRequestBody,
  validateTemplateName,
  validateTemplateContent,
} from '@/lib/api/template-helpers';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!UUID_V4_REGEX.test(id)) {
      return NextResponse.json({ error: 'Invalid template ID format' }, { status: 400 });
    }

    const body = await request.json();

    const bodyError = validateRequestBody(body);
    if (bodyError) return bodyError;

    const { name, content } = body;

    const nameError = validateTemplateName(name, false);
    if (nameError) return nameError;

    const contentError = validateTemplateContent(content, false);
    if (contentError) return contentError;

    const db = getDbInstance();

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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!UUID_V4_REGEX.test(id)) {
      return NextResponse.json({ error: 'Invalid template ID format' }, { status: 400 });
    }

    const db = getDbInstance();

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
