/**
 * GET /api/assistant/tools
 * Issue #649: Returns list of installed CLI tools for assistant chat.
 */

import { NextResponse } from 'next/server';
import { CLIToolManager } from '@/lib/cli-tools/manager';

export async function GET(): Promise<NextResponse> {
  const manager = CLIToolManager.getInstance();
  const toolsInfo = await manager.getAllToolsInfo();

  return NextResponse.json({
    tools: toolsInfo.map((t) => ({
      id: t.id,
      name: t.name,
      installed: t.installed,
    })),
  });
}
