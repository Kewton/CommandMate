/**
 * Whether the chat surface is showing tool activity, remembered per browser
 * (Issue #2284).
 *
 * ## What "tool activity" means here
 *
 * Three folded things on one surface: the trailing `Tool calls (N)` section
 * (#2234, folded by `splitToolLog`), the `Thinking` section (#2272, folded by
 * `splitChatThinking`) and the run of approval dialogs (#2245,
 * `ChatToolApprovalGroup`). They are all the same KIND of thing — a subordinate
 * log the reader may want and does not want first — so they answer to ONE
 * control rather than to three, and that control's position is what this module
 * stores.
 *
 * ## Why localStorage and not `app_settings`
 *
 * This is a reading preference belonging to a pair of eyes, not to a worktree
 * or to the server: the same account reading from a phone and from a desktop
 * wants different answers, and a round trip would make the first paint of every
 * transcript wait on a fetch. `commandmate:showArchived` (#168) and
 * `commandmate:historyUserOnly` (#725) are stored the same way for the same
 * reason, down to the `'true'` / `'false'` representation.
 *
 * Every access is wrapped: a browser with site data blocked throws on the
 * property access itself, and a transcript that cannot remember a chevron must
 * still render.
 */

/** localStorage key for the chat surface's tool-activity toggle. */
export const CHAT_TOOL_ACTIVITY_STORAGE_KEY = 'commandmate:chatShowToolActivity';

/**
 * What the reader last chose, or the default.
 *
 * Default **folded**: the Issue's whole point is that a reply is what a row
 * opens with, and any value other than the literal `'true'` — a missing key, a
 * legacy `'1'`, a half-written value — means folded rather than throwing.
 */
export function readChatToolActivityPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the reader's choice. Silently a no-op where storage is unavailable. */
export function writeChatToolActivityPreference(showAll: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, String(showAll));
  } catch {
    /* storage unavailable — the toggle still works for this mount */
  }
}
