/**
 * Tests for useWorktreeUIState hook
 *
 * Tests the useReducer-based state management for worktree UI
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorktreeUIState, worktreeUIReducer } from '@/hooks/useWorktreeUIState';
import type { WorktreeUIState } from '@/types/ui-state';
import type { WorktreeUIAction } from '@/types/ui-actions';
import type { ChatMessage, PromptData, YesNoPromptData } from '@/types/models';
import { createInitialUIState } from '@/types/ui-state';

describe('worktreeUIReducer', () => {
  let initialState: WorktreeUIState;

  beforeEach(() => {
    initialState = createInitialUIState();
  });

  describe('Phase transitions', () => {
    it('should handle SET_PHASE action', () => {
      const action: WorktreeUIAction = { type: 'SET_PHASE', phase: 'waiting' };
      const result = worktreeUIReducer(initialState, action);
      expect(result.phase).toBe('waiting');
    });

    it('should transition through all phases', () => {
      const phases: Array<'idle' | 'waiting' | 'receiving' | 'prompt' | 'complete'> = [
        'idle',
        'waiting',
        'receiving',
        'prompt',
        'complete',
      ];

      phases.forEach((phase) => {
        const action: WorktreeUIAction = { type: 'SET_PHASE', phase };
        const result = worktreeUIReducer(initialState, action);
        expect(result.phase).toBe(phase);
      });
    });
  });

  // Issue #736: the terminal reducer slice (SET_TERMINAL_OUTPUT / SET_TERMINAL_ACTIVE
  // / SET_TERMINAL_THINKING / SET_AUTO_SCROLL) and the compound actions that touched
  // it were removed. Mobile (like the PC split panes, #728) now sources terminal
  // output from useTerminalPanePolling instead of this reducer.
  describe('Issue #736 — terminal slice removed', () => {
    it('does not expose a terminal slice on state', () => {
      const state = initialState as unknown as Record<string, unknown>;
      expect(state.terminal).toBeUndefined();
    });

    it('ignores legacy SET_TERMINAL_* / SET_AUTO_SCROLL actions (no-op, no terminal slice created)', () => {
      const legacyActions = [
        { type: 'SET_TERMINAL_OUTPUT', output: 'x', realtimeSnippet: 'y' },
        { type: 'SET_TERMINAL_ACTIVE', isActive: true },
        { type: 'SET_TERMINAL_THINKING', isThinking: true },
        { type: 'SET_AUTO_SCROLL', enabled: false },
      ] as unknown as WorktreeUIAction[];
      legacyActions.forEach((action) => {
        const result = worktreeUIReducer(initialState, action) as unknown as Record<string, unknown>;
        expect(result.terminal).toBeUndefined();
        expect(result).toEqual(initialState);
      });
    });
  });

  describe('Prompt actions', () => {
    it('should handle SHOW_PROMPT action', () => {
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Do you want to continue?',
        options: ['yes', 'no'],
        status: 'pending',
      };
      const action: WorktreeUIAction = {
        type: 'SHOW_PROMPT',
        data: promptData,
        messageId: 'msg-123',
      };
      const result = worktreeUIReducer(initialState, action);
      expect(result.phase).toBe('prompt');
      expect(result.prompt.data).toEqual(promptData);
      expect(result.prompt.messageId).toBe('msg-123');
      expect(result.prompt.visible).toBe(true);
      expect(result.prompt.answering).toBe(false);
    });

    it('should handle CLEAR_PROMPT action', () => {
      // First show a prompt
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Do you want to continue?',
        options: ['yes', 'no'],
        status: 'pending',
      };
      const showAction: WorktreeUIAction = {
        type: 'SHOW_PROMPT',
        data: promptData,
        messageId: 'msg-123',
      };
      const stateWithPrompt = worktreeUIReducer(initialState, showAction);

      // Then clear it
      const clearAction: WorktreeUIAction = { type: 'CLEAR_PROMPT' };
      const result = worktreeUIReducer(stateWithPrompt, clearAction);
      expect(result.prompt.data).toBeNull();
      expect(result.prompt.messageId).toBeNull();
      expect(result.prompt.visible).toBe(false);
      expect(result.prompt.answering).toBe(false);
    });

    it('should handle SET_PROMPT_ANSWERING action', () => {
      const action: WorktreeUIAction = { type: 'SET_PROMPT_ANSWERING', answering: true };
      const result = worktreeUIReducer(initialState, action);
      expect(result.prompt.answering).toBe(true);
    });
  });

  describe('Layout actions', () => {
    it('should handle SET_LAYOUT_MODE action', () => {
      const action: WorktreeUIAction = { type: 'SET_LAYOUT_MODE', mode: 'tabs' };
      const result = worktreeUIReducer(initialState, action);
      expect(result.layout.mode).toBe('tabs');
    });

    it('should handle SET_MOBILE_ACTIVE_PANE action', () => {
      const action: WorktreeUIAction = { type: 'SET_MOBILE_ACTIVE_PANE', pane: 'history' };
      const result = worktreeUIReducer(initialState, action);
      expect(result.layout.mobileActivePane).toBe('history');
    });

    it('should handle SET_SPLIT_RATIO action', () => {
      const action: WorktreeUIAction = { type: 'SET_SPLIT_RATIO', ratio: 0.7 };
      const result = worktreeUIReducer(initialState, action);
      expect(result.layout.splitRatio).toBe(0.7);
    });

    it('should have leftPaneCollapsed=false in initial state (Issue #688)', () => {
      expect(initialState.layout.leftPaneCollapsed).toBe(false);
    });

    it('should handle TOGGLE_LEFT_PANE action (Issue #688)', () => {
      const action: WorktreeUIAction = { type: 'TOGGLE_LEFT_PANE' };
      const result = worktreeUIReducer(initialState, action);
      expect(result.layout.leftPaneCollapsed).toBe(true);
    });

    it('should handle TOGGLE_LEFT_PANE action twice (toggle back) (Issue #688)', () => {
      const stateCollapsed = worktreeUIReducer(initialState, { type: 'TOGGLE_LEFT_PANE' });
      const result = worktreeUIReducer(stateCollapsed, { type: 'TOGGLE_LEFT_PANE' });
      expect(result.layout.leftPaneCollapsed).toBe(false);
    });

    it('should handle SET_LEFT_PANE_COLLAPSED action (Issue #688)', () => {
      const action: WorktreeUIAction = { type: 'SET_LEFT_PANE_COLLAPSED', collapsed: true };
      const result = worktreeUIReducer(initialState, action);
      expect(result.layout.leftPaneCollapsed).toBe(true);
    });

    it('should handle SET_LEFT_PANE_COLLAPSED action with false (Issue #688)', () => {
      const stateCollapsed = worktreeUIReducer(initialState, { type: 'SET_LEFT_PANE_COLLAPSED', collapsed: true });
      const result = worktreeUIReducer(stateCollapsed, { type: 'SET_LEFT_PANE_COLLAPSED', collapsed: false });
      expect(result.layout.leftPaneCollapsed).toBe(false);
    });
  });

  describe('Error actions', () => {
    it('should handle SET_ERROR action', () => {
      const errorState = {
        type: 'connection' as const,
        message: 'Connection lost',
        retryable: true,
        retryCount: 0,
      };
      const action: WorktreeUIAction = { type: 'SET_ERROR', error: errorState };
      const result = worktreeUIReducer(initialState, action);
      expect(result.error).toEqual(errorState);
    });

    it('should handle CLEAR_ERROR action', () => {
      // First set an error
      const errorState = {
        type: 'connection' as const,
        message: 'Connection lost',
        retryable: true,
        retryCount: 1,
      };
      const setErrorAction: WorktreeUIAction = { type: 'SET_ERROR', error: errorState };
      const stateWithError = worktreeUIReducer(initialState, setErrorAction);

      // Then clear it
      const clearAction: WorktreeUIAction = { type: 'CLEAR_ERROR' };
      const result = worktreeUIReducer(stateWithError, clearAction);
      expect(result.error.type).toBeNull();
      expect(result.error.message).toBeNull();
      expect(result.error.retryable).toBe(false);
      expect(result.error.retryCount).toBe(0);
    });

    it('should handle INCREMENT_RETRY_COUNT action', () => {
      const errorState = {
        type: 'connection' as const,
        message: 'Connection lost',
        retryable: true,
        retryCount: 0,
      };
      const setErrorAction: WorktreeUIAction = { type: 'SET_ERROR', error: errorState };
      const stateWithError = worktreeUIReducer(initialState, setErrorAction);

      const incrementAction: WorktreeUIAction = { type: 'INCREMENT_RETRY_COUNT' };
      const result = worktreeUIReducer(stateWithError, incrementAction);
      expect(result.error.retryCount).toBe(1);
    });
  });

  describe('Message actions', () => {
    const mockMessage: ChatMessage = {
      id: 'msg-1',
      worktreeId: 'wt-1',
      role: 'user',
      content: 'Hello',
      timestamp: new Date(),
      messageType: 'normal',
      archived: false,
    };

    it('should handle SET_MESSAGES action', () => {
      const action: WorktreeUIAction = { type: 'SET_MESSAGES', messages: [mockMessage] };
      const result = worktreeUIReducer(initialState, action);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(mockMessage);
    });

    it('should handle ADD_MESSAGE action', () => {
      const action: WorktreeUIAction = { type: 'ADD_MESSAGE', message: mockMessage };
      const result = worktreeUIReducer(initialState, action);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(mockMessage);
    });

    it('should handle UPDATE_MESSAGE action', () => {
      const setAction: WorktreeUIAction = { type: 'SET_MESSAGES', messages: [mockMessage] };
      const stateWithMessage = worktreeUIReducer(initialState, setAction);

      const updateAction: WorktreeUIAction = {
        type: 'UPDATE_MESSAGE',
        id: 'msg-1',
        updates: { content: 'Updated' },
      };
      const result = worktreeUIReducer(stateWithMessage, updateAction);
      expect(result.messages[0].content).toBe('Updated');
    });

    it('should handle CLEAR_MESSAGES action', () => {
      const setAction: WorktreeUIAction = { type: 'SET_MESSAGES', messages: [mockMessage] };
      const stateWithMessage = worktreeUIReducer(initialState, setAction);

      const clearAction: WorktreeUIAction = { type: 'CLEAR_MESSAGES' };
      const result = worktreeUIReducer(stateWithMessage, clearAction);
      expect(result.messages).toHaveLength(0);
    });
  });

  describe('Connection actions', () => {
    it('should handle SET_WS_CONNECTED action', () => {
      const action: WorktreeUIAction = { type: 'SET_WS_CONNECTED', connected: true };
      const result = worktreeUIReducer(initialState, action);
      expect(result.wsConnected).toBe(true);
    });
  });

  describe('Unknown actions', () => {
    it('should return current state for unknown action', () => {
      const unknownAction = { type: 'UNKNOWN_ACTION' } as unknown as WorktreeUIAction;
      const result = worktreeUIReducer(initialState, unknownAction);
      expect(result).toEqual(initialState);
    });
  });
});

describe('useWorktreeUIState hook', () => {
  it('should return initial state', () => {
    const { result } = renderHook(() => useWorktreeUIState());
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.wsConnected).toBe(false);
  });

  it('should provide action creators', () => {
    const { result } = renderHook(() => useWorktreeUIState());
    expect(typeof result.current.actions.setPhase).toBe('function');
    expect(typeof result.current.actions.showPrompt).toBe('function');
    expect(typeof result.current.actions.clearPrompt).toBe('function');
    expect(typeof result.current.actions.setError).toBe('function');
    expect(typeof result.current.actions.clearError).toBe('function');
    expect(typeof result.current.actions.setMessages).toBe('function');
    expect(typeof result.current.actions.setMobileActivePane).toBe('function');
    expect(typeof result.current.actions.toggleLeftPane).toBe('function');
  });

  // Issue #736: removed terminal/compound action creators must be gone.
  it('does not expose removed terminal/compound action creators (Issue #736)', () => {
    const { result } = renderHook(() => useWorktreeUIState());
    const actions = result.current.actions as unknown as Record<string, unknown>;
    expect(actions.setTerminalOutput).toBeUndefined();
    expect(actions.setTerminalActive).toBeUndefined();
    expect(actions.setTerminalThinking).toBeUndefined();
    expect(actions.setAutoScroll).toBeUndefined();
    expect(actions.startWaitingForResponse).toBeUndefined();
    expect(actions.responseReceived).toBeUndefined();
    expect(actions.sessionEnded).toBeUndefined();
  });

  it('should toggle left pane collapsed state (Issue #688)', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    expect(result.current.state.layout.leftPaneCollapsed).toBe(false);

    act(() => {
      result.current.actions.toggleLeftPane();
    });

    expect(result.current.state.layout.leftPaneCollapsed).toBe(true);

    act(() => {
      result.current.actions.toggleLeftPane();
    });

    expect(result.current.state.layout.leftPaneCollapsed).toBe(false);
  });

  it('should update state when action is dispatched', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    act(() => {
      result.current.actions.setPhase('waiting');
    });

    expect(result.current.state.phase).toBe('waiting');
  });

  it('should show and clear prompt', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    const promptData: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    act(() => {
      result.current.actions.showPrompt(promptData, 'msg-1');
    });

    expect(result.current.state.prompt.visible).toBe(true);
    expect(result.current.state.prompt.data).toEqual(promptData);

    act(() => {
      result.current.actions.clearPrompt();
    });

    expect(result.current.state.prompt.visible).toBe(false);
    expect(result.current.state.prompt.data).toBeNull();
  });

  // Issue #728: ensure terminal-splits state was NOT added to the reducer.
  // Independent hook (useTerminalSplits) owns that domain, per S3-006.
  describe('Issue #728 — no terminalSplits state slice (S3-006)', () => {
    it('does not expose a terminalSplits slice on state.layout or state root', () => {
      const { result } = renderHook(() => useWorktreeUIState());
      const state = result.current.state as unknown as Record<string, unknown> & {
        layout?: Record<string, unknown>;
      };
      expect(state.terminalSplits).toBeUndefined();
      expect(state.splits).toBeUndefined();
      expect(state.layout?.terminalSplits).toBeUndefined();
      expect(state.layout?.splits).toBeUndefined();
    });

    it('does not expose terminalSplits action creators', () => {
      const { result } = renderHook(() => useWorktreeUIState());
      const actions = result.current.actions as unknown as Record<string, unknown>;
      expect(actions.addSplit).toBeUndefined();
      expect(actions.removeSplit).toBeUndefined();
      expect(actions.setSplitCliTool).toBeUndefined();
      expect(actions.setSplitWidth).toBeUndefined();
      expect(actions.setFocusedSplitIndex).toBeUndefined();
    });
  });
});
