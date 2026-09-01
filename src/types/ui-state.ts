/**
 * UI State Type Definitions
 *
 * Defines the state structure for worktree UI management using useReducer
 * Based on Issue #13 UX Improvement design specification (Section 16)
 */

import type { ChatMessage, LivePromptData } from './models';
import type { ActivityId } from '@/config/activity-bar-config';

/**
 * UI Phase (state transition center)
 * - idle: No active session, waiting for user action
 * - waiting: User sent a message, waiting for Claude to start responding
 * - receiving: Claude is actively responding
 * - prompt: Claude is asking for user confirmation (yes/no, multiple choice)
 * - complete: Claude's response is complete
 */
export type UIPhase = 'idle' | 'waiting' | 'receiving' | 'prompt' | 'complete';

/**
 * Prompt State
 * Manages Claude's prompt (yes/no, multiple choice) state
 */
export interface PromptState {
  /**
   * Prompt data (question, options, etc.).
   *
   * Issue #1738: {@link LivePromptData} — the reducer is fed straight from
   * `/current-output`, which has published the degraded structured form since
   * #1725. Narrow with `isAnswerablePromptData` before reading `options`.
   */
  data: LivePromptData | null;
  /** Associated message ID */
  messageId: string | null;
  /** Whether the prompt panel is visible */
  visible: boolean;
  /** Whether user is currently answering (button pressed) */
  answering: boolean;
}

/**
 * Deep link pane type for ?pane= query parameter [DR2-006]
 * Issue #600: Unified pane identifier for deep linking
 *
 * Not a 1:1 mapping with MobileActivePane or LeftPaneTab.
 * Conversion logic resides in useWorktreeTabState().
 */
export type DeepLinkPane = 'terminal' | 'history' | 'git' | 'files' | 'notes' | 'logs' | 'agent' | 'timer' | 'info';

/**
 * Output-surface mode for a session view (Issue #2193).
 *
 * Which surface occupies the *output* half of a worktree session: the read-only
 * tmux frame (`terminal`) or the conversation transcript (`chat`). It says
 * nothing about the input half — the composer, PromptPanel and Auto-Yes are
 * unchanged in both modes, which is what lets the two be swapped mid-turn.
 *
 * Deliberately NOT closed with a `never` exhaustive default anywhere it is
 * switched on: Epic #2192 keeps a third value (`'xterm'`) open, and an
 * exhaustive switch would turn adding it into a compile error in every consumer
 * at once. Every switch on this type falls back to {@link DEFAULT_SURFACE_MODE}.
 */
export type SurfaceMode = 'terminal' | 'chat';

/**
 * The mode a session opens in when nothing has been persisted and no `?view=`
 * was given, and the value every invalid input falls back to.
 */
export const DEFAULT_SURFACE_MODE: SurfaceMode = 'terminal';

/** Set of valid {@link SurfaceMode} values for runtime validation. */
export const VALID_SURFACE_MODES: ReadonlySet<string> = new Set<string>([
  'terminal',
  'chat',
]);

/**
 * Runtime type guard for {@link SurfaceMode}.
 *
 * The boundary for BOTH untrusted sources of a mode: the `?view=` query
 * parameter and the localStorage value (which a user, an extension or an older
 * build may have written). Accepts `unknown` so `searchParams.get()` /
 * `localStorage.getItem()` — both `string | null` — can be handed over
 * unnarrowed; a non-string is simply not a SurfaceMode.
 */
export function isSurfaceMode(value: unknown): value is SurfaceMode {
  return typeof value === 'string' && VALID_SURFACE_MODES.has(value);
}

/**
 * Mobile tab type for navigation
 */
export type MobileActivePane = 'history' | 'terminal' | 'files' | 'memo' | 'info';

/**
 * Left pane tab type for desktop view
 */
export type LeftPaneTab = 'history' | 'files' | 'memo';

/**
 * Sub-tab type within the History tab (Issue #447)
 */
export type HistorySubTab = 'message' | 'git';

/**
 * Activity Bar state (Issue #727).
 * Tracks the active VS Code-style activity. `null` means the ActivityPane
 * is hidden (user clicked the active icon to close it).
 */
export interface ActivityBarState {
  active: ActivityId | null;
}

/**
 * History Pane state (Issue #727).
 * On PC the History pane is a dedicated column that can be hidden / resized.
 */
export interface HistoryPaneState {
  /** Visible on PC */
  visible: boolean;
  /** Width in percent */
  width: number;
  /**
   * Convenience flag mirroring `!visible` — useful for components that already
   * accept a "collapsed" prop.
   */
  collapsed: boolean;
}

/**
 * Layout State
 * Manages responsive layout settings
 */
export interface LayoutState {
  /** Layout mode: split (desktop) or tabs (mobile) */
  mode: 'split' | 'tabs';
  /** Active pane in mobile tab view */
  mobileActivePane: MobileActivePane;
  /** Active tab in desktop left pane (history or files) — kept for mobile compat (Issue #727) */
  leftPaneTab: LeftPaneTab;
  /** Split ratio for desktop view (0.0 - 1.0) */
  splitRatio: number;
  /**
   * Whether the desktop left pane is collapsed (Issue #688).
   * When true, the left pane is hidden (width 0) and a 24px expand bar is shown.
   * Persisted to localStorage under key `commandmate.worktree.leftPaneCollapsed`.
   * Kept for backward compatibility — Issue #727 introduces dedicated
   * `activityBar` / `historyPane` slots on PC.
   */
  leftPaneCollapsed: boolean;
  /** VS Code-style Activity Bar state (Issue #727) */
  activityBar: ActivityBarState;
  /** History pane PC column state (Issue #727) */
  historyPane: HistoryPaneState;
}

/**
 * Error State
 * Manages error conditions and retry logic
 */
export interface ErrorState {
  /** Error type */
  type: 'connection' | 'timeout' | 'server_error' | 'network_slow' | null;
  /** Error message */
  message: string | null;
  /** Whether the error is retryable */
  retryable: boolean;
  /** Number of retry attempts */
  retryCount: number;
}

/**
 * Integrated UI State for Worktree
 * This is the main state structure managed by useReducer
 */
export interface WorktreeUIState {
  /** Current UI phase */
  phase: UIPhase;
  /** Prompt state */
  prompt: PromptState;
  /** Layout state */
  layout: LayoutState;
  /** Error state */
  error: ErrorState;
  /** Chat messages */
  messages: ChatMessage[];
  /** WebSocket connection status */
  wsConnected: boolean;
}

/**
 * Initial prompt state
 */
export const initialPromptState: PromptState = {
  data: null,
  messageId: null,
  visible: false,
  answering: false,
};

/**
 * Initial layout state
 */
export const initialLayoutState: LayoutState = {
  mode: 'split',
  mobileActivePane: 'terminal',
  leftPaneTab: 'history',
  splitRatio: 0.5,
  leftPaneCollapsed: false,
  // Issue #727: Activity Bar + History pane defaults. The actual persisted
  // values are owned by `useActivityBarState` / `useHistoryPaneState`; this
  // reducer-level state mirrors them for components that read from `state.layout`.
  activityBar: { active: 'files' },
  historyPane: { visible: true, width: 25, collapsed: false },
};

/**
 * Initial error state
 */
export const initialErrorState: ErrorState = {
  type: null,
  message: null,
  retryable: false,
  retryCount: 0,
};

/**
 * Initial UI state (factory function for creating fresh state)
 */
export function createInitialUIState(): WorktreeUIState {
  return {
    phase: 'idle',
    prompt: { ...initialPromptState },
    layout: { ...initialLayoutState },
    error: { ...initialErrorState },
    messages: [],
    wsConnected: false,
  };
}
