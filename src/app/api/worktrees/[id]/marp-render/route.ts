/**
 * MARP Render API Route
 *
 * Renders MARP markdown content to HTML slides.
 * Currently returns markdown wrapped in basic HTML (MARP core integration deferred).
 *
 * Issue #438: MARP slide preview in file panel
 *
 * POST /api/worktrees/[id]/marp-render
 * Body: { markdownContent: string }
 * Response: { slides: string[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import { escapeHtml } from '@/lib/utils';

// ============================================================================
// Constants
// ============================================================================

/** Maximum MARP content length (1MB) */
const MAX_MARP_CONTENT_LENGTH = 1_000_000;

// ============================================================================
// Handler
// ============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // Validate worktree exists
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 },
      );
    }

    // Parse request body
    const body = await request.json();
    const { markdownContent } = body;

    // Validate markdownContent
    if (typeof markdownContent !== 'string') {
      return NextResponse.json(
        { error: 'markdownContent must be a string' },
        { status: 400 },
      );
    }

    if (markdownContent.length > MAX_MARP_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: 'markdownContent exceeds maximum length' },
        { status: 400 },
      );
    }

    // Simple HTML wrapper (MARP core integration deferred)
    // Split on --- slide separators (common MARP pattern)
    const slideTexts = markdownContent
      .split(/^---$/m)
      .filter((s) => s.trim().length > 0)
      // Remove MARP frontmatter from first slide
      .map((s, i) => {
        if (i === 0) {
          return s.replace(/^---\s*\nmarp:\s*true\s*\n/m, '').trim();
        }
        return s.trim();
      })
      .filter((s) => s.length > 0);

    const slides = slideTexts.map(
      (text) =>
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:2rem;margin:0;}</style></head><body><pre style="white-space:pre-wrap;word-wrap:break-word;">${escapeHtml(text)}</pre></body></html>`,
    );

    return NextResponse.json({ slides });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
