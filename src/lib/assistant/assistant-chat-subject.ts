/**
 * How an Assistant Chat failure is identified and addressed (Issue #2022).
 *
 * Assistant Chat is the first push producer whose subject is not a worktree, and
 * both facts a notification needs are missing from the worktree vocabulary:
 *
 *  - **the id.** Keyed on the REPOSITORY, not the conversation: the conversation
 *    row is created by `POST /api/assistant/start`, and the availability check
 *    that raises this notification deliberately runs *before* that creation, so
 *    a refused start leaves no half-open chat behind for `AssistantChatPanel` to
 *    render. The repository is what exists at refusal time, and it is also what
 *    the user re-selects when they retry — so two refusals of the same chat are
 *    one dedup key and one Service-Worker tag, as they should be. The
 *    `assistant-` prefix keeps it out of the real worktree namespace and the
 *    `-repo-` segment out of `getAssistantConversationWorktreeId`'s.
 *  - **the name and the link.** `failure-push-notifier`'s `resolveWorktreeName`
 *    would answer with that raw id, and the derived `/worktrees/<id>` would open
 *    a worktree page that does not exist. So the repository names itself, and
 *    the link is the chat screen.
 *
 * A leaf on purpose: `conversation-session` is the natural neighbour but it
 * pulls `CLIToolManager` — the whole seven-tool graph — and one of the two
 * callers is `non-interactive-runner`, which has no other reason to load it.
 *
 * @module lib/assistant/assistant-chat-subject
 */

import type { SessionStartSubject } from '@/lib/session/session-start-error';

/** Where Assistant Chat lives in the UI — the page `src/app/chat/page.tsx` serves. */
const ASSISTANT_CHAT_PATH = '/chat';

/** The minimum of a repository row this module needs to name a chat. */
export interface AssistantChatRepository {
  id: string;
  name: string;
  displayName?: string;
}

/**
 * The notification identity of a repository's Assistant Chat.
 *
 * @param repository - The repository whose chat could not start
 * @returns The subject id, and the title/tap-target overrides for the notifier
 */
export function getAssistantChatFailureTarget(repository: AssistantChatRepository): {
  worktreeId: string;
  subject: SessionStartSubject;
} {
  return {
    worktreeId: `assistant-repo-${repository.id}`,
    subject: {
      name: repository.displayName || repository.name,
      url: ASSISTANT_CHAT_PATH,
    },
  };
}
