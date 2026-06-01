/**
 * UI Action Type Definitions
 *
 * Defines all actions that can modify the WorktreeUIState
 * Based on Issue #13 UX Improvement design specification (Section 16.3)
 */

import type { ChatMessage, PromptData } from './models';
import type { UIPhase, ErrorState, MobileActivePane, LeftPaneTab } from './ui-state';
import type { ActivityId } from '@/config/activity-bar-config';

/**
 * WorktreeUIAction union type
 * All possible actions for the worktree UI reducer
 */
export type WorktreeUIAction =
  // Phase transitions
  | { type: 'SET_PHASE'; phase: UIPhase }

  // Prompt actions
  | { type: 'SHOW_PROMPT'; data: PromptData; messageId: string }
  | { type: 'CLEAR_PROMPT' }
  | { type: 'SET_PROMPT_ANSWERING'; answering: boolean }

  // Layout actions
  | { type: 'SET_LAYOUT_MODE'; mode: 'split' | 'tabs' }
  | { type: 'SET_MOBILE_ACTIVE_PANE'; pane: MobileActivePane }
  | { type: 'SET_LEFT_PANE_TAB'; tab: LeftPaneTab }
  | { type: 'SET_SPLIT_RATIO'; ratio: number }
  // Issue #688: Left pane collapse/expand
  | { type: 'TOGGLE_LEFT_PANE' }
  | { type: 'SET_LEFT_PANE_COLLAPSED'; collapsed: boolean }

  // Issue #727: Activity Bar + History pane (PC)
  | { type: 'SET_ACTIVE_ACTIVITY'; activity: ActivityId | null }
  | { type: 'TOGGLE_ACTIVITY'; activity: ActivityId }
  | { type: 'TOGGLE_HISTORY_PANE' }
  | { type: 'SET_HISTORY_PANE_VISIBLE'; visible: boolean }
  | { type: 'SET_HISTORY_WIDTH'; width: number }

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
  | { type: 'SET_WS_CONNECTED'; connected: boolean };

