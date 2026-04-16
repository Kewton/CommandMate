/**
 * Helpers for mapping assistant conversations to tmux session identities.
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

export function getAssistantConversationWorktreeId(conversationId: string): string {
  return `assistant-${conversationId}`;
}

export function getAssistantConversationSession(cliToolId: CLIToolType, conversationId: string) {
  const cliTool = CLIToolManager.getInstance().getTool(cliToolId);
  const worktreeId = getAssistantConversationWorktreeId(conversationId);
  const sessionName = cliTool.getSessionName(worktreeId);

  return { cliTool, worktreeId, sessionName };
}
