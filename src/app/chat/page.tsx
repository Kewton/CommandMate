/**
 * Chat Page (/chat)
 *
 * Dedicated page for the Assistant Chat (Home Assistant-style conversation)
 * that was previously embedded in the Home page.
 */

'use client';

import { AppShell } from '@/components/layout';
import { AssistantChatPanel } from '@/components/home/AssistantChatPanel';

export default function ChatPage() {
  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">Assistant Chat</h1>
          <p className="text-sm text-muted-foreground">
            Converse with a local CLI assistant (Claude or Codex) scoped to a selected repository.
          </p>
        </div>

        <AssistantChatPanel />
      </div>
    </AppShell>
  );
}
