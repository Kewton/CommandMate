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

import React, { useEffect, useCallback, useLayoutEffect, useState, memo, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { DESKTOP_STATUS_LABEL_KEYS } from '@/config/status-colors';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip } from '@/components/common/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/DropdownMenu';
import {
  classifyHeaderInstances,
  isLabeledInstance,
  type HeaderInstanceItem,
} from '@/lib/agent-status-display';
import { LogViewer } from '@/components/worktree/LogViewer';
import { VersionSection } from '@/components/worktree/VersionSection';
import { FeedbackSection } from '@/components/worktree/FeedbackSection';
import { Modal } from '@/components/ui/Modal';
import { Button, Spinner } from '@/components/ui';
import { worktreeApi } from '@/lib/api-client';
import { truncateString } from '@/lib/utils';
import { ClipboardCopy, Check } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { NotificationDot } from '@/components/common/NotificationDot';
import { deriveCliStatus } from '@/types/sidebar';
import type { AgentEventSourceView, Worktree, ChatMessage, GitStatus } from '@/types/models';
import {
  sumAgentSessionTokens,
  type AgentSessionContextView,
  type AgentSessionSnapshot,
  type AgentSessionView,
} from '@/types/agent-session';
import { getInstanceLabel, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import { PcDisplaySizeSelector } from '@/components/layout/PcDisplaySizeSelector';

// ============================================================================
// Constants
// ============================================================================

/** Build-time app version from package.json via next.config.js */
const APP_VERSION_DISPLAY = process.env.NEXT_PUBLIC_APP_VERSION
  ? `v${process.env.NEXT_PUBLIC_APP_VERSION}`
  : '-';

/**
 * Worktree status options for the status dropdowns (Issue #1277: `labelKey` is
 * resolved against the `worktree` namespace at the call site, so the options
 * list stays a single source of truth for both the desktop header dropdown and
 * the WorktreeInfoFields dropdown without pinning either to English).
 */
const WORKTREE_STATUS_OPTIONS: Array<{
  value: 'ready' | 'in_progress' | 'in_review' | 'done' | null;
  labelKey: string;
}> = [
  { value: null, labelKey: 'worktreeStatus.notSet' },
  { value: 'ready', labelKey: 'worktreeStatus.ready' },
  { value: 'in_progress', labelKey: 'worktreeStatus.inProgress' },
  { value: 'in_review', labelKey: 'worktreeStatus.inReview' },
  { value: 'done', labelKey: 'worktreeStatus.done' },
];

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

/**
 * The one string every surface shows for "what is this agent running on"
 * (Issue #1783 model, #1784 effort).
 *
 * `model · effort`, or the model alone when the effort is unknown — still the
 * ordinary case rather than an edge one, though for a narrower reason since
 * Issue #2048: it is read off the CLI's own chrome for codex and claude, derived
 * from the model id for antigravity, and **published by the agent** for opencode
 * alone, which calls it a `variant`. Nothing knows it for gemini or copilot.
 * Returns null when there is no model either, so every call site's existing
 * `{label && …}` guard keeps meaning "show nothing".
 *
 * Issue #2048 needed no change here, and that is the point of the parameter
 * order: opencode's variant arrives through the same `reasoningEffort` field
 * every other tool's level does (`agent-event-state` latches it and
 * `mergeModelInfo` ranks it), so `agent · model · variant` is what this already
 * composed. What did change is that the third segment is now reachable for a
 * tool whose pane never prints it.
 *
 * Centralised rather than interpolated at each of the four display sites so the
 * pane header, the roster rows, the mobile sheet and the header pill's tooltip
 * cannot drift apart.
 *
 * Issue #2042 prepends the agent *persona* — opencode's `build` / `plan`, from
 * `structuredEvents.session.agent` — when one is known, giving
 * `build · claude-sonnet-4.6`. Only opencode publishes one, so every other
 * tool's label is byte-identical to pre-#2042; the parameter is last and
 * optional so every existing call site is too.
 *
 * @param model - The model id, **or an already-composed model label**: the split
 *   pane re-enters here with the string its parent formatted, to add a persona
 *   to it without a second join living somewhere else. Null returns null.
 * @param effort - The reasoning effort, when the CLI's chrome showed one
 * @param agent - The persona driving the session (Issue #2042), or null
 */
export function formatAgentModelLabel(
  model: string | null | undefined,
  effort?: string | null,
  agent?: string | null
): string | null {
  if (!model) return null;
  const withEffort = effort ? `${model} · ${effort}` : model;
  return agent ? `${agent} · ${withEffort}` : withEffort;
}

/**
 * The one sentence that describes what is reading an agent pane (Issue #2054).
 *
 * Returns null when there is nothing to say, and **that is the whole of
 * acceptance criterion 2**: the server publishes `eventSource` only for a source
 * that can be degraded (opencode, and nothing else today — see
 * `describeAgentEventSource`), so every claude / codex call site keeps its
 * existing `{label && …}` guard and renders a byte-identical chip. The rule is
 * enforced HERE as well as on the server, because a surface that decided for
 * itself which tools to draw for would be a second copy of the rule to keep in
 * sync: nothing is drawn unless the pair the server can only fill in for a
 * subscription source is actually filled in.
 *
 * Centralised for the reason {@link formatAgentModelLabel} is: the header pill's
 * tooltip and the roster's warning row must not describe one disconnection two
 * ways.
 *
 * @param source - `sessionStatusByInstance[id].eventSource`, or undefined
 * @param t - The `worktree` namespace translator
 * @returns The line, or null when this pane has nothing degraded to report
 */
export function formatAgentSourceLabel(
  source: AgentEventSourceView | null | undefined,
  t: ReturnType<typeof useTranslations<'worktree'>>
): string | null {
  if (!source) return null;
  // Neither half present means the server had nothing a pane could differ on.
  if (!source.liveness && !source.degradedReason) return null;

  const kind =
    source.kind === 'sse'
      ? t('agentSource.kindSse')
      : source.kind === 'scraper'
        ? t('agentSource.kindScraper')
        : t('agentSource.kindHooks');

  // Fixed keys, never `t(\`agentSource.reason.\${x}\`)`: the reason is a token a
  // transport wrote and a future one can spell a way this build has no message
  // for, and a dynamic lookup would render a raw key path at the operator. The
  // unknown branch shows the token itself, which is the honest fallback.
  const reason =
    source.degradedReason === undefined
      ? null
      : source.degradedReason === 'port_identity_changed'
        ? t('agentSource.reasonPortIdentityChanged')
        : source.degradedReason === 'heartbeat_stale'
          ? t('agentSource.reasonHeartbeatStale')
          : source.degradedReason === 'not_subscribed'
            ? t('agentSource.reasonNotSubscribed')
            : t('agentSource.reasonOther', { reason: source.degradedReason });

  const liveness =
    source.liveness === 'stale'
      ? t('agentSource.livenessStale')
      : source.liveness === 'live'
        ? t('agentSource.livenessLive')
        : null;

  const state = [liveness, reason].filter((part): part is string => part !== null).join(' · ');
  return state ? t('agentSource.line', { kind, state }) : t('agentSource.lineBare', { kind });
}

/**
 * Whether {@link formatAgentSourceLabel}'s line is a problem or a reassurance
 * (Issue #2054).
 *
 * Only `sse` + `live` is the healthy state. Everything else — a stream that went
 * quiet, a port another process took, a pane with no subscription at all — means
 * the frame is the only thing left reading this agent, which is the state the
 * roster row is styled to warn about.
 */
export function isAgentSourceDegraded(
  source: AgentEventSourceView | null | undefined
): boolean {
  if (!source) return false;
  return !(source.kind === 'sse' && source.liveness === 'live');
}

/**
 * How many tokens are rendered, in the agent's own compact form (#2042).
 *
 * `8.5K`, not `8,508`, because that is what the surface being matched shows:
 * opencode's footer reads `8.5K (1%)` and this chip sits in the same role on a
 * row with the same width problem. The exact count is in the tooltip, where
 * there is room for it — see {@link formatAgentSessionTooltip}.
 *
 * @param tokens - A token count, or null
 * @param locale - BCP-47 tag; `undefined` takes the runtime's own
 */
export function formatAgentTokenCount(
  tokens: number | null | undefined,
  locale?: string
): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return null;
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(tokens);
}

