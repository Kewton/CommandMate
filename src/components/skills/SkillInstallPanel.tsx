/**
 * Install and uninstall flow for one Skill (Issue #1431)
 *
 * Connects the pieces #1232/#1233 built but never wired together: pick a
 * worktree, build a plan, read what the plan says would happen, and only then
 * apply it. Nothing is written before the user has seen the preview, and the
 * apply request spends the plan token the preview was built from, so what is
 * approved and what is executed are the same plan.
 *
 * Two rules the flow does not bend:
 * - A high-risk package gets its own acknowledgement, separate from the ordinary
 *   confirm. The apply request is never sent without it, so the API's
 *   `SKILL_PLAN_RISK_NOT_ACKNOWLEDGED` refusal stays a backstop rather than the
 *   thing the user meets.
 * - Every refusal is reported with what the server said. A blocked plan is
 *   rendered, not swallowed: "nothing was written and here is what is in the
 *   way" is a different message from "install failed".
 *
 * @module components/skills/SkillInstallPanel
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Checkbox } from '@/components/ui';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import { dispatchSkillInstalled } from '@/lib/skill-events';
import { SkillNotice } from './SkillNotice';
import { SkillTargetSelector } from './SkillTargetSelector';
import { SkillInstallPlanPreview, SkillUninstallPlanPreview } from './SkillPlanPreview';
import { operationErrorLabelKey, resolveSkillMessageKey } from './skill-vocabulary';
import {
  applySkillInstall,
  applySkillUninstall,
  createSkillInstallPlan,
  createSkillUninstallPlan,
  type SkillFetchFailure,
} from './skills-client';
import type {
  SkillInstallApplyResponse,
  SkillInstallPlanDto,
  SkillUninstallApplyResponse,
  SkillUninstallPlanDto,
} from './types';

type Busy = 'install-plan' | 'install-apply' | 'uninstall-plan' | 'uninstall-apply' | null;

interface PanelState {
  worktreeId: string | null;
  busy: Busy;
  installPlan: SkillInstallPlanDto | null;
  uninstallPlan: SkillUninstallPlanDto | null;
  installResult: SkillInstallApplyResponse | null;
  uninstallResult: SkillUninstallApplyResponse | null;
  /** The user's explicit consent to a high-risk install, reset with the plan. */
  riskAcknowledged: boolean;
  failure: SkillFetchFailure | null;
}

const INITIAL_STATE: PanelState = {
  worktreeId: null,
  busy: null,
  installPlan: null,
  uninstallPlan: null,
  installResult: null,
  uninstallResult: null,
  riskAcknowledged: false,
  failure: null,
};

/** Everything a plan produced, cleared whenever a new operation starts. */
function clearOutcome(state: PanelState): PanelState {
  return {
    ...state,
    installPlan: null,
    uninstallPlan: null,
    installResult: null,
    uninstallResult: null,
    riskAcknowledged: false,
    failure: null,
  };
}

/**
 * Retry key for an apply.
 *
 * Derived from the plan token so retrying the same approved plan replays the
 * original operation instead of starting a second one. A fresh plan means a
 * fresh key, which is what makes a genuinely new install genuinely new.
 */
function idempotencyKey(prefix: string, token: string): string {
  return `${prefix}-${token}`;
}

