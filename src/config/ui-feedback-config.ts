/**
 * UI feedback / interaction timing constants.
 *
 * Issue #760: Consolidates hardcoded setTimeout delays used for transient UI
 * feedback (copy confirmation, toast dismissal, key-press feedback) that were
 * scattered across worktree / repository / home components.
 *
 * All values are preserved from the original literals (no behavior change).
 */

/**
 * Duration (ms) a "copied!" confirmation icon stays before reverting to its
 * default state.
 * Sites: MarkdownEditor, WorktreeDetailSubComponents (path / repo path),
 * FilePanelContent (path / content), FileViewer (content / path), ReportTab.
 */
export const COPY_FEEDBACK_RESET_MS = 2000;

/**
 * Shorter "copied!" reset used in the compact assistant message list.
 * Site: AssistantMessageList.
 */
export const COPY_FEEDBACK_RESET_SHORT_MS = 1500;

/**
 * Duration (ms) an auto-response toast notification stays visible before being
 * dismissed.
 * Site: AutoYesToggle.
 */
export const NOTIFICATION_DISMISS_MS = 2000;

/**
 * Duration (ms) a navigation button stays visually "active" after being pressed,
 * providing immediate press feedback.
 * Site: NavigationButtons.
 */
export const KEY_PRESS_FEEDBACK_RESET_MS = 150;

/**
 * Delay (ms) after sending a special key before triggering a terminal refresh,
 * allowing tmux to process the key first.
 * Site: NavigationButtons.
 */
export const NAV_KEY_REFRESH_DELAY_MS = 100;

/**
 * Duration (ms) of exit (fade-out) animations for overlay UI before unmount.
 * Issue #1114: JS-side twin of the CSS motion token `--motion-duration-base`
 * (globals.css, 200ms) and the tw-animate-css `duration-200` utilities
 * used by the exit classes — keep the three in sync.
 * Sites: Modal, Toast (via useExitAnimation).
 */
export const EXIT_ANIMATION_DURATION_MS = 200;

/**
 * Exit duration (ms) for the file-tree ContextMenu, matching its faster
 * `duration-100` enter animation.
 * Site: ContextMenu (via useExitAnimation). Issue #1114.
 */
export const CONTEXT_MENU_EXIT_DURATION_MS = 100;
