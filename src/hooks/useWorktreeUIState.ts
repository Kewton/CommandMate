/**
 * useWorktreeUIState Hook
 *
 * A useReducer-based state management hook for worktree UI
 * Based on Issue #13 UX Improvement design specification (Section 16.4, 16.5)
 */

'use client';

import { useReducer, useMemo } from 'react';
import type { WorktreeUIState, UIPhase, ErrorState } from '@/types/ui-state';
import type { WorktreeUIAction } from '@/types/ui-actions';
import type { ChatMessage, PromptData } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  createInitialUIState,
  initialTerminalState,
  initialPromptState,
  initialErrorState,
} from '@/types/ui-state';

/**
 * Reducer function for worktree UI state
 */
export function worktreeUIReducer(
  state: WorktreeUIState,
  action: WorktreeUIAction
): WorktreeUIState {
  switch (action.type) {
    // Phase transitions
    case 'SET_PHASE':
      return { ...state, phase: action.phase };

    // Terminal actions
    case 'SET_TERMINAL_OUTPUT':
      return {
        ...state,
        terminal: {
          ...state.terminal,
          output: action.output,
          realtimeSnippet: action.realtimeSnippet,
          lastUpdated: new Date(),
        },
      };

    case 'SET_TERMINAL_ACTIVE':
      return {
        ...state,
        terminal: { ...state.terminal, isActive: action.isActive },
      };

    case 'SET_TERMINAL_THINKING':
      return {
        ...state,
        terminal: { ...state.terminal, isThinking: action.isThinking },
      };

    case 'SET_AUTO_SCROLL':
      return {
        ...state,
        terminal: { ...state.terminal, autoScroll: action.enabled },
      };

    // Prompt actions
    case 'SHOW_PROMPT':
      return {
        ...state,
        phase: 'prompt',
        prompt: {
          data: action.data,
          messageId: action.messageId,
          visible: true,
          answering: false,
        },
      };

    case 'CLEAR_PROMPT':
      return {
        ...state,
        prompt: { ...initialPromptState },
      };

    case 'SET_PROMPT_ANSWERING':
      return {
        ...state,
        prompt: { ...state.prompt, answering: action.answering },
      };

    // Layout actions
    case 'SET_LAYOUT_MODE':
      return {
        ...state,
        layout: { ...state.layout, mode: action.mode },
      };

    case 'SET_MOBILE_ACTIVE_PANE':
      return {
        ...state,
        layout: { ...state.layout, mobileActivePane: action.pane },
      };

    case 'SET_SPLIT_RATIO':
      return {
        ...state,
        layout: { ...state.layout, splitRatio: action.ratio },
      };

    // Error actions
    case 'SET_ERROR':
      return { ...state, error: action.error };

    case 'CLEAR_ERROR':
      return { ...state, error: { ...initialErrorState } };

    case 'INCREMENT_RETRY_COUNT':
      return {
        ...state,
        error: { ...state.error, retryCount: state.error.retryCount + 1 },
      };

    // Message actions
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };

    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };

    case 'UPDATE_MESSAGE':
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg.id === action.id ? { ...msg, ...action.updates } : msg
        ),
      };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };

    // Connection actions
    case 'SET_WS_CONNECTED':
      return { ...state, wsConnected: action.connected };

    // Compound actions
    case 'START_WAITING_FOR_RESPONSE':
      return {
        ...state,
        phase: 'waiting',
        terminal: {
          ...state.terminal,
          isActive: true,
          output: '',
          realtimeSnippet: '',
        },
        prompt: { ...initialPromptState },
      };

    case 'RESPONSE_RECEIVED':
      return {
        ...state,
        phase: 'complete',
        messages: [...state.messages, action.message],
        terminal: {
          ...state.terminal,
          isActive: false,
          isThinking: false,
        },
      };

    case 'SESSION_ENDED':
      return {
        ...state,
        phase: 'idle',
        terminal: { ...initialTerminalState },
        prompt: { ...initialPromptState },
      };

    default:
      return state;
  }
}

/**
 * Action creators interface
 */
