/**
 * WorktreeDetailRefactored Component
 *
 * Integrates worktree UI components with responsive layout support:
 * - Desktop: 2-column split layout (History | Terminal) with resizable panes
 * - Mobile: Tab-based navigation with header and bottom tab bar
 *
 * Features:
 * - Real-time terminal output polling
 * - Prompt detection and response handling
 * - Error boundary protection
 * - useReducer-based state management
 *
 * Based on Issue #13 UX Improvement design specification
 */

'use client';

import React, { useEffect, useCallback, useMemo, useState, memo } from 'react';
import { useRouter } from 'next/navigation';
import { useWorktreeUIState } from '@/hooks/useWorktreeUIState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MobileHeader, type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { MobileTabBar, type MobileTab } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import { Modal } from '@/components/ui/Modal';
import type { Worktree, ChatMessage, PromptData } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

/** Props for WorktreeDetailRefactored component */
export interface WorktreeDetailRefactoredProps {
  /** Worktree ID to display */
  worktreeId: string;
}

/** API response shape for current output endpoint */
interface CurrentOutputResponse {
  isRunning: boolean;
  isGenerating?: boolean;
  isPromptWaiting?: boolean;
  promptData?: PromptData;
  content?: string;
  fullOutput?: string;
  realtimeSnippet?: string;
  thinking?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Polling interval when terminal is active (ms) */
const ACTIVE_POLLING_INTERVAL_MS = 2000;

/** Polling interval when terminal is idle (ms) */
const IDLE_POLLING_INTERVAL_MS = 5000;

/** Default worktree name when not loaded */
const DEFAULT_WORKTREE_NAME = 'Unknown';

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert UI state to WorktreeStatus for MobileHeader display */
function deriveWorktreeStatus(
  isTerminalActive: boolean,
  isReceiving: boolean,
  isPromptVisible: boolean,
  hasError: boolean
): WorktreeStatus {
  if (hasError) return 'error';
  if (isPromptVisible) return 'waiting';
  if (isReceiving || isTerminalActive) return 'running';
  return 'idle';
}

/** Parse message timestamps from API response */
function parseMessageTimestamps(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

// ============================================================================
// Sub-components
// ============================================================================

/** Props for DesktopHeader component */
interface DesktopHeaderProps {
  worktreeName: string;
  onBackClick: () => void;
  onInfoClick: () => void;
}

/** Desktop header with back button, worktree name, and info button */
const DesktopHeader = memo(function DesktopHeader({
  worktreeName,
  onBackClick,
  onInfoClick,
}: DesktopHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
      {/* Left: Back button and title */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBackClick}
          className="flex items-center gap-1 text-gray-600 hover:text-gray-900 transition-colors"
          aria-label="Go back to worktree list"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          <span className="text-sm font-medium">Back</span>
        </button>
        <div className="w-px h-6 bg-gray-300" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-gray-900 truncate max-w-md">
          {worktreeName}
        </h1>
      </div>

      {/* Right: Info button */}
      <button
        type="button"
        onClick={onInfoClick}
        className="flex items-center gap-1.5 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        aria-label="View worktree information"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="text-sm font-medium">Info</span>
      </button>
    </div>
  );
});

/** Props for InfoModal component */
interface InfoModalProps {
  worktree: Worktree | null;
  isOpen: boolean;
  onClose: () => void;
}

/** Modal displaying worktree information */
const InfoModal = memo(function InfoModal({
  worktree,
  isOpen,
  onClose,
}: InfoModalProps) {
  if (!worktree) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Worktree Information" size="md">
      <div className="space-y-4">
        {/* Worktree Name */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-500 mb-1">Worktree</h2>
          <p className="text-lg font-semibold text-gray-900">{worktree.name}</p>
        </div>

        {/* Repository Info */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-500 mb-1">Repository</h2>
          <p className="text-base text-gray-900">{worktree.repositoryName}</p>
          <p className="text-xs text-gray-500 mt-1 break-all">{worktree.repositoryPath}</p>
        </div>

        {/* Path */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-500 mb-1">Path</h2>
          <p className="text-sm text-gray-700 break-all font-mono">{worktree.path}</p>
        </div>

        {/* Status */}
        {worktree.status && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-500 mb-1">Status</h2>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              worktree.status === 'done' ? 'bg-green-100 text-green-800' :
              worktree.status === 'doing' ? 'bg-blue-100 text-blue-800' :
              'bg-gray-100 text-gray-800'
            }`}>
              {worktree.status.toUpperCase()}
            </span>
          </div>
        )}

        {/* Memo */}
        {worktree.memo && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-500 mb-1">Memo</h2>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{worktree.memo}</p>
          </div>
        )}

        {/* Link */}
        {worktree.link && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-500 mb-1">Link</h2>
            <a
              href={worktree.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline break-all"
            >
              {worktree.link}
            </a>
          </div>
        )}

        {/* Last Updated */}
        {worktree.updatedAt && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-500 mb-1">Last Updated</h2>
            <p className="text-sm text-gray-700">
              {new Date(worktree.updatedAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
});

/** Loading indicator with spinner and text */
const LoadingIndicator = memo(function LoadingIndicator() {
  return (
    <div
      className="flex items-center justify-center h-full min-h-[200px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600"
          aria-hidden="true"
        />
        <p className="text-gray-600">Loading worktree...</p>
      </div>
    </div>
  );
});

/** Props for ErrorDisplay component */
interface ErrorDisplayProps {
  message: string;
  onRetry?: () => void;
}

/** Error display with optional retry button */
const ErrorDisplay = memo(function ErrorDisplay({
  message,
  onRetry,
}: ErrorDisplayProps) {
  return (
    <div
      className="flex items-center justify-center h-full min-h-[200px]"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center p-6 bg-red-50 rounded-lg border border-red-200 max-w-md">
        <svg
          className="mx-auto h-12 w-12 text-red-400 mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-red-600 font-medium">Error loading worktree</p>
        <p className="text-red-500 text-sm mt-2">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// Mobile Content Component
// ============================================================================

/** Props for MobileContent component */
interface MobileContentProps {
  activeTab: MobileTab;
  worktreeId: string;
  worktree: Worktree | null;
  messages: ChatMessage[];
  terminalOutput: string;
  isTerminalActive: boolean;
  isThinking: boolean;
  onFilePathClick: (path: string) => void;
}

/** Renders content based on active mobile tab */
const MobileContent = memo(function MobileContent({
  activeTab,
  worktreeId,
  worktree,
  messages,
  terminalOutput,
  isTerminalActive,
  isThinking,
  onFilePathClick,
}: MobileContentProps) {
  switch (activeTab) {
    case 'terminal':
      return (
        <ErrorBoundary componentName="TerminalDisplay">
          <TerminalDisplay
            output={terminalOutput}
            isActive={isTerminalActive}
            isThinking={isThinking}
            className="h-full"
          />
        </ErrorBoundary>
      );
    case 'history':
      return (
        <ErrorBoundary componentName="HistoryPane">
          <HistoryPane
            messages={messages}
            worktreeId={worktreeId}
            onFilePathClick={onFilePathClick}
            className="h-full"
          />
        </ErrorBoundary>
      );
    case 'logs':
      return (
        <div className="p-4 text-gray-500 text-center" role="status">
          Logs view coming soon
        </div>
      );
    case 'info':
      return (
        <div className="p-4 space-y-4 overflow-y-auto h-full">
          {worktree ? (
            <>
              {/* Worktree Name */}
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-sm font-medium text-gray-500 mb-1">Worktree</h2>
                <p className="text-lg font-semibold text-gray-900">{worktree.name}</p>
              </div>

              {/* Repository Info */}
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-sm font-medium text-gray-500 mb-1">Repository</h2>
                <p className="text-base text-gray-900">{worktree.repositoryName}</p>
                <p className="text-xs text-gray-500 mt-1 break-all">{worktree.repositoryPath}</p>
              </div>

              {/* Path */}
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-sm font-medium text-gray-500 mb-1">Path</h2>
                <p className="text-sm text-gray-700 break-all font-mono">{worktree.path}</p>
              </div>

              {/* Status */}
              {worktree.status && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-sm font-medium text-gray-500 mb-1">Status</h2>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    worktree.status === 'done' ? 'bg-green-100 text-green-800' :
                    worktree.status === 'doing' ? 'bg-blue-100 text-blue-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {worktree.status.toUpperCase()}
                  </span>
                </div>
              )}

              {/* Memo */}
              {worktree.memo && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-sm font-medium text-gray-500 mb-1">Memo</h2>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{worktree.memo}</p>
                </div>
              )}

              {/* Link */}
              {worktree.link && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-sm font-medium text-gray-500 mb-1">Link</h2>
                  <a
                    href={worktree.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline break-all"
                  >
                    {worktree.link}
                  </a>
                </div>
              )}

              {/* Last Updated */}
              {worktree.updatedAt && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-sm font-medium text-gray-500 mb-1">Last Updated</h2>
                  <p className="text-sm text-gray-700">
                    {new Date(worktree.updatedAt).toLocaleString()}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-500 text-center py-8">
              Loading worktree info...
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * WorktreeDetailRefactored - Integrated worktree detail component
 *
 * @example
 * ```tsx
 * <WorktreeDetailRefactored worktreeId="feature-123" />
 * ```
 */
export const WorktreeDetailRefactored = memo(function WorktreeDetailRefactored({
  worktreeId,
}: WorktreeDetailRefactoredProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { state, actions } = useWorktreeUIState();

  // Local state for worktree data and loading status
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);

  // ========================================================================
  // API Fetch Functions
  // ========================================================================

  /** Fetch worktree metadata */
  const fetchWorktree = useCallback(async (): Promise<Worktree | null> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch worktree: ${response.status}`);
      }
      const data: Worktree = await response.json();
      setWorktree(data);
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return null;
    }
  }, [worktreeId]);

