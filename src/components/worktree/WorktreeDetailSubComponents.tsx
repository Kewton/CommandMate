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
import { useTranslations } from 'next-intl';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { DESKTOP_STATUS_CONFIG, SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip } from '@/components/common/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/DropdownMenu';
import { classifyHeaderInstances } from '@/lib/agent-status-display';
import { LogViewer } from '@/components/worktree/LogViewer';
import { VersionSection } from '@/components/worktree/VersionSection';
import { FeedbackSection } from '@/components/worktree/FeedbackSection';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui';
import { worktreeApi } from '@/lib/api-client';
import { truncateString } from '@/lib/utils';
import { ClipboardCopy, Check } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { NotificationDot } from '@/components/common/NotificationDot';
import { deriveCliStatus } from '@/types/sidebar';
import type { Worktree, ChatMessage, GitStatus } from '@/types/models';
import { getInstanceLabel, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';
import { AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import { PcDisplaySizeSelector } from '@/components/layout/PcDisplaySizeSelector';

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
  /** Callback to update parent worktree state */
  onWorktreeUpdate?: (updated: Worktree) => void;
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
  onWorktreeUpdate,
}: WorktreeInfoFieldsProps) {
  const { isEditing, text, setText, isSaving, handleSave, handleCancel, startEditing } = descriptionEditor;

  const [pathCopied, setPathCopied] = useState(false);
  const [repoPathCopied, setRepoPathCopied] = useState(false);
  const pathTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const repoPathTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
      if (repoPathTimerRef.current) clearTimeout(repoPathTimerRef.current);
    };
  }, []);

  const handleCopyPath = useCallback(async () => {
    try {
      await copyToClipboard(worktree.path);
      setPathCopied(true);
      if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
      pathTimerRef.current = setTimeout(() => setPathCopied(false), COPY_FEEDBACK_RESET_MS);
    } catch {
      // Silent failure
    }
  }, [worktree.path]);

  const handleCopyRepoPath = useCallback(async () => {
    try {
      await copyToClipboard(worktree.repositoryPath);
      setRepoPathCopied(true);
      if (repoPathTimerRef.current) clearTimeout(repoPathTimerRef.current);
      repoPathTimerRef.current = setTimeout(() => setRepoPathCopied(false), COPY_FEEDBACK_RESET_MS);
    } catch {
      // Silent failure
    }
  }, [worktree.repositoryPath]);

  return (
    <>
      {/* Worktree Name */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-muted-foreground mb-1">Worktree</h2>
        <p className="text-lg font-semibold text-foreground">{worktree.name}</p>
      </div>

      {/* Repository Info */}
      <div className={cardClassName}>
        <div className="flex items-center gap-1.5 mb-1">
          <h2 className="text-sm font-medium text-muted-foreground">Repository</h2>
          <Button
            variant="ghost"
            type="button"
            onClick={handleCopyRepoPath}
            className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Copy repository path"
            title={repoPathCopied ? 'Copied!' : 'Copy repository path'}
          >
            {repoPathCopied ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <ClipboardCopy className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
        <p className="text-base text-foreground">{worktree.repositoryDisplayName ?? worktree.repositoryName}</p>
        <p className="text-xs text-muted-foreground mt-1 break-all">{worktree.repositoryPath}</p>
      </div>

      {/* Path */}
      <div className={cardClassName}>
        <div className="flex items-center gap-1.5 mb-1">
          <h2 className="text-sm font-medium text-muted-foreground">Path</h2>
          <Button
            variant="ghost"
            type="button"
            onClick={handleCopyPath}
            className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Copy worktree path"
            title={pathCopied ? 'Copied!' : 'Copy path'}
          >
            {pathCopied ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <ClipboardCopy className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
        <p className="text-sm text-foreground break-all font-mono">{worktree.path}</p>
      </div>

      {/* Status - dropdown for mobile */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-muted-foreground mb-1">Status</h2>
        <select
          value={worktree.status ?? ''}
          onChange={async (e) => {
            const val = e.target.value;
            const newStatus = val === '' ? null : val as 'ready' | 'in_progress' | 'in_review' | 'done';
            try {
              const response = await fetch(`/api/worktrees/${worktree.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
              });
              if (response.ok && onWorktreeUpdate) {
                const updated = await response.json();
                onWorktreeUpdate(updated);
              }
            } catch {
              // Silently handle
            }
          }}
          className="text-sm px-3 py-1.5 rounded-lg border border-input bg-surface text-foreground focus:ring-2 focus:ring-ring focus:border-transparent w-full"
          data-testid="mobile-status-dropdown"
          aria-label="Worktree status"
        >
          <option value="">Not set</option>
          <option value="ready">Ready</option>
          <option value="in_progress">In Progress</option>
          <option value="in_review">In Review</option>
          <option value="done">Done</option>
        </select>
      </div>

      {/* Description - Editable */}
      <div className={cardClassName}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-muted-foreground">Description</h2>
          {!isEditing && (
            /* Issue #1061: borderless text-link — Button base padding/hover-lift would distort the inline link — 残置 */
            <button
              type="button"
              onClick={startEditing}
              className="text-sm text-accent-600 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-300"
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
              className="w-full min-h-[150px] p-3 border border-input dark:bg-surface dark:text-foreground rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 bg-accent-600 text-white rounded-lg hover:bg-accent-700 disabled:opacity-50 text-sm font-medium"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-border disabled:opacity-50 text-sm font-medium"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-h-[50px]">
            {worktree.description ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">{worktree.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No description added yet</p>
            )}
          </div>
        )}
      </div>

      {/* Link */}
      {worktree.link && (
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Link</h2>
          <a
            href={worktree.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent-600 hover:underline break-all"
          >
            {worktree.link}
          </a>
        </div>
      )}

      {/* Last Updated */}
      {worktree.updatedAt && (
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Last Updated</h2>
          <p className="text-sm text-foreground">
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
          <h2 className="text-sm font-medium text-muted-foreground">Logs</h2>
          {/* Issue #1061: borderless text-link — Button base padding/hover-lift would distort the inline link — 残置 */}
          <button
            type="button"
            onClick={onToggleLogs}
            className="text-sm text-accent-600 hover:text-accent-800"
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
  /**
   * Optional sidebar toggle callback.
   * Issue #747: the sidebar (Branches) toggle moved out of DesktopHeader into
   * the top of the ActivityBar, so DesktopHeader no longer renders a hamburger.
   * Kept as an optional prop for backward compatibility.
   */
  onMenuClick?: () => void;
  /** Whether an app update is available (shows notification dot on Info button) - Issue #278 */
  hasUpdate?: boolean;
  /** Current worktree status (ready/in_progress/in_review/done/null) */
  worktreeStatus?: 'ready' | 'in_progress' | 'in_review' | 'done' | null;
  /** Callback when worktree status is changed via dropdown */
  onWorktreeStatusChange?: (status: 'ready' | 'in_progress' | 'in_review' | 'done' | null) => void;
  /** Per-CLI session status map (PC only, optional). Issue #749 */
  sessionStatusByCli?: Worktree['sessionStatusByCli'];
  /**
   * Per-instance session status map keyed by instanceId (PC only, optional).
   * Issue #875: the per-agent status row and "End" button resolve each
   * instance's status from here so alias instances (instanceId !== cliToolId)
   * show their own status. Falls back to {@link sessionStatusByCli} per backing
   * CLI tool when an instance entry is absent (transition / backward compat).
   */
  sessionStatusByInstance?: Worktree['sessionStatusByInstance'];
  /**
   * Issue #869: agent instance roster (PC only, optional). The per-agent status
   * row is now an instance-tab switcher: one tab per instance, labelled by alias
   * (`getInstanceLabel`). Status is resolved per instance (Issue #875).
   */
  instances?: AgentInstance[];
  /** Issue #869: currently active agent instance id (PC only, optional). */
  activeInstanceId?: string;
  /** Issue #869: callback when an instance tab is clicked (PC only, optional). */
  onActiveInstanceChange?: (instanceId: string) => void;
  /**
   * Issue #786 / #869: published when an instance tab starts being dragged, so
   * the parent can share the dragged instanceId with the terminal splits for the
   * dragOver allowed/forbidden ring (D-2). Optional — when omitted, drag still
   * sets the dataTransfer payload but no id is published (ring stays inert).
   */
  onAgentDragStart?: (instanceId: string) => void;
  /** Issue #786: published when an instance tab drag ends (cleanup). */
  onAgentDragEnd?: () => void;
  /**
   * Callback to kill the active CLI session (PC only, optional). Issue #784.
   * Restores the kill button removed by #728 (split-ification) and missed by
   * #755 (Desktop/Mobile split). When provided and the active CLI session is
   * running, a kill button is rendered between the per-agent status row and the
   * worktree status dropdown.
   */
  onKillSession?: () => void;
}

/** Worktree status options for dropdown */
const WORKTREE_STATUS_OPTIONS: Array<{ value: 'ready' | 'in_progress' | 'in_review' | 'done' | null; label: string }> = [
  { value: null, label: 'Not set' },
  { value: 'ready', label: 'Ready' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
];

/** Status indicator configuration is imported from @/config/status-colors (SF1) */

/**
 * Issue #1078: max labelled agent pills kept inline in the desktop header before
 * the rest collapse into the "+N" overflow menu. Idle/ready instances always
 * render as narrow icon-only dots and never count against this budget.
 */
const MAX_HEADER_AGENT_PILLS = 4;

/** Desktop header with hamburger menu, back button, worktree name, repository, status, and info button */
export const DesktopHeader = memo(function DesktopHeader({
  worktreeName,
  repositoryName,
  description: worktreeDescription,
  status,
  gitStatus,
  onBackClick,
  onInfoClick,
  hasUpdate,
  worktreeStatus,
  onWorktreeStatusChange,
  sessionStatusByCli,
  sessionStatusByInstance,
  instances,
  activeInstanceId,
  onActiveInstanceChange,
  onAgentDragStart,
  onAgentDragEnd,
  onKillSession,
}: DesktopHeaderProps) {
  const tWorktree = useTranslations('worktree');
  const statusConfig = DESKTOP_STATUS_CONFIG[status];
  // Issue #111: DRY - Use shared truncateString utility
  const DESKTOP_BRANCH_MAX_LENGTH = 30;
  const DESCRIPTION_MAX_LENGTH = 50;

  // Issue #786 / #869: which instance tab is currently being dragged (for the
  // opacity-50/cursor-grabbing visual). Local to the header; the instanceId
  // published to the splits goes through onAgentDragStart/onAgentDragEnd.
  const [draggingInstanceId, setDraggingInstanceId] = useState<string | null>(null);

  // Issue #875: the active instance's CLI tool + its own running state. The
  // "End" button targets the active *instance* (kill-session is instance-scoped),
  // so its visibility is driven by the per-instance status; we fall back to the
  // per-CLI map when the per-instance entry is absent (transition / backward compat).
  const activeInstance = instances?.find((inst) => inst.id === activeInstanceId);
  const activeInstanceRunning = activeInstanceId
    ? (sessionStatusByInstance?.[activeInstanceId]?.isRunning
        ?? (activeInstance ? sessionStatusByCli?.[activeInstance.cliTool]?.isRunning : undefined)
        ?? false)
    : false;

  const handleAgentDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, instanceId: string) => {
      // Issue #786 / #869: payload via dedicated MIME so external file/text
      // drags don't collide. getData is readable only on drop in real browsers
      // (D-2). The MIME is the single shared constant the drop target reads with
      // (D-1) so the setData/getData keys can never drift apart. Payload is the
      // agent instanceId (previously a bare CLI tool id).
      e.dataTransfer.setData(AGENT_INSTANCE_DND_MIME, instanceId);
      e.dataTransfer.effectAllowed = 'move';
      setDraggingInstanceId(instanceId);
      onAgentDragStart?.(instanceId);
    },
    [onAgentDragStart],
  );

  const handleAgentDragEnd = useCallback(() => {
    // Always clear the drag-active visual (finally-equivalent), regardless of
    // whether the drag succeeded or onAgentDragStart wired anything (S3-002).
    setDraggingInstanceId(null);
    onAgentDragEnd?.();
  }, [onAgentDragEnd]);

  // Truncate description using shared utility
  const truncatedDescription = worktreeDescription
    ? truncateString(worktreeDescription, DESCRIPTION_MAX_LENGTH)
    : null;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-surface border-b border-border">
      {/* Left: Back button and title (Issue #747: hamburger moved to ActivityBar) */}
      <div className="flex items-center gap-3">
        {/* Issue #1061: paddingless nav link — Button base px-4 py-2 would enlarge/misalign the header back control — 残置 */}
        <button
          type="button"
          onClick={onBackClick}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
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
        <div className="w-px h-6 bg-border" aria-hidden="true" />
        {/* Worktree-level status (Issue #1078: unified StatusDot visual language) */}
        <StatusDot
          data-testid="desktop-status-indicator"
          status={status}
          size="lg"
          label={statusConfig.label}
        />
        {/* Worktree name, memo, and repository */}
        <div className="flex flex-col min-w-0">
          <h1 className="text-lg font-semibold text-foreground truncate max-w-[200px] leading-tight">
            {worktreeName}
          </h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate max-w-[200px]">
              {repositoryName}
            </span>
            {gitStatus && gitStatus.currentBranch !== '(unknown)' && (
              <>
                <span className="text-muted-foreground">/</span>
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
                <span className="text-muted-foreground">—</span>
                <span
                  className="truncate max-w-[300px] text-muted-foreground"
                  title={worktreeDescription}
                >
                  {truncatedDescription}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right: Per-agent status row + Status dropdown + Info button */}
      <div className="flex items-center gap-2">
        {/* Issue #749/#869/#1078: Per-instance session status row (PC only).
            Distinct from the worktree-level StatusDot on the left: this row is
            per-agent-instance and doubles as an instance-tab switcher. Issue #1078
            unifies the status visual on <StatusDot> and collapses idle noise —
            active/working instances stay labelled pills, idle/ready collapse to
            icon-only dots (label via Tooltip), and pills beyond the budget fold
            into a "+N" overflow menu so a working session never gets buried.
            Rendered only when instances is provided (backward compat). */}
        {instances && instances.length > 0 && (() => {
          // Issue #875: resolve each instance's status from the per-instance map
          // so alias instances (instanceId !== cliToolId) show their own status;
          // fall back to the per-CLI map for backward compat.
          const classified = classifyHeaderInstances(
            instances.map((inst) => ({
              item: inst,
              status: deriveCliStatus(
                sessionStatusByInstance?.[inst.id] ?? sessionStatusByCli?.[inst.cliTool]
              ),
              isActive: inst.id === activeInstanceId,
            })),
            MAX_HEADER_AGENT_PILLS
          );
          const overflow = classified.filter((c) => c.slot === 'overflow');
          // Issue #1078: if any folded instance is actively working, surface the
          // living glow on the "+N" trigger so a running session stays visible
          // at a glance even when collapsed. Prefer running/generating (green
          // glow) over waiting (amber blink); no working ones → no glow.
          const overflowGlowStatus =
            overflow.find((c) => c.status === 'running' || c.status === 'generating')?.status ??
            overflow.find((c) => c.status === 'waiting')?.status ??
            null;

          return (
            <div className="flex items-center gap-2 flex-shrink-0" data-testid="desktop-agent-status-row">
              {classified.map((c) => {
                if (c.slot === 'overflow') return null;
                const inst = c.item;
                const label = getInstanceLabel(inst);
                const fullLabel = `${label}: ${SIDEBAR_STATUS_CONFIG[c.status].label}`;
                const isActive = c.isActive;
                // Issue #786: drag source. click and drag are mutually exclusive
                // in HTML; a plain click (no drag) still fires onClick exactly
                // once (S3-002 regression-guarded). Preserved on both pill and dot.
                const dragProps = {
                  draggable: true,
                  onDragStart: (e: React.DragEvent<HTMLButtonElement>) => handleAgentDragStart(e, inst.id),
                  onDragEnd: handleAgentDragEnd,
                } as const;
                const dragActive = draggingInstanceId === inst.id ? ' opacity-50 cursor-grabbing' : '';

                if (c.slot === 'pill') {
                  return (
                    /* Issue #1061: draggable instance-tab switcher (aria-pressed) with typed drag handlers — 残置 */
                    <button
                      key={inst.id}
                      type="button"
                      data-testid={`desktop-agent-status-${inst.id}`}
                      onClick={() => onActiveInstanceChange?.(inst.id)}
                      {...dragProps}
                      aria-label={fullLabel}
                      aria-pressed={isActive}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
                        isActive
                          ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-900 dark:text-accent-100'
                          : 'hover:bg-muted text-foreground'
                      }${dragActive}`}
                    >
                      {/* Issue #1078: unified StatusDot (decorative; the button carries the label) */}
                      <StatusDot status={c.status} size="sm" aria-hidden title={undefined} />
                      <span className="whitespace-nowrap">{fullLabel}</span>
                    </button>
                  );
                }

                // Idle/ready → icon-only 24px circular button; full label via Tooltip.
                return (
                  <Tooltip key={inst.id} content={fullLabel} placement="bottom">
                    {/* Issue #1061: draggable instance-tab switcher (aria-pressed) — 残置 */}
                    <button
                      type="button"
                      data-testid={`desktop-agent-status-${inst.id}`}
                      onClick={() => onActiveInstanceChange?.(inst.id)}
                      {...dragProps}
                      aria-label={fullLabel}
                      aria-pressed={isActive}
                      className={`flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
                        isActive
                          ? 'bg-accent-100 dark:bg-accent-900/30'
                          : 'hover:bg-muted'
                      }${dragActive}`}
                    >
                      <StatusDot status={c.status} size="sm" aria-hidden title={undefined} />
                    </button>
                  </Tooltip>
                );
              })}

              {/* Issue #1078: width-overflow menu for surplus labelled pills. */}
              {overflow.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* Issue #1061: DropdownMenuTrigger asChild requires ref forwarding; Button forwards no ref — 残置 */}
                    <button
                      type="button"
                      data-testid="desktop-agent-status-overflow"
                      aria-label={tWorktree('agentStatus.moreAgents', { count: overflow.length })}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs tabular-nums text-muted-foreground hover:bg-muted transition-colors"
                    >
                      {overflowGlowStatus && (
                        <StatusDot status={overflowGlowStatus} size="sm" aria-hidden title={undefined} />
                      )}
                      +{overflow.length}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {overflow.map((c) => {
                      const inst = c.item;
                      const fullLabel = `${getInstanceLabel(inst)}: ${SIDEBAR_STATUS_CONFIG[c.status].label}`;
                      return (
                        <DropdownMenuItem
                          key={inst.id}
                          data-testid={`desktop-agent-overflow-${inst.id}`}
                          onSelect={() => onActiveInstanceChange?.(inst.id)}
                        >
                          <StatusDot status={c.status} size="sm" aria-hidden title={undefined} />
                          <span className="whitespace-nowrap">{fullLabel}</span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })()}
        {/* Issue #784: Session kill button (PC only). Restored after the
            #728 (split-ification) + #755 (Desktop/Mobile split) regression that
            left the kill confirmation modal unreachable on PC. Mirrors the
            Mobile kill button (WorktreeDetailRefactored.tsx:409-421). Rendered
            only when a kill handler is wired AND the active CLI session is
            running; click opens the existing confirmation modal. */}
        {onKillSession && activeInstanceRunning && (
          <Button
            variant="ghost"
            type="button"
            onClick={onKillSession}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
            aria-label="End session"
            data-testid="desktop-kill-session"
          >
            <span aria-hidden="true">&#x2715;</span>
            End
          </Button>
        )}
        {/* Worktree status dropdown */}
        {onWorktreeStatusChange && (
          <select
            value={worktreeStatus ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              onWorktreeStatusChange(val === '' ? null : val as 'ready' | 'in_progress' | 'in_review' | 'done');
            }}
            onClick={(e) => e.stopPropagation()}
            className="text-xs px-2 py-1.5 rounded-lg border border-input bg-surface text-foreground focus:ring-2 focus:ring-ring focus:border-transparent cursor-pointer"
            data-testid="desktop-status-dropdown"
            aria-label="Worktree status"
          >
            {WORKTREE_STATUS_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        {/* Issue #917: PC display-size selector. The global Header (where it
            also lives) is suppressed on /worktrees/[id] (useLayoutConfig
            showGlobalNav:false), so it is surfaced here too. PC only — the
            selector returns null on mobile. */}
        <PcDisplaySizeSelector />
      <Button
        variant="ghost"
        type="button"
        onClick={onInfoClick}
        className="relative flex items-center gap-1.5 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
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
      </Button>
      </div>
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
          cardClassName="bg-muted rounded-lg p-4"
          descriptionEditor={descriptionEditor}
          showLogs={showLogs}
          onToggleLogs={() => setShowLogs(!showLogs)}
          onWorktreeUpdate={onWorktreeUpdate}
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
          className="animate-spin rounded-full h-8 w-8 border-4 border-input border-t-accent-600 dark:border-t-accent-400"
          aria-hidden="true"
        />
        <p className="text-muted-foreground">Loading worktree...</p>
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
      <div className="text-center p-6 bg-danger-subtle rounded-lg border border-danger-border max-w-md">
        <svg
          className="mx-auto h-12 w-12 text-danger-foreground/70 mb-4"
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
        <p className="text-danger-foreground font-medium">Error loading worktree</p>
        <p className="text-danger-foreground/80 text-sm mt-2">{message}</p>
        {onRetry && (
          <Button
            variant="ghost"
            type="button"
            onClick={onRetry}
            className="mt-4 px-4 py-2 bg-danger-foreground text-danger-subtle rounded-lg hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2 ring-offset-background"
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// Mobile Content Components (Issue #755)
// ============================================================================

/**
 * Issue #755: MobileContent / MobileInfoContent moved to
 * `WorktreeDetailMobile.tsx`. Re-exported here for backward compatibility so
 * existing imports of these symbols from WorktreeDetailSubComponents keep
 * working. New code should import from `@/components/worktree/WorktreeDetailMobile`.
 */
export {
  MobileContent,
  MobileInfoContent,
} from '@/components/worktree/WorktreeDetailMobile';