function FailureNotice({ failure }: { failure: SkillFetchFailure }) {
  const t = useTranslations('skills');
  return (
    <div className="space-y-2" data-testid="skill-operation-error">
      <SkillNotice tone="danger">
        <p className="font-medium">{t('operation.errorHeading')}</p>
        <p className="mt-1">{t(operationErrorLabelKey(failure.code))}</p>
        <p className="mt-1 break-words">{t('state.errorCode', { code: failure.code })}</p>
      </SkillNotice>
      {failure.nextActionKey && (
        <SkillNotice tone="warning">{t(resolveSkillMessageKey(failure.nextActionKey))}</SkillNotice>
      )}
      {failure.blockers && failure.blockers.length > 0 && (
        <ul className="space-y-1" data-testid="skill-operation-error-blockers">
          {failure.blockers.map((blocker) => (
            <li
              key={`${blocker.code}:${blocker.path ?? ''}`}
              className="text-xs text-danger-foreground"
            >
              {blocker.path && <span className="mr-1 break-all font-mono">{blocker.path}</span>}
              {t(resolveSkillMessageKey(blocker.messageKey))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReloadGuidance({
  agents,
  skillId,
  version,
}: {
  agents: Array<{ agent: string; messageKey: string }>;
  skillId: string;
  version: string;
}) {
  const t = useTranslations('skills');
  if (agents.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="skill-operation-reload">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('operation.reloadHeading')}
      </h4>
      <ul className="space-y-1">
        {agents.map((agent) => (
          <li key={agent.agent} className="text-xs text-muted-foreground">
            {t(resolveSkillMessageKey(agent.messageKey), {
              agent: getCliToolDisplayNameSafe(agent.agent),
              skillId,
              version,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface SkillInstallPanelProps {
  skillId: string;
  /** Version to plan, or null when the Catalog offers none that applies here. */
  version: string | null;
  /**
   * Why the Catalog rules out installing, or null when it does not. Uninstall
   * stays available either way: a Skill that no longer runs here is exactly the
   * one a user needs to be able to remove.
   */
  blockedReason: string | null;
  /**
   * Issue #1441: when set, the panel installs into exactly this worktree and the
   * target picker is not rendered — the caller (e.g. the worktree detail Skills
   * pane) already knows which checkout it is acting on. When omitted the panel
   * keeps its original behavior and asks the user to pick a target.
   */
  worktreeId?: string;
}

export function SkillInstallPanel({
  skillId,
  version,
  blockedReason,
  worktreeId: fixedWorktreeId,
}: SkillInstallPanelProps) {
  const t = useTranslations('skills');
  const [state, setState] = useState<PanelState>(() =>
    fixedWorktreeId ? { ...INITIAL_STATE, worktreeId: fixedWorktreeId } : INITIAL_STATE
  );

  const selectTarget = useCallback((worktreeId: string) => {
    setState((current) =>
      current.worktreeId === worktreeId
        ? current
        : clearOutcome({ ...current, worktreeId, busy: null })
    );
  }, []);

  // Keep the fixed target in step if the caller swaps worktrees without
  // remounting. Guarded so it is a no-op once state already holds it (the
  // initializer set it on mount), which keeps the ordinary picker path — where
  // fixedWorktreeId is undefined — completely untouched.
  useEffect(() => {
    if (fixedWorktreeId) selectTarget(fixedWorktreeId);
  }, [fixedWorktreeId, selectTarget]);

  const buildInstallPlan = useCallback(async () => {
    const worktreeId = state.worktreeId;
    if (!worktreeId) return;
    setState((current) => ({ ...clearOutcome(current), busy: 'install-plan' }));

    const result = await createSkillInstallPlan(worktreeId, skillId, {
      version: version ?? undefined,
    });
    setState((current) => ({
      ...current,
      busy: null,
      installPlan: result.ok ? result.data.plan : null,
      failure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.worktreeId, version]);

  const confirmInstall = useCallback(async () => {
    const worktreeId = state.worktreeId;
    const plan = state.installPlan;
    if (!worktreeId || !plan) return;
    // The API refuses an unacknowledged high-risk apply, but the request must
    // not leave the browser in the first place.
    if (plan.requiresRiskAcknowledgement && !state.riskAcknowledged) return;

    setState((current) => ({ ...current, busy: 'install-apply', failure: null }));

    const result = await applySkillInstall(worktreeId, skillId, {
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: plan.requiresRiskAcknowledgement ? true : undefined,
      idempotencyKey: idempotencyKey('skill-install', plan.token),
    });
    // Issue #1477: the newly installed Skill is a new slash command. Tell any
    // palette showing this worktree to refetch, so the command appears without
    // a full page reload.
    if (result.ok) {
      dispatchSkillInstalled(worktreeId);
    }
    setState((current) => ({
      ...current,
      busy: null,
      installPlan: result.ok ? null : current.installPlan,
      installResult: result.ok ? result.data : null,
      failure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.installPlan, state.riskAcknowledged, state.worktreeId]);

  const buildUninstallPlan = useCallback(async () => {
    const worktreeId = state.worktreeId;
    if (!worktreeId) return;
    setState((current) => ({ ...clearOutcome(current), busy: 'uninstall-plan' }));

    const result = await createSkillUninstallPlan(worktreeId, skillId);
    setState((current) => ({
      ...current,
      busy: null,
      uninstallPlan: result.ok ? result.data.plan : null,
      failure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.worktreeId]);

  const confirmUninstall = useCallback(async () => {
    const worktreeId = state.worktreeId;
    const plan = state.uninstallPlan;
    if (!worktreeId || !plan) return;

    setState((current) => ({ ...current, busy: 'uninstall-apply', failure: null }));

    const result = await applySkillUninstall(worktreeId, skillId, {
      planToken: plan.token,
      idempotencyKey: idempotencyKey('skill-uninstall', plan.token),
    });
    setState((current) => ({
      ...current,
      busy: null,
      uninstallPlan: result.ok ? null : current.uninstallPlan,
      uninstallResult: result.ok ? result.data : null,
      failure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.uninstallPlan, state.worktreeId]);

  const discardPlan = useCallback(() => {
    setState((current) => clearOutcome(current));
  }, []);

  const busy = state.busy !== null;
  const installPlan = state.installPlan;
  const uninstallPlan = state.uninstallPlan;

  const planReason = blockedReason ?? (state.worktreeId ? t('plan.ready') : t('plan.chooseTarget'));
  const awaitingAcknowledgement =
    installPlan !== null && installPlan.requiresRiskAcknowledgement && !state.riskAcknowledged;

  return (
    <div className="space-y-3" data-testid="skill-install-panel">
      {/* Issue #1441: with a fixed worktreeId the caller has already chosen the
          target, so the picker is suppressed and the panel acts on that worktree
          directly. Without it, the original target-selection flow is preserved. */}
      {!fixedWorktreeId && (
        <SkillTargetSelector
          selectedWorktreeId={state.worktreeId}
          onSelect={selectTarget}
          disabled={busy}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || blockedReason !== null || !state.worktreeId}
          onClick={buildInstallPlan}
          data-testid="skill-install-action"
          aria-describedby="skill-install-reason"
        >
          {state.busy === 'install-plan' ? t('plan.building') : t('plan.build')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !state.worktreeId}
          onClick={buildUninstallPlan}
          data-testid="skill-uninstall-action"
        >
          {state.busy === 'uninstall-plan' ? t('uninstall.building') : t('uninstall.build')}
        </Button>
      </div>
      <p
        id="skill-install-reason"
        className="text-sm text-muted-foreground"
        data-testid="skill-install-reason"
      >
        {planReason}
      </p>

      {state.failure && <FailureNotice failure={state.failure} />}

      {installPlan && (
        <div className="space-y-3">
          <SkillInstallPlanPreview plan={installPlan} />

          {installPlan.requiresRiskAcknowledgement && (
            <Card className="space-y-3" data-testid="skill-install-risk-acknowledgement">
              <SkillNotice tone="danger">
                {t(
                  resolveSkillMessageKey(
                    installPlan.riskAcknowledgementMessageKey ?? 'skills.plan.highRiskAcknowledgement'
                  )
                )}
              </SkillNotice>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  checked={state.riskAcknowledged}
                  onCheckedChange={(checked) =>
                    setState((current) => ({ ...current, riskAcknowledged: checked === true }))
                  }
                  disabled={busy}
                  data-testid="skill-install-risk-checkbox"
                  className="mt-0.5"
                />
                <span>{t('plan.acknowledgeLabel')}</span>
              </label>
            </Card>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant={installPlan.requiresRiskAcknowledgement ? 'danger' : 'primary'}
              disabled={busy || !installPlan.installable || awaitingAcknowledgement}
              onClick={confirmInstall}
              data-testid="skill-install-confirm"
            >
              {state.busy === 'install-apply' ? t('plan.confirming') : t('plan.confirm')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={discardPlan}
              data-testid="skill-install-discard"
            >
              {t('plan.discard')}
            </Button>
          </div>
        </div>
      )}

      {uninstallPlan && (
        <div className="space-y-3">
          <SkillUninstallPlanPreview plan={uninstallPlan} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={busy || !uninstallPlan.removable}
              onClick={confirmUninstall}
              data-testid="skill-uninstall-confirm"
            >
              {state.busy === 'uninstall-apply'
                ? t('uninstall.confirming')
                : t('uninstall.confirm')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={discardPlan}
              data-testid="skill-uninstall-discard"
            >
              {t('plan.discard')}
            </Button>
          </div>
        </div>
      )}

      {state.installResult && (
        <Card className="space-y-3" data-testid="skill-install-result">
          <h3 className="text-sm font-semibold text-foreground">{t('operation.installedHeading')}</h3>
          <SkillNotice tone="info">
            {t(resolveSkillMessageKey(state.installResult.operation.nextActionKey))}
          </SkillNotice>
          {state.installResult.operation.replayed && (
            <SkillNotice tone="neutral" data-testid="skill-operation-replayed">
              {t('operation.replayNotice')}
            </SkillNotice>
          )}
          {state.installResult.install && 'files' in state.installResult.install && (
            <p className="text-xs text-muted-foreground">
              {t('operation.filesWritten', { count: state.installResult.install.files.length })}
            </p>
          )}
          {'reload' in state.installResult && (
            <ReloadGuidance
              agents={state.installResult.reload.agents}
              skillId={state.installResult.reload.skillId}
              version={state.installResult.reload.version}
            />
          )}
          <Button variant="secondary" size="sm" onClick={discardPlan} data-testid="skill-operation-reset">
            {t('operation.startOver')}
          </Button>
        </Card>
      )}

      {state.uninstallResult && (
        <Card className="space-y-3" data-testid="skill-uninstall-result">
          <h3 className="text-sm font-semibold text-foreground">
            {t('operation.uninstalledHeading')}
          </h3>
          <SkillNotice tone="info">
            {t(resolveSkillMessageKey(state.uninstallResult.operation.nextActionKey))}
          </SkillNotice>
          {state.uninstallResult.operation.replayed && (
            <SkillNotice tone="neutral" data-testid="skill-operation-replayed">
              {t('operation.replayNotice')}
            </SkillNotice>
          )}
          {state.uninstallResult.uninstall && 'removedFiles' in state.uninstallResult.uninstall && (
            <p className="text-xs text-muted-foreground">
              {t('operation.filesRemoved', {
                count: state.uninstallResult.uninstall.removedFiles.length,
              })}
            </p>
          )}
          {'reload' in state.uninstallResult && (
            <ReloadGuidance
              agents={state.uninstallResult.reload.agents}
              skillId={state.uninstallResult.reload.skillId}
              version={state.uninstallResult.reload.version}
            />
          )}
          <Button variant="secondary" size="sm" onClick={discardPlan} data-testid="skill-operation-reset">
            {t('operation.startOver')}
          </Button>
        </Card>
      )}
    </div>
  );
}

export default SkillInstallPanel;
