/**
 * NotesAndLogsPane Component
 * Issue #294: Combined Memo + Execution Log pane
 * Issue #368: Added 'agent' sub-tab for Agent settings
 * Issue #874: The 'agent' sub-tab can switch to instance-management mode (mobile)
 * Issue #1816: Adds the 'verification' sub-tab (mobile Tools tab), mirroring the
 * PC Activity Bar's Verification pane
 *
 * [S1-013] Props: { worktreeId: string; className?: string; }
 * Sub-tab state is managed internally (not exposed to parent)
 * Tab ID 'memo' is maintained for backward compatibility
 */

'use client';

import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import { useTranslations } from 'next-intl';
import { MemoPane } from './MemoPane';
import { TodoPane } from './TodoPane';
import { ExecutionLogPane } from './ExecutionLogPane';
import { AgentSettingsPane } from './AgentSettingsPane';
import { MobileAgentInstancesPane } from './MobileAgentInstancesPane';
import { TimerPane } from './TimerPane';
import { WorktreeSkillsPane } from '@/components/skills/WorktreeSkillsPane';
import { VerificationPane } from './VerificationPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { WorktreeVerificationState } from '@/hooks/useWorktreeVerification';

// ============================================================================
// Types
// ============================================================================

/** Issue #368: Extended with 'agent' sub-tab. Issue #534: Extended with 'timer' sub-tab. Issue #1015: 'todo' sub-tab. Issue #1442: 'skills' sub-tab (mobile). Issue #1816: 'verification' sub-tab (mobile) */
export type SubTab = 'notes' | 'logs' | 'agent' | 'timer' | 'todo' | 'skills' | 'verification';

/**
 * A request from outside to jump to a sub-tab (Issue #1816).
 *
 * Carries a token because the same tab can be requested twice in a row (tapping
 * the header chip again while the Tools tab is already open), and a bare tab
 * value would compare equal and do nothing. The parent clears the request when
 * the user leaves the Tools tab, so a later visit opens on the default tab
 * rather than replaying a stale jump.
 */
export interface SubTabRequest {
  tab: SubTab;
  token: number;
}

/** Configuration for a sub-tab button */
interface SubTabConfig {
  id: SubTab;
  labelKey: string;
}

