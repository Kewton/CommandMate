/**
 * Issue #4385 (A4 差し戻し): the screen a send the server refused because of the role lands on —
 * the composer (`MessageInput` with the optimistic hand-off), the pane's optimistic layer
 * (`useOptimisticPaneMessages`), the history rows (PC `ConversationPairCard`, phone
 * `ChatMessageBubble`) and the app's toast (`ToastProvider`). `fetch` answers `/send` with the
 * 409 the server gives (`send-failure.ts` / `send-session-start.ts`: `{ error, code, roleRefusal,
 * sendOutcome: 'not_sent' }`); the response's shape is the server's, unchanged.
 *
 * Shared by the test and its mutant (the positive control), so both run the very same scenario.
 */
import React, { useState } from 'react';
import { expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { ToastProvider } from '@/components/common/Toast';
import { useOptimisticPaneMessages } from '@/hooks/useOptimisticPaneMessages';

export const WT = 'wt-4385';
export const BODY = 'please review the diff';

/** The three reasons the judge's A4 / A5 / A8a send back, with the sentence each must show (en). */
export const ROLE_CASES = [
  {
    label: 'A4: agy agent did not list the agent (not-applied)',
    roleRefusal: 'not-applied',
    sentence: 'The role is not applied to this session, so nothing was sent (the agent runs without it). Stop the session and start it again.',
  },
  {
    label: 'A5: agy agent failed / could not be checked (not-confirmed)',
    roleRefusal: 'not-confirmed',
    sentence: 'The role could not be confirmed for this session, so nothing was sent. Stop the session and start it again.',
  },
  {
    label: 'A8a: the role file could not be prepared (artifact-failed)',
    roleRefusal: 'artifact-failed',
    sentence: "The role's file could not be prepared, so the session was not started and nothing was sent. Check the role settings and send again.",
  },
] as const;

/** A server sentence that carries no agy output; the screen shows its own words, not this. */
export const SERVER_SENTENCE =
  'The role could not be confirmed for this Antigravity session, so nothing was sent. Stop the session and start it again. (agy agent did not list the agent before the start, so agy runs without the role; agy 1.5.8, checked on 1.5.8)';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `fetch` for the scenario: `/send` answers `send`, everything else an empty 200. */
export function installFetch(send: () => Response) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') return send();
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

export function roleRefusal409(roleRefusal: string): Response {
  return json(409, { error: SERVER_SENTENCE, code: 'ROLE_LAUNCH_REFUSED', roleRefusal, sendOutcome: 'not_sent' });
}

export function serverError500(): Response {
  return json(500, { error: 'Internal failure' });
}

function Pane() {
  const [insert, setInsert] = useState<string | null>(null);
  const { messages, sendOptimistic, retry, discard } = useOptimisticPaneMessages({
    worktreeId: WT,
    serverMessages: [],
    onSent: () => undefined,
    onNotSent: (content) => setInsert(content),
  });
  return (
    <>
      <MessageInput
        worktreeId={WT}
        cliToolId="antigravity"
        onMessageSent={() => undefined}
        onOptimisticSend={sendOptimistic}
        pendingInsertText={insert}
        onInsertConsumed={() => setInsert(null)}
      />
      <div data-testid="pc-history">
        {messages.map((m) => (
          <ConversationPairCard
            key={m.id}
            pair={{ id: m.id, userMessage: m, assistantMessages: [], status: 'pending' }}
            onFilePathClick={() => undefined}
            onRetryPending={retry}
            onDiscardPending={(id) => {
              const content = discard(id);
              if (content) setInsert(content);
            }}
          />
        ))}
      </div>
      <div data-testid="phone-history">
        {messages.map((m) => (
          <ChatMessageBubble key={m.id} message={m} showHeader onFilePathClick={() => undefined} onRetryPending={retry} />
        ))}
      </div>
    </>
  );
}

export function renderPane() {
  return render(
    <ToastProvider>
      <Pane />
    </ToastProvider>,
  );
}

export const textarea = () => screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;

export async function sendBody(body = BODY): Promise<void> {
  fireEvent.change(textarea(), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
  // The failed row appears on both histories once the 409 has landed.
  await waitFor(() => expect(within(screen.getByTestId('pc-history')).getByTestId('optimistic-error')).toBeInTheDocument());
}

/**
 * The three things the screen must show for a role refusal: (1) the toast right after the send,
 * (2) the reason on the failed row (PC and phone), (3) the draft kept in the composer.
 */
export async function expectRoleReasonShown(sentence: string, body = BODY): Promise<void> {
  // (1) right after the send: the app's toast, near the composer's other notices.
  await waitFor(() => expect(screen.getByTestId('toast-container')).toHaveTextContent(sentence));
  // (2) the failed row says why, on both histories, next to "Failed to send".
  const pc = within(screen.getByTestId('pc-history'));
  expect(pc.getByTestId('optimistic-error')).toHaveTextContent('Failed to send');
  expect(pc.getByTestId('optimistic-error-reason')).toHaveTextContent(sentence);
  const phone = within(screen.getByTestId('phone-history'));
  expect(phone.getByTestId('chat-optimistic-error-reason')).toHaveTextContent(sentence);
  // (3) nothing was sent, so the composer keeps the body.
  await waitFor(() => expect(textarea().value).toBe(body));
  // agy's own output is never shown (the server's parenthesised detail is not echoed either).
  expect(document.body.textContent).not.toContain('agy 1.5.8, checked on');
}
