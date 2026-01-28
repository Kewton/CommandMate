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

import React, { useEffect, useCallback, useMemo, useState, memo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useWorktreeUIState } from '@/hooks/useWorktreeUIState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MobileHeader, type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { DESKTOP_STATUS_CONFIG } from '@/config/status-colors';
import { MobileTabBar, type MobileTab } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { LeftPaneTabSwitcher, type LeftPaneTab } from '@/components/worktree/LeftPaneTabSwitcher';
import { FileViewer } from '@/components/worktree/FileViewer';
import { MemoPane } from '@/components/worktree/MemoPane';
import { Modal } from '@/components/ui/Modal';
import { worktreeApi } from '@/lib/api-client';
import { useAutoYes } from '@/hooks/useAutoYes';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
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
  autoYes?: {
    enabled: boolean;
    expiresAt: number | null;
  };
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

/** Convert worktree data to WorktreeStatus - consistent with sidebar */
function deriveWorktreeStatus(
  worktree: Worktree | null,
  hasError: boolean
): WorktreeStatus {
  if (hasError) return 'error';
  if (!worktree) return 'idle';

  // Use the same logic as sidebar (from API response)
  const claudeStatus = worktree.sessionStatusByCli?.claude;
  if (claudeStatus) {
    if (claudeStatus.isWaitingForResponse) {
      return 'waiting';
    }
    if (claudeStatus.isProcessing) {
      return 'running';
    }
    // Session running but not processing = ready (waiting for user to type new message)
    if (claudeStatus.isRunning) {
      return 'ready';
    }
  }

  // Fall back to legacy status fields
  if (worktree.isWaitingForResponse) {
    return 'waiting';
  }
  if (worktree.isProcessing) {
    return 'running';
  }
  // Session running but not processing = ready
  if (worktree.isSessionRunning) {
    return 'ready';
  }

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
  repositoryName: string;
  description?: string;
  status: WorktreeStatus;
  onBackClick: () => void;
  onInfoClick: () => void;
  onMenuClick: () => void;
}

/** Status indicator configuration is imported from @/config/status-colors (SF1) */