/**
 * What a session has cost, formatted the way the agent formats it (#2042).
 *
 * USD with two decimals, which is not this app choosing a currency: it is
 * opencode's own `Intl.NumberFormat("en-US", { style: "currency", currency:
 * "USD" })`, transcribed so the chip and the agent's own footer print the same
 * string for the same session. `cost` is the agent's raw number and only
 * opencode publishes one today; a tool that later reports a cost in some other
 * unit would need this to learn about the unit, not to guess harder.
 *
 * @param cost - The agent's own number, or null
 * @param locale - BCP-47 tag for grouping/decimal marks; the currency is fixed
 * @param fractionDigits - Raised to 4 for the tooltip, where `$0.0346` is the
 *   value `opencode stats` prints and `$0.03` is not
 */
export function formatAgentSessionCost(
  cost: number | null | undefined,
  locale?: string,
  fractionDigits = 2
): string | null {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(cost);
}

/**
 * The visible `cost · tokens (percent)` chip, or null (Issue #2042).
 *
 * Null — render nothing — whenever the agent has published neither a cost nor a
 * context measurement, which is every session of every tool but opencode and
 * every opencode pane that has not finished a turn. That is the same rule
 * {@link formatAgentModelLabel} follows and the reason both return null instead
 * of an "unknown" string: an unknown badge on every claude and codex pane would
 * be noise on the busiest row of the screen.
 *
 * **The token count is the context one, not the session one.** They are
 * different quantities — see `types/agent-session`'s
 * {@link AgentSessionContextView} — and this chip is the one that has to line up
 * with opencode's own footer, so it shows what the footer shows. The session's
 * cumulative spend is in the tooltip, labelled as such.
 *
 * @param session - `structuredEvents.session`, or null
 * @param context - `structuredEvents.sessionContext`, or null
 * @param t - The `worktree` namespace translator
 * @param locale - BCP-47 tag for the number formats
 */
