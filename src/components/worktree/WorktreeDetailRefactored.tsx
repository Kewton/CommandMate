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
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useWorktreeUIState } from '@/hooks/useWorktreeUIState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MobileHeader, type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { MobileTabBar, type MobileTab } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { SearchBar } from '@/components/worktree/SearchBar';
import { useFileSearch } from '@/hooks/useFileSearch';
import { LeftPaneTabSwitcher, type LeftPaneTab } from '@/components/worktree/LeftPaneTabSwitcher';
import { FileViewer } from '@/components/worktree/FileViewer';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import { useFileTabs } from '@/hooks/useFileTabs';
import { useFilePolling } from '@/hooks/useFilePolling';
import { FILE_TREE_POLL_INTERVAL_MS } from '@/config/file-polling-config';


/**
 * Dynamic import of MarkdownEditor with SSR disabled.
 * highlight.js / rehype-highlight require browser APIs during rendering.
 * Uses .then() pattern because MarkdownEditor is a named export.
 */
const MarkdownEditor = dynamic(
  () =>
    import('@/components/worktree/MarkdownEditor').then((mod) => ({
      default: mod.MarkdownEditor,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-500">
        <Loader2 className="animate-spin h-6 w-6 mr-2" />
        <span>Loading editor...</span>
      </div>
    ),
  }
);
import {
  deriveWorktreeStatus,
  parseMessageTimestamps,
  DesktopHeader,
  InfoModal,
  LoadingIndicator,
  ErrorDisplay,
  MobileContent,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { UPLOADABLE_EXTENSIONS, getMaxFileSize, isUploadableExtension } from '@/config/uploadable-extensions';
import { ToastContainer, useToast } from '@/components/common/Toast';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import { GitPane } from '@/components/worktree/GitPane';
import { Modal } from '@/components/ui/Modal';
import { useAutoYes } from '@/hooks/useAutoYes';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import type { AutoYesStopReason } from '@/config/auto-yes-config';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import type { Worktree, ChatMessage, PromptData, FileContent } from '@/types/models';
import { getCliToolDisplayName, isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import { deriveCliStatus } from '@/types/sidebar';
import { useTranslations } from 'next-intl';
import { useFileOperations } from '@/hooks/useFileOperations';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import { parseCmateContent, validateScheduleHeaders, validateSchedulesSection, CMATE_TEMPLATE_CONTENT } from '@/lib/cmate-validator';

// ============================================================================
// Constants
// ============================================================================

/** localStorage key prefix for persisting the active CLI tool tab per worktree */
const ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX = 'activeCliTab-';

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
  /** Issue #473: OpenCode TUI selection list active flag */
  isSelectionListActive?: boolean;
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
  const tSchedule = useTranslations('schedule');

  // Local state for worktree data and loading status
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  // Issue #438: File tabs state (replaces fileViewerPath for desktop)
  const fileTabs = useFileTabs(worktreeId);
  // Mobile-only: file viewer path for modal display (desktop uses fileTabs)
  const [mobileFileViewerPath, setMobileFileViewerPath] = useState<string | null>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  // Issue #104: Track editor maximized state to disable Modal close handlers
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [autoYesEnabled, setAutoYesEnabled] = useState(false);
  const [autoYesExpiresAt, setAutoYesExpiresAt] = useState<number | null>(null);
  // Issue #473: Track OpenCode TUI selection list state
  const [isSelectionListActive, setIsSelectionListActive] = useState(false);
  // Issue #314: Track previous auto-yes enabled state for stop reason toast
  const prevAutoYesEnabledRef = useRef<boolean>(false);
  // Issue #314: Pending stop reason toast (deferred until showToast is available)
  const [stopReasonPending, setStopReasonPending] = useState(false);
  // Issue #368: Selected agents state (initialized from API, drives terminal header tabs)
  const [selectedAgents, setSelectedAgents] = useState<CLIToolType[]>(DEFAULT_SELECTED_AGENTS);
  // Ref to access latest selectedAgents inside fetchWorktree without adding to useCallback deps
  const selectedAgentsRef = useRef(selectedAgents);
  selectedAgentsRef.current = selectedAgents;
  // Issue #368: Vibe-local Ollama model state (initialized from API)
  const [vibeLocalModel, setVibeLocalModel] = useState<string | null>(null);
  // Issue #374: Vibe-local context window state (initialized from API)
  const [vibeLocalContextWindow, setVibeLocalContextWindow] = useState<number | null>(null);
  // Issue #4: CLI tool tab state - restored from localStorage or fallback to selectedAgents[0]
  const [activeCliTab, setActiveCliTabRaw] = useState<CLIToolType>(() => {
    try {
      const saved = window.localStorage.getItem(ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX + worktreeId);
      if (saved && isCliToolType(saved)) {
        return saved;
      }
    } catch { /* localStorage unavailable (SSR) */ }
    return DEFAULT_SELECTED_AGENTS[0];
  });
  // Wrapper: persist activeCliTab to localStorage on change
  const setActiveCliTab = useCallback((tool: CLIToolType) => {
    setActiveCliTabRaw(tool);
    try {
      window.localStorage.setItem(ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX + worktreeId, tool);
    } catch { /* localStorage unavailable */ }
  }, [worktreeId]);
  // Issue #4: Ref to avoid polling callback recreation on tab switch
  const activeCliTabRef = useRef<CLIToolType>(activeCliTab);
  activeCliTabRef.current = activeCliTab;
  // Trigger to refresh FileTreeView after file operations
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);

  // [Issue #469] Tree polling: detect file tree changes via JSON comparison
  const prevTreeHashRef = useRef<string | null>(null);
  useFilePolling({
    intervalMs: FILE_TREE_POLL_INTERVAL_MS,
    enabled: state.layout.leftPaneTab === 'files',
    onPoll: async () => {
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/tree`);
        if (!response.ok) return; // Ignore errors in polling
        const data = await response.json();
        const newHash = JSON.stringify(data?.items);
        if (newHash !== prevTreeHashRef.current) {
          prevTreeHashRef.current = newHash;
          setFileTreeRefresh(prev => prev + 1);
        }
      } catch {
        // Silently ignore network errors during polling
      }
    },
  });

  // [Issue #447] History sub-tab: 'message' (default) or 'git'
  const [historySubTab, setHistorySubTab] = useState<'message' | 'git'>('message');

  // [Issue #447] Diff content for right pane display (PC only)
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFilePath, setDiffFilePath] = useState<string | null>(null);

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
      // Skip setState when value is unchanged to prevent unnecessary re-renders
      if (data.selectedAgents) {
        const current = selectedAgentsRef.current;
        const isSame = data.selectedAgents.length === current.length &&
          data.selectedAgents.every((v: string, i: number) => v === current[i]);
        if (!isSame) {
          setSelectedAgents(data.selectedAgents);
        }
      }
      // Issue #368: Sync vibeLocalModel from API response
      if ('vibeLocalModel' in data) {
        setVibeLocalModel(data.vibeLocalModel ?? null);
      }
      // Issue #374: Sync vibeLocalContextWindow from API response
      if ('vibeLocalContextWindow' in data) {
        setVibeLocalContextWindow(data.vibeLocalContextWindow ?? null);
      }
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

      // Issue #473: Update selection list state from server
      setIsSelectionListActive(data.isSelectionListActive ?? false);

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

  // Mobile: limit displayed agents to 2 (screen space constraint)
  const MOBILE_MAX_AGENTS = 2;
  const displayedAgents = isMobile && selectedAgents.length > MOBILE_MAX_AGENTS
    ? selectedAgents.slice(0, MOBILE_MAX_AGENTS)
    : selectedAgents;

  // Issue #368: Sync activeCliTab when displayedAgents changes
  // If current activeCliTab is no longer in displayedAgents, switch to first agent
  useEffect(() => {
    if (!displayedAgents.includes(activeCliTab)) {
      setActiveCliTab(displayedAgents[0]);
    }
  }, [displayedAgents, activeCliTab, setActiveCliTab]);

  // Issue #379: Disable auto-follow for OpenCode (full-screen TUI).
  // OpenCode renders its TUI in a fixed viewport where menus (e.g., /model, /commands)
  // appear at the top. Auto-following new content to bottom would hide these menus.
  const disableAutoFollow = activeCliTab === 'opencode';

  /** Issue #368: Callback for AgentSettingsPane to update selectedAgents */
  const handleSelectedAgentsChange = useCallback((agents: CLIToolType[]) => {
    setSelectedAgents(agents);
  }, []);

  /** Issue #368: Callback for AgentSettingsPane to update vibeLocalModel */
  const handleVibeLocalModelChange = useCallback((model: string | null) => {
    setVibeLocalModel(model);
  }, []);

  /** Issue #374: Callback for AgentSettingsPane to update vibeLocalContextWindow */
  const handleVibeLocalContextWindowChange = useCallback((value: number | null) => {
    setVibeLocalContextWindow(value);
  }, []);

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

  // Toast state for notifications (moved before event handlers that reference showToast)
  const { toasts, showToast, removeToast } = useToast();

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /** Handle file path click in history pane */
  const handleFilePathClick = useCallback((path: string) => {
    if (isMobile) {
      setMobileFileViewerPath(path);
    } else {
      const result = fileTabs.openFile(path);
      if (result === 'limit_reached') {
        showToast('Maximum 5 file tabs. Close a tab first.', 'info');
      }
    }
  }, [isMobile, fileTabs, showToast]);

  /**
   * Handle file select from FileTreeView
   * Opens MarkdownEditor for .md files, file tab panel (desktop) or modal (mobile) for others
   * [Stage 3 SF-004] Separate editorFilePath state to avoid conflict
   * Issue #438: Uses file tabs instead of modal for non-editable files on desktop
   */
  const handleFileSelect = useCallback((path: string) => {
    if (isMobile) {
      // Mobile: all files open in FileViewer modal (includes MARP, path copy, fullscreen)
      setMobileFileViewerPath(path);
    } else {
      // Desktop: open in file tab panel (including .md files for preview)
      const result = fileTabs.openFile(path);
      if (result === 'limit_reached') {
        showToast('Maximum 5 file tabs. Close a tab first.', 'info');
      }
    }
  }, [isMobile, fileTabs, showToast]);

  /** Handle closing mobile FileViewer modal */
  const handleMobileFileViewerClose = useCallback(() => {
    setMobileFileViewerPath(null);
  }, []);

  /** Handle file save in tab panel - refresh tree to reflect changes */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- savedPath accepted for callback interface compatibility
  const handleFilePanelSave = useCallback((_savedPath: string) => {
    setFileTreeRefresh(prev => prev + 1);
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

  /** Handle diff selection from GitPane (Issue #447) */
  const handleDiffSelect = useCallback((diff: string, filePath: string) => {
    if (!isMobile) {
      // PC: show diff in right pane file panel area
      setDiffContent(diff);
      setDiffFilePath(filePath);
    }
    // Mobile: diff is shown inline within GitPane
  }, [isMobile]);

  /** Close diff view in right pane (Issue #447) */
  const handleCloseDiff = useCallback(() => {
    setDiffContent(null);
    setDiffFilePath(null);
  }, []);

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
      // Renamed successfully - update file tab if the renamed file was open
      const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
      fileTabs.onFileRenamed(path, `${parentDir}${newName}`);
      // Trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to rename:', err);
      window.alert(tError('fileOps.failedToRename'));
    }
  }, [worktreeId, fileTabs, tError]);

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
      // Issue #438: Close file tab if the deleted file was open
      fileTabs.onFileDeleted(path);
      // Trigger FileTreeView refresh
      setFileTreeRefresh(prev => prev + 1);
    } catch (err) {
      console.error('[WorktreeDetailRefactored] Failed to delete:', err);
      window.alert(tError('fileOps.failedToDelete'));
    }
  }, [worktreeId, editorFilePath, fileTabs, tCommon, tError]);

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

  /** [Issue #294] Handle CMATE.md setup/validate button */
  const handleCmateSetup = useCallback(async () => {
    try {
      // Check if CMATE.md exists via tree listing (avoids 404 console noise)
      const treeResponse = await fetch(`/api/worktrees/${worktreeId}/tree`);
      if (!treeResponse.ok) {
        throw new Error(`Failed to list worktree files: ${treeResponse.status}`);
      }
      const treeData = await treeResponse.json();
      const treeItems: { name: string }[] = treeData.items ?? [];
      const cmateExists = treeItems.some(item => item.name === 'CMATE.md');

      let content: string;

      if (!cmateExists) {
        // File does not exist - create with template
        const createResponse = await fetch(
          `/api/worktrees/${worktreeId}/files/CMATE.md`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'file', content: CMATE_TEMPLATE_CONTENT }),
          }
        );
        if (!createResponse.ok) {
          throw new Error('Failed to create CMATE.md');
        }
        showToast(tSchedule('cmateCreated'), 'success');
        setFileTreeRefresh(prev => prev + 1);
        // Use template content directly for validation
        content = CMATE_TEMPLATE_CONTENT;
      } else {
        // File exists - read content for validation
        const fileResponse = await fetch(
          `/api/worktrees/${worktreeId}/files/CMATE.md`
        );
        if (!fileResponse.ok) {
          throw new Error(`Failed to read CMATE.md: ${fileResponse.status}`);
        }
        const data = await fileResponse.json();
        if (typeof data.content !== 'string') {
          showToast(tSchedule('cmateValidation.failed'), 'error');
          return;
        }
        content = data.content;
      }

      // Validate content
      const headerErrors = validateScheduleHeaders(content);
      const sections = parseCmateContent(content);
      const scheduleRows = sections.get('Schedules');

      if (!scheduleRows || scheduleRows.length === 0) {
        showToast(tSchedule('cmateValidation.noSchedulesSection'), 'error');
        return;
      }

      const rowErrors = validateSchedulesSection(scheduleRows);
      const errors = [...headerErrors, ...rowErrors];

      if (errors.length === 0) {
        showToast(
          tSchedule('cmateValidation.valid', { count: String(scheduleRows.length) }),
          'success'
        );
      } else {
        const maxDisplay = 3;
        const details = errors
          .slice(0, maxDisplay)
          .map((e) => e.message)
          .join('; ');
        const suffix = errors.length > maxDisplay ? ` (+${errors.length - maxDisplay})` : '';
        showToast(
          tSchedule('cmateValidation.errors', {
            errorCount: String(errors.length),
            details: details + suffix,
          }),
          'error'
        );
      }
    } catch (err) {
      console.error('[WorktreeDetailRefactored] CMATE setup error:', err);
      showToast(tSchedule('cmateValidation.failed'), 'error');
    }
  }, [worktreeId, showToast, tSchedule]);

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
      // Parallel: fetch worktree, messages, and current output simultaneously.
      // fetchMessages/fetchCurrentOutput handle missing worktree gracefully.
      await Promise.all([
        fetchWorktree(),
        fetchMessages(),
        fetchCurrentOutput(),
      ]);
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
  // Issue #438: File panel loading callbacks (memoized for FilePanelSplit)
  // ========================================================================

  const handleLoadContent = useCallback((path: string, content: FileContent) => {
    fileTabs.dispatch({ type: 'SET_CONTENT', path, content });
  }, [fileTabs]);

  const handleLoadError = useCallback((path: string, errorMsg: string) => {
    fileTabs.dispatch({ type: 'SET_ERROR', path, error: errorMsg });
  }, [fileTabs]);

  const handleSetLoading = useCallback((path: string, isLoading: boolean) => {
    fileTabs.dispatch({ type: 'SET_LOADING', path, loading: isLoading });
  }, [fileTabs]);

  // [Issue #469] isDirty state change callback for file content polling control
  const handleDirtyChange = useCallback((path: string, isDirty: boolean) => {
    fileTabs.dispatch({ type: 'SET_DIRTY', path, isDirty });
  }, [fileTabs]);

  // ========================================================================
  // Memoized Panes (Issue #411: avoid re-render on polling)
  // ========================================================================

  /** Memoized CLI tool tab header for the terminal pane */
  const terminalHeaderMemo = useMemo(
    () => (
      <div className="px-3 py-1.5 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-shrink-0">
        <nav className="flex items-center gap-3" aria-label="CLI Tool Selection">
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
            cliToolName={activeCliTab}
            inline
          />
          <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
          {displayedAgents.map((tool) => {
            const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
            const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
            return (
              <button
                key={tool}
                onClick={() => setActiveCliTab(tool)}
                className={`pb-1 px-1.5 border-b-2 font-medium text-xs transition-colors flex items-center gap-1 ${
                  activeCliTab === tool
                    ? 'border-cyan-600 text-cyan-600'
                    : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
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
                {getCliToolDisplayName(tool)}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          {/* [Issue #47] Terminal search button */}
          <button
            onClick={() => {
              // Dispatch a custom event that TerminalDisplay listens for
              window.dispatchEvent(new CustomEvent('terminal-search-open'));
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            aria-label="ターミナル内を検索"
            data-testid="terminal-search-button"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          {worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning && (
            <button
              onClick={handleKillSession}
              className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
              aria-label={`End ${activeCliTab} session`}
            >
              <span aria-hidden="true">&#x2715;</span>
              End
            </button>
          )}
        </div>
      </div>
    ),
    [autoYesEnabled, autoYesExpiresAt, handleAutoYesToggle, lastAutoResponse, activeCliTab, displayedAgents, worktree?.sessionStatusByCli, handleKillSession, setActiveCliTab]
  );

  /** Memoized right pane (terminal + file panel) to prevent re-render when left pane state changes */
  const rightPaneMemo = useMemo(
    () => (
      <FilePanelSplit
        terminal={
          <TerminalDisplay
            output={state.terminal.output}
            isActive={state.terminal.isActive}
            isThinking={state.terminal.isThinking}
            autoScroll={state.terminal.autoScroll}
            onScrollChange={handleAutoScrollChange}
            disableAutoFollow={disableAutoFollow}
          />
        }
        terminalHeader={terminalHeaderMemo}
        fileTabs={fileTabs.state}
        worktreeId={worktreeId}
        onCloseTab={fileTabs.closeTab}
        onActivateTab={fileTabs.activateTab}
        onLoadContent={handleLoadContent}
        onLoadError={handleLoadError}
        onSetLoading={handleSetLoading}
        onFileSaved={handleFilePanelSave}
        diffContent={diffContent}
        diffFilePath={diffFilePath}
        onCloseDiff={handleCloseDiff}
        onDirtyChange={handleDirtyChange}
      />
    ),
    [state.terminal.output, state.terminal.isActive, state.terminal.isThinking, state.terminal.autoScroll, handleAutoScrollChange, disableAutoFollow, terminalHeaderMemo, fileTabs.state, fileTabs.closeTab, fileTabs.activateTab, worktreeId, handleLoadContent, handleLoadError, handleSetLoading, handleFilePanelSave, diffContent, diffFilePath, handleCloseDiff, handleDirtyChange]
  );

  /**
   * Memoized left pane to prevent re-render when terminal state changes.
   *
   * MAINTENANCE NOTE (Issue #411, R3-007):
   * The dependency array below lists every prop, state value, and callback
   * referenced inside the JSX. When adding a new prop or state variable to
   * the left pane content, you MUST also add it to this dependency array,
   * otherwise the memoized output will be stale.
   */
  const leftPaneMemo = useMemo(
    () => (
      <div className="h-full flex flex-col">
        <LeftPaneTabSwitcher
          activeTab={leftPaneTab}
          onTabChange={handleLeftPaneTabChange}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          {leftPaneTab === 'history' && (
            <div className="h-full flex flex-col">
              {/* History sub-tab switcher: Message | Git (Issue #447) */}
              <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0">
                <button
                  type="button"
                  onClick={() => setHistorySubTab('message')}
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
                  onClick={() => setHistorySubTab('git')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                    historySubTab === 'git'
                      ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  Git
                </button>
              </div>
              {historySubTab === 'message' && (
                <HistoryPane
                  messages={state.messages}
                  worktreeId={worktreeId}
                  onFilePathClick={handleFilePathClick}
                  className="flex-1 min-h-0"
                  showToast={showToast}
                />
              )}
              {historySubTab === 'git' && (
                <ErrorBoundary componentName="GitPane">
                  <GitPane
                    worktreeId={worktreeId}
                    onDiffSelect={handleDiffSelect}
                    isMobile={false}
                    className="flex-1 min-h-0"
                  />
                </ErrorBoundary>
              )}
            </div>
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
                  onCmateSetup={handleCmateSetup}
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
            <ErrorBoundary componentName="NotesAndLogsPane">
              <NotesAndLogsPane
                worktreeId={worktreeId}
                className="h-full"
                selectedAgents={selectedAgents}
                onSelectedAgentsChange={handleSelectedAgentsChange}
                vibeLocalModel={vibeLocalModel}
                onVibeLocalModelChange={handleVibeLocalModelChange}
                vibeLocalContextWindow={vibeLocalContextWindow}
                onVibeLocalContextWindowChange={handleVibeLocalContextWindowChange}
                maxAgents={4}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>
    ),
    [leftPaneTab, handleLeftPaneTabChange, historySubTab, state.messages, worktreeId, handleFilePathClick, showToast, fileSearch.query, fileSearch.mode, fileSearch.isSearching, fileSearch.error, fileSearch.setQuery, fileSearch.setMode, fileSearch.clearSearch, fileSearch.results?.results, handleFileSelect, handleNewFile, handleNewDirectory, handleRename, handleDelete, handleUpload, handleMove, handleCmateSetup, fileTreeRefresh, selectedAgents, handleSelectedAgentsChange, vibeLocalModel, handleVibeLocalModelChange, vibeLocalContextWindow, handleVibeLocalContextWindowChange, handleDiffSelect]
  );

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
              leftPane={leftPaneMemo}
              rightPane={rightPaneMemo}
              initialLeftWidth={20}
              minLeftWidth={15}
              maxLeftWidth={60}
            />
          </div>
          {/* Issue #473: Navigation buttons for OpenCode TUI selection list */}
          {isSelectionListActive && (
            <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 px-4 pt-2 bg-gray-50 dark:bg-gray-800">
              <NavigationButtons
                worktreeId={worktreeId}
                cliToolId={activeCliTab}
              />
            </div>
          )}
          <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800">
            <MessageInput
              worktreeId={worktreeId}
              onMessageSent={handleMessageSent}
              cliToolId={activeCliTab}
              isSessionRunning={state.terminal.isActive}
            />
          </div>
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
                cliToolName={getCliToolDisplayName(activeCliTab)}
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
          {/* Issue #438: Desktop FileViewer modal replaced by FilePanelSplit in rightPaneMemo */}
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
            title={tWorktree('session.confirmEnd', { tool: getCliToolDisplayName(activeCliTab) })}
            size="sm"
            showCloseButton={true}
          >
            <div className="space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {tWorktree('session.endWarning')}
              </p>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleKillCancel}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300"
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
          <div className="z-35">
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          </div>
        )}

        {/* Auto Yes + CLI Tool Tabs combined row (Mobile) */}
        <div className="sticky top-0 z-30 flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
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
              {displayedAgents.map((tool) => {
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
                    {getCliToolDisplayName(tool)}
                  </button>
                );
              })}
            </nav>
            {/* [Issue #47] Terminal search button (Mobile) */}
            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('terminal-search-open'));
              }}
              className="flex items-center px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              aria-label="ターミナル内を検索"
              data-testid="terminal-search-button-mobile"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
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
          className="flex-1 pb-32 overflow-hidden"
          style={{
            paddingBottom: 'calc(8rem + env(safe-area-inset-bottom, 0px))',
          }}
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
            onCmateSetup={handleCmateSetup}
            selectedAgents={selectedAgents}
            onSelectedAgentsChange={handleSelectedAgentsChange}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={handleVibeLocalModelChange}
            vibeLocalContextWindow={vibeLocalContextWindow}
            onVibeLocalContextWindowChange={handleVibeLocalContextWindowChange}
            autoScroll={state.terminal.autoScroll}
            onScrollChange={handleAutoScrollChange}
            disableAutoFollow={disableAutoFollow}
            historySubTab={historySubTab}
            onHistorySubTabChange={setHistorySubTab}
            onDiffSelect={handleDiffSelect}
          />
        </main>

        {/* Message Input - fixed above tab bar */}
        <div
          className="fixed left-0 right-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 z-30"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {/* Issue #473: Navigation buttons for OpenCode TUI selection list (mobile) */}
          {isSelectionListActive && (
            <div className="px-2 pt-1 border-b border-gray-200 dark:border-gray-700">
              <NavigationButtons
                worktreeId={worktreeId}
                cliToolId={activeCliTab}
              />
            </div>
          )}
          <div className="p-2">
            <MessageInput
              worktreeId={worktreeId}
              onMessageSent={handleMessageSent}
              cliToolId={activeCliTab}
              isSessionRunning={state.terminal.isActive}
            />
          </div>
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
            cliToolName={getCliToolDisplayName(activeCliTab)}
          />
        )}

        {/* File Viewer Modal (Mobile only) */}
        <FileViewer
          isOpen={mobileFileViewerPath !== null}
          onClose={handleMobileFileViewerClose}
          worktreeId={worktreeId}
          filePath={mobileFileViewerPath ?? ''}
          onEditMarkdown={setEditorFilePath}
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
          title={tWorktree('session.confirmEnd', { tool: getCliToolDisplayName(activeCliTab) })}
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
