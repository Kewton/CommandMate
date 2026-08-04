/**
 * SkillUpdateDialog (Issue #1243, apply: #1244)
 *
 * The update surface for one installed Skill in one worktree: an update badge,
 * an explicit version picker, the server-built Update Plan — version diff,
 * risk and permission changes, and every reason an update is refused — and the
 * apply step that presents the plan's single-use token back to the server.
 *
 * Rules the dialog does not bend:
 * - The candidate is always an exact version the user can see. "Update to
 *   latest" is a default selection in the picker, never an implicit action.
 * - A blocked plan is rendered, not swallowed: local changes are the user's
 *   work, and the screen names each blocking path with what to do about it.
 *   Apply is only offered on an updatable plan.
 * - The risk gates fail closed: a high-risk candidate and a risk increase each
 *   require their own explicit acknowledgement before apply is enabled.
 *
 * @module components/skills/SkillUpdateDialog
 */

'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Modal } from '@/components/ui';
import { isNewerSkillVersion } from '@/lib/skills/version-resolver';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import { SkillNotice } from './SkillNotice';
import { SkillRiskBadge } from './SkillBadges';
import {
  COMPATIBILITY_LABEL_KEY,
  PERMISSION_LABEL_KEY,
  UPDATE_CHANGE_BADGE_VARIANT,
  UPDATE_CHANGE_LABEL_KEY,
  operationErrorLabelKey,
  resolveSkillMessageKey,
} from './skill-vocabulary';
import {
  applySkillUpdate,
  createSkillUpdatePlan,
  type SkillFetchFailure,
} from './skills-client';
import type { SkillUpdateApplyResponse, SkillUpdatePlanDto, SkillVersionDto } from './types';

const SELECT_CLASS =
  'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface SkillUpdateDialogProps {
  skillId: string;
  skillName: string;
  worktreeId: string;
  /** Exact version the receipt/index records as installed. */
  installedVersion: string;
  /** Published versions from the Catalog entry, newest first (server-ordered). */
  versions: SkillVersionDto[];
}

interface DialogState {
  open: boolean;
  selectedVersion: string | null;
  busy: boolean;
  plan: SkillUpdatePlanDto | null;
  failure: SkillFetchFailure | null;
  /** Both risk gates; only rendered (and required) when the plan demands them. */
  riskAcknowledged: boolean;
  riskIncreaseAcknowledged: boolean;
  applying: boolean;
  applyResult: SkillUpdateApplyResponse | null;
  applyFailure: SkillFetchFailure | null;
}

const DIALOG_CLOSED: DialogState = {
  open: false,
  selectedVersion: null,
  busy: false,
  plan: null,
  failure: null,
  riskAcknowledged: false,
  riskIncreaseAcknowledged: false,
  applying: false,
  applyResult: null,
  applyFailure: null,
};

/**
 * Retry key for an apply, derived from the plan token so retrying the same
 * approved plan replays the original operation instead of starting a second
 * one (the install panel's rule, shared).
 */
function updateIdempotencyKey(token: string): string {
  return `skill-update-${token}`;
}

