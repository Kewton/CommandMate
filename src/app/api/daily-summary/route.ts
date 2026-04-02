/**
 * Daily Summary API Route
 * GET: Retrieve saved report + message count
 * POST: Trigger AI summary generation
 * PUT: Update report content
 *
 * Issue #607: Daily summary feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getDailyReport, updateDailyReportContent } from '@/lib/db/daily-report-db';
import { getMessagesByDateRange } from '@/lib/db/chat-db';
import {
  generateDailySummary,
  ConcurrentGenerationError,
  GenerationTimeoutError,
  OutputValidationError,
  MAX_SUMMARY_OUTPUT_LENGTH,
} from '@/lib/daily-summary-generator';
import type { DailyReport } from '@/lib/db/daily-report-db';
import { SUMMARY_ALLOWED_TOOLS, MAX_USER_INSTRUCTION_LENGTH } from '@/config/review-config';

// =============================================================================
// Helpers
// =============================================================================

/** Serialize a DailyReport to a plain JSON-safe object (Date -> ISO string) */
function serializeReport(report: DailyReport) {
  return {
    date: report.date,
    content: report.content,
    generatedByTool: report.generatedByTool,
    model: report.model,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate date parameter (YYYY-MM-DD format, valid date, not in the future)
 * DR4-001
 */
function validateDateParam(date: string): string | null {
  // 1. Format check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return 'Invalid date format. Expected YYYY-MM-DD';
  }
  // 2. Parse validity
  const parsed = new Date(date + 'T00:00:00');
  if (isNaN(parsed.getTime())) {
    return 'Invalid date value';
  }
  // 3. Auto-correction detection (e.g., 2026-02-30 -> 2026-03-02)
  const [y, m, d] = date.split('-').map(Number);
  if (parsed.getFullYear() !== y || parsed.getMonth() + 1 !== m || parsed.getDate() !== d) {
    return 'Invalid date value';
  }
  // 4. Future date check (allow today)
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (parsed > today) {
    return 'Future date is not allowed';
  }
  return null;
}

// =============================================================================
// GET: Retrieve report + message count
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    if (!date) {
      return NextResponse.json({ error: 'date parameter is required' }, { status: 400 });
    }

    const dateError = validateDateParam(date);
    if (dateError) {
      return NextResponse.json({ error: dateError }, { status: 400 });
    }

    const db = getDbInstance();

    // Get saved report
    const report = getDailyReport(db, date);

    // Get message count for the date
    const dayStart = new Date(date + 'T00:00:00');
    const dayEnd = new Date(date + 'T23:59:59.999');
    const messages = getMessagesByDateRange(db, { after: dayStart, before: dayEnd });

    return NextResponse.json({
      report: report ? serializeReport(report) : null,
      messageCount: messages.length,
    });
  } catch (error) {
    console.error('GET /api/daily-summary error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// POST: Trigger AI summary generation
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Body shape validation
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { date, tool, model, userInstruction } = body;

    // Validate date
    if (!date || typeof date !== 'string') {
      return NextResponse.json({ error: 'date is required' }, { status: 400 });
    }
    const dateError = validateDateParam(date);
    if (dateError) {
      return NextResponse.json({ error: dateError }, { status: 400 });
    }

    // Validate tool
    if (!tool || !SUMMARY_ALLOWED_TOOLS.includes(tool)) {
      return NextResponse.json({ error: 'Invalid tool. Allowed: claude, codex, copilot' }, { status: 400 });
    }

    // Validate model (optional, only for copilot)
    if (model !== undefined && model !== null && typeof model !== 'string') {
      return NextResponse.json({ error: 'Invalid model parameter' }, { status: 400 });
    }

    // Validate userInstruction (optional, Issue #612)
    if (userInstruction !== undefined && userInstruction !== null) {
      if (typeof userInstruction !== 'string') {
        return NextResponse.json({ error: 'Invalid userInstruction parameter' }, { status: 400 });
      }
      if (userInstruction.length > MAX_USER_INSTRUCTION_LENGTH) {
        return NextResponse.json(
          { error: `userInstruction exceeds maximum length (${MAX_USER_INSTRUCTION_LENGTH})` },
          { status: 400 }
        );
      }
    }

    const db = getDbInstance();

    const report = await generateDailySummary(db, {
      date,
      tool,
      model,
      userInstruction: userInstruction || undefined,
    });

    return NextResponse.json({
      report: serializeReport(report),
      generated: true,
    });
  } catch (error) {
    if (error instanceof ConcurrentGenerationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429 }
      );
    }
    if (error instanceof GenerationTimeoutError) {
      return NextResponse.json(
        { error: error.message },
        { status: 504 }
      );
    }
    if (error instanceof OutputValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    console.error('POST /api/daily-summary error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// =============================================================================
// PUT: Update report content
// =============================================================================

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { date, content } = body;

    // Validate date
    if (!date || typeof date !== 'string') {
      return NextResponse.json({ error: 'date is required' }, { status: 400 });
    }
    const dateError = validateDateParam(date);
    if (dateError) {
      return NextResponse.json({ error: dateError }, { status: 400 });
    }

    // Validate content (DR4-005)
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ error: 'content is required and cannot be empty' }, { status: 400 });
    }
    if (content.length > MAX_SUMMARY_OUTPUT_LENGTH) {
      return NextResponse.json(
        { error: `content exceeds maximum length (${MAX_SUMMARY_OUTPUT_LENGTH})` },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Check if report exists
    const existing = getDailyReport(db, date);
    if (!existing) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    updateDailyReportContent(db, date, content);

    const updated = getDailyReport(db, date)!;

    return NextResponse.json({
      report: serializeReport(updated),
    });
  } catch (error) {
    console.error('PUT /api/daily-summary error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
