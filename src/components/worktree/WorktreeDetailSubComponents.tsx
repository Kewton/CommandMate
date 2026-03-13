/**
 * WorktreeDetail Sub-Components
 *
 * Extracted from WorktreeDetailRefactored.tsx (Issue #479) to separate
 * presentational sub-components from the main component logic.
 *
 * Contains: Helper functions, useDescriptionEditor hook, and 7 memo components
 * (WorktreeInfoFields, DesktopHeader, InfoModal, LoadingIndicator, ErrorDisplay,
 * MobileInfoContent, MobileContent).
 */

'use client';

import React, { useEffect, useCallback, useState, memo, useRef } from 'react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { DESKTOP_STATUS_CONFIG } from '@/config/status-colors';
import { type MobileTab } from '@/components/mobile/MobileTabBar';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { SearchBar } from '@/components/worktree/SearchBar';
import { LogViewer } from '@/components/worktree/LogViewer';
import { VersionSection } from '@/components/worktree/VersionSection';
import { FeedbackSection } from '@/components/worktree/FeedbackSection';
import { Modal } from '@/components/ui/Modal';
import { worktreeApi } from '@/lib/api-client';
import { truncateString } from '@/lib/utils';
import { NotificationDot } from '@/components/common/NotificationDot';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import { GitPane } from '@/components/worktree/GitPane';
import type { Worktree, ChatMessage, GitStatus } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { UseFileSearchReturn } from '@/hooks/useFileSearch';

// ============================================================================
// Constants
// ============================================================================

/** Build-time app version from package.json via next.config.js */
const APP_VERSION_DISPLAY = process.env.NEXT_PUBLIC_APP_VERSION
  ? `v${process.env.NEXT_PUBLIC_APP_VERSION}`
  : '-';

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert worktree data to WorktreeStatus - consistent with sidebar */
export function deriveWorktreeStatus(
  worktree: Worktree | null,
  hasError: boolean,
  cliTool: CLIToolType = 'claude'
): WorktreeStatus {
  if (hasError) return 'error';
  if (!worktree) return 'idle';

  // Use the same logic as sidebar (from API response)
  const cliStatus = worktree.sessionStatusByCli?.[cliTool];
  if (cliStatus) {
    if (cliStatus.isWaitingForResponse) {
      return 'waiting';
    }
    if (cliStatus.isProcessing) {
      return 'running';
    }
    // Session running but not processing = ready (waiting for user to type new message)
    if (cliStatus.isRunning) {
      return 'ready';
    }
  }

  // Fall back to legacy status fields (only for claude)
  if (cliTool === 'claude') {
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
  }

  return 'idle';
}

/** Parse message timestamps from API response */
export function parseMessageTimestamps(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

// ============================================================================
// Custom Hooks (extracted for DRY)
// ============================================================================

/**
 * useDescriptionEditor - Shared hook for worktree description editing state.
 *
 * Extracted from InfoModal and MobileInfoContent to eliminate duplicated
 * description editing logic (state management, save/cancel handlers, API call).
 *
 * @param worktree - Current worktree data (may be null during loading)
 * @param onWorktreeUpdate - Callback to update parent worktree state after save
 * @param syncTrigger - When this value changes (and reset conditions are met),
 *   the description text is re-synced from the worktree. InfoModal passes
 *   a boolean derived from isOpen; MobileInfoContent passes worktree?.id.
 * @param shouldReset - Predicate controlling when description text should be
 *   re-synced (e.g., modal just opened, worktree ID changed).
 */
export function useDescriptionEditor(
  worktree: Worktree | null,
  onWorktreeUpdate: (updated: Worktree) => void,
  syncTrigger: unknown,
  shouldReset: () => boolean,
) {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (shouldReset() && worktree) {
      setText(worktree.description || '');
      setIsEditing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTrigger, worktree]);

  const handleSave = useCallback(async () => {
    if (!worktree) return;
    setIsSaving(true);
    try {
      const updated = await worktreeApi.updateDescription(worktree.id, text);
      onWorktreeUpdate(updated);
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to save description:', err);
    } finally {
      setIsSaving(false);
    }
  }, [worktree, text, onWorktreeUpdate]);

  const handleCancel = useCallback(() => {
    setText(worktree?.description || '');
    setIsEditing(false);
  }, [worktree]);

  const startEditing = useCallback(() => {
    setIsEditing(true);
  }, []);

  return { isEditing, text, setText, isSaving, handleSave, handleCancel, startEditing };
}

