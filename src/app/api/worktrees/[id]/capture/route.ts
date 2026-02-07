/**
 * Terminal Capture API endpoint
 * Captures current tmux session output
 */

import { NextRequest, NextResponse } from 'next/server';
import * as tmux from '@/lib/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getSessionNameUtil } from '@/lib/session-name';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { cliToolId, lines = 1000 } = await req.json();

    if (!cliToolId) {
      return NextResponse.json(
        { error: 'Missing cliToolId' },
        { status: 400 }
      );
    }

    const sessionName = getSessionNameUtil(params.id, cliToolId as CLIToolType);

    // Check if session exists
    const sessionExists = await tmux.hasSession(sessionName);

    if (!sessionExists) {
      return NextResponse.json({
        output: `Session not running. Starting ${cliToolId} session...\n`
      });
    }

    // Capture current output
    const output = await tmux.capturePane(sessionName, lines);

    return NextResponse.json({ output });
  } catch (error) {
    console.error('Capture API error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}