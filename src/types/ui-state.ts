/**
 * UI State Type Definitions
 *
 * Defines the state structure for worktree UI management using useReducer
 * Based on Issue #13 UX Improvement design specification (Section 16)
 */

import type { ChatMessage, PromptData } from './models';

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
 * Terminal State
 * Manages the terminal display output and settings
 */
export interface TerminalState {
  /** Full terminal output content */
  output: string;
  /** Real-time snippet for showing current activity */
  realtimeSnippet: string;
  /** Whether the terminal session is active */
  isActive: boolean;
  /** Whether Claude is currently thinking/processing */
  isThinking: boolean;
  /** Auto-scroll enabled (pause when user scrolls manually) */
  autoScroll: boolean;
  /** Last update timestamp */
  lastUpdated: Date | null;
}

/**
 * Prompt State
 * Manages Claude's prompt (yes/no, multiple choice) state
 */
export interface PromptState {
  /** Prompt data (question, options, etc.) */
  data: PromptData | null;
  /** Associated message ID */
  messageId: string | null;
  /** Whether the prompt panel is visible */
  visible: boolean;
  /** Whether user is currently answering (button pressed) */
  answering: boolean;
}

/**
 * Mobile tab type for navigation
 */
export type MobileActivePane = 'history' | 'terminal' | 'files' | 'info';

/**
 * Left pane tab type for desktop view
 */
export type LeftPaneTab = 'history' | 'files';

/**
 * Layout State
 * Manages responsive layout settings
 */
export interface LayoutState {
  /** Layout mode: split (desktop) or tabs (mobile) */
  mode: 'split' | 'tabs';
  /** Active pane in mobile tab view */
  mobileActivePane: MobileActivePane;
  /** Active tab in desktop left pane (history or files) */
  leftPaneTab: LeftPaneTab;
  /** Split ratio for desktop view (0.0 - 1.0) */
  splitRatio: number;
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
  /** Terminal state */
  terminal: TerminalState;
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
 * Initial terminal state
 */
export const initialTerminalState: TerminalState = {
  output: '',
  realtimeSnippet: '',
  isActive: false,
  isThinking: false,
  autoScroll: true,
  lastUpdated: null,
};

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
    terminal: { ...initialTerminalState },
    prompt: { ...initialPromptState },
    layout: { ...initialLayoutState },
    error: { ...initialErrorState },
    messages: [],
    wsConnected: false,
  };
}
