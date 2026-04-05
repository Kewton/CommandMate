/**
 * Daily Summary Status API Route
 * GET: Check if a report generation is currently in progress
 *
 * Issue #638: Report generation status visibility
 */

import { NextResponse } from 'next/server';
import { isGenerating, getGeneratingState } from '@/lib/daily-summary-generator';

export async function GET() {
  if (!isGenerating()) {
    return NextResponse.json({ generating: false });
  }

  const state = getGeneratingState();
  if (!state) {
    return NextResponse.json({ generating: false });
  }

  return NextResponse.json({
    generating: true,
    date: state.date,
    tool: state.tool,
    startedAt: new Date(state.startedAt).toISOString(),
  });
}
