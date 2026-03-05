/**
 * MARP Render API Route
 *
 * Renders MARP markdown content to HTML slides using @marp-team/marp-core.
 * Each slide is returned as a self-contained HTML string with embedded CSS.
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
import Marp from '@marp-team/marp-core';

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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const { markdownContent } = body as Record<string, unknown>;

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

    // Render with Marp Core
    const marp = new Marp({
      html: false,
      math: true,
    });

    const { html, css } = marp.render(markdownContent);

    // Extract individual slide sections from the rendered HTML
    // Marp renders each slide as a <section> element
    const sectionRegex = /<section[^>]*>[\s\S]*?<\/section>/g;
    const sections = html.match(sectionRegex) || [];

    // Wrap each slide with full HTML document including Marp CSS
    const slides = sections.map(
      (section) =>
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style><style>body{margin:0;overflow:hidden;}section{position:relative;width:100%;height:100vh;display:flex;flex-direction:column;justify-content:center;}</style></head><body>${section}</body></html>`,
    );

    // Fallback: if no sections found, return the whole HTML as one slide
    if (slides.length === 0 && html.trim().length > 0) {
      slides.push(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`,
      );
    }

    return NextResponse.json({ slides });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
