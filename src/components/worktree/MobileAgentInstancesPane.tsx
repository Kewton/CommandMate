/**
 * MobileAgentInstancesPane Component (Issue #874)
 *
 * Mobile instance-management UI. 折衷案 (compromise) split:
 *   - The instance ROSTER (id / cliTool / alias / order) is shared with PC and
 *     lives in the DB. Mobile reuses the SAME {@link AgentInstancesPane} so add /
 *     rename / delete / reorder behave exactly like PC and stay consistent
 *     across devices (PATCH /api/worktrees/[id] with `agentInstances`).
 *   - WHICH instances are shown as tabs on THIS device is a per-device view
 *     preference (localStorage, lifted to the controller via
 *     {@link useMobileSelectedInstances}). It NEVER writes the DB, preserving the
 *     #837/#851 intent that a mobile user narrowing their tabs must not shrink
 *     the PC view.
 *
 * This component renders the shared roster editor plus a "Show on this device"
 * checklist driven by the visibility props.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  getInstanceLabel,
  getCliToolDisplayName,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { Checkbox } from '@/components/ui';
import { MIN_VISIBLE_INSTANCES } from '@/hooks/useMobileSelectedInstances';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';

export interface MobileAgentInstancesPaneProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Current agent instances (shared roster, ordered) */
  instances: AgentInstance[];
  /** Callback when the roster changes (after a successful PATCH) */
  onInstancesChange: (instances: AgentInstance[]) => void;
  /** Current vibe-local model selection (null = default) */
  vibeLocalModel: string | null;
  /** Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** Current vibe-local context window (null = default) */
  vibeLocalContextWindow?: number | null;
  /** Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange?: (value: number | null) => void;
  /** Per-device visible instance ids (from useMobileSelectedInstances). */
  visibleInstanceIds: string[];
  /** Toggle one instance's per-device visibility (enforces MIN_VISIBLE_INSTANCES). */
  onToggleInstanceVisible: (instanceId: string) => void;
}

export const MobileAgentInstancesPane = memo(function MobileAgentInstancesPane({
  worktreeId,
  instances,
  onInstancesChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  visibleInstanceIds,
  onToggleInstanceVisible,
}: MobileAgentInstancesPaneProps) {
  const t = useTranslations('schedule');

  const visibleSet = new Set(visibleInstanceIds);
  const atMinVisible = visibleInstanceIds.length <= MIN_VISIBLE_INSTANCES;

  return (
    <div data-testid="mobile-agent-instances-pane">
      {/* Shared roster editor (entity + alias → DB, consistent with PC). */}
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={instances}
        onInstancesChange={onInstancesChange}
        vibeLocalModel={vibeLocalModel}
        onVibeLocalModelChange={onVibeLocalModelChange}
        vibeLocalContextWindow={vibeLocalContextWindow}
        onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
      />

      {/* Per-device "show as tabs" selection (localStorage, never the DB). */}
      <div
        data-testid="mobile-visible-instances"
        className="px-4 pb-4 border-t border-border mt-2 pt-4"
      >
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t('mobileVisibleInstances')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('mobileVisibleInstancesDescription')}
        </p>

        <div className="space-y-1">
          {instances.map((inst) => {
            const checked = visibleSet.has(inst.id);
            // Cannot hide the last remaining visible instance (MIN=1).
            const disabled = checked && atMinVisible;
            return (
              <label
                key={inst.id}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer ${
                  disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted'
                }`}
              >
                <Checkbox
                  data-testid={`mobile-visible-instance-toggle-${inst.id}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={() => onToggleInstanceVisible(inst.id)}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-foreground truncate">
                    {getInstanceLabel(inst)}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {getCliToolDisplayName(inst.cliTool)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {atMinVisible && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('mobileVisibleInstanceMin')}
          </p>
        )}
      </div>
    </div>
  );
});

export default MobileAgentInstancesPane;