export interface NotesAndLogsPaneProps {
  /** Worktree ID */
  worktreeId: string;
  /** Additional CSS classes */
  className?: string;
  /** Issue #485: Callback when memo content is inserted into message input */
  onInsertToMessage?: (content: string) => void;
  /** Issue #368: Currently selected agents for the worktree */
  selectedAgents: CLIToolType[];
  /** Issue #368: Callback when selected agents change */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** Issue #438: Maximum number of agents that can be selected */
  maxAgents?: number;
  /** Issue #837: Selectable agent pool for AgentSettingsPane (defaults to all CLI tools) */
  availableAgents?: readonly CLIToolType[];
  /** Issue #837: When false, AgentSettingsPane changes are not persisted to the DB */
  persistToServer?: boolean;
  /** Issue #368: Current vibe-local model selection */
  vibeLocalModel: string | null;
  /** Issue #368: Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** Issue #374: Current vibe-local context window (null = default) */
  vibeLocalContextWindow?: number | null;
  /** Issue #374: Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange?: (value: number | null) => void;
  /**
   * Issue #874: When true the 'agent' sub-tab renders the instance-management UI
   * (MobileAgentInstancesPane) instead of AgentSettingsPane. Requires the
   * instance props below. Defaults to false (legacy checkbox UI) for backward
   * compatibility.
   */
  useInstanceManagement?: boolean;
  /** Issue #874: Shared agent instance roster (instance-management mode). */
  instances?: AgentInstance[];
  /** Issue #874: Callback when the roster changes (after a successful PATCH). */
  onInstancesChange?: (instances: AgentInstance[]) => void;
  /** Issue #874: Per-device visible instance ids (localStorage, never the DB). */
  visibleInstanceIds?: string[];
  /** Issue #874: Toggle one instance's per-device visibility. */
  onToggleInstanceVisible?: (instanceId: string) => void;
  /**
   * Issue #1783: instanceId -> the model that instance last reported running.
   * Threaded to {@link MobileAgentInstancesPane} for a read-only display; absent
   * entries render nothing.
   */
  modelByInstance?: Readonly<Partial<Record<string, string | null>>>;
  /**
   * Issue #1816: task contract + verification runs, owned by
   * `useWorktreeVerification` in the detail controller. The 'verification'
   * sub-tab is offered only when this is supplied, so callers that have no such
   * state (none today besides the mobile shell) keep the previous six tabs.
   */
  verification?: WorktreeVerificationState;
  /** Issue #1816: jump to a sub-tab from outside (the header chip). */
  requestedSubTab?: SubTabRequest | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Sub-tab definitions driven by data (DRY: avoids repeating button markup) */
const SUB_TABS: readonly SubTabConfig[] = [
  { id: 'notes', labelKey: 'notes' },
  { id: 'logs', labelKey: 'logs' },
  { id: 'agent', labelKey: 'agentTab' },
  { id: 'timer', labelKey: 'timerTab' },
  // Issue #1015: branch-scoped ToDo list. Label resolves from schedule.json
  // `todoTab` (added to BOTH en and ja, [S3-003]).
  { id: 'todo', labelKey: 'todoTab' },
  // Issue #1442: worktree-scoped Skills surface (mobile). Reuses the PC pane
  // (#1441). Label resolves from schedule.json `skillsTab` (BOTH en and ja).
  { id: 'skills', labelKey: 'skillsTab' },
  // Issue #1816: execution contract + verification gates (mobile). Reuses the PC
  // pane. Label resolves from schedule.json `verificationTab` (BOTH en and ja).
  { id: 'verification', labelKey: 'verificationTab' },
] as const;

/** CSS class for the active sub-tab button */
const ACTIVE_TAB_CLASS = 'text-accent-600 dark:text-accent-400 border-b-2 border-accent-600 dark:border-accent-400 bg-accent-50 dark:bg-accent-900/30';
/** CSS class for inactive sub-tab buttons */
const INACTIVE_TAB_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-muted';

// ============================================================================
// Component
// ============================================================================

export const NotesAndLogsPane = memo(function NotesAndLogsPane({
  worktreeId,
  className = '',
  selectedAgents,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  maxAgents,
  availableAgents,
  persistToServer,
  onInsertToMessage,
  useInstanceManagement = false,
  instances,
  onInstancesChange,
  visibleInstanceIds,
  onToggleInstanceVisible,
  modelByInstance,
  verification,
  requestedSubTab,
}: NotesAndLogsPaneProps) {
  const t = useTranslations('schedule');
  // Internal sub-tab state (not leaked to parent). Issue #1816: an outside
  // request present at mount is honoured as the initial tab, because the mobile
  // shell unmounts this pane whenever the Tools tab is left — the chip's jump
  // arrives together with the remount, not after it.
  const [activeSubTab, setActiveSubTab] = useState<SubTab>(requestedSubTab?.tab ?? 'notes');
  const appliedRequestTokenRef = useRef(requestedSubTab?.token ?? null);

  // A *new* request (same pane already mounted: the chip tapped while the Tools
  // tab is open) switches tabs. The token guard is what keeps the mount-time
  // request from being applied twice.
  useEffect(() => {
    if (!requestedSubTab) return;
    if (requestedSubTab.token === appliedRequestTokenRef.current) return;
    appliedRequestTokenRef.current = requestedSubTab.token;
    setActiveSubTab(requestedSubTab.tab);
  }, [requestedSubTab]);

  const handleSubTabChange = useCallback((tab: SubTab) => {
    setActiveSubTab(tab);
  }, []);

  // Issue #1816: the tab row scrolls horizontally (#1442), so a tab selected
  // from OUTSIDE the row — the header chip jumping straight to Verification,
  // which is last — would render its pane with no visible active tab. Optional
  // call because jsdom does not implement scrollIntoView.
  const tabRefs = useRef<Partial<Record<SubTab, HTMLButtonElement | null>>>({});
  useEffect(() => {
    tabRefs.current[activeSubTab]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeSubTab]);

  const subTabs = verification
    ? SUB_TABS
    : SUB_TABS.filter((tab) => tab.id !== 'verification');

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Sub-tab switcher. Issue #1442: six tabs no longer fit a `flex-1`
          equal-split on narrow (≈320px) mobile widths, so the row scrolls
          horizontally (`overflow-x-auto scrollbar-hide`, mirroring the
          agent-instance tabs in WorktreeDetailRefactored) and each button stays
          at its natural width (`flex-shrink-0 whitespace-nowrap`) instead of
          being squeezed/wrapped. `scrollbar-hide` is defined in globals.css.
          Tabs use plain `onClick` with no hover-gated visibility, so every tab
          stays tappable on touch devices. */}
      <div className="flex overflow-x-auto scrollbar-hide border-b border-border bg-surface dark:bg-surface-2 flex-shrink-0">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            onClick={() => handleSubTabChange(tab.id)}
            className={`flex-shrink-0 whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors ${
              activeSubTab === tab.id ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeSubTab === 'notes' && (
          <MemoPane worktreeId={worktreeId} className="h-full" onInsertToMessage={onInsertToMessage} />
        )}
        {activeSubTab === 'logs' && (
          <ExecutionLogPane
            worktreeId={worktreeId}
            className="h-full"
            onInsertToMessage={onInsertToMessage}
            instances={instances}
          />
        )}
        {activeSubTab === 'agent' && (
          useInstanceManagement && instances && onInstancesChange && visibleInstanceIds && onToggleInstanceVisible ? (
            <div className="h-full overflow-y-auto">
              <MobileAgentInstancesPane
                worktreeId={worktreeId}
                instances={instances}
                onInstancesChange={onInstancesChange}
                vibeLocalModel={vibeLocalModel}
                onVibeLocalModelChange={onVibeLocalModelChange}
                vibeLocalContextWindow={vibeLocalContextWindow}
                onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
                visibleInstanceIds={visibleInstanceIds}
                onToggleInstanceVisible={onToggleInstanceVisible}
                modelByInstance={modelByInstance}
              />
            </div>
          ) : (
            <AgentSettingsPane
              worktreeId={worktreeId}
              selectedAgents={selectedAgents}
              onSelectedAgentsChange={onSelectedAgentsChange}
              vibeLocalModel={vibeLocalModel}
              onVibeLocalModelChange={onVibeLocalModelChange}
              vibeLocalContextWindow={vibeLocalContextWindow}
              onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
              maxAgents={maxAgents}
              availableAgents={availableAgents}
              persistToServer={persistToServer}
            />
          )
        )}
        {activeSubTab === 'timer' && (
          <TimerPane
            worktreeId={worktreeId}
            instances={instances}
            selectedAgents={selectedAgents}
          />
        )}
        {activeSubTab === 'todo' && (
          <TodoPane worktreeId={worktreeId} className="h-full" />
        )}
        {/* Issue #1442: same worktree-scoped Skills pane the PC Activity Bar
            mounts (#1441); the worktree is fixed by this screen. */}
        {activeSubTab === 'skills' && (
          <WorktreeSkillsPane worktreeId={worktreeId} className="h-full" />
        )}
        {/* Issue #1816: same pane the PC Activity Bar mounts; the state comes
            from the one hook the detail controller owns. */}
        {activeSubTab === 'verification' && verification && (
          <VerificationPane state={verification} className="h-full" />
        )}
      </div>
    </div>
  );
});

export default NotesAndLogsPane;