// ============================================================================
// Shared Presentational Components (extracted for DRY)
// ============================================================================

/** Props for WorktreeInfoFields component */
interface WorktreeInfoFieldsProps {
  worktreeId: string;
  worktree: Worktree;
  /** CSS class for each info card container (varies between desktop/mobile) */
  cardClassName: string;
  /** Description editor state from useDescriptionEditor hook */
  descriptionEditor: ReturnType<typeof useDescriptionEditor>;
  /** Whether to show the logs section */
  showLogs: boolean;
  /** Toggle logs visibility */
  onToggleLogs: () => void;
}

/**
 * WorktreeInfoFields - Shared info fields rendered in both InfoModal and MobileInfoContent.
 *
 * Extracted to eliminate duplicated field rendering (Worktree name, Repository, Path,
 * Status, Description, Link, LastUpdated, Version, Feedback, Logs). The only difference
 * between desktop and mobile was the card container className, now passed as a prop.
 */
export const WorktreeInfoFields = memo(function WorktreeInfoFields({
  worktreeId,
  worktree,
  cardClassName,
  descriptionEditor,
  showLogs,
  onToggleLogs,
}: WorktreeInfoFieldsProps) {
  const { isEditing, text, setText, isSaving, handleSave, handleCancel, startEditing } = descriptionEditor;

  return (
    <>
      {/* Worktree Name */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Worktree</h2>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{worktree.name}</p>
      </div>

      {/* Repository Info */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Repository</h2>
        <p className="text-base text-gray-900 dark:text-gray-100">{worktree.repositoryName}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-all">{worktree.repositoryPath}</p>
      </div>

      {/* Path */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Path</h2>
        <p className="text-sm text-gray-700 dark:text-gray-300 break-all font-mono">{worktree.path}</p>
      </div>

      {/* Status */}
      {worktree.status && (
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Status</h2>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            worktree.status === 'done' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300' :
            worktree.status === 'doing' ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300' :
            'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
          }`}>
            {worktree.status.toUpperCase()}
          </span>
        </div>
      )}

      {/* Description - Editable */}
      <div className={cardClassName}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">Description</h2>
          {!isEditing && (
            <button
              type="button"
              onClick={startEditing}
              className="text-sm text-cyan-600 hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-300"
            >
              Edit
            </button>
          )}
        </div>
        {isEditing ? (
          <div className="space-y-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add notes about this branch..."
              className="w-full min-h-[150px] p-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                className="px-4 py-2 bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 rounded-lg hover:bg-gray-300 disabled:opacity-50 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-[50px]">
            {worktree.description ? (
              <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{worktree.description}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No description added yet</p>
            )}
          </div>
        )}
      </div>

      {/* Link */}
      {worktree.link && (
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Link</h2>
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
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Last Updated</h2>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {new Date(worktree.updatedAt).toLocaleString()}
          </p>
        </div>
      )}

      {/* Version - Issue #257: VersionSection component (SF-001 DRY) */}
      <VersionSection version={APP_VERSION_DISPLAY} className={cardClassName} />

      {/* Feedback - Issue #264: FeedbackSection component */}
      <FeedbackSection className={cardClassName} />

      {/* Logs */}
      <div className={cardClassName}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-500">Logs</h2>
          <button
            type="button"
            onClick={onToggleLogs}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            {showLogs ? 'Hide' : 'Show'}
          </button>
        </div>
        {showLogs && <LogViewer worktreeId={worktreeId} />}
      </div>
    </>
  );
});

// ============================================================================
// Sub-components
// ============================================================================

/** Props for DesktopHeader component */
interface DesktopHeaderProps {
  worktreeName: string;
  repositoryName: string;
  description?: string;
  status: WorktreeStatus;
  gitStatus?: GitStatus;
  onBackClick: () => void;
  onInfoClick: () => void;
  onMenuClick: () => void;
  /** Whether an app update is available (shows notification dot on Info button) - Issue #278 */
  hasUpdate?: boolean;
}

/** Status indicator configuration is imported from @/config/status-colors (SF1) */

/** Desktop header with hamburger menu, back button, worktree name, repository, status, and info button */
export const DesktopHeader = memo(function DesktopHeader({
  worktreeName,
  repositoryName,
  description: worktreeDescription,
  status,
  gitStatus,
  onBackClick,
  onInfoClick,
  onMenuClick,
  hasUpdate,
}: DesktopHeaderProps) {
  const statusConfig = DESKTOP_STATUS_CONFIG[status];
  // Issue #111: DRY - Use shared truncateString utility
  const DESKTOP_BRANCH_MAX_LENGTH = 30;
  const DESCRIPTION_MAX_LENGTH = 50;

  // Truncate description using shared utility
  const truncatedDescription = worktreeDescription
    ? truncateString(worktreeDescription, DESCRIPTION_MAX_LENGTH)
    : null;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      {/* Left: Menu, Back button and title */}
      <div className="flex items-center gap-3">
        {/* Hamburger menu button */}
        <button
          type="button"
          onClick={onMenuClick}
          className="p-2 -ml-2 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
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
        <div className="w-px h-6 bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
        <button
          type="button"
          onClick={onBackClick}
          className="flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
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
              d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"
            />
          </svg>
          <span className="text-sm font-medium">Home</span>
        </button>
        <div className="w-px h-6 bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
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
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[200px] leading-tight">
            {worktreeName}
          </h1>
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="truncate max-w-[200px]">
              {repositoryName}
            </span>
            {gitStatus && gitStatus.currentBranch !== '(unknown)' && (
              <>
                <span className="text-gray-300 dark:text-gray-600">/</span>
                <span
                  className="truncate max-w-[150px] font-mono"
                  title={gitStatus.currentBranch}
                  data-testid="desktop-branch-name"
                >
                  {truncateString(gitStatus.currentBranch, DESKTOP_BRANCH_MAX_LENGTH)}
                </span>
                {gitStatus.isDirty && (
                  <span className="text-amber-500" title="Uncommitted changes">*</span>
                )}
              </>
            )}
            {truncatedDescription && (
              <>
                <span className="text-gray-300 dark:text-gray-600">—</span>
                <span
                  className="truncate max-w-[300px] text-gray-400 dark:text-gray-500"
                  title={worktreeDescription}
                >
                  {truncatedDescription}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right: Info button */}
      <button
        type="button"
        onClick={onInfoClick}
        className="relative flex items-center gap-1.5 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
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
        {hasUpdate && (
          <NotificationDot
            data-testid="info-update-indicator"
            className="absolute top-0 right-0"
            aria-label="Update available"
          />
        )}
      </button>
    </div>
  );
});

/** Props for InfoModal component */
interface InfoModalProps {
  worktreeId: string;
  worktree: Worktree | null;
  isOpen: boolean;
  onClose: () => void;
  onWorktreeUpdate: (updated: Worktree) => void;
}

/**
 * Modal displaying worktree information with description editing.
 * Uses useDescriptionEditor hook and WorktreeInfoFields for DRY compliance.
 */
export const InfoModal = memo(function InfoModal({
  worktreeId,
  worktree,
  isOpen,
  onClose,
  onWorktreeUpdate,
}: InfoModalProps) {
  const [showLogs, setShowLogs] = useState(false);

  // Track previous isOpen state to detect modal opening
  const prevIsOpenRef = useRef(isOpen);

  const descriptionEditor = useDescriptionEditor(
    worktree,
    onWorktreeUpdate,
    isOpen,
    () => {
      const wasOpened = isOpen && !prevIsOpenRef.current;
      prevIsOpenRef.current = isOpen;
      return wasOpened;
    },
  );

  if (!worktree) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Worktree Information" size="md">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        <WorktreeInfoFields
          worktreeId={worktreeId}
          worktree={worktree}
          cardClassName="bg-gray-50 dark:bg-gray-800 rounded-lg p-4"
          descriptionEditor={descriptionEditor}
          showLogs={showLogs}
          onToggleLogs={() => setShowLogs(!showLogs)}
        />
      </div>
    </Modal>
  );
});

/** Loading indicator with spinner and text */
export const LoadingIndicator = memo(function LoadingIndicator() {
  return (
    <div
      className="flex items-center justify-center h-full min-h-[200px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="animate-spin rounded-full h-8 w-8 border-4 border-gray-300 dark:border-gray-600 border-t-cyan-600 dark:border-t-cyan-400"
          aria-hidden="true"
        />
        <p className="text-gray-600 dark:text-gray-400">Loading worktree...</p>
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
export const ErrorDisplay = memo(function ErrorDisplay({
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
  worktreeId: string;
  worktree: Worktree | null;
  onWorktreeUpdate: (updated: Worktree) => void;
}

/**
 * Mobile Info tab content with description editing.
 * Uses useDescriptionEditor hook and WorktreeInfoFields for DRY compliance.
 */
export const MobileInfoContent = memo(function MobileInfoContent({
  worktreeId,
  worktree,
  onWorktreeUpdate,
}: MobileInfoContentProps) {
  const [showLogs, setShowLogs] = useState(false);

  // Track previous worktree ID to detect worktree changes
  const prevWorktreeIdRef = useRef(worktree?.id);
  // Track editing state via ref to avoid circular dependency with useDescriptionEditor
  const isEditingRef = useRef(false);

  const descriptionEditor = useDescriptionEditor(
    worktree,
    onWorktreeUpdate,
    worktree?.id,
    () => {
      const worktreeChanged = worktree?.id !== prevWorktreeIdRef.current;
      prevWorktreeIdRef.current = worktree?.id;
      return worktreeChanged && !isEditingRef.current;
    },
  );

  // Keep ref in sync with hook state
  isEditingRef.current = descriptionEditor.isEditing;

  if (!worktree) {
    return (
      <div className="text-gray-500 text-center py-8">
        Loading worktree info...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <WorktreeInfoFields
        worktreeId={worktreeId}
        worktree={worktree}
        cardClassName="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
        descriptionEditor={descriptionEditor}
        showLogs={showLogs}
        onToggleLogs={() => setShowLogs(!showLogs)}
      />
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
  onNewFile: (parentPath: string) => void;
  onNewDirectory: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onUpload: (targetDir: string) => void;
  /** [Issue #162] Move callback */
  onMove?: (path: string, type: 'file' | 'directory') => void;
  refreshTrigger: number;
  /** [Issue #21] File search hook return object */
  fileSearch: UseFileSearchReturn;
  /** [Issue #211] Toast notification callback for copy feedback */
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** [Issue #294] CMATE setup callback */
  onCmateSetup?: () => void;
  /** [Issue #368] Selected agents for Agent tab */
  selectedAgents: CLIToolType[];
  /** [Issue #368] Callback when selected agents change */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** [Issue #368] Current vibe-local model selection */
  vibeLocalModel: string | null;
  /** [Issue #368] Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** [Issue #374] Current vibe-local context window (null = default) */
  vibeLocalContextWindow: number | null;
  /** [Issue #374] Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange: (value: number | null) => void;
  /** [Issue #379] Auto-scroll state for terminal */
  autoScroll?: boolean;
  /** [Issue #379] Callback when auto-scroll state changes */
  onScrollChange?: (enabled: boolean) => void;
  /** [Issue #379] Disable auto-follow for TUI tools (OpenCode) */
  disableAutoFollow?: boolean;
  /** [Issue #447] History sub-tab state */
  historySubTab: 'message' | 'git';
  /** [Issue #447] History sub-tab change handler */
  onHistorySubTabChange: (tab: 'message' | 'git') => void;
  /** [Issue #447] Diff select handler for GitPane */
  onDiffSelect: (diff: string, filePath: string) => void;
}

/** Renders content based on active mobile tab */
export const MobileContent = memo(function MobileContent({
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
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  refreshTrigger,
  fileSearch,
  showToast,
  onCmateSetup,
  selectedAgents,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  autoScroll,
  onScrollChange,
  disableAutoFollow,
  historySubTab,
  onHistorySubTabChange,
  onDiffSelect,
}: MobileContentProps) {
  switch (activeTab) {
    case 'terminal':
      return (
        <ErrorBoundary componentName="TerminalDisplay">
          <TerminalDisplay
            output={terminalOutput}
            isActive={isTerminalActive}
            isThinking={isThinking}
            autoScroll={autoScroll}
            onScrollChange={onScrollChange}
            disableAutoFollow={disableAutoFollow}
            className="h-full"
          />
        </ErrorBoundary>
      );
    case 'history':
      return (
        <div className="h-full flex flex-col">
          {/* History sub-tab switcher: Message | Git (Issue #447) */}
          <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0">
            <button
              type="button"
              onClick={() => onHistorySubTabChange('message')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                historySubTab === 'message'
                  ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Message
            </button>
            <button
              type="button"
              onClick={() => onHistorySubTabChange('git')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                historySubTab === 'git'
                  ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Git
            </button>
          </div>
          {historySubTab === 'message' ? (
            <ErrorBoundary componentName="HistoryPane">
              <HistoryPane
                messages={messages}
                worktreeId={worktreeId}
                onFilePathClick={onFilePathClick}
                className="flex-1 min-h-0"
                showToast={showToast}
              />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary componentName="GitPane">
              <GitPane
                worktreeId={worktreeId}
                onDiffSelect={onDiffSelect}
                isMobile={true}
                className="flex-1 min-h-0"
              />
            </ErrorBoundary>
          )}
        </div>
      );
    case 'files':
      return (
        <ErrorBoundary componentName="FileTreeView">
          <div className="h-full flex flex-col">
            {/* [Issue #21] Search Bar - Mobile */}
            <SearchBar
              query={fileSearch.query}
              mode={fileSearch.mode}
              isSearching={fileSearch.isSearching}
              error={fileSearch.error}
              onQueryChange={fileSearch.setQuery}
              onModeChange={fileSearch.setMode}
              onClear={fileSearch.clearSearch}
            />
            <FileTreeView
              worktreeId={worktreeId}
              onFileSelect={onFileSelect}
              onNewFile={onNewFile}
              onNewDirectory={onNewDirectory}
              onRename={onRename}
              onDelete={onDelete}
              onUpload={onUpload}
              onMove={onMove}
              onCmateSetup={onCmateSetup}
              refreshTrigger={refreshTrigger}
              searchQuery={fileSearch.query}
              searchMode={fileSearch.mode}
              searchResults={fileSearch.results?.results}
              className="flex-1 min-h-0"
            />
          </div>
        </ErrorBoundary>
      );
    case 'memo':
      return (
        <ErrorBoundary componentName="NotesAndLogsPane">
          <NotesAndLogsPane
            worktreeId={worktreeId}
            className="h-full"
            selectedAgents={selectedAgents}
            onSelectedAgentsChange={onSelectedAgentsChange}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={onVibeLocalModelChange}
            vibeLocalContextWindow={vibeLocalContextWindow}
            onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
          />
        </ErrorBoundary>
      );
    case 'info':
      return (
        <MobileInfoContent
          worktreeId={worktreeId}
          worktree={worktree}
          onWorktreeUpdate={onWorktreeUpdate}
        />
      );
    default:
      return null;
  }
});