  /** Fetch message history for the worktree */
  const fetchMessages = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/messages?cliTool=claude`);
      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.status}`);
      }
      const data: ChatMessage[] = await response.json();
      actions.setMessages(parseMessageTimestamps(data));
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error fetching messages:', err);
    }
  }, [worktreeId, actions]);

  /** Fetch current terminal output and prompt status */
  const fetchCurrentOutput = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/current-output?cliTool=claude`);
      if (!response.ok) {
        return;
      }
      const data: CurrentOutputResponse = await response.json();

      // Update terminal state - use fullOutput for complete display, fallback to realtimeSnippet
      // Only clear output if we explicitly have empty fullOutput (session not running returns empty)
      const terminalOutput = data.fullOutput ?? data.realtimeSnippet ?? '';

      // Only update terminal output if we have content or session is running
      // This prevents clearing the terminal when polling returns empty during session transitions
      if (terminalOutput || data.isRunning) {
        actions.setTerminalOutput(terminalOutput, data.realtimeSnippet ?? '');
      }

      actions.setTerminalActive(data.isRunning ?? false);
      actions.setTerminalThinking(data.thinking ?? false);

      // Handle prompt state transitions
      if (data.isPromptWaiting && data.promptData) {
        actions.showPrompt(data.promptData, `prompt-${Date.now()}`);
      } else if (!data.isPromptWaiting && state.prompt.visible) {
        actions.clearPrompt();
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error fetching current output:', err);
    }
  }, [worktreeId, actions, state.prompt.visible]);

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /** Handle file path click in history pane (placeholder for future implementation) */
  const handleFilePathClick = useCallback((path: string) => {
    console.log('[WorktreeDetailRefactored] File path clicked:', path);
  }, []);

  /** Handle back button click - navigate to portal */
  const handleBackClick = useCallback(() => {
    router.push('/');
  }, [router]);

  /** Handle info button click - open info modal */
  const handleInfoClick = useCallback(() => {
    setIsInfoModalOpen(true);
  }, []);

  /** Handle info modal close */
  const handleInfoModalClose = useCallback(() => {
    setIsInfoModalOpen(false);
  }, []);

  /** Handle prompt response submission */
  const handlePromptRespond = useCallback(
    async (answer: string): Promise<void> => {
      actions.setPromptAnswering(true);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer, cliTool: 'claude' }),
        });
        if (!response.ok) {
          throw new Error(`Failed to send prompt response: ${response.status}`);
        }
        actions.clearPrompt();
      } catch (err) {
        console.error('[WorktreeDetailRefactored] Error sending prompt response:', err);
      } finally {
        actions.setPromptAnswering(false);
      }
    },
    [worktreeId, actions]
  );

  /** Handle prompt dismiss without response */
  const handlePromptDismiss = useCallback(() => {
    actions.clearPrompt();
  }, [actions]);

  /** Handle mobile tab navigation */
  const handleMobileTabChange = useCallback(
    (tab: MobileTab) => {
      actions.setMobileActivePane(tab);
    },
    [actions]
  );

  /** Handle terminal auto-scroll toggle */
  const handleAutoScrollChange = useCallback(
    (enabled: boolean) => {
      actions.setAutoScroll(enabled);
    },
    [actions]
  );

  /** Handle message sent - refresh messages after sending */
  const handleMessageSent = useCallback(
    () => {
      // Refresh messages after sending
      void fetchMessages();
      void fetchCurrentOutput();
    },
    [fetchMessages, fetchCurrentOutput]
  );

  /** Retry loading all data after error */
  const handleRetry = useCallback(async (): Promise<void> => {
    setError(null);
    setLoading(true);
    const worktreeData = await fetchWorktree();
    if (worktreeData) {
      await Promise.all([fetchMessages(), fetchCurrentOutput()]);
    }
    setLoading(false);
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);

  // ========================================================================
  // Effects
  // ========================================================================

  /** Initial data fetch on mount */
  useEffect(() => {
    let isMounted = true;

    const loadInitialData = async () => {
      setLoading(true);
      const worktreeData = await fetchWorktree();
      if (!isMounted) return;

      if (worktreeData) {
        await Promise.all([fetchMessages(), fetchCurrentOutput()]);
      }
      if (isMounted) {
        setLoading(false);
      }
    };

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);

  /** Poll for current output at adaptive intervals */
  useEffect(() => {
    if (loading || error) return;

    const pollingInterval = state.terminal.isActive
      ? ACTIVE_POLLING_INTERVAL_MS
      : IDLE_POLLING_INTERVAL_MS;

    const intervalId = setInterval(fetchCurrentOutput, pollingInterval);

    return () => clearInterval(intervalId);
  }, [loading, error, fetchCurrentOutput, state.terminal.isActive]);

  /** Sync layout mode with viewport size */
  useEffect(() => {
    actions.setLayoutMode(isMobile ? 'tabs' : 'split');
  }, [isMobile, actions]);

  // ========================================================================
  // Computed Values
  // ========================================================================

  /** Derive worktree status for mobile header display */
  const worktreeStatus = useMemo<WorktreeStatus>(
    () =>
      deriveWorktreeStatus(
        state.terminal.isActive,
        state.phase === 'receiving',
        state.prompt.visible,
        state.error.type !== null
      ),
    [state.terminal.isActive, state.phase, state.prompt.visible, state.error.type]
  );

  /** Current active tab for mobile view */
  const activeTab = useMemo<MobileTab>(
    () => state.layout.mobileActivePane,
    [state.layout.mobileActivePane]
  );

  /** Display name for worktree */
  const worktreeName = worktree?.name ?? DEFAULT_WORKTREE_NAME;

  // ========================================================================
  // Render
  // ========================================================================

  // Handle loading state
  if (loading) {
    return <LoadingIndicator />;
  }

  // Handle error state
  if (error) {
    return <ErrorDisplay message={error} onRetry={handleRetry} />;
  }

  // Render desktop layout
  if (!isMobile) {
    return (
      <ErrorBoundary componentName="WorktreeDetailRefactored">
        <div className="h-full flex flex-col relative">
          {/* Desktop Header with back button and info */}
          <DesktopHeader
            worktreeName={worktreeName}
            onBackClick={handleBackClick}
            onInfoClick={handleInfoClick}
          />
          <div className="flex-1 min-h-0">
            <WorktreeDesktopLayout
              leftPane={
                <HistoryPane
                  messages={state.messages}
                  worktreeId={worktreeId}
                  onFilePathClick={handleFilePathClick}
                />
              }
              rightPane={
                <TerminalDisplay
                  output={state.terminal.output}
                  isActive={state.terminal.isActive}
                  isThinking={state.terminal.isThinking}
                  autoScroll={state.terminal.autoScroll}
                  onScrollChange={handleAutoScrollChange}
                />
              }
              initialLeftWidth={40}
              minLeftWidth={20}
              maxLeftWidth={60}
            />
          </div>
          <div className="flex-shrink-0 border-t border-gray-200 p-4 bg-gray-50">
            <MessageInput
              worktreeId={worktreeId}
              onMessageSent={handleMessageSent}
              cliToolId="claude"
            />
          </div>
          {/* Prompt Panel - fixed overlay at bottom */}
          {state.prompt.visible && (
            <div className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-2xl px-4">
              <PromptPanel
                promptData={state.prompt.data}
                messageId={state.prompt.messageId}
                visible={state.prompt.visible}
                answering={state.prompt.answering}
                onRespond={handlePromptRespond}
                onDismiss={handlePromptDismiss}
              />
            </div>
          )}
          {/* Info Modal */}
          <InfoModal
            worktree={worktree}
            isOpen={isInfoModalOpen}
            onClose={handleInfoModalClose}
          />
        </div>
      </ErrorBoundary>
    );
  }

  // Render mobile layout
  return (
    <ErrorBoundary componentName="WorktreeDetailRefactored">
      <div className="h-full flex flex-col">
        <MobileHeader
          worktreeName={worktreeName}
          status={worktreeStatus}
          onBackClick={handleBackClick}
        />

        <main className="flex-1 pt-14 pb-32 overflow-hidden">
          <MobileContent
            activeTab={activeTab}
            worktreeId={worktreeId}
            worktree={worktree}
            messages={state.messages}
            terminalOutput={state.terminal.output}
            isTerminalActive={state.terminal.isActive}
            isThinking={state.terminal.isThinking}
            onFilePathClick={handleFilePathClick}
          />
        </main>

        {/* Message Input - fixed above tab bar */}
        <div className="fixed bottom-16 left-0 right-0 border-t border-gray-200 bg-white p-2 z-10">
          <MessageInput
            worktreeId={worktreeId}
            onMessageSent={handleMessageSent}
            cliToolId="claude"
          />
        </div>

        <MobileTabBar
          activeTab={activeTab}
          onTabChange={handleMobileTabChange}
          hasNewOutput={false}
          hasPrompt={state.prompt.visible}
        />

        <MobilePromptSheet
          promptData={state.prompt.data}
          visible={state.prompt.visible}
          answering={state.prompt.answering}
          onRespond={handlePromptRespond}
          onDismiss={handlePromptDismiss}
        />
      </div>
    </ErrorBoundary>
  );
});

export default WorktreeDetailRefactored;
