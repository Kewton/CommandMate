/**
 * Report Templates API Route
 * GET: Retrieve all templates
 * POST: Create a new template
 *
 * Issue #618: Report template system
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAllTemplates, createTemplate, getTemplateCount } from '@/lib/db/template-db';
import { MAX_TEMPLATES } from '@/config/review-config';
import {
  serializeTemplate,
  validateRequestBody,
  validateTemplateName,
  validateTemplateContent,
} from '@/lib/api/template-helpers';

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const bodyError = validateRequestBody(body);
    if (bodyError) return bodyError;

    const { name, content } = body;

    const nameError = validateTemplateName(name, true);
    if (nameError) return nameError;

    const contentError = validateTemplateContent(content, true);
    if (contentError) return contentError;

    const db = getDbInstance();

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
