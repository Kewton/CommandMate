/**
 * Assistant API client for Home Assistant Chat.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  AssistantConversationResponse,
  AssistantCurrentOutputResponse,
  AssistantMessagesResponse,
  StartAssistantResponse,
} from '@/types/assistant';
import type {
  AssistantConversation,
  AssistantMessage,
} from '@/lib/db/assistant-conversation-db';

export interface AssistantToolInfo {
  id: CLIToolType;
  name: string;
  installed: boolean;
}

function reviveConversation(
  conversation: AssistantConversation | null
): AssistantConversation | null {
  if (!conversation) {
    return null;
  }

  return {
    ...conversation,
    createdAt: new Date(conversation.createdAt),
    updatedAt: new Date(conversation.updatedAt),
    lastStartedAt: conversation.lastStartedAt ? new Date(conversation.lastStartedAt) : undefined,
    lastStoppedAt: conversation.lastStoppedAt ? new Date(conversation.lastStoppedAt) : undefined,
    contextSentAt: conversation.contextSentAt ? new Date(conversation.contextSentAt) : undefined,
  };
}

function reviveMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
  };
}

export const assistantApi = {
  async getConversation(
    repositoryId: string,
    cliToolId: CLIToolType,
  ): Promise<AssistantConversation | null> {
    const res = await fetch(
      `/api/assistant/conversation?repositoryId=${encodeURIComponent(repositoryId)}&cliToolId=${encodeURIComponent(cliToolId)}`,
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to get conversation (${res.status})`);
    }

    const data = (await res.json()) as AssistantConversationResponse;
    return reviveConversation(data.conversation);
  },

  async getMessages(conversationId: string): Promise<AssistantMessage[]> {
    const res = await fetch(
      `/api/assistant/messages?conversationId=${encodeURIComponent(conversationId)}`,
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to get messages (${res.status})`);
    }

    const data = (await res.json()) as AssistantMessagesResponse;
    return data.messages.map(reviveMessage);
  },

  async clearMessages(
    conversationId: string,
    options?: { fromMessageId?: string },
  ): Promise<{ archivedCount: number }> {
    const params = new URLSearchParams({ conversationId });
    if (options?.fromMessageId) {
      params.set('fromMessageId', options.fromMessageId);
    }
    const res = await fetch(`/api/assistant/messages?${params.toString()}`, { method: 'DELETE' });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to clear messages (${res.status})`);
    }

    const data = await res.json();
    return { archivedCount: data.archivedCount ?? 0 };
  },

  async startSession(
    cliToolId: CLIToolType,
    repositoryId: string,
  ): Promise<StartAssistantResponse> {
    const res = await fetch('/api/assistant/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId, repositoryId }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to start session (${res.status})`);
    }

    const data = (await res.json()) as StartAssistantResponse;
    return {
      ...data,
      conversation: reviveConversation(data.conversation)!,
    };
  },

  async sendCommand(
    cliToolId: CLIToolType,
    conversationId: string,
    command: string,
  ): Promise<void> {
    const res = await fetch('/api/assistant/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId, conversationId, command }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to send command (${res.status})`);
    }
  },

  async getCurrentOutput(
    cliToolId: CLIToolType,
    conversationId: string,
  ): Promise<AssistantCurrentOutputResponse> {
    const res = await fetch(
      `/api/assistant/current-output?cliToolId=${encodeURIComponent(cliToolId)}&conversationId=${encodeURIComponent(conversationId)}`,
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to get output (${res.status})`);
    }

    return res.json();
  },

  async stopSession(
    cliToolId: CLIToolType,
    conversationId: string,
  ): Promise<{ success: boolean; killed: boolean }> {
    const res = await fetch(
      `/api/assistant/session?cliToolId=${encodeURIComponent(cliToolId)}&conversationId=${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to stop session (${res.status})`);
    }

    return res.json();
  },

  async getInstalledTools(): Promise<AssistantToolInfo[]> {
    const res = await fetch('/api/assistant/tools');
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    return (data.tools ?? []) as AssistantToolInfo[];
  },
};
