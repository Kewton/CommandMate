/**
 * Report Templates API Route
 * GET: Retrieve all templates
 * POST: Create a new template
 *
 * Issue #618: Report template system
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getAllTemplates,
  createTemplate,
  getTemplateCount,
} from '@/lib/db/template-db';
import type { ReportTemplate } from '@/lib/db/template-db';
import {
  MAX_TEMPLATES,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_CONTENT_LENGTH,
} from '@/config/review-config';

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
// GET: Retrieve all templates
// =============================================================================

export async function GET() {
  try {
    const db = getDbInstance();
    const templates = getAllTemplates(db);

    return NextResponse.json({
      templates: templates.map(serializeTemplate),
    });
  } catch (error) {
    console.error('GET /api/templates error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// POST: Create a new template
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Body shape validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { name, content } = body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: 'name is required and cannot be empty' }, { status: 400 });
    }
    if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name exceeds maximum length (${MAX_TEMPLATE_NAME_LENGTH})` },
        { status: 400 }
      );
    }

    // Validate content
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ error: 'content is required and cannot be empty' }, { status: 400 });
    }
    if (content.length > MAX_TEMPLATE_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: `content exceeds maximum length (${MAX_TEMPLATE_CONTENT_LENGTH})` },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Check template count limit
    const count = getTemplateCount(db);
    if (count >= MAX_TEMPLATES) {
      return NextResponse.json(
        { error: `Maximum number of templates (${MAX_TEMPLATES}) reached` },
        { status: 409 }
      );
    }

    const template = createTemplate(db, { name: name.trim(), content: content.trim() });

    return NextResponse.json({
      template: serializeTemplate(template),
    }, { status: 201 });
  } catch (error) {
    console.error('POST /api/templates error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
