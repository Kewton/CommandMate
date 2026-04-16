import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AssistantConversationExecutionMode } from '@/lib/db';

const NON_INTERACTIVE_TOOLS = new Set<CLIToolType>(['claude', 'codex']);

export function getAssistantExecutionMode(cliToolId: CLIToolType): AssistantConversationExecutionMode {
  return NON_INTERACTIVE_TOOLS.has(cliToolId) ? 'non_interactive' : 'interactive';
}

export function isAssistantNonInteractiveTool(cliToolId: CLIToolType): boolean {
  return getAssistantExecutionMode(cliToolId) === 'non_interactive';
}
