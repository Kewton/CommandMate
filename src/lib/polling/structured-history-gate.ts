/**
 * Whether somebody better-informed is already recording this turn (Issue #2041).
 *
 * The poller's job has always been to be the only writer of conversation
 * history, because for five of the six tools the terminal is the only place the
 * reply exists. opencode is the exception: since #1763 CommandMate holds an SSE
 * connection to the agent's own server, and since this Issue that connection
 * carries the reply's Markdown source. Two writers for one turn would put the
 * same answer in History twice — once as the agent wrote it and once as its TUI
 * drew it — so one of them has to stand down, and it is the one reading the
 * screen.
 *
 * ## Why this is a module and not an `if`
 *
 * Two reasons, and the second is the one that matters. The obvious one is that
 * `response-checker` is 1,000 lines with a single tool-agnostic spine, and a
 * `cliToolId === 'opencode' && …` in the middle of the save path is exactly the
 * kind of branch that gets copied to the next tool that grows a server. The
 * real one is the import: `@/lib/hooks/sources/opencode/subscription` reaches
 * the whole opencode client through its module graph, and the poller's tests
 * replace that graph wholesale. One named seam is one thing to stub.
 *
 * ## What is NOT gated
 *
 * Only the two calls that *record the reply* — the `chat_messages` row and the
 * Markdown conversation log. Prompt rows, Auto-Yes, the waiting-episode edges,
 * push notifications, task events and the session-state cursor all stay on the
 * scraper, because none of them are things the event stream duplicates: a
 * `permission.asked` becomes a pending decision, never a history row, and the
 * push fan-out has no second producer at all. Gating them would trade a
 * duplicated reply for a silent notification, which is the worse failure.
 *
 * @module lib/polling/structured-history-gate
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { isOpencodeStructuredHistoryLive } from '@/lib/hooks/sources/opencode/subscription';

const logger = createLogger('lib/polling/structured-history-gate');

/**
 * Whether the agent's own server is recording this instance's replies.
 *
 * False for every tool but opencode, and false for an opencode instance whose
 * subscription is anything other than `live` — see
 * {@link isOpencodeStructuredHistoryLive} for why `lost` counts as "nobody is
 * writing this down" rather than as "somebody will". The fallback direction is
 * the safe one: two writers duplicate a reply, no writer loses it.
 *
 * Never throws. A source that cannot be asked is one that is not writing.
 *
 * @param worktreeId - The worktree
 * @param cliToolId - The tool driving the pane
 * @param instanceId - The agent instance; defaults to the primary
 */
export function isStructuredHistoryWriterLive(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): boolean {
  if (cliToolId !== 'opencode') return false;
  try {
    return isOpencodeStructuredHistoryLive({
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
    });
  } catch (error) {
    logger.warn('structured-history-gate-unavailable', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