export function formatAgentSessionUsage(
  session: AgentSessionView | null | undefined,
  context: AgentSessionContextView | null | undefined,
  t: (key: string, values?: Record<string, string | number>) => string,
  locale?: string
): string | null {
  const cost = formatAgentSessionCost(session?.cost, locale);
  const tokens = formatAgentTokenCount(context?.tokens, locale);
  const segments: string[] = [];
  if (cost) segments.push(cost);
  if (tokens) {
    segments.push(
      typeof context?.percent === 'number'
        ? t('agentSession.context', { tokens, percent: context.percent })
        : tokens
    );
  }
  return segments.length > 0 ? segments.join(' · ') : null;
}

/**
 * The long form, for the `title` / accessible name (Issue #2042).
 *
 * Everything the chip had no room for, one fact per line: the session's own
 * title, which persona is driving, the cost at four decimal places (the
 * precision `opencode stats` prints, where the chip's two would read `$0.00` for
 * a whole afternoon of cheap turns), what the session has spent in total, and
 * how full the window is.
 *
 * The two token lines are deliberately both here and deliberately worded
 * differently. "Spent this session" is cumulative and is what `opencode stats`
 * reports; "Context in use" is the last finished turn's footprint and is what
 * the agent's footer shows. Reading one as the other is the mistake this Issue
 * was one summation away from shipping.
 *
 * @returns A newline-joined description, or null when nothing is known
 */
