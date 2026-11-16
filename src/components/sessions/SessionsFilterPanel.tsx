/**
 * The /sessions filter panel (Issue #4386): the branch field, its error, clear.
 * Rendered inside a Modal on PC and a bottom sheet on mobile.
 *
 * Issue #4389: a role checklist (`GET /api/roles`) plus "no role" and "cannot
 * tell". Nothing checked means no role condition. When the instance roles could
 * not be read, a notice says the role condition is not in use.
 *
 * Issue #4388: below the conditions, "make this the default" (saved server-wide),
 * "back to default", and clear (which does not save).
 */

'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import type {
  SessionsFilterError,
  SessionsRoleCondition,
  SessionsRoleError,
} from '@/lib/sessions-filter';

/** A role the checklist offers (id and display name). */
export interface SessionsFilterRoleOption {
  id: string;
  name: string;
}

/** The default-condition actions (Issue #4388). */
export interface SessionsFilterDefaultActions {
  onSave: () => void;
  onReset: () => void;
  /** False when no default is saved. */
  canReset: boolean;
  saving: boolean;
  saved: boolean;
  /** Already-worded save error, or null. */
  saveError: string | null;
}

export interface SessionsFilterPanelProps {
  branchPattern: string;
  onBranchPatternChange: (value: string) => void;
  error: SessionsFilterError | null;
  onClear: () => void;
  /** Issue #4389. The checklist is drawn only when this is given (`null` = could not read). */
  roles?: readonly SessionsFilterRoleOption[] | null;
  role?: SessionsRoleCondition;
  onRoleChange?: (role: SessionsRoleCondition) => void;
  roleError?: SessionsRoleError | null;
  /** Issue #4388. The default buttons are drawn only when this is given. */
  defaultActions?: SessionsFilterDefaultActions;
}

const SECONDARY_BUTTON_CLASS =
  'rounded-md border border-input bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-muted';

function toggle(list: readonly string[] | undefined, id: string, on: boolean): string[] {
  const rest = (list ?? []).filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

function RoleCheck({
  testId,
  label,
  checked,
  onChange,
}: {
  testId: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="h-4 w-4"
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

export function SessionsFilterPanel({
  branchPattern,
  onBranchPatternChange,
  error,
  onClear,
  roles,
  role,
  onRoleChange,
  roleError,
  defaultActions,
}: SessionsFilterPanelProps) {
  const tCommon = useTranslations('common');
  return (
    <div className="space-y-3" data-testid="sessions-filter-panel">
      <label className="block text-sm text-foreground" htmlFor="sessions-branch-filter">
        {tCommon('sessions.branchFilter.label')}
      </label>
      <Input
        id="sessions-branch-filter"
        type="text"
        value={branchPattern}
        onChange={(e) => onBranchPatternChange(e.target.value)}
        placeholder={tCommon('sessions.branchFilter.placeholder')}
        data-testid="sessions-branch-filter"
        aria-invalid={error ? true : undefined}
        className={error ? 'border-danger-border focus-visible:ring-danger' : undefined}
      />
      {error && (
        <p className="text-sm text-danger-foreground" role="alert" data-testid="sessions-branch-filter-error">
          {tCommon(
            error === 'too_long'
              ? 'sessions.branchFilter.errorTooLong'
              : 'sessions.branchFilter.errorInvalid'
          )}
        </p>
      )}
      {roles !== undefined && onRoleChange && (
        <fieldset className="space-y-2" data-testid="sessions-role-filter">
          <legend className="text-sm text-foreground">{tCommon('sessions.roleFilter.label')}</legend>
          {roleError && (
            <p className="text-sm text-danger-foreground" role="alert" data-testid="sessions-role-filter-unavailable">
              {tCommon('sessions.roleFilter.unavailable')}
            </p>
          )}
          {roles === null ? (
            <p className="text-sm text-muted-foreground" data-testid="sessions-role-filter-roles-error">
              {tCommon('sessions.roleFilter.rolesLoadError')}
            </p>
          ) : (
            roles.map((r) => (
              <RoleCheck
                key={r.id}
                testId={`sessions-role-filter-role-${r.id}`}
                label={r.name}
                checked={(role?.roleIds ?? []).includes(r.id)}
                onChange={(on) => onRoleChange({ ...role, roleIds: toggle(role?.roleIds, r.id, on) })}
              />
            ))
          )}
          <RoleCheck
            testId="sessions-role-filter-none"
            label={tCommon('sessions.roleFilter.noRole')}
            checked={role?.includeNoRole === true}
            onChange={(on) => onRoleChange({ ...role, includeNoRole: on })}
          />
          <RoleCheck
            testId="sessions-role-filter-ambiguous"
            label={tCommon('sessions.roleFilter.ambiguous')}
            checked={role?.includeAmbiguous === true}
            onChange={(on) => onRoleChange({ ...role, includeAmbiguous: on })}
          />
        </fieldset>
      )}
      {defaultActions?.saveError && (
        <p className="text-sm text-danger-foreground" role="alert" data-testid="sessions-default-filter-save-error">
          {defaultActions.saveError}
        </p>
      )}
      {defaultActions?.saved && !defaultActions.saveError && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="sessions-default-filter-saved">
          {tCommon('sessions.defaultFilter.saved')}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {defaultActions && (
          <>
            <button
              type="button"
              onClick={defaultActions.onSave}
              data-testid="sessions-default-filter-save"
              aria-busy={defaultActions.saving || undefined}
              className={SECONDARY_BUTTON_CLASS}
            >
              {tCommon(defaultActions.saving ? 'sessions.defaultFilter.saving' : 'sessions.defaultFilter.save')}
            </button>
            <button
              type="button"
              onClick={defaultActions.onReset}
              disabled={!defaultActions.canReset}
              data-testid="sessions-default-filter-reset"
              className={`${SECONDARY_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {tCommon('sessions.defaultFilter.reset')}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onClear}
          data-testid="sessions-filter-clear"
          className={SECONDARY_BUTTON_CLASS}
        >
          {tCommon('sessions.branchFilter.clear')}
        </button>
      </div>
    </div>
  );
}
