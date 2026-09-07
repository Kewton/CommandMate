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
 *
 * ## Row actions, including "insert delegation brief" (Issue #2376 / #2382)
 *
 * Every per-row action a phone user sees here — rename, reorder, delete, and
 * the #2376 "insert delegation brief into the composer" kebab item
 * (`agent-instance-delegate-<id>`) — is rendered by the shared
 * {@link AgentInstancesPane}. There is deliberately no mobile copy of the
 * delegation item: its wording (`DELEGATE_TEXT`), its two server reads
 * (`fetchDelegationBrief`) and its delivery (`insertIntoVisibleComposer`) are
 * one implementation, so a `grep delegat` on this file finding nothing is
 * expected, not a gap. On a phone that item lands in the composer docked under
 * EVERY mobile tab (`MobileComposer` in `WorktreeDetailRefactored`), so it
 * works from the Tools tab this pane lives on; the "no composer" toast is
 * reachable only where no composer is mounted at all.
 *
 * "Do not delegate to yourself" is the shared pane's guard too, and it reads
 * the chat surface's `data-instance-id`. That surface is never mounted at the
 * same time as this pane (it belongs to the terminal tab), so on a phone the
 * DOM read answers "unknown" and would let the insert through — the same
 * outcome PC has in terminal mode, by the same design (see
 * `readVisibleChatInstanceId`).
 *
 * Issue #2395 supplies the answer the DOM cannot: {@link
 * MobileAgentInstancesPaneProps.composerTargetInstanceId} carries the docked
 * composer's own target down from `WorktreeDetailRefactored` (its
 * `activeInstanceId`) through `WorktreeDetailMobile` and `NotesAndLogsPane`.
 * Forwarded unchanged; this wrapper adds no rule of its own, so the row that is
 * the composer's target loses the item on exactly the shared pane's terms.
 */

'use client';

import React, { memo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  getInstanceLabel,
  getCliToolDisplayName,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { Checkbox } from '@/components/ui';
import { MIN_VISIBLE_INSTANCES } from '@/hooks/useMobileSelectedInstances';
import { AgentInstancesPane, relayBadgeClassName } from '@/components/worktree/AgentInstancesPane';
import { useSessionRelays } from '@/lib/relay/use-session-relays';
import { resolveRelayBadges } from '@/lib/relay/relay-badges';
import type { AgentEventSourceView } from '@/types/models';

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
  /**
   * Issue #1783: instanceId -> last reported model. Threaded to the shared
   * {@link AgentInstancesPane} and shown as a third line on this pane's
   * "show on this device" rows, under the existing alias / tool-name pair.
   * Read-only; absent entries render nothing.
   */
  modelByInstance?: Readonly<Partial<Record<string, string | null>>>;
  /**
   * Issue #2054: instanceId -> what is reading that instance besides the frame.
   *
   * Forwarded to the shared {@link AgentInstancesPane}, which renders the
   * warning row. Optional and normally absent: with nothing supplied the shared
   * pane reads for itself, and only when the roster contains a tool whose source
   * can be degraded. Passing it is how a caller that already holds
   * `sessionStatusByInstance` avoids a second read.
   */
  sourceByInstance?: Readonly<Partial<Record<string, AgentEventSourceView>>>;
  /**
   * Issue #2395: the instance the phone's docked composer sends to.
   *
   * Forwarded verbatim to the shared {@link AgentInstancesPane}, which drops
   * its "insert delegation brief" item on that row. Optional only so this pane
   * still renders standalone (tests, and any caller that has no composer): with
   * nothing supplied the shared pane falls back to its DOM read, which on a
   * phone answers "unknown" — the pre-#2395 behaviour.
   */
  composerTargetInstanceId?: string;
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
  modelByInstance,
  sourceByInstance,
  composerTargetInstanceId,
}: MobileAgentInstancesPaneProps) {
  const t = useTranslations('schedule');
  // Issue #1783: model wording lives in the `worktree` namespace.
  const tWorktree = useTranslations('worktree');

  const visibleSet = new Set(visibleInstanceIds);
  const atMinVisible = visibleInstanceIds.length <= MIN_VISIBLE_INSTANCES;

  // Issue #2377: the relay lines, on this list as well as on the shared roster
  // editor above it. Both are drawn because they answer different questions —
  // the roster is where a session is configured, this list is where a phone
  // decides which tabs to carry, and "this one owes somebody a reply" is a
  // reason to keep a tab visible.
  const relays = useSessionRelays(worktreeId);
  const aliasOf = useCallback(
    (endpoint: { worktreeId: string; instanceId: string }) => {
      if (endpoint.worktreeId !== worktreeId) {
        return `${endpoint.instanceId} @ ${endpoint.worktreeId}`;
      }
      return instances.find((inst) => inst.id === endpoint.instanceId)?.alias
        ?? endpoint.instanceId;
    },
    [instances, worktreeId],
  );

  return (
    <div data-testid="mobile-agent-instances-pane">
      {/* Shared roster editor (entity + alias → DB, consistent with PC).
          Issue #2382: this is also where the phone gets the #2376 "insert
          delegation brief" row action — see the module comment above. */}
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={instances}
        onInstancesChange={onInstancesChange}
        vibeLocalModel={vibeLocalModel}
        onVibeLocalModelChange={onVibeLocalModelChange}
        vibeLocalContextWindow={vibeLocalContextWindow}
        onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
        // Issue #1783: read-only observed model per roster row.
        modelByInstance={modelByInstance}
        // Issue #2054: forwarded so the shared pane does not have to read twice
        // when a caller already holds the map. Undefined leaves it reading for
        // itself, which is the mobile shell's path today.
        sourceByInstance={sourceByInstance}
        // Issue #2395: the docked composer's target, so the shared pane's self
        // guard can bite on a phone. Undefined leaves the pane on its DOM read.
        composerTargetInstanceId={composerTargetInstanceId}
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
            // Issue #1783: observed model for this instance, or null.
            const instanceModel = modelByInstance?.[inst.id] ?? null;
            // Issue #2377: what this session owes and is waiting for.
            const relayBadges = resolveRelayBadges({
              owed: relays.owedBy(inst.id),
              awaiting: relays.awaitedBy(inst.id),
              aliasOf,
            });
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
                  {/* Issue #1783: the third line of the existing 2-line row.
                      Omitted entirely when no model has been reported. */}
                  {instanceModel && (
                    <span
                      data-testid={`mobile-visible-instance-model-${inst.id}`}
                      title={tWorktree('agentModel.modelLabel', { model: instanceModel })}
                      className="block text-xs text-muted-foreground truncate"
                    >
                      {instanceModel}
                    </span>
                  )}
                  {/* Issue #2377: absent when nothing is open, exactly as the
                      model line above is absent when nothing was reported. */}
                  {relayBadges.map((badge) => (
                    <span
                      key={badge.key}
                      data-testid={`mobile-visible-instance-relay-${badge.tone}-${inst.id}`}
                      title={tWorktree(`relay.${badge.titleKey}`)}
                      className={`block text-xs truncate ${relayBadgeClassName(badge)}`}
                    >
                      {tWorktree(`relay.${badge.key}`, badge.params)}
                    </span>
                  ))}
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