export function formatAgentSessionTooltip(
  session: AgentSessionView | null | undefined,
  context: AgentSessionContextView | null | undefined,
  t: (key: string, values?: Record<string, string | number>) => string,
  locale?: string
): string | null {
  const lines: string[] = [];
  if (session?.title) lines.push(t('agentSession.titleLabel', { title: session.title }));
  if (session?.agent) lines.push(t('agentSession.agentLabel', { agent: session.agent }));
  const cost = formatAgentSessionCost(session?.cost, locale, 4);
  if (cost) lines.push(t('agentSession.costLabel', { cost }));
  const spent = sumAgentSessionTokens(session?.tokens);
  if (spent !== null) {
    lines.push(
      t('agentSession.spentLabel', {
        tokens: new Intl.NumberFormat(locale).format(spent),
      })
    );
  }
  if (typeof context?.tokens === 'number') {
    const used = new Intl.NumberFormat(locale).format(context.tokens);
    lines.push(
      typeof context.limit === 'number' && typeof context.percent === 'number'
        ? t('agentSession.contextLabel', {
            tokens: used,
            limit: new Intl.NumberFormat(locale).format(context.limit),
            percent: context.percent,
          })
        : t('agentSession.contextUnknownLabel', { tokens: used })
    );
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Project `sessionStatusByInstance` down to instanceId -> display label
 * (Issue #1783, extended with effort in #1784).
 *
 * The roster panes take a plain lookup rather than the status payload, so this
 * is where the shape is dropped. Instances that reported no model are left out
 * entirely instead of mapped to null, so a caller's `?? null` and a caller's
 * `if (model)` agree — and so the object stays empty, not full of nulls, on the
 * common case of a worktree whose tools have no hooks configured.
 *
 * @param byInstance - `worktree.sessionStatusByInstance`, or undefined
 * @returns A frozen-in-spirit lookup; empty when nothing has reported a model
 */
export function buildModelByInstance(
  byInstance: Worktree['sessionStatusByInstance']
): Readonly<Record<string, string>> {
  if (!byInstance) return {};
  const models: Record<string, string> = {};
  for (const [instanceId, status] of Object.entries(byInstance)) {
    const label = formatAgentModelLabel(status?.model, status?.reasoningEffort);
    if (label) models[instanceId] = label;
  }
  return models;
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
  const tWorktree = useTranslations('worktree');
  const tCommon = useTranslations('common');

  // Two INDEPENDENT confirmations (Issue #2180, previously `pathTimerRef` /
  // `repoPathTimerRef` here): one timer each, so copying the repository path
  // does not cut the worktree path confirmation short.
  const { copied: pathCopied, markCopied: markPathCopied } = useCopyFeedback();
  const { copied: repoPathCopied, markCopied: markRepoPathCopied } = useCopyFeedback();

  const handleCopyPath = useCallback(async () => {
    try {
      await copyToClipboard(worktree.path);
      markPathCopied();
    } catch {
      // Silent failure
    }
  }, [worktree.path, markPathCopied]);

  const handleCopyRepoPath = useCallback(async () => {
    try {
      await copyToClipboard(worktree.repositoryPath);
      markRepoPathCopied();
    } catch {
      // Silent failure
    }
  }, [worktree.repositoryPath, markRepoPathCopied]);

  return (
    <>
      {/* Worktree Name */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-muted-foreground mb-1">{tWorktree('detail.worktree')}</h2>
        <p className="text-lg font-semibold text-foreground">{worktree.name}</p>
      </div>

      {/* Repository Info */}
      <div className={cardClassName}>
        <div className="flex items-center gap-1.5 mb-1">
          <h2 className="text-sm font-medium text-muted-foreground">{tWorktree('detail.repository')}</h2>
          <Button
            variant="ghost"
            type="button"
            onClick={handleCopyRepoPath}
            className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label={tWorktree('detail.copyRepositoryPath')}
            title={repoPathCopied ? tWorktree('detail.copied') : tWorktree('detail.copyRepositoryPath')}
          >
            {repoPathCopied ? (
              <Check className="w-3.5 h-3.5 text-success" />
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
          <h2 className="text-sm font-medium text-muted-foreground">{tWorktree('detail.path')}</h2>
          <Button
            variant="ghost"
            type="button"
            onClick={handleCopyPath}
            className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label={tWorktree('detail.copyWorktreePath')}
            title={pathCopied ? tWorktree('detail.copied') : tWorktree('detail.copyPath')}
          >
            {pathCopied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <ClipboardCopy className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
        <p className="text-sm text-foreground break-all font-mono">{worktree.path}</p>
      </div>

      {/* Status - dropdown for mobile */}
      <div className={cardClassName}>
        <h2 className="text-sm font-medium text-muted-foreground mb-1">{tWorktree('detail.status')}</h2>
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
          aria-label={tWorktree('detail.worktreeStatusLabel')}
        >
          {WORKTREE_STATUS_OPTIONS.map((opt) => (
            <option key={opt.labelKey} value={opt.value ?? ''}>
              {tWorktree(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {/* Description - Editable */}
      <div className={cardClassName}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-muted-foreground">{tWorktree('detail.description')}</h2>
          {!isEditing && (
            /* Issue #1061: borderless text-link — Button base padding/hover-lift would distort the inline link — 残置 */
            <button
              type="button"
              onClick={startEditing}
              className="text-sm text-accent-600 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-300"
            >
              {tWorktree('actions.edit')}
            </button>
          )}
        </div>
        {isEditing ? (
          <div className="space-y-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={tWorktree('detail.addNotesPlaceholder')}
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
                {isSaving ? tWorktree('actions.saving') : tWorktree('actions.save')}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-border disabled:opacity-50 text-sm font-medium"
              >
                {tCommon('cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-h-[50px]">
            {worktree.description ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">{worktree.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">{tWorktree('detail.noDescription')}</p>
            )}
          </div>
        )}
      </div>

      {/* Link */}
      {worktree.link && (
        <div className={cardClassName}>
          <h2 className="text-sm font-medium text-muted-foreground mb-1">{tWorktree('detail.link')}</h2>
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
          <h2 className="text-sm font-medium text-muted-foreground mb-1">{tWorktree('detail.lastUpdated')}</h2>
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
          <h2 className="text-sm font-medium text-muted-foreground">{tWorktree('detail.logs')}</h2>
          {/* Issue #1061: borderless text-link — Button base padding/hover-lift would distort the inline link — 残置 */}
          <button
            type="button"
            onClick={onToggleLogs}
            className="text-sm text-accent-600 hover:text-accent-800"
          >
            {showLogs ? tWorktree('detail.hide') : tWorktree('detail.show')}
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
  /**
   * Issue #1816: the task-contract / verification status chip, rendered next to
   * the branch title. A slot rather than the chip itself so this module keeps
   * no dependency on the verification client — the parent already owns that
   * state and can hand the built node down. Omitted (or `null`) renders
   * nothing, which is what every worktree without a task row gets.
   */
  verificationChip?: React.ReactNode;
  /**
   * What each instance's agent says about the session it is in (Issue #2042).
   *
   * Keyed by instanceId, and sparse on purpose: the only path this data takes
   * to the browser is a terminal pane's own `current-output` poll, so an
   * instance in the roster with no open split has no entry, and every tool but
   * opencode has none either. Absent renders exactly what pre-#2042 rendered.
   *
   * **Tooltip only, like the model before it.** This row is width-budgeted —
   * `MAX_HEADER_AGENT_PILLS` caps the labelled pills and the rest fold into
   * "+N" — so a second visible string per pill would push a working instance
   * into the overflow menu to make room for a cost nobody is scanning for. The
   * visible chip lives on the split pane's own header, which has the width.
   */
  agentSessionByInstance?: Readonly<Record<string, AgentSessionSnapshot>>;
}

/** Status indicator configuration is imported from @/config/status-colors (SF1) */

/**
 * Issue #1078: max labelled agent pills kept inline in the desktop header before
 * the rest collapse into the "+N" overflow menu. Idle/ready instances always
 * render as narrow icon-only dots and never count against this budget.
 *
 * Issue #2481: a ceiling, not the budget itself — a header too narrow for this
 * many keeps fewer (see {@link useDesktopHeaderFit}).
 */
const MAX_HEADER_AGENT_PILLS = 4;

/** What the desktop header can afford at its current width (Issue #2481). */
interface DesktopHeaderFit {
  /** Labelled agent pills kept inline; the rest fold into the "+N" menu. */
  pillBudget: number;
  /**
   * The last resort, once there is no labelled pill left to fold: the identity
   * group and the agent row clip horizontally instead of painting under the
   * right-hand controls.
   */
  squeezed: boolean;
}

/**
 * Whether anything in the desktop header's identity group is wider than its box
 * (Issue #2481).
 *
 * The group's own overflow catches content pushed past its edge. The walk
 * catches content that collides inside it without widening anything: the
 * verification chip squeezed below its badges paints them over its own ⓘ
 * toggle, and the chip is a slot this module does not look into. Elements that
 * clip (the `truncate` spans) are wider than their box by design and skipped.
 */
function identityOverflows(identity: HTMLElement): boolean {
  if (identity.scrollWidth > identity.clientWidth + 1) return true;
  for (const el of Array.from(identity.querySelectorAll('*'))) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (getComputedStyle(el).overflowX !== 'visible') continue;
    return true;
  }
  return false;
}

/**
 * Fits the desktop header's one row to its width (Issue #2481).
 *
 * At 1470px with the sidebar open, identity (name, branch, verification chip)
 * plus the agent pills and controls no longer fit, and the header's parent is
 * `overflow-hidden` — so the right end (display size, Info) was cut off with no
 * way to scroll to it. The layout now decides who gives way: the controls group
 * never shrinks, the identity group (`min-w-0`) takes what is left and
 * truncates. This hook handles the point where truncating is not enough — the
 * identity group's content is wider than its box — by folding one more
 * labelled pill into the existing "+N" menu (#1078) and measuring again, down
 * to zero pills and then {@link DesktopHeaderFit.squeezed}.
 *
 * The measurement runs in a layout effect, whose state updates re-render before
 * the browser paints, so the intermediate steps are never seen. Folding only
 * goes one way, so the fit restarts from the ceiling whenever there may be room
 * again: the header got wider or narrower (a ResizeObserver — opening the
 * sidebar resizes the header without resizing the window), or `contentKey`
 * changed (an instance went idle, a label or the branch changed).
 *
 * @param headerRef - The header row, observed for size changes
 * @param identityRef - The left group; its overflow is the "does not fit" signal
 * @param contentKey - What, besides the budget, changes the row's widths
 * @param labelledCount - Instances that want a labelled pill (active or working)
 * @param unkeyedContent - Content whose width `contentKey` cannot capture (the
 *   verification chip node): a new value re-measures without restarting, so a
 *   chip that grows folds a pill and one that shrinks waits for the next resize
 */
function useDesktopHeaderFit(
  headerRef: React.RefObject<HTMLDivElement | null>,
  identityRef: React.RefObject<HTMLDivElement | null>,
  contentKey: string,
  labelledCount: number,
  unkeyedContent: unknown
): DesktopHeaderFit {
  const [fit, setFit] = useState(() => ({
    key: contentKey,
    pillBudget: MAX_HEADER_AGENT_PILLS,
    squeezed: false,
  }));

  // Reset while rendering (React's "adjust state when a prop changes"
  // pattern), not in an effect: an effect would run after the step below in
  // the same commit and be overwritten by it.
  let current = fit;
  if (fit.key !== contentKey) {
    current = { key: contentKey, pillBudget: MAX_HEADER_AGENT_PILLS, squeezed: false };
    setFit(current);
  }

  // While the identity group's content overflows, give up one more step.
  // Every step is a new `fit`, so this re-runs until the row fits or is
  // squeezed; a step never undoes one, so the chain ends.
  useLayoutEffect(() => {
    const identity = identityRef.current;
    if (!identity || fit.squeezed || !identityOverflows(identity)) return;
    setFit((prev) => {
      if (prev.squeezed) return prev;
      const shown = Math.min(prev.pillBudget, labelledCount);
      return shown > 0 ? { ...prev, pillBudget: shown - 1 } : { ...prev, squeezed: true };
    });
  }, [identityRef, fit, labelledCount, unkeyedContent]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === 'undefined') return;
    let lastWidth: number | null = null;
    let lastHeight: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const widthChanged = rect.width !== lastWidth;
      if (!widthChanged && rect.height === lastHeight) return;
      lastWidth = rect.width;
      lastHeight = rect.height;
      // A new width may hold more: start again from the ceiling. The header's
      // width comes from its parent, never from this row, so this cannot feed
      // back into itself. A height-only change (display size) is only
      // re-checked — a fresh object re-renders, and the step above can only
      // fold further, so it cannot oscillate either.
      setFit((prev) =>
        widthChanged
          ? { key: prev.key, pillBudget: MAX_HEADER_AGENT_PILLS, squeezed: false }
          : { ...prev }
      );
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [headerRef]);

  return { pillBudget: current.pillBudget, squeezed: current.squeezed };
}

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
  verificationChip,
  agentSessionByInstance,
}: DesktopHeaderProps) {
  const tWorktree = useTranslations('worktree');
  const locale = useLocale();
  // Issue #1277: agent-instance status labels resolve through the generic
  // `common.status.*` keys (defined by #1273), so the wording has a single
  // source of truth. The config keeps owning the color/type mapping.
  const tCommon = useTranslations('common');
  // Issue #1304: the worktree-level dot shows a long-form description
  // ("Idle - No active session"). `error` has no entry — its label is the
  // generic `common.status.error`, which StatusDot resolves itself when `label`
  // is omitted, so we pass undefined rather than duplicating that wording.
  const statusLabelKey = DESKTOP_STATUS_LABEL_KEYS[status];
  const statusLabel = statusLabelKey ? tWorktree(statusLabelKey) : undefined;
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

  // Issue #875: resolve each instance's status from the per-instance map so
  // alias instances (instanceId !== cliToolId) show their own status; fall back
  // to the per-CLI map for backward compat. Resolved up here rather than inside
  // the row (Issue #2481) because the width fit below needs the same facts.
  const headerItems: HeaderInstanceItem<AgentInstance>[] = (instances ?? []).map((inst) => ({
    item: inst,
    status: deriveCliStatus(
      sessionStatusByInstance?.[inst.id] ?? sessionStatusByCli?.[inst.cliTool]
    ),
    isActive: inst.id === activeInstanceId,
  }));

  // Issue #1787 acceptance 4: the detail header is the third surface
  // that has to say "an agent here is done and wants work", alongside
  // the sidebar row and the WorktreeCard. It was missed when #1787
  // landed because this file sat outside that Issue's scope.
  //
  // ONE badge for the whole row, not one per pill, which is the same
  // granularity `BranchListItem` shows (`branch.awaitingInstruction` is
  // already the fold across every instance — see
  // `deriveWorktreeWaitingDetail`). It is also the only granularity this
  // row can afford: it is width-budgeted by MAX_HEADER_AGENT_PILLS, and
  // a per-pill string would push working instances into the "+N"
  // overflow to make room — the very trade-off #1783 refused when it
  // put the model in the tooltip instead. Rendered AFTER the overflow
  // trigger so it takes nothing from the pill budget, and nothing that
  // was here before is removed.
  //
  // Resolved per instance with the same per-instance → per-CLI fallback
  // the status dots use, so an alias instance is not read off a roster
  // entry that has no status of its own.
  const awaitingInstruction = (instances ?? []).some(
    (inst) =>
      (sessionStatusByInstance?.[inst.id] ?? sessionStatusByCli?.[inst.cliTool])
        ?.awaitingInstruction === true
  );

  const showKillButton = Boolean(onKillSession) && activeInstanceRunning;

  // Issue #2481: everything, besides the pill budget itself, that changes how
  // wide the row is. A change here may have made room, so the fit restarts
  // from MAX_HEADER_AGENT_PILLS. The verification chip is a node and cannot be
  // keyed; a chip that grows still folds a pill (the fit re-measures on every
  // commit), a chip that shrinks gets the room back on the next resize.
  const headerFitKey = [
    locale,
    worktreeName,
    repositoryName,
    truncatedDescription ?? '',
    gitStatus?.currentBranch ?? '',
    gitStatus?.isDirty ? 'dirty' : '',
    showKillButton ? 'end' : '',
    awaitingInstruction ? 'awaiting' : '',
    ...headerItems.map(
      (it) => `${it.item.id}:${getInstanceLabel(it.item)}:${it.status}:${it.isActive ? 'active' : ''}`
    ),
  ].join('\n');
  const headerRef = useRef<HTMLDivElement>(null);
  const identityRef = useRef<HTMLDivElement>(null);
  const headerFit = useDesktopHeaderFit(
    headerRef,
    identityRef,
    headerFitKey,
    headerItems.filter(isLabeledInstance).length,
    verificationChip
  );

  return (
    <div
      ref={headerRef}
      data-testid="desktop-header"
      className="flex items-center justify-between gap-3 px-4 py-3 bg-surface border-b border-border"
    >
      {/* Left: Back button and title (Issue #747: hamburger moved to ActivityBar).
          Issue #2481: `min-w-0` makes this group — not the controls on the
          right — the one that gives way on a narrow header: the name, branch
          and chip title truncate. The back link, divider and dot keep their
          width. Clipped only as the fit's last resort, because the chip's
          reason popover hangs out of this group and a clip would cut it. */}
      <div
        ref={identityRef}
        data-testid="desktop-header-identity"
        className={`flex items-center gap-3 min-w-0${headerFit.squeezed ? ' overflow-x-clip' : ''}`}
      >
        {/* Issue #1061: paddingless nav link — Button base px-4 py-2 would enlarge/misalign the header back control — 残置 */}
        <button
          type="button"
          onClick={onBackClick}
          className="flex flex-shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={tWorktree('detail.goBack')}
          data-testid="worktree-back-button"
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
          <span className="text-sm font-medium">{tWorktree('detail.home')}</span>
        </button>
        <div className="w-px h-6 flex-shrink-0 bg-border" aria-hidden="true" />
        {/* Worktree-level status (Issue #1078: unified StatusDot visual language) */}
        <StatusDot
          data-testid="desktop-status-indicator"
          status={status}
          size="lg"
          label={statusLabel}
        />
        {/* Worktree name, memo, and repository. Issue #2481: gives way before
            the verification chip on a narrow header (`shrink-4` against the
            chip's 1), down to a floor that keeps the start of the name
            readable. A whole-number factor on purpose — see the chip below. */}
        <div className="flex flex-col min-w-[6rem] shrink-4">
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
                  <span className="text-warning" title={tWorktree('git.uncommittedChanges')}>*</span>
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
        {/* Issue #1816: task contract / verification verdict, next to the branch
            identity it belongs to. `min-w-0` so a long task title truncates
            instead of pushing the right-hand controls off the header.
            Issue #2481: the name column gives way before it, because the chip's
            badges cannot truncate and, once it is down to them, the header has
            to fold an agent pill. Two flexbox rules shape this. The 360px cap
            is a `w-*` capped by `max-w-max` rather than a `max-w-*`, because an
            item that hits its max-width is frozen there — a long task title
            stayed 360px while the name truncated to nothing. And the name gets
            the larger factor rather than the chip a fractional one, because
            items whose factors sum below 1 absorb only that fraction of the
            overflow: at `shrink-[0.25]` the chip, left alone to shrink once the
            name hit its floor, stopped 70px short. Same width as before
            whenever the row fits. */}
        {verificationChip && (
          <div className="min-w-0 w-[360px] max-w-max">{verificationChip}</div>
        )}
      </div>

      {/* Right: Per-agent status row + Status dropdown + Info button.
          Issue #2481: never shrinks, so the controls always keep their width;
          room is made by the fit folding agent pills instead. `max-w-full` only
          matters on a header too narrow even for this group alone: it caps the
          group at the header's width and the agent row (`min-w-0`) yields. */}
      <div className="flex items-center gap-2 flex-shrink-0 max-w-full" data-testid="desktop-header-controls">
        {/* Issue #749/#869/#1078: Per-instance session status row (PC only).
            Distinct from the worktree-level StatusDot on the left: this row is
            per-agent-instance and doubles as an instance-tab switcher. Issue #1078
            unifies the status visual on <StatusDot> and collapses idle noise —
            active/working instances stay labelled pills, idle/ready collapse to
            icon-only dots (label via Tooltip), and pills beyond the budget fold
            into a "+N" overflow menu so a working session never gets buried.
            Issue #2481: the budget is what the header's width affords, capped
            at MAX_HEADER_AGENT_PILLS (useDesktopHeaderFit).
            Rendered only when instances is provided (backward compat). */}
        {instances && instances.length > 0 && (() => {
          const classified = classifyHeaderInstances(headerItems, headerFit.pillBudget);
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
            <div
              className={`flex items-center gap-2 min-w-0${headerFit.squeezed ? ' overflow-x-clip' : ''}`}
              data-testid="desktop-agent-status-row"
            >
              {classified.map((c) => {
                if (c.slot === 'overflow') return null;
                const inst = c.item;
                const label = getInstanceLabel(inst);
                const fullLabel = tWorktree('detail.statusPill', {
                  label,
                  status: tCommon(`status.${c.status}`),
                });
                // Issue #1783: tooltip-only, on purpose. This row is
                // width-budgeted — MAX_HEADER_AGENT_PILLS caps the labelled
                // pills and the rest fold into "+N" — so adding a second
                // visible string per pill would push working instances into the
                // overflow menu to make room for text nobody is scanning for.
                // The model rides on the existing hover/`title` affordance
                // instead, and the visible pill text is unchanged. `null` (no
                // hooks, no model) leaves the label byte-identical to pre-#1783.
                // Issue #1784 appends "· <effort>" here too; the pill's visible
                // text is still untouched, so the width budget above is unmoved.
                const instanceStatus = sessionStatusByInstance?.[inst.id];
                // Issue #2042: the same tooltip, with the persona in front of
                // the model when the agent named one. Only opencode does, so
                // every other pill's string is byte-identical to pre-#2042.
                const instanceSession = agentSessionByInstance?.[inst.id];
                const instanceModel = formatAgentModelLabel(
                  instanceStatus?.model,
                  instanceStatus?.reasoningEffort,
                  instanceSession?.session?.agent
                );
                const baseLabel = instanceModel
                  ? tWorktree('detail.statusPillWithModel', {
                      label,
                      status: tCommon(`status.${c.status}`),
                      model: instanceModel,
                    })
                  : fullLabel;
                // Issue #2042: cost / context ride on the tooltip for the reason
                // #1783 put the model there — the visible pill text is still
                // untouched, so MAX_HEADER_AGENT_PILLS's width budget is unmoved.
                const instanceUsage = formatAgentSessionUsage(
                  instanceSession?.session,
                  instanceSession?.context,
                  tWorktree,
                  locale
                );
                const usageLabel = instanceUsage
                  ? tWorktree('detail.statusPillWithUsage', {
                      base: baseLabel,
                      usage: instanceUsage,
                    })
                  : baseLabel;
                // Issue #2054: what is reading this pane, appended to the same
                // hover/`title` affordance #1783 chose over row width — and for
                // the same reason: MAX_HEADER_AGENT_PILLS's budget is unmoved,
                // so nothing is pushed into the "+N" overflow to make room. Null
                // for every tool whose source cannot be degraded, which leaves
                // the claude / codex pill strings byte-identical to pre-#2054
                // (`DesktopHeader-source-2054.test.tsx` pins that).
                const sourceLabel = formatAgentSourceLabel(
                  instanceStatus?.eventSource,
                  tWorktree
                );
                const labelWithModel = sourceLabel
                  ? tWorktree('detail.statusPillWithSource', {
                      base: usageLabel,
                      source: sourceLabel,
                    })
                  : usageLabel;
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
                      aria-label={labelWithModel}
                      // Issue #1783: native tooltip so the model is reachable
                      // without spending row width. Same string as the
                      // accessible name, so hover and screen reader agree.
                      title={labelWithModel}
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
                  /* Issue #1783: the idle/ready variant already had a tooltip;
                     it now carries the model too when one is known. */
                  <Tooltip key={inst.id} content={labelWithModel} placement="bottom">
                    {/* Issue #1061: draggable instance-tab switcher (aria-pressed) — 残置 */}
                    <button
                      type="button"
                      data-testid={`desktop-agent-status-${inst.id}`}
                      onClick={() => onActiveInstanceChange?.(inst.id)}
                      {...dragProps}
                      // No `title` here: the <Tooltip> above already renders
                      // this string, and a native tooltip would stack on it.
                      aria-label={labelWithModel}
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
                      const fullLabel = tWorktree('detail.statusPill', {
                        label: getInstanceLabel(inst),
                        status: tCommon(`status.${c.status}`),
                      });
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

              {/*
                Issue #1787: `awaitingInstruction` (the agent said its turn is
                over) is a SECONDARY state deliberately styled `success` green,
                so it can never be read as the amber "needs your answer" case
                the StatusDots above own. Same tokens, same wording and the same
                two dictionary keys as the sidebar badge — two surfaces showing
                one state must not look like two different states.
              */}
              {awaitingInstruction && (
                <span
                  data-testid="desktop-awaiting-instruction-badge"
                  className="flex-shrink-0 rounded-full bg-success-subtle px-1.5 py-0.5 text-[10px] font-medium leading-4 text-success-foreground"
                  title={tWorktree('awaitingInstruction.label')}
                >
                  {tWorktree('awaitingInstruction.badge')}
                </span>
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
        {showKillButton && (
          <Button
            variant="ghost"
            type="button"
            onClick={onKillSession}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg text-danger-foreground hover:bg-danger-subtle transition-colors flex-shrink-0"
            aria-label={tWorktree('terminal.endSession')}
            data-testid="desktop-kill-session"
          >
            <span aria-hidden="true">&#x2715;</span>
            {tCommon('end')}
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
            className="flex-shrink-0 text-xs px-2 py-1.5 rounded-lg border border-input bg-surface text-foreground focus:ring-2 focus:ring-ring focus:border-transparent cursor-pointer"
            data-testid="desktop-status-dropdown"
            aria-label={tWorktree('detail.worktreeStatusLabel')}
          >
            {WORKTREE_STATUS_OPTIONS.map((opt) => (
              <option key={opt.labelKey} value={opt.value ?? ''}>
                {tWorktree(opt.labelKey)}
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
        className="relative flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
        aria-label={tWorktree('detail.viewInfo')}
        data-testid="desktop-info-button"
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
        <span className="text-sm font-medium">{tWorktree('detail.info')}</span>
        {hasUpdate && (
          <NotificationDot
            data-testid="info-update-indicator"
            className="absolute top-0 right-0"
            aria-label={tWorktree('tabs.updateAvailable')}
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
  const tWorktree = useTranslations('worktree');

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
    <Modal isOpen={isOpen} onClose={onClose} title={tWorktree('detail.infoModalTitle')} size="md">
      {/* Issue #1277: stable hook for the E2E spec — the modal heading text is
          now localized, so tests must not select it by its English wording. */}
      <div className="space-y-4 max-h-[70vh] overflow-y-auto" data-testid="worktree-info-modal">
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
  const tWorktree = useTranslations('worktree');
  return (
    <div
      className="flex items-center justify-center h-full min-h-[200px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <Spinner size="xl" variant="accent" />
        <p className="text-muted-foreground">{tWorktree('detail.loading')}</p>
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
  const tWorktree = useTranslations('worktree');
  const tCommon = useTranslations('common');
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
        <p className="text-danger-foreground font-medium">{tWorktree('detail.errorLoading')}</p>
        <p className="text-danger-foreground/80 text-sm mt-2">{message}</p>
        {onRetry && (
          <Button
            variant="ghost"
            type="button"
            onClick={onRetry}
            className="mt-4 px-4 py-2 bg-danger-foreground text-danger-subtle rounded-lg hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2 ring-offset-background"
          >
            {tCommon('retry')}
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