export interface WorktreeUIActions {
  setPhase: (phase: UIPhase) => void;
  setTerminalOutput: (output: string, realtimeSnippet: string) => void;
  setTerminalActive: (isActive: boolean) => void;
  setTerminalThinking: (isThinking: boolean) => void;
  showPrompt: (data: PromptData, messageId: string) => void;
  clearPrompt: () => void;
  setPromptAnswering: (answering: boolean) => void;
  setError: (error: ErrorState) => void;
  clearError: () => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  startWaitingForResponse: (cliToolId: CLIToolType) => void;
  responseReceived: (message: ChatMessage) => void;
  sessionEnded: () => void;
  setAutoScroll: (enabled: boolean) => void;
  setMobileActivePane: (pane: 'history' | 'terminal') => void;
  setLayoutMode: (mode: 'split' | 'tabs') => void;
  setSplitRatio: (ratio: number) => void;
  setWsConnected: (connected: boolean) => void;
}

/**
 * Custom hook for worktree UI state management
 *
 * @returns Object containing state, dispatch function, and memoized action creators
 *
 * @example
 * ```tsx
 * function WorktreeDetail() {
 *   const { state, actions } = useWorktreeUIState();
 *
 *   const handleSendMessage = () => {
 *     actions.startWaitingForResponse('claude');
 *   };
 *
 *   return (
 *     <div>
 *       <p>Phase: {state.phase}</p>
 *       <button onClick={handleSendMessage}>Send</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useWorktreeUIState(): {
  state: WorktreeUIState;
  dispatch: React.Dispatch<WorktreeUIAction>;
  actions: WorktreeUIActions;
} {
  const [state, dispatch] = useReducer(worktreeUIReducer, undefined, createInitialUIState);

  // Memoized action creators
  const actions = useMemo<WorktreeUIActions>(
    () => ({
      setPhase: (phase: UIPhase) => dispatch({ type: 'SET_PHASE', phase }),

      setTerminalOutput: (output: string, realtimeSnippet: string) =>
        dispatch({ type: 'SET_TERMINAL_OUTPUT', output, realtimeSnippet }),

      setTerminalActive: (isActive: boolean) =>
        dispatch({ type: 'SET_TERMINAL_ACTIVE', isActive }),

      setTerminalThinking: (isThinking: boolean) =>
        dispatch({ type: 'SET_TERMINAL_THINKING', isThinking }),

      showPrompt: (data: PromptData, messageId: string) =>
        dispatch({ type: 'SHOW_PROMPT', data, messageId }),

      clearPrompt: () => dispatch({ type: 'CLEAR_PROMPT' }),

      setPromptAnswering: (answering: boolean) =>
        dispatch({ type: 'SET_PROMPT_ANSWERING', answering }),

      setError: (error: ErrorState) => dispatch({ type: 'SET_ERROR', error }),

      clearError: () => dispatch({ type: 'CLEAR_ERROR' }),

      setMessages: (messages: ChatMessage[]) =>
        dispatch({ type: 'SET_MESSAGES', messages }),

      addMessage: (message: ChatMessage) =>
        dispatch({ type: 'ADD_MESSAGE', message }),

      updateMessage: (id: string, updates: Partial<ChatMessage>) =>
        dispatch({ type: 'UPDATE_MESSAGE', id, updates }),

      clearMessages: () => dispatch({ type: 'CLEAR_MESSAGES' }),

      startWaitingForResponse: (cliToolId: CLIToolType) =>
        dispatch({ type: 'START_WAITING_FOR_RESPONSE', cliToolId }),

      responseReceived: (message: ChatMessage) =>
        dispatch({ type: 'RESPONSE_RECEIVED', message }),

      sessionEnded: () => dispatch({ type: 'SESSION_ENDED' }),

      setAutoScroll: (enabled: boolean) =>
        dispatch({ type: 'SET_AUTO_SCROLL', enabled }),

      setMobileActivePane: (pane: 'history' | 'terminal') =>
        dispatch({ type: 'SET_MOBILE_ACTIVE_PANE', pane }),

      setLayoutMode: (mode: 'split' | 'tabs') =>
        dispatch({ type: 'SET_LAYOUT_MODE', mode }),

      setSplitRatio: (ratio: number) =>
        dispatch({ type: 'SET_SPLIT_RATIO', ratio }),

      setWsConnected: (connected: boolean) =>
        dispatch({ type: 'SET_WS_CONNECTED', connected }),
    }),
    []
  );

  return { state, dispatch, actions };
}
