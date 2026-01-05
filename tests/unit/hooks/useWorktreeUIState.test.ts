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

  describe('Terminal actions', () => {
    it('should handle SET_TERMINAL_OUTPUT action', () => {
      const action: WorktreeUIAction = {
        type: 'SET_TERMINAL_OUTPUT',
        output: 'Test output',
        realtimeSnippet: 'Snippet',
      };
      const result = worktreeUIReducer(initialState, action);
      expect(result.terminal.output).toBe('Test output');
      expect(result.terminal.realtimeSnippet).toBe('Snippet');
      expect(result.terminal.lastUpdated).toBeInstanceOf(Date);
    });

    it('should handle SET_TERMINAL_ACTIVE action', () => {
      const action: WorktreeUIAction = { type: 'SET_TERMINAL_ACTIVE', isActive: true };
      const result = worktreeUIReducer(initialState, action);
      expect(result.terminal.isActive).toBe(true);
    });

    it('should handle SET_TERMINAL_THINKING action', () => {
      const action: WorktreeUIAction = { type: 'SET_TERMINAL_THINKING', isThinking: true };
      const result = worktreeUIReducer(initialState, action);
      expect(result.terminal.isThinking).toBe(true);
    });

    it('should handle SET_AUTO_SCROLL action', () => {
      const action: WorktreeUIAction = { type: 'SET_AUTO_SCROLL', enabled: false };
      const result = worktreeUIReducer(initialState, action);
      expect(result.terminal.autoScroll).toBe(false);
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

  describe('Compound actions', () => {
    it('should handle START_WAITING_FOR_RESPONSE action', () => {
      const action: WorktreeUIAction = {
        type: 'START_WAITING_FOR_RESPONSE',
        cliToolId: 'claude',
      };
      const result = worktreeUIReducer(initialState, action);
      expect(result.phase).toBe('waiting');
      expect(result.terminal.isActive).toBe(true);
      expect(result.terminal.output).toBe('');
      expect(result.terminal.realtimeSnippet).toBe('');
      expect(result.prompt.visible).toBe(false);
    });

    it('should handle RESPONSE_RECEIVED action', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        worktreeId: 'wt-1',
        role: 'assistant',
        content: 'Response',
        timestamp: new Date(),
        messageType: 'normal',
      };
      const action: WorktreeUIAction = { type: 'RESPONSE_RECEIVED', message };
      const result = worktreeUIReducer(initialState, action);
      expect(result.phase).toBe('complete');
      expect(result.messages).toContainEqual(message);
      expect(result.terminal.isActive).toBe(false);
      expect(result.terminal.isThinking).toBe(false);
    });

    it('should handle SESSION_ENDED action', () => {
      // First, simulate an active session
      const activeState = worktreeUIReducer(initialState, {
        type: 'START_WAITING_FOR_RESPONSE',
        cliToolId: 'claude',
      });

      const action: WorktreeUIAction = { type: 'SESSION_ENDED' };
      const result = worktreeUIReducer(activeState, action);
      expect(result.phase).toBe('idle');
      expect(result.terminal.isActive).toBe(false);
      expect(result.terminal.output).toBe('');
      expect(result.prompt.visible).toBe(false);
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
    expect(typeof result.current.actions.setTerminalOutput).toBe('function');
    expect(typeof result.current.actions.showPrompt).toBe('function');
    expect(typeof result.current.actions.clearPrompt).toBe('function');
    expect(typeof result.current.actions.setError).toBe('function');
    expect(typeof result.current.actions.clearError).toBe('function');
    expect(typeof result.current.actions.setMessages).toBe('function');
    expect(typeof result.current.actions.startWaitingForResponse).toBe('function');
    expect(typeof result.current.actions.responseReceived).toBe('function');
    expect(typeof result.current.actions.sessionEnded).toBe('function');
    expect(typeof result.current.actions.setAutoScroll).toBe('function');
    expect(typeof result.current.actions.setMobileActivePane).toBe('function');
  });

  it('should update state when action is dispatched', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    act(() => {
      result.current.actions.setPhase('waiting');
    });

    expect(result.current.state.phase).toBe('waiting');
  });

  it('should update terminal output', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    act(() => {
      result.current.actions.setTerminalOutput('Test output', 'Snippet');
    });

    expect(result.current.state.terminal.output).toBe('Test output');
    expect(result.current.state.terminal.realtimeSnippet).toBe('Snippet');
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

  it('should handle compound actions', () => {
    const { result } = renderHook(() => useWorktreeUIState());

    act(() => {
      result.current.actions.startWaitingForResponse('claude');
    });

    expect(result.current.state.phase).toBe('waiting');
    expect(result.current.state.terminal.isActive).toBe(true);

    const message: ChatMessage = {
      id: 'msg-1',
      worktreeId: 'wt-1',
      role: 'assistant',
      content: 'Response',
      timestamp: new Date(),
      messageType: 'normal',
    };

    act(() => {
      result.current.actions.responseReceived(message);
    });

    expect(result.current.state.phase).toBe('complete');
    expect(result.current.state.messages).toHaveLength(1);
  });
});
