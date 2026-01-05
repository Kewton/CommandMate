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

/**
 * Action type constants for type-safe action creation
 */
export const ActionTypes = {
  // Phase
  SET_PHASE: 'SET_PHASE',

  // Terminal
  SET_TERMINAL_OUTPUT: 'SET_TERMINAL_OUTPUT',
  SET_TERMINAL_ACTIVE: 'SET_TERMINAL_ACTIVE',
  SET_TERMINAL_THINKING: 'SET_TERMINAL_THINKING',
  SET_AUTO_SCROLL: 'SET_AUTO_SCROLL',

  // Prompt
  SHOW_PROMPT: 'SHOW_PROMPT',
  CLEAR_PROMPT: 'CLEAR_PROMPT',
  SET_PROMPT_ANSWERING: 'SET_PROMPT_ANSWERING',

  // Layout
  SET_LAYOUT_MODE: 'SET_LAYOUT_MODE',
  SET_MOBILE_ACTIVE_PANE: 'SET_MOBILE_ACTIVE_PANE',
  SET_SPLIT_RATIO: 'SET_SPLIT_RATIO',

  // Error
  SET_ERROR: 'SET_ERROR',
  CLEAR_ERROR: 'CLEAR_ERROR',
  INCREMENT_RETRY_COUNT: 'INCREMENT_RETRY_COUNT',

  // Messages
  SET_MESSAGES: 'SET_MESSAGES',
  ADD_MESSAGE: 'ADD_MESSAGE',
  UPDATE_MESSAGE: 'UPDATE_MESSAGE',
  CLEAR_MESSAGES: 'CLEAR_MESSAGES',

  // Connection
  SET_WS_CONNECTED: 'SET_WS_CONNECTED',

  // Compound
  START_WAITING_FOR_RESPONSE: 'START_WAITING_FOR_RESPONSE',
  RESPONSE_RECEIVED: 'RESPONSE_RECEIVED',
  SESSION_ENDED: 'SESSION_ENDED',
} as const;