/** Desktop header with hamburger menu, back button, worktree name, repository, status, and info button */
const DesktopHeader = memo(function DesktopHeader({
  worktreeName,
  repositoryName,
  description: worktreeDescription,
  status,
  onBackClick,
  onInfoClick,
  onMenuClick,
}: DesktopHeaderProps) {
  const statusConfig = DESKTOP_STATUS_CONFIG[status];
  // Truncate description to 50 characters
  const truncatedDescription = worktreeDescription
    ? worktreeDescription.length > 50
      ? `${worktreeDescription.substring(0, 50)}...`
      : worktreeDescription
    : null;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
      {/* Left: Menu, Back button and title */}
      <div className="flex items-center gap-3">
        {/* Hamburger menu button */}
        <button
          type="button"
          onClick={onMenuClick}
          className="p-2 -ml-2 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          aria-label="Toggle sidebar"
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
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
        <div className="w-px h-6 bg-gray-300" aria-hidden="true" />
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
        {/* Status indicator */}
        {statusConfig.type === 'spinner' ? (
          <span
            data-testid="desktop-status-indicator"
            title={statusConfig.label}
            aria-label={statusConfig.label}
            className={`w-3 h-3 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
          />
        ) : (
          <span
            data-testid="desktop-status-indicator"
            title={statusConfig.label}
            aria-label={statusConfig.label}
            className={`w-3 h-3 rounded-full flex-shrink-0 ${statusConfig.className}`}
          />
        )}
        {/* Worktree name, memo, and repository */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900 truncate max-w-[200px] leading-tight">
              {worktreeName}
            </h1>
            {truncatedDescription && (
              <span
                className="text-sm text-gray-500 truncate max-w-md"
                title={worktreeDescription}
              >
                {truncatedDescription}
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500 truncate max-w-md">
            {repositoryName}
          </span>
        </div>
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
  onWorktreeUpdate: (updated: Worktree) => void;
}

/** Modal displaying worktree information with description editing */
const InfoModal = memo(function InfoModal({
  worktree,
  isOpen,
  onClose,
  onWorktreeUpdate,
}: InfoModalProps) {
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Track previous isOpen state to detect modal opening
  const prevIsOpenRef = useRef(isOpen);

  // Only sync description text when modal opens (not on every worktree poll)
  useEffect(() => {
    const wasOpened = isOpen && !prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    // Only reset description text when modal first opens, not during editing
    if (wasOpened && worktree) {
      setDescriptionText(worktree.description || '');
      setIsEditingDescription(false);
    }
  }, [worktree, isOpen]);

  const handleSaveDescription = useCallback(async () => {
    if (!worktree) return;
    setIsSaving(true);
    try {
      const updated = await worktreeApi.updateDescription(worktree.id, descriptionText);
      onWorktreeUpdate(updated);
      setIsEditingDescription(false);
    } catch (err) {
      console.error('Failed to save description:', err);
    } finally {
      setIsSaving(false);
    }
  }, [worktree, descriptionText, onWorktreeUpdate]);

  const handleCancelDescription = useCallback(() => {
    setDescriptionText(worktree?.description || '');
    setIsEditingDescription(false);
  }, [worktree]);

  if (!worktree) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Worktree Information" size="md">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
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

        {/* Description - Editable */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-gray-500">Description</h2>
            {!isEditingDescription && (
              <button
                type="button"
                onClick={() => setIsEditingDescription(true)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Edit
              </button>
            )}
          </div>
          {isEditingDescription ? (
            <div className="space-y-3">
              <textarea
                value={descriptionText}
                onChange={(e) => setDescriptionText(e.target.value)}
                placeholder="Add notes about this branch..."
                className="w-full min-h-[150px] p-3 border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveDescription}
                  disabled={isSaving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={handleCancelDescription}
                  disabled={isSaving}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50 text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="min-h-[50px]">
              {worktree.description ? (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{worktree.description}</p>
              ) : (
                <p className="text-sm text-gray-400 italic">No description added yet</p>
              )}
            </div>
          )}
        </div>

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

/** Props for MobileInfoContent component */
interface MobileInfoContentProps {
  worktree: Worktree | null;
  onWorktreeUpdate: (updated: Worktree) => void;
}

/** Mobile Info tab content with description editing */
const MobileInfoContent = memo(function MobileInfoContent({
  worktree,
  onWorktreeUpdate,
}: MobileInfoContentProps) {
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Track previous worktree ID to detect worktree changes
  const prevWorktreeIdRef = useRef(worktree?.id);

  // Only sync description text when worktree changes (not during editing due to polling)
  useEffect(() => {
    const worktreeChanged = worktree?.id !== prevWorktreeIdRef.current;
    prevWorktreeIdRef.current = worktree?.id;

    // Only reset description text when worktree changes, not during editing
    if (worktreeChanged && worktree && !isEditingDescription) {
      setDescriptionText(worktree.description || '');
    }
  }, [worktree, isEditingDescription]);

  const handleSaveDescription = useCallback(async () => {
    if (!worktree) return;
    setIsSaving(true);
    try {
      const updated = await worktreeApi.updateDescription(worktree.id, descriptionText);
      onWorktreeUpdate(updated);
      setIsEditingDescription(false);
    } catch (err) {
      console.error('Failed to save description:', err);
    } finally {
      setIsSaving(false);
    }
  }, [worktree, descriptionText, onWorktreeUpdate]);

  const handleCancelDescription = useCallback(() => {
    setDescriptionText(worktree?.description || '');
    setIsEditingDescription(false);
  }, [worktree]);

  if (!worktree) {
    return (
      <div className="text-gray-500 text-center py-8">
        Loading worktree info...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
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

      {/* Description - Editable */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-500">Description</h2>
          {!isEditingDescription && (
            <button
              type="button"
              onClick={() => setIsEditingDescription(true)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Edit
            </button>
          )}
        </div>
        {isEditingDescription ? (
          <div className="space-y-3">
            <textarea
              value={descriptionText}
              onChange={(e) => setDescriptionText(e.target.value)}
              placeholder="Add notes about this branch..."
              className="w-full min-h-[150px] p-3 border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveDescription}
                disabled={isSaving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCancelDescription}
                disabled={isSaving}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-[50px]">
            {worktree.description ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{worktree.description}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No description added yet</p>
            )}
          </div>
        )}
      </div>

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
    </div>
  );
});

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
  onFileSelect: (path: string) => void;
  onWorktreeUpdate: (updated: Worktree) => void;
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
  onFileSelect,
  onWorktreeUpdate,
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
    case 'files':
      return (
        <ErrorBoundary componentName="FileTreeView">
          <FileTreeView
            worktreeId={worktreeId}
            onFileSelect={onFileSelect}
            className="h-full"
          />
        </ErrorBoundary>
      );
    case 'memo':
      return (
        <ErrorBoundary componentName="MemoPane">
          <MemoPane
            worktreeId={worktreeId}
            className="h-full"
          />
        </ErrorBoundary>
      );
    case 'info':
      return (
        <MobileInfoContent
          worktree={worktree}
          onWorktreeUpdate={onWorktreeUpdate}
        />
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
  const { toggle, openMobileDrawer } = useSidebarContext();
  const { state, actions } = useWorktreeUIState();

  // Local state for worktree data and loading status
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null);
  const [autoYesEnabled, setAutoYesEnabled] = useState(false);
  const [autoYesExpiresAt, setAutoYesExpiresAt] = useState<number | null>(null);

  // Track if initial load has completed to prevent re-triggering
  const initialLoadCompletedRef = useRef(false);

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

      // Update auto-yes state from server
      if (data.autoYes) {
        setAutoYesEnabled(data.autoYes.enabled);
        setAutoYesExpiresAt(data.autoYes.expiresAt);
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error fetching current output:', err);
    }
  }, [worktreeId, actions, state.prompt.visible]);

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /** Handle file path click in history pane - opens file viewer */
  const handleFilePathClick = useCallback((path: string) => {
    setFileViewerPath(path);
  }, []);

  /** Handle file select from FileTreeView - opens file viewer */
  const handleFileSelect = useCallback((path: string) => {
    setFileViewerPath(path);
  }, []);

  /** Handle FileViewer close */
  const handleFileViewerClose = useCallback(() => {
    setFileViewerPath(null);
  }, []);

  /** Handle left pane tab change */
  const handleLeftPaneTabChange = useCallback(
    (tab: LeftPaneTab) => {
      actions.setLeftPaneTab(tab);
    },
    [actions]
  );

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
        // Immediately fetch current output to update terminal without waiting for polling
        await fetchCurrentOutput();
      } catch (err) {
        console.error('[WorktreeDetailRefactored] Error sending prompt response:', err);
      } finally {
        actions.setPromptAnswering(false);
      }
    },
    [worktreeId, actions, fetchCurrentOutput]
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

  /** Handle auto-yes toggle */
  const handleAutoYesToggle = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/auto-yes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (response.ok) {
        const data = await response.json();
        setAutoYesEnabled(data.enabled);
        setAutoYesExpiresAt(data.expiresAt);
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error toggling auto-yes:', err);
    }
  }, [worktreeId]);

  // Auto-yes hook
  const { lastAutoResponse } = useAutoYes({
    worktreeId,
    cliTool: 'claude',
    isPromptWaiting: state.prompt.visible,
    promptData: state.prompt.data,
    autoYesEnabled,
  });

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

  /** Initial data fetch on mount - runs only once */
  useEffect(() => {
    // Skip if already loaded to prevent re-triggering on dependency changes
    if (initialLoadCompletedRef.current) {
      return;
    }

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
        initialLoadCompletedRef.current = true;
      }
    };

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);

  /** Poll for current output and worktree status at adaptive intervals */
  useEffect(() => {
    if (loading || error) return;

    const pollingInterval = state.terminal.isActive
      ? ACTIVE_POLLING_INTERVAL_MS
      : IDLE_POLLING_INTERVAL_MS;

    const pollData = async () => {
      await Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()]);
    };

    const intervalId = setInterval(pollData, pollingInterval);

    return () => clearInterval(intervalId);
  }, [loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, state.terminal.isActive]);

  /** Sync layout mode with viewport size */
  useEffect(() => {
    actions.setLayoutMode(isMobile ? 'tabs' : 'split');
  }, [isMobile, actions]);

  // ========================================================================
  // Computed Values
  // ========================================================================

  /** Derive worktree status - consistent with sidebar display */
  const worktreeStatus = useMemo<WorktreeStatus>(
    () => deriveWorktreeStatus(worktree, state.error.type !== null),
    [worktree, state.error.type]
  );

  /** Current active tab for mobile view */
  const activeTab = useMemo<MobileTab>(
    () => state.layout.mobileActivePane,
    [state.layout.mobileActivePane]
  );

  /** Current active tab for desktop left pane */
  const leftPaneTab = useMemo<LeftPaneTab>(
    () => state.layout.leftPaneTab,
    [state.layout.leftPaneTab]
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
          {/* Desktop Header with back button, status, and info */}
          <DesktopHeader
            worktreeName={worktreeName}
            repositoryName={worktree?.repositoryName ?? 'Unknown'}
            description={worktree?.description}
            status={worktreeStatus}
            onBackClick={handleBackClick}
            onInfoClick={handleInfoClick}
            onMenuClick={toggle}
          />
          <div className="flex-1 min-h-0">
            <WorktreeDesktopLayout
              leftPane={
                <div className="h-full flex flex-col">
                  <LeftPaneTabSwitcher
                    activeTab={leftPaneTab}
                    onTabChange={handleLeftPaneTabChange}
                  />
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {leftPaneTab === 'history' && (
                      <HistoryPane
                        messages={state.messages}
                        worktreeId={worktreeId}
                        onFilePathClick={handleFilePathClick}
                        className="h-full"
                      />
                    )}
                    {leftPaneTab === 'files' && (
                      <ErrorBoundary componentName="FileTreeView">
                        <FileTreeView
                          worktreeId={worktreeId}
                          onFileSelect={handleFileSelect}
                          className="h-full"
                        />
                      </ErrorBoundary>
                    )}
                    {leftPaneTab === 'memo' && (
                      <ErrorBoundary componentName="MemoPane">
                        <MemoPane
                          worktreeId={worktreeId}
                          className="h-full"
                        />
                      </ErrorBoundary>
                    )}
                  </div>
                </div>
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
              isSessionRunning={state.terminal.isActive}
            />
          </div>
          {/* Auto Yes Toggle */}
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
          />
          {/* Prompt Panel - fixed overlay at bottom */}
          {state.prompt.visible && !autoYesEnabled && (
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
            onWorktreeUpdate={setWorktree}
          />
          {/* File Viewer Modal */}
          <FileViewer
            isOpen={fileViewerPath !== null}
            onClose={handleFileViewerClose}
            worktreeId={worktreeId}
            filePath={fileViewerPath ?? ''}
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
          repositoryName={worktree?.repositoryName}
          status={worktreeStatus}
          onBackClick={handleBackClick}
          onMenuClick={openMobileDrawer}
        />

        <div className="fixed top-14 inset-x-0 z-30">
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
          />
        </div>

        <main
          className="flex-1 pt-[6.25rem] pb-32 overflow-hidden"
          style={{ paddingBottom: 'calc(8rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <MobileContent
            activeTab={activeTab}
            worktreeId={worktreeId}
            worktree={worktree}
            messages={state.messages}
            terminalOutput={state.terminal.output}
            isTerminalActive={state.terminal.isActive}
            isThinking={state.terminal.isThinking}
            onFilePathClick={handleFilePathClick}
            onFileSelect={handleFileSelect}
            onWorktreeUpdate={setWorktree}
          />
        </main>

        {/* Message Input - fixed above tab bar */}
        <div
          className="fixed left-0 right-0 border-t border-gray-200 bg-white p-2 z-30"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <MessageInput
            worktreeId={worktreeId}
            onMessageSent={handleMessageSent}
            cliToolId="claude"
            isSessionRunning={state.terminal.isActive}
          />
        </div>

        <MobileTabBar
          activeTab={activeTab}
          onTabChange={handleMobileTabChange}
          hasNewOutput={false}
          hasPrompt={state.prompt.visible}
        />

        {!autoYesEnabled && (
          <MobilePromptSheet
            promptData={state.prompt.data}
            visible={state.prompt.visible}
            answering={state.prompt.answering}
            onRespond={handlePromptRespond}
            onDismiss={handlePromptDismiss}
          />
        )}

        {/* File Viewer Modal */}
        <FileViewer
          isOpen={fileViewerPath !== null}
          onClose={handleFileViewerClose}
          worktreeId={worktreeId}
          filePath={fileViewerPath ?? ''}
        />
      </div>
    </ErrorBoundary>
  );
});

export default WorktreeDetailRefactored;