function PathList({ heading, paths, testid }: { heading: string; paths: string[]; testid: string }) {
  if (paths.length === 0) return null;
  return (
    <div data-testid={testid}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h4>
      <ul className="mt-1 space-y-0.5">
        {paths.map((path) => (
          <li key={path} className="break-all font-mono text-xs text-foreground">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SkillUpdateDialog({
  skillId,
  skillName,
  worktreeId,
  installedVersion,
  versions,
}: SkillUpdateDialogProps) {
  const t = useTranslations('skills');

  // The picker offers only strictly newer published versions; the server
  // re-derives the same set from the receipt and the Catalog, so this filter is
  // presentation, not authority (#1243: no duplicated detection logic — the
  // comparison is `version-resolver`'s, shared with the API).
  const candidates = useMemo(
    () => versions.filter((entry) => isNewerSkillVersion(entry.version, installedVersion)),
    [versions, installedVersion]
  );
  const defaultVersion = useMemo(
    () =>
      (
        candidates.find((entry) => entry.compatibility.commandmate.status === 'compatible') ??
        candidates[0]
      )?.version ?? null,
    [candidates]
  );

  const [state, setState] = useState<DialogState>(DIALOG_CLOSED);

  const openDialog = useCallback(() => {
    setState({ ...DIALOG_CLOSED, open: true, selectedVersion: defaultVersion });
  }, [defaultVersion]);

  const closeDialog = useCallback(() => {
    setState(DIALOG_CLOSED);
  }, []);

  const buildPlan = useCallback(async () => {
    const version = state.selectedVersion;
    if (!version) return;
    setState((current) => ({
      ...current,
      busy: true,
      plan: null,
      failure: null,
      riskAcknowledged: false,
      riskIncreaseAcknowledged: false,
      applyResult: null,
      applyFailure: null,
    }));

    const result = await createSkillUpdatePlan(worktreeId, skillId, { version });
    setState((current) => ({
      ...current,
      busy: false,
      plan: result.ok ? result.data.plan : null,
      failure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.selectedVersion, worktreeId]);

  const applyPlan = useCallback(async () => {
    const currentPlan = state.plan;
    if (!currentPlan || !currentPlan.updatable) return;
    setState((current) => ({ ...current, applying: true, applyFailure: null }));

    const result = await applySkillUpdate(worktreeId, skillId, {
      planToken: currentPlan.token,
      version: currentPlan.update.toVersion,
      acknowledgeRisk: state.riskAcknowledged,
      acknowledgeRiskIncrease: state.riskIncreaseAcknowledged,
      idempotencyKey: updateIdempotencyKey(currentPlan.token),
    });
    setState((current) => ({
      ...current,
      applying: false,
      applyResult: result.ok ? result.data : null,
      applyFailure: result.ok ? null : result.failure,
    }));
  }, [skillId, state.plan, state.riskAcknowledged, state.riskIncreaseAcknowledged, worktreeId]);

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="skill-update-uptodate">
        {t('update.upToDate', { version: installedVersion })}
      </p>
    );
  }

  const plan = state.plan;
  const applied = state.applyResult;

  return (
    <div data-testid="skill-update-dialog-host">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="info" data-testid="skill-update-badge">
          {t('update.badge')}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {t('update.fromTo', { from: installedVersion, to: candidates[0].version })}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={openDialog}
          data-testid="skill-update-trigger"
        >
          {t('update.open')}
        </Button>
      </div>

      <Modal isOpen={state.open} onClose={closeDialog} title={t('update.heading')} size="lg">
        <div className="space-y-3 p-4" data-testid="skill-update-dialog">
          <p className="text-sm text-muted-foreground">
            {t('update.intro', { skill: skillName, version: installedVersion })}
          </p>
          <p className="text-xs text-muted-foreground">{t('update.ready')}</p>

          <label className="block text-xs font-medium text-muted-foreground">
            {t('update.versionPicker')}
            <select
              className={`${SELECT_CLASS} mt-1`}
              value={state.selectedVersion ?? ''}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  selectedVersion: event.target.value,
                  plan: null,
                  failure: null,
                }))
              }
              disabled={state.busy}
              data-testid="skill-update-version-select"
            >
              {candidates.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {entry.version}
                  {entry.prerelease ? ` (${t('detail.prerelease')})` : ''}
                  {entry.compatibility.commandmate.status !== 'compatible'
                    ? ` — ${t(COMPATIBILITY_LABEL_KEY[entry.compatibility.commandmate.status])}`
                    : ''}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="primary"
            disabled={state.busy || !state.selectedVersion}
            onClick={buildPlan}
            data-testid="skill-update-build"
          >
            {state.busy ? t('update.building') : t('update.build')}
          </Button>

          {state.failure && (
            <SkillNotice tone="danger" data-testid="skill-update-error">
              <p>{t(operationErrorLabelKey(state.failure.code))}</p>
              <p className="mt-1 break-words">
                {t('state.errorCode', { code: state.failure.code })}
              </p>
            </SkillNotice>
          )}

          {plan && (
            <div className="space-y-3" data-testid="skill-update-plan">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {t('update.fromTo', {
                    from: plan.update.fromVersion,
                    to: plan.update.toVersion,
                  })}
                </span>
                {plan.update.latestVersion !== null &&
                  plan.update.latestVersion !== plan.update.toVersion && (
                    <span className="text-xs text-muted-foreground">
                      {t('update.latestAvailable', { version: plan.update.latestVersion })}
                    </span>
                  )}
              </div>

              <SkillNotice
                tone={plan.updatable ? 'info' : 'warning'}
                data-testid="skill-update-next-action"
              >
                {t(resolveSkillMessageKey(plan.nextActionKey))}
              </SkillNotice>

              {plan.blockers.length > 0 && (
                <ul className="space-y-1" data-testid="skill-update-blockers">
                  {plan.blockers.map((blocker) => (
                    <li
                      key={`${blocker.code}:${blocker.path ?? ''}`}
                      className="text-xs text-danger-foreground"
                    >
                      {blocker.path && (
                        <span className="mr-1 break-all font-mono">{blocker.path}</span>
                      )}
                      {t(resolveSkillMessageKey(blocker.messageKey))}
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-2" data-testid="skill-update-risk">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('plan.riskHeading')}
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                  <SkillRiskBadge risk={plan.securityDiff.risk.from.effective} />
                  <span aria-hidden="true">→</span>
                  <SkillRiskBadge risk={plan.securityDiff.risk.to.effective} />
                </div>
                {plan.riskIncreased && plan.riskIncreaseMessageKey && (
                  <SkillNotice tone="danger" data-testid="skill-update-risk-increase">
                    {t(resolveSkillMessageKey(plan.riskIncreaseMessageKey))}
                  </SkillNotice>
                )}
                {plan.requiresRiskAcknowledgement && plan.riskAcknowledgementMessageKey && (
                  <SkillNotice tone="warning" data-testid="skill-update-high-risk">
                    {t(resolveSkillMessageKey(plan.riskAcknowledgementMessageKey))}
                  </SkillNotice>
                )}
                {plan.updatable && !state.applyResult && plan.requiresRiskAcknowledgement && (
                  <label className="flex items-start gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={state.riskAcknowledged}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          riskAcknowledged: event.target.checked,
                        }))
                      }
                      data-testid="skill-update-ack-risk"
                    />
                    {t('update.ackRisk')}
                  </label>
                )}
                {plan.updatable && !state.applyResult && plan.riskIncreased && (
                  <label className="flex items-start gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={state.riskIncreaseAcknowledged}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          riskIncreaseAcknowledged: event.target.checked,
                        }))
                      }
                      data-testid="skill-update-ack-risk-increase"
                    />
                    {t('update.ackRiskIncrease')}
                  </label>
                )}
              </div>

              <div className="space-y-2" data-testid="skill-update-security-diff">
                {plan.securityDiff.permissions.added.length > 0 && (
                  <div data-testid="skill-update-permissions-added">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('update.permissionsAdded')}
                    </h4>
                    <ul className="mt-1 space-y-0.5">
                      {plan.securityDiff.permissions.added.map((permission) => (
                        <li key={permission} className="text-xs text-foreground">
                          {t(PERMISSION_LABEL_KEY[permission] ?? 'plan.permissionsNone')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {plan.securityDiff.permissions.removed.length > 0 && (
                  <div data-testid="skill-update-permissions-removed">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('update.permissionsRemoved')}
                    </h4>
                    <ul className="mt-1 space-y-0.5">
                      {plan.securityDiff.permissions.removed.map((permission) => (
                        <li key={permission} className="text-xs text-foreground">
                          {t(PERMISSION_LABEL_KEY[permission] ?? 'plan.permissionsNone')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <PathList
                  heading={t('update.scriptsAdded')}
                  paths={plan.securityDiff.scripts.added}
                  testid="skill-update-scripts-added"
                />
                <PathList
                  heading={t('update.scriptsRemoved')}
                  paths={plan.securityDiff.scripts.removed}
                  testid="skill-update-scripts-removed"
                />
                <PathList
                  heading={t('update.executablesAdded')}
                  paths={plan.securityDiff.executables.added}
                  testid="skill-update-executables-added"
                />
                <PathList
                  heading={t('update.executablesRemoved')}
                  paths={plan.securityDiff.executables.removed}
                  testid="skill-update-executables-removed"
                />
              </div>

              {plan.securityDiff.changelogs.length > 0 && (
                <div className="space-y-1" data-testid="skill-update-changelogs">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('detail.changelogHeading')}
                  </h4>
                  {plan.securityDiff.changelogs.map((entry) => (
                    <div key={entry.version}>
                      <p className="text-xs font-semibold text-foreground">{entry.version}</p>
                      <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {entry.changelog}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1" data-testid="skill-update-files">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('update.filesHeading')}
                </h4>
                <p className="text-xs text-muted-foreground" data-testid="skill-update-stats">
                  {t('update.stats', {
                    added: plan.stats.added,
                    updated: plan.stats.updated,
                    removed: plan.stats.removed,
                    unchanged: plan.stats.unchanged,
                  })}
                </p>
                <ul className="space-y-1">
                  {plan.files
                    .filter((entry) => entry.change !== 'unchanged')
                    .map((entry) => (
                      <li key={entry.path} data-testid="skill-update-file">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={UPDATE_CHANGE_BADGE_VARIANT[entry.change] ?? 'gray'}>
                            {t(UPDATE_CHANGE_LABEL_KEY[entry.change] ?? 'update.change.update')}
                          </Badge>
                          <span className="break-all font-mono text-xs text-foreground">
                            {entry.path}
                          </span>
                        </div>
                        {entry.diff && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              {t('update.showDiff')}
                            </summary>
                            <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs text-foreground">
                              {entry.diff}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                </ul>
              </div>

              <p className="text-xs text-muted-foreground" data-testid="skill-update-expiry">
                {t('plan.expiresAt', { timestamp: plan.expiresAt })}
              </p>

              {plan.updatable && !state.applyResult && (
                <Button
                  variant="primary"
                  disabled={
                    state.applying ||
                    (plan.requiresRiskAcknowledgement && !state.riskAcknowledged) ||
                    (plan.riskIncreased && !state.riskIncreaseAcknowledged)
                  }
                  onClick={applyPlan}
                  data-testid="skill-update-apply"
                >
                  {state.applying ? t('update.applying') : t('update.apply')}
                </Button>
              )}

              {state.applyFailure && (
                <div className="space-y-2" data-testid="skill-update-apply-error">
                  <SkillNotice tone="danger">
                    <p>{t(operationErrorLabelKey(state.applyFailure.code))}</p>
                    <p className="mt-1 break-words">
                      {t('state.errorCode', { code: state.applyFailure.code })}
                    </p>
                  </SkillNotice>
                  {state.applyFailure.nextActionKey && (
                    <SkillNotice tone="warning">
                      {t(resolveSkillMessageKey(state.applyFailure.nextActionKey))}
                    </SkillNotice>
                  )}
                  {state.applyFailure.blockers && state.applyFailure.blockers.length > 0 && (
                    <ul className="space-y-1" data-testid="skill-update-apply-error-blockers">
                      {state.applyFailure.blockers.map((blocker) => (
                        <li
                          key={`${blocker.code}:${blocker.path ?? ''}`}
                          className="text-xs text-danger-foreground"
                        >
                          {blocker.path && (
                            <span className="mr-1 break-all font-mono">{blocker.path}</span>
                          )}
                          {t(resolveSkillMessageKey(blocker.messageKey))}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {applied && (
            <div className="space-y-3" data-testid="skill-update-result">
              <SkillNotice
                tone={applied.operation.result === 'succeeded' ? 'info' : 'warning'}
                data-testid="skill-update-result-next-action"
              >
                {t(resolveSkillMessageKey(applied.operation.nextActionKey))}
              </SkillNotice>
              {'reload' in applied && (
                <>
                  <p className="text-sm font-semibold text-foreground">
                    {t('update.fromTo', {
                      from: applied.update.fromVersion,
                      to: applied.update.toVersion,
                    })}
                  </p>
                  <div className="space-y-1" data-testid="skill-update-result-reload">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('operation.reloadHeading')}
                    </h4>
                    <ul className="space-y-1">
                      {applied.reload.agents.map((agent) => (
                        <li key={agent.agent} className="text-xs text-muted-foreground">
                          {t(resolveSkillMessageKey(agent.messageKey), {
                            agent: getCliToolDisplayNameSafe(agent.agent),
                            skillId: applied.reload.skillId,
                            version: applied.reload.version,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="skill-update-result-rollback"
                  >
                    {t(resolveSkillMessageKey(applied.rollback.messageKey), {
                      version: applied.rollback.backup.fromVersion,
                    })}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default SkillUpdateDialog;
