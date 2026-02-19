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
import { DESKTOP_STATUS_CONFIG, SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { MobileTabBar, type MobileTab } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { SearchBar } from '@/components/worktree/SearchBar';
import { useFileSearch } from '@/hooks/useFileSearch';
import { LeftPaneTabSwitcher, type LeftPaneTab } from '@/components/worktree/LeftPaneTabSwitcher';
import { FileViewer } from '@/components/worktree/FileViewer';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { EDITABLE_EXTENSIONS } from '@/config/editable-extensions';
import { UPLOADABLE_EXTENSIONS, getMaxFileSize, isUploadableExtension } from '@/config/uploadable-extensions';
import { ToastContainer, useToast } from '@/components/common/Toast';
import { MemoPane } from '@/components/worktree/MemoPane';
import { LogViewer } from '@/components/worktree/LogViewer';
import { VersionSection } from '@/components/worktree/VersionSection';
import { FeedbackSection } from '@/components/worktree/FeedbackSection';
import { Modal } from '@/components/ui/Modal';
import { worktreeApi } from '@/lib/api-client';
import { truncateString } from '@/lib/utils';
import { useAutoYes } from '@/hooks/useAutoYes';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import type { AutoYesStopReason } from '@/config/auto-yes-config';
import { NotificationDot } from '@/components/common/NotificationDot';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import type { Worktree, ChatMessage, PromptData, GitStatus } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { deriveCliStatus } from '@/types/sidebar';
import { useTranslations } from 'next-intl';
import { useFileOperations } from '@/hooks/useFileOperations';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { encodePathForUrl } from '@/lib/url-path-encoder';

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
    stopReason?: AutoYesStopReason;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Polling interval when terminal is active (ms) */
const ACTIVE_POLLING_INTERVAL_MS = 2000;

/** Polling interval when terminal is idle (ms) */
const IDLE_POLLING_INTERVAL_MS = 5000;

/**
 * Throttle interval for visibilitychange recovery (ms).
 * Prevents excessive API calls when the page rapidly transitions between
 * visible and hidden states.
 * Same value as IDLE_POLLING_INTERVAL_MS but semantically independent:
 * - IDLE_POLLING_INTERVAL_MS: steady-state polling frequency
 * - RECOVERY_THROTTLE_MS: visibilitychange burst prevention threshold
 * (Issue #246, SF-001)
 */
const RECOVERY_THROTTLE_MS = 5000;

/** Default worktree name when not loaded */
const DEFAULT_WORKTREE_NAME = 'Unknown';

/** Build-time app version from package.json via next.config.js */
const APP_VERSION_DISPLAY = process.env.NEXT_PUBLIC_APP_VERSION
  ? `v${process.env.NEXT_PUBLIC_APP_VERSION}`
  : '-';

// ============================================================================
// Helper Functions
// ============================================================================

/** Capitalize first character of a string (e.g., 'claude' -> 'Claude') */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Convert worktree data to WorktreeStatus - consistent with sidebar */
function deriveWorktreeStatus(
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
function parseMessageTimestamps(messages: ChatMessage[]): ChatMessage[] {
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
function useDescriptionEditor(
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
const WorktreeInfoFields = memo(function WorktreeInfoFields({
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
        <h2 className="text-sm font-medium text-gray-500 mb-1">Worktree</h2>
        <p className="text-lg font-semibold text-gray-900">{worktree.name}</p>
      </div>

      {/* Repository Info */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-gray-500 mb-1">Repository</h2>
        <p className="text-base text-gray-900">{worktree.repositoryName}</p>
        <p className="text-xs text-gray-500 mt-1 break-all">{worktree.repositoryPath}</p>
      </div>

      {/* Path */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-gray-500 mb-1">Path</h2>
        <p className="text-sm text-gray-700 break-all font-mono">{worktree.path}</p>
      </div>

      {/* Status */}
      {worktree.status && (
        <div className={cardClassName}>
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
      <div className={cardClassName}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-gray-500">Description</h2>
          {!isEditing && (
            <button
              type="button"
              onClick={startEditing}
              className="text-sm text-blue-600 hover:text-blue-800"
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
              className="w-full min-h-[150px] p-3 border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
        <div className={cardClassName}>
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
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-gray-500 mb-1">Last Updated</h2>
          <p className="text-sm text-gray-700">
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
const DesktopHeader = memo(function DesktopHeader({
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
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="truncate max-w-[200px]">
              {repositoryName}
            </span>
            {gitStatus && gitStatus.currentBranch !== '(unknown)' && (
              <>
                <span className="text-gray-300">/</span>
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
          </div>
        </div>
      </div>

      {/* Right: Info button */}
      <button
        type="button"
        onClick={onInfoClick}
        className="relative flex items-center gap-1.5 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
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
const InfoModal = memo(function InfoModal({
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
          cardClassName="bg-gray-50 rounded-lg p-4"
          descriptionEditor={descriptionEditor}
          showLogs={showLogs}
          onToggleLogs={() => setShowLogs(!showLogs)}
        />
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
  worktreeId: string;
  worktree: Worktree | null;
  onWorktreeUpdate: (updated: Worktree) => void;
}

/**
 * Mobile Info tab content with description editing.
 * Uses useDescriptionEditor hook and WorktreeInfoFields for DRY compliance.
 */
const MobileInfoContent = memo(function MobileInfoContent({
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
        cardClassName="bg-white rounded-lg border border-gray-200 p-4"
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
}

/** [Issue #21] Type for file search hook return */
import type { UseFileSearchReturn } from '@/hooks/useFileSearch';

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
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  refreshTrigger,
  fileSearch,
  showToast,
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
            showToast={showToast}
          />
        </ErrorBoundary>
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
          worktreeId={worktreeId}
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
  const tWorktree = useTranslations('worktree');
  const tError = useTranslations('error');
  const tCommon = useTranslations('common');
  const tAutoYes = useTranslations('autoYes');

  // Local state for worktree data and loading status
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  // Issue #104: Track editor maximized state to disable Modal close handlers
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [autoYesEnabled, setAutoYesEnabled] = useState(false);
  const [autoYesExpiresAt, setAutoYesExpiresAt] = useState<number | null>(null);
  // Issue #314: Track previous auto-yes enabled state for stop reason toast
  const prevAutoYesEnabledRef = useRef<boolean>(false);
  // Issue #314: Pending stop reason toast (deferred until showToast is available)
  const [stopReasonPending, setStopReasonPending] = useState(false);
  // Issue #4: CLI tool tab state (Claude/Codex)
  const [activeCliTab, setActiveCliTab] = useState<CLIToolType>('claude');
  // Issue #4: Ref to avoid polling callback recreation on tab switch
  const activeCliTabRef = useRef<CLIToolType>(activeCliTab);
  activeCliTabRef.current = activeCliTab;
  // Trigger to refresh FileTreeView after file operations
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);

  // [Issue #21] File search state
  const fileSearch = useFileSearch({ worktreeId });

  // Track if initial load has completed to prevent re-triggering
  const initialLoadCompletedRef = useRef(false);

  // Issue #131: Track previous worktreeId to detect worktree changes
  const prevWorktreeIdRef = useRef<string | undefined>(worktreeId);

  // Issue #131: Reset state when worktreeId changes (worktree switching)
  // This prevents stale messages from previous worktree causing scroll issues
  useEffect(() => {
    if (prevWorktreeIdRef.current !== worktreeId) {
      // Clear messages immediately to prevent scroll animation on stale data
      actions.clearMessages();
      // Reset initial load flag to trigger fresh data fetch
      initialLoadCompletedRef.current = false;
      // Clear terminal output
      actions.setTerminalOutput('', '');
      // Update ref for next comparison
      prevWorktreeIdRef.current = worktreeId;
    }
  }, [worktreeId, actions]);

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
  // Issue #4: Use ref for activeCliTab to avoid callback recreation on tab switch
  const fetchMessages = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/messages?cliTool=${activeCliTabRef.current}`);
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
  // Issue #4: Use ref for activeCliTab to avoid callback recreation on tab switch
  const fetchCurrentOutput = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/current-output?cliTool=${activeCliTabRef.current}`);
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

      // Update auto-yes state from server (Issue #314: stopReason tracking)
      if (data.autoYes) {
        const wasEnabled = prevAutoYesEnabledRef.current;
        setAutoYesEnabled(data.autoYes.enabled);
        setAutoYesExpiresAt(data.autoYes.expiresAt);
        prevAutoYesEnabledRef.current = data.autoYes.enabled;

        // Issue #314: Detect stop condition match (enabled -> disabled transition)
        if (wasEnabled && !data.autoYes.enabled && data.autoYes.stopReason === 'stop_pattern_matched') {
          setStopReasonPending(true);
        }
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error fetching current output:', err);
    }
  }, [worktreeId, actions, state.prompt.visible]);

  // Issue #4: Immediately refresh data when CLI tab changes (without polling restart)
  const prevCliTabRef = useRef<CLIToolType>(activeCliTab);
  useEffect(() => {
    if (prevCliTabRef.current !== activeCliTab) {
      prevCliTabRef.current = activeCliTab;
      // Clear stale data immediately for snappy UI
      actions.clearMessages();
      actions.setTerminalOutput('', '');
      // Fetch fresh data for the new tab
      void fetchMessages();
      void fetchCurrentOutput();
    }
  }, [activeCliTab, actions, fetchMessages, fetchCurrentOutput]);

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /** Handle file path click in history pane - opens file viewer */
  const handleFilePathClick = useCallback((path: string) => {
    setFileViewerPath(path);
  }, []);

  /**
   * Handle file select from FileTreeView
   * Opens MarkdownEditor for .md files, FileViewer for others
   * [Stage 3 SF-004] Separate editorFilePath state to avoid FileViewer conflict
   */
  const handleFileSelect = useCallback((path: string) => {
    const extension = path.split('.').pop()?.toLowerCase();
    const extWithDot = extension ? `.${extension}` : '';

    if (EDITABLE_EXTENSIONS.includes(extWithDot)) {
      // Open in MarkdownEditor
      setEditorFilePath(path);
    } else {
      // Open in FileViewer
      setFileViewerPath(path);
    }
  }, []);

  /** Handle FileViewer close */
  const handleFileViewerClose = useCallback(() => {
    setFileViewerPath(null);
  }, []);

  /** Handle MarkdownEditor close */
  const handleEditorClose = useCallback(() => {
    setEditorFilePath(null);
  }, []);

  /** Handle file save in editor - refresh tree to reflect changes */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- savedPath accepted for callback interface compatibility
  const handleEditorSave = useCallback((_savedPath: string) => {
    setFileTreeRefresh(prev => prev + 1);
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
        // Issue #287: Use shared builder to include promptType and defaultOptionNumber
        // so the API can use cursor-key navigation even when promptCheck re-verification fails.
        const requestBody = buildPromptResponseBody(answer, activeCliTab, state.prompt.data);

        const response = await fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
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
    [worktreeId, actions, fetchCurrentOutput, activeCliTab, state.prompt.data]
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

  /** Handle auto-yes toggle (Issue #225: duration, Issue #314: stopPattern) */
  const handleAutoYesToggle = useCallback(async (params: AutoYesToggleParams): Promise<void> => {
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/auto-yes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: params.enabled,
          cliToolId: activeCliTab,
          duration: params.duration,
          stopPattern: params.stopPattern,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setAutoYesEnabled(data.enabled);
        setAutoYesExpiresAt(data.expiresAt);
        prevAutoYesEnabledRef.current = data.enabled;
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error toggling auto-yes:', err);
    }
  }, [worktreeId, activeCliTab]);

  /** Issue #4: Kill session confirmation dialog state */
  const [showKillConfirm, setShowKillConfirm] = useState(false);

  /** Issue #4: Show confirmation dialog before killing session */
  const handleKillSession = useCallback((): void => {
    setShowKillConfirm(true);
  }, []);

  /** Issue #4: Execute session kill after confirmation */
  const handleKillConfirm = useCallback(async (): Promise<void> => {
    setShowKillConfirm(false);
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/kill-session?cliTool=${activeCliTab}`,
        { method: 'POST' }
      );
      if (!response.ok) return;
      actions.clearMessages();
      actions.setTerminalOutput('', '');
      actions.setTerminalActive(false);
      actions.setTerminalThinking(false);
      actions.clearPrompt();
      await fetchWorktree();
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Error killing session:', err);
    }
  }, [worktreeId, activeCliTab, actions, fetchWorktree]);

  /** Issue #4: Cancel session kill */
  const handleKillCancel = useCallback((): void => {
    setShowKillConfirm(false);
  }, []);

  // ========================================================================
  // File Operation Handlers (for FileTreeView context menu)
  // ========================================================================

  /** Handle new file creation in FileTreeView */
  const handleNewFile = useCallback(async (parentPath: string) => {
    const fileName = window.prompt('Enter file name (e.g., document.md):');
    if (!fileName) return;

    // Add .md extension if not present
    const finalName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
    const newPath = parentPath ? `${parentPath}/${finalName}` : finalName;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(newPath)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'file', content: '' }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to create file');
      }
      // File created successfully - trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to create file:', err);
      window.alert(tError('fileOps.failedToCreateFile'));
    }
  }, [worktreeId, tError]);

  /** Handle new directory creation in FileTreeView */
  const handleNewDirectory = useCallback(async (parentPath: string) => {
    const dirName = window.prompt('Enter directory name:');
    if (!dirName) return;

    const newPath = parentPath ? `${parentPath}/${dirName}` : dirName;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(newPath)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'directory' }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to create directory');
      }
      // Directory created successfully - trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to create directory:', err);
      window.alert(tError('fileOps.failedToCreateDirectory'));
    }
  }, [worktreeId, tError]);

  /** Handle file/directory rename in FileTreeView */
  const handleRename = useCallback(async (path: string) => {
    const currentName = path.split('/').pop() || '';
    const newName = window.prompt('Enter new name:', currentName);
    if (!newName || newName === currentName) return;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', newName }),
        }
      );
      if (!response.ok) {
        throw new Error('Failed to rename');
      }
      // Renamed successfully - trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to rename:', err);
      window.alert(tError('fileOps.failedToRename'));
    }
  }, [worktreeId, tError]);

  /** Handle file/directory delete in FileTreeView */
  const handleDelete = useCallback(async (path: string) => {
    const name = path.split('/').pop() || path;
    if (!window.confirm(tCommon('confirmDelete', { name }))) return;

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}?recursive=true`,
        {
          method: 'DELETE',
        }
      );
      if (!response.ok) {
        throw new Error('Failed to delete');
      }
      // Deleted successfully - close editor if the deleted file was open
      if (editorFilePath === path || editorFilePath?.startsWith(`${path}/`)) {
        setEditorFilePath(null);
      }
      // Trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to delete:', err);
      window.alert(tError('fileOps.failedToDelete'));
    }
  }, [worktreeId, editorFilePath, tCommon, tError]);

  // Toast state for upload notifications
  const { toasts, showToast, removeToast } = useToast();

  // Issue #314: Show stop reason toast when pending (deferred from fetchCurrentOutput)
  useEffect(() => {
    if (stopReasonPending) {
      showToast(tAutoYes('stopPatternMatched'), 'info');
      setStopReasonPending(false);
    }
  }, [stopReasonPending, showToast, tAutoYes]);

  // [Issue #162] File operations hook (move dialog state management)
  const {
    moveTarget,
    isMoveDialogOpen,
    handleMove,
    handleMoveConfirm,
    handleMoveCancel,
  } = useFileOperations(
    worktreeId,
    () => setFileTreeRefresh(prev => prev + 1),
    (msg) => showToast(msg, 'success'),
    (msg) => showToast(msg, 'error')
  );

  // Hidden file input ref for upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef<string>('');

  /** Handle file upload from FileTreeView context menu [IMPACT-004] */
  const handleUpload = useCallback((targetDir: string) => {
    uploadTargetPathRef.current = targetDir;
    fileInputRef.current?.click();
  }, []);

  /** Handle file input change - perform actual upload */
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input for re-selection of same file
    e.target.value = '';

    const targetDir = uploadTargetPathRef.current;
    const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;

    // Client-side validation
    if (!isUploadableExtension(ext)) {
      showToast(`Unsupported file type: ${ext}. Allowed: ${UPLOADABLE_EXTENSIONS.join(', ')}`, 'error');
      return;
    }

    const maxSize = getMaxFileSize(ext);
    if (file.size > maxSize) {
      showToast(`File too large. Maximum size: ${(maxSize / 1024 / 1024).toFixed(1)}MB`, 'error');
      return;
    }

    // Build form data
    const formData = new FormData();
    formData.append('file', file);

    // Upload API call [API-004] Using /upload/:path endpoint
    try {
      const uploadPath = targetDir || '.';
      const response = await fetch(
        `/api/worktrees/${worktreeId}/upload/${encodePathForUrl(uploadPath)}`,
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData?.error?.message || 'Failed to upload file';
        showToast(errorMessage, 'error');
        return;
      }

      const result = await response.json();
      showToast(`Uploaded: ${result.filename}`, 'success');

      // Refresh file tree [IMPACT-004]
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to upload:', err);
      showToast('Upload failed. Please try again.', 'error');
    }
  }, [worktreeId, showToast]);

  // Update check hook (Issue #278: hasUpdate state for DesktopHeader/MobileTabBar)
  const { data: updateCheckData } = useUpdateCheck();
  const hasUpdate = updateCheckData?.hasUpdate ?? false;

  // Auto-yes hook
  const { lastAutoResponse } = useAutoYes({
    worktreeId,
    cliTool: activeCliTab,
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
  // Visibility Change Recovery (Issue #246, Issue #266)
  // ========================================================================

  /**
   * Timestamp of the last visibilitychange recovery to prevent rapid re-fetches.
   * Used as a throttle guard: if less than RECOVERY_THROTTLE_MS has elapsed
   * since the last recovery, the handler skips execution.
   */
  const lastRecoveryTimestampRef = useRef<number>(0);

  /**
   * Handle page visibility change for background recovery.
   * When the page becomes visible again (e.g., smartphone foreground restoration),
   * performs data re-fetch to synchronize stale state.
   *
   * Design rationale (Issue #246, Issue #266):
   *
   * [SF-001] SRP: handleVisibilityChange is responsible for "background recovery
   *   data sync" only. Full recovery (handleRetry) is a separate concern.
   *
   * [SF-002] KISS: Simple error guard - error state uses handleRetry (full recovery),
   *   normal state uses lightweight recovery (no loading state change).
   *
   * [IA-002] Overlap: When the page becomes visible, up to 3 data-fetch
   *   sources may fire concurrently:
   *   1. This visibilitychange handler (lightweight recovery)
   *   2. The setInterval polling timer (if it fires during the same tick)
   *   3. WebSocket reconnection triggering a broadcast-based fetch
   *   All fetches are idempotent GET requests, so concurrent execution is
   *   safe -- it may cause redundant network calls but no data corruption.
   */
  const handleVisibilityChange = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    const now = Date.now();
    if (now - lastRecoveryTimestampRef.current < RECOVERY_THROTTLE_MS) {
      return;
    }
    lastRecoveryTimestampRef.current = now;

    // [SF-001] Error state requires full recovery (handleRetry) to reset
    // loading state and rebuild the UI from ErrorDisplay back to normal.
    if (error) {
      handleRetry();
      return;
    }

    // [SF-002] Normal state uses lightweight recovery (loading state unchanged).
    // This preserves the component tree, preventing MessageInput/PromptPanel
    // content from being cleared by unmount/remount caused by setLoading(true/false).
    //
    // [SF-DRY-001] Note: These fetch calls duplicate the data retrieval done by
    // handleRetry(). handleRetry uses setLoading(true/false) for full recovery,
    // while this path intentionally omits loading state changes for lightweight
    // recovery. When adding/changing fetch functions, update handleRetry() as well.
    //
    // [SF-CONS-001] handleRetry uses a sequential pattern (fetchWorktree first,
    // then conditionally fetchMessages/fetchCurrentOutput). Lightweight recovery
    // uses Promise.all for parallel execution because: failure is silently ignored
    // (next polling cycle recovers), all requests are idempotent GETs (no data
    // corruption risk), and parallel execution improves response time.
    try {
      await Promise.all([
        fetchWorktree(),
        fetchMessages(),
        fetchCurrentOutput(),
      ]);
    } finally {
      // [SF-IMP-001] fetchWorktree() internally catches errors and calls
      // setError(message) without rethrowing. This means Promise.all resolves
      // successfully even when fetchWorktree fails, but error state has already
      // been set internally. Call setError(null) unconditionally to counter any
      // internal setError() calls and maintain the component tree.
      // On success, this is a no-op (error is already null).
      // On failure, this prevents ErrorDisplay from replacing the normal UI,
      // allowing the next polling cycle to recover naturally.
      setError(null);
    }
    // [SF-IMP-002] Note: error in the dependency array causes useCallback to
    // regenerate when error state changes, triggering useEffect listener
    // re-registration (removeEventListener/addEventListener). Performance impact
    // is negligible as these are synchronous lightweight operations.
  }, [error, handleRetry, fetchWorktree, fetchMessages, fetchCurrentOutput]);

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

  /**
   * Register visibilitychange event listener for background recovery (Issue #246, #266).
   * When the page becomes visible, performs lightweight recovery (normal state)
   * or full recovery via handleRetry() (error state) to re-fetch all data.
   * This handles the case where the browser suspended network requests while
   * the page was in the background (common on mobile browsers).
   *
   * Unlike WorktreeList.tsx (SF-003), this component needs:
   * - Error state branching: full recovery (handleRetry) vs lightweight recovery
   * - Throttle guard (RECOVERY_THROTTLE_MS) to prevent rapid re-fetches
   */
  useEffect(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [handleVisibilityChange]);

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
    () => deriveWorktreeStatus(worktree, state.error.type !== null, activeCliTab),
    [worktree, state.error.type, activeCliTab]
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
            gitStatus={worktree?.gitStatus}
            onBackClick={handleBackClick}
            onInfoClick={handleInfoClick}
            onMenuClick={toggle}
            hasUpdate={hasUpdate}
          />
          {/* Issue #4: CLI Tool Tab Switcher (Claude/Codex) */}
          <div className="px-4 py-2 bg-white border-b border-gray-200 flex items-center justify-between">
            <nav className="flex gap-4" aria-label="CLI Tool Selection">
              {(['claude', 'codex'] as const).map((tool) => {
                const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
                const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
                return (
                  <button
                    key={tool}
                    onClick={() => setActiveCliTab(tool)}
                    className={`pb-2 px-2 border-b-2 font-medium text-sm transition-colors flex items-center gap-1.5 ${
                      activeCliTab === tool
                        ? 'border-blue-600 text-blue-600'
                        : 'border-transparent text-gray-600 hover:text-gray-900'
                    }`}
                    aria-current={activeCliTab === tool ? 'page' : undefined}
                  >
                    {statusConfig.type === 'spinner' ? (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
                        title={statusConfig.label}
                        aria-label={`${tool} status: ${statusConfig.label}`}
                      />
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`}
                        title={statusConfig.label}
                        aria-label={`${tool} status: ${statusConfig.label}`}
                      />
                    )}
                    {capitalizeFirst(tool)}
                  </button>
                );
              })}
            </nav>
            {/* Issue #4: End Session button - shown only when active CLI tool session is running */}
            {worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning && (
              <button
                onClick={handleKillSession}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
                aria-label={`End ${activeCliTab} session`}
              >
                <span aria-hidden="true">&#x2715;</span>
                End Session
              </button>
            )}
          </div>
          {/* Issue #111: Branch mismatch warning */}
          {worktree?.gitStatus && (
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          )}
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
                        showToast={showToast}
                      />
                    )}
                    {leftPaneTab === 'files' && (
                      <ErrorBoundary componentName="FileTreeView">
                        <div className="h-full flex flex-col">
                          {/* [Issue #21] Search Bar */}
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
                            onFileSelect={handleFileSelect}
                            onNewFile={handleNewFile}
                            onNewDirectory={handleNewDirectory}
                            onRename={handleRename}
                            onDelete={handleDelete}
                            onUpload={handleUpload}
                            onMove={handleMove}
                            refreshTrigger={fileTreeRefresh}
                            searchQuery={fileSearch.query}
                            searchMode={fileSearch.mode}
                            searchResults={fileSearch.results?.results}
                            className="flex-1 min-h-0"
                          />
                        </div>
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
              cliToolId={activeCliTab}
              isSessionRunning={state.terminal.isActive}
            />
          </div>
          {/* Auto Yes Toggle */}
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
            cliToolName={activeCliTab}
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
            worktreeId={worktreeId}
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
          {/* Markdown Editor Modal - Issue #104: disableClose when editor is maximized */}
          {editorFilePath && (
            <Modal
              isOpen={true}
              onClose={handleEditorClose}
              title={editorFilePath.split('/').pop() || 'Editor'}
              size="full"
              disableClose={isEditorMaximized}
            >
              <div className="h-[80vh]">
                <MarkdownEditor
                  worktreeId={worktreeId}
                  filePath={editorFilePath}
                  onClose={handleEditorClose}
                  onSave={handleEditorSave}
                  onMaximizedChange={setIsEditorMaximized}
                />
              </div>
            </Modal>
          )}
          {/* Hidden file input for upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOADABLE_EXTENSIONS.join(',')}
            onChange={handleFileInputChange}
            className="hidden"
            aria-label="Upload file"
          />
          {/* Kill session confirmation dialog */}
          <Modal
            isOpen={showKillConfirm}
            onClose={handleKillCancel}
            title={tWorktree('session.confirmEnd', { tool: capitalizeFirst(activeCliTab) })}
            size="sm"
            showCloseButton={true}
          >
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                {tWorktree('session.endWarning')}
              </p>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleKillCancel}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700"
                >
                  {tCommon('cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleKillConfirm}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white"
                >
                  {tCommon('end')}
                </button>
              </div>
            </div>
          </Modal>
          {/* [Issue #162] Move Dialog */}
          {moveTarget && (
            <MoveDialog
              isOpen={isMoveDialogOpen}
              onClose={handleMoveCancel}
              onConfirm={handleMoveConfirm}
              worktreeId={worktreeId}
              sourcePath={moveTarget.path}
              sourceType={moveTarget.type}
            />
          )}
          {/* Toast notifications */}
          <ToastContainer toasts={toasts} onClose={removeToast} />
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
          gitStatus={worktree?.gitStatus}
          onBackClick={handleBackClick}
          onMenuClick={openMobileDrawer}
        />

        {/* Issue #111: Branch mismatch warning (Mobile) */}
        {worktree?.gitStatus && worktree.gitStatus.isBranchMismatch && (
          <div className="fixed top-14 inset-x-0 z-35">
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          </div>
        )}

        {/* Auto Yes + CLI Tool Tabs combined row (Mobile) */}
        <div className="fixed top-14 inset-x-0 z-30 flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
          {/* Left: Auto Yes toggle (inline mode) */}
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
            cliToolName={activeCliTab}
            inline
          />
          {/* Right: CLI tool tabs + End button */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <nav className="flex gap-2" aria-label="CLI Tool Selection">
              {(['claude', 'codex'] as const).map((tool) => {
                const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
                const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
                return (
                  <button
                    key={tool}
                    onClick={() => setActiveCliTab(tool)}
                    className={`px-1.5 py-0.5 rounded font-medium text-xs transition-colors flex items-center gap-1 ${
                      activeCliTab === tool
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                    aria-current={activeCliTab === tool ? 'page' : undefined}
                  >
                    {statusConfig.type === 'spinner' ? (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
                        title={statusConfig.label}
                      />
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`}
                        title={statusConfig.label}
                      />
                    )}
                    {capitalizeFirst(tool)}
                  </button>
                );
              })}
            </nav>
            <button
              onClick={handleKillSession}
              disabled={!worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium rounded transition-colors ${
                worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning
                  ? 'text-red-600 hover:bg-red-50'
                  : 'invisible'
              }`}
              aria-label={`End ${activeCliTab} session`}
            >
              <span aria-hidden="true">&#x2715;</span>
              End
            </button>
          </div>
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
            onNewFile={handleNewFile}
            onNewDirectory={handleNewDirectory}
            onRename={handleRename}
            onDelete={handleDelete}
            onUpload={handleUpload}
            onMove={handleMove}
            refreshTrigger={fileTreeRefresh}
            fileSearch={fileSearch}
            showToast={showToast}
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
            cliToolId={activeCliTab}
            isSessionRunning={state.terminal.isActive}
          />
        </div>

        <MobileTabBar
          activeTab={activeTab}
          onTabChange={handleMobileTabChange}
          hasNewOutput={false}
          hasPrompt={state.prompt.visible}
          hasUpdate={hasUpdate}
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
        {/* Markdown Editor Modal (Mobile) - Issue #104: disableClose when editor is maximized */}
        {editorFilePath && (
          <Modal
            isOpen={true}
            onClose={handleEditorClose}
            title={editorFilePath.split('/').pop() || 'Editor'}
            size="full"
            disableClose={isEditorMaximized}
          >
            <div className="h-[80vh]">
              <MarkdownEditor
                worktreeId={worktreeId}
                filePath={editorFilePath}
                onClose={handleEditorClose}
                onSave={handleEditorSave}
                onMaximizedChange={setIsEditorMaximized}
              />
            </div>
          </Modal>
        )}
        {/* Hidden file input for upload (Mobile) */}
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOADABLE_EXTENSIONS.join(',')}
          onChange={handleFileInputChange}
          className="hidden"
          aria-label="Upload file"
        />
        {/* Kill session confirmation dialog (Mobile) */}
        <Modal
          isOpen={showKillConfirm}
          onClose={handleKillCancel}
          title={tWorktree('session.confirmEnd', { tool: capitalizeFirst(activeCliTab) })}
          size="sm"
          showCloseButton={true}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              {tWorktree('session.endWarning')}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleKillCancel}
                className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                onClick={handleKillConfirm}
                className="px-4 py-2 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white"
              >
                {tCommon('end')}
              </button>
            </div>
          </div>
        </Modal>
        {/* [Issue #162] Move Dialog (Mobile) */}
        {moveTarget && (
          <MoveDialog
            isOpen={isMoveDialogOpen}
            onClose={handleMoveCancel}
            onConfirm={handleMoveConfirm}
            worktreeId={worktreeId}
            sourcePath={moveTarget.path}
            sourceType={moveTarget.type}
          />
        )}
        {/* Toast notifications (Mobile) */}
        <ToastContainer toasts={toasts} onClose={removeToast} />
      </div>
    </ErrorBoundary>
  );
});

export default WorktreeDetailRefactored;
