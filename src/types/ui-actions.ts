/**
 * UI Action Type Definitions
 *
 * Defines all actions that can modify the WorktreeUIState
 * Based on Issue #13 UX Improvement design specification (Section 16.3)
 */

import type { ChatMessage, PromptData } from './models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { UIPhase, ErrorState } from './ui-state';

/**
 * WorktreeUIAction union type
 * All possible actions for the worktree UI reducer
 */
export type WorktreeUIAction =
  // Phase transitions
  | { type: 'SET_PHASE'; phase: UIPhase }

  // Terminal actions
  | { type: 'SET_TERMINAL_OUTPUT'; output: string; realtimeSnippet: string }
  | { type: 'SET_TERMINAL_ACTIVE'; isActive: boolean }
  | { type: 'SET_TERMINAL_THINKING'; isThinking: boolean }
  | { type: 'SET_AUTO_SCROLL'; enabled: boolean }

  // Prompt actions
  | { type: 'SHOW_PROMPT'; data: PromptData; messageId: string }
  | { type: 'CLEAR_PROMPT' }
  | { type: 'SET_PROMPT_ANSWERING'; answering: boolean }

  // Layout actions
  | { type: 'SET_LAYOUT_MODE'; mode: 'split' | 'tabs' }
  | { type: 'SET_MOBILE_ACTIVE_PANE'; pane: 'history' | 'terminal' }
  | { type: 'SET_SPLIT_RATIO'; ratio: number }

  // Error actions
  | { type: 'SET_ERROR'; error: ErrorState }
  | { type: 'CLEAR_ERROR' }
  | { type: 'INCREMENT_RETRY_COUNT' }

  // Message actions
  | { type: 'SET_MESSAGES'; messages: ChatMessage[] }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_MESSAGE'; id: string; updates: Partial<ChatMessage> }
  | { type: 'CLEAR_MESSAGES' }

  // Connection actions
  | { type: 'SET_WS_CONNECTED'; connected: boolean }

  // Compound actions (update multiple states simultaneously)
  | { type: 'START_WAITING_FOR_RESPONSE'; cliToolId: CLIToolType }
  | { type: 'RESPONSE_RECEIVED'; message: ChatMessage }
  | { type: 'SESSION_ENDED' };

