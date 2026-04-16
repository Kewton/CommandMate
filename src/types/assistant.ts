/**
 * Types for Home Assistant Chat conversation APIs.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  AssistantConversation,
  AssistantMessage,
} from '@/lib/db/assistant-conversation-db';

export interface StartAssistantRequest {
  cliToolId: CLIToolType;
  repositoryId: string;
}

export interface StartAssistantResponse {
  success: boolean;
  conversation: AssistantConversation;
  executionMode?: 'interactive' | 'non_interactive';
  resumeAvailable?: boolean;
}

export interface AssistantConversationResponse {
  conversation: AssistantConversation | null;
}

export interface AssistantMessagesResponse {
  conversationId: string;
  messages: AssistantMessage[];
}

export interface AssistantTerminalRequest {
  cliToolId: CLIToolType;
  conversationId: string;
  command: string;
}

export interface AssistantCurrentOutputResponse {
  output: string;
  sessionActive: boolean;
}

export interface AssistantSendResponse {
  success: boolean;
  messageId: string;
  executionId?: string;
}
