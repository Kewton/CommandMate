/**
 * SkillTargetSelector (Issue #1233)
 *
 * Picks the one registered worktree an Install Plan will be built for. Exactly
 * one, deliberately: a Skill lands in a specific repository on a specific
 * branch, and offering a multi-select would invite the user to approve a change
 * they cannot see the diff for (UX-02).
 *
 * The identity of a target is shown in full — repository, branch, agents and
 * working tree state — because "which checkout am I about to modify?" is the
 * question a misplaced install answers too late. The branch shown here comes
 * from the last worktree sync and is labelled as such; the authoritative live
 * branch and HEAD are resolved server-side when the plan is built, which is
 * also where a mismatch is reported (UX-07).
 *
 * No filesystem path is rendered or submitted. The component hands back a
 * worktree ID and nothing else.
 *
 * @module components/skills/SkillTargetSelector
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import type { Worktree } from '@/types/models';
import { SkillNotice } from './SkillNotice';

/** A worktree reduced to what choosing an install target requires. */
export interface SkillTargetOption {
  id: string;
  name: string;
  repositoryName: string;
  /** Branch from the last worktree sync, or null when it was never recorded. */
  syncedBranch: string | null;
  /** Live branch, when the row carried a git status. */
  liveBranch: string | null;
  /** Live working tree has uncommitted changes; null when unknown. */
  dirty: boolean | null;
  /** Agents configured for this worktree. */
  agents: string[];
  sessionRunning: boolean;
}

/**
 * Reduce an API worktree row to a target option.
 *
 * The list endpoint does not carry a git status, so `liveBranch` and `dirty`
 * are frequently null. They are kept as tri-state rather than defaulted,
 * because rendering "clean" for a worktree nobody inspected would be a claim
 * the UI cannot support.
 */
export function toSkillTargetOption(worktree: Worktree): SkillTargetOption {
  const agents =
    worktree.agentInstances && worktree.agentInstances.length > 0
      ? worktree.agentInstances.map((instance) => instance.alias || instance.cliTool)
      : (worktree.selectedAgents ?? (worktree.cliToolId ? [worktree.cliToolId] : []));

  return {
    id: worktree.id,
    name: worktree.name,
    repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
    syncedBranch: worktree.branch ?? null,
    liveBranch: worktree.gitStatus?.currentBranch ?? null,
    dirty: worktree.gitStatus ? worktree.gitStatus.isDirty : null,
    agents: [...new Set(agents)],
    sessionRunning: worktree.isSessionRunning === true,
  };
}

interface SelectorState {
  status: 'loading' | 'loaded' | 'error';
  options: SkillTargetOption[];
}

const INITIAL_STATE: SelectorState = { status: 'loading', options: [] };

async function loadTargets(signal: AbortSignal): Promise<SkillTargetOption[]> {
  const response = await fetch('/api/worktrees', {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  const worktrees = (body as { worktrees?: Worktree[] } | null)?.worktrees;
  if (!Array.isArray(worktrees)) throw new Error('Malformed worktree list');
  return worktrees.map(toSkillTargetOption);
}

export interface SkillTargetSelectorProps {
  /** Currently selected worktree ID, or null when nothing is chosen yet. */
  selectedWorktreeId: string | null;
  onSelect: (worktreeId: string) => void;
  /** Disable every option, e.g. while a plan is being built. */
  disabled?: boolean;
}

export function SkillTargetSelector({
  selectedWorktreeId,
  onSelect,
  disabled = false,
}: SkillTargetSelectorProps) {
  const t = useTranslations('skills');
  const [state, setState] = useState<SelectorState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL_STATE);

    loadTargets(controller.signal)
      .then((options) => {
        if (controller.signal.aborted) return;
        setState({ status: 'loaded', options });
      })
      .catch(() => {
        // An abort has no outcome to render; anything else is a load failure.
        if (!controller.signal.aborted) setState({ status: 'error', options: [] });
      });

    return () => controller.abort();
  }, [reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  if (state.status === 'loading') {
    return (
      <div className="space-y-2" data-testid="skill-target-loading">
        <p className="text-sm text-muted-foreground">{t('target.loading')}</p>
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Card className="space-y-3" data-testid="skill-target-error">
        <SkillNotice tone="danger">{t('target.errorNotice')}</SkillNotice>
        <Button variant="secondary" size="sm" onClick={retry} data-testid="skill-target-retry">
          {t('target.retry')}
        </Button>
      </Card>
    );
  }

  if (state.options.length === 0) {
    return (
      <Card data-testid="skill-target-empty">
        <p className="text-sm text-muted-foreground">{t('target.empty')}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="skill-target-selector">
      <div
        role="radiogroup"
        aria-label={t('target.heading')}
        className="space-y-2"
      >
        {state.options.map((option) => (
          <TargetRow
            key={option.id}
            option={option}
            selected={option.id === selectedWorktreeId}
            disabled={disabled}
            onSelect={onSelect}
          />
        ))}
      </div>
      <SkillNotice tone="neutral" data-testid="skill-target-branch-notice">
        {t('target.branchFreshnessNotice')}
      </SkillNotice>
    </div>
  );
}

function TargetRow({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: SkillTargetOption;
  selected: boolean;
  disabled: boolean;
  onSelect: (worktreeId: string) => void;
}) {
  const t = useTranslations('skills');
  const branch = option.liveBranch ?? option.syncedBranch;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(option.id)}
      data-testid={`skill-target-option-${option.id}`}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/40'
          : 'border-border bg-card hover:bg-muted'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground break-all">{option.name}</span>
        {selected && <Badge variant="info">{t('target.selected')}</Badge>}
      </div>

      <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <TargetField label={t('target.repository')}>{option.repositoryName}</TargetField>
        <TargetField label={t('target.branch')}>
          {branch ?? t('target.branchUnknown')}
        </TargetField>
        <TargetField label={t('target.agents')}>
          {option.agents.length > 0 ? option.agents.join(', ') : t('target.agentsNone')}
        </TargetField>
        <TargetField label={t('target.workingTree')}>
          {option.dirty === null
            ? t('target.workingTreeUnknown')
            : option.dirty
              ? t('target.workingTreeDirty')
              : t('target.workingTreeClean')}
        </TargetField>
      </dl>

      {option.sessionRunning && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid={`skill-target-session-${option.id}`}>
          {t('target.sessionRunning')}
        </p>
      )}
    </button>
  );
}

function TargetField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground break-words">{children}</dd>
    </div>
  );
}

export default SkillTargetSelector;
