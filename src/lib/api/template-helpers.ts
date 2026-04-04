/**
 * Shared helpers for template API routes
 * Issue #618: Report template system
 */

import { NextResponse } from 'next/server';
import type { ReportTemplate } from '@/lib/db/template-db';
import {
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_CONTENT_LENGTH,
} from '@/config/review-config';

/** UUID v4 format regex */
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Serialize a ReportTemplate to a JSON-safe object (Date -> ISO string) */
export function serializeTemplate(template: ReportTemplate) {
  return {
    id: template.id,
    name: template.name,
    content: template.content,
    sortOrder: template.sortOrder,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

/**
 * Validate a template name field.
 * Returns a NextResponse error if invalid, or null if valid.
 */
export function validateTemplateName(
  name: unknown,
  required: boolean
): NextResponse | null {
  if (required) {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json(
        { error: 'name is required and cannot be empty' },
        { status: 400 }
      );
    }
  } else if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json(
        { error: 'name cannot be empty' },
        { status: 400 }
      );
    }
  }

  if (typeof name === 'string' && name.length > MAX_TEMPLATE_NAME_LENGTH) {
    return NextResponse.json(
      { error: `name exceeds maximum length (${MAX_TEMPLATE_NAME_LENGTH})` },
      { status: 400 }
    );
  }

  return null;
}

/**
 * Validate a template content field.
 * Returns a NextResponse error if invalid, or null if valid.
 */
export function validateTemplateContent(
  content: unknown,
  required: boolean
): NextResponse | null {
  if (required) {
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json(
        { error: 'content is required and cannot be empty' },
        { status: 400 }
      );
    }
  } else if (content !== undefined) {
    if (typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json(
        { error: 'content cannot be empty' },
        { status: 400 }
      );
    }
  }

  if (typeof content === 'string' && content.length > MAX_TEMPLATE_CONTENT_LENGTH) {
    return NextResponse.json(
      { error: `content exceeds maximum length (${MAX_TEMPLATE_CONTENT_LENGTH})` },
      { status: 400 }
    );
  }

  return null;
}

/** Validate request body shape (non-null object, not array) */
export function validateRequestBody(body: unknown): NextResponse | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
  return null;
}
