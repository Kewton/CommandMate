/**
 * How a role's state reads on screen (Issue #4117). One wording for the add dialog,
 * the roster, the repository settings and the split header. Reads what the API
 * answered and resolves nothing itself.
 *
 * @module components/roles/role-display
 */
import type { EffectiveRole, InstanceRoleEntry, RoleAssignmentInput, StoredRoleState } from '@/types/agent-roles';

/** `t` of the `common` namespace. */
export type RoleTranslate = (key: string, values?: Record<string, string | number>) => string;

export const ROLE_CHOICE_INHERIT = 'inherit';
export const ROLE_CHOICE_NONE = 'none';

/** The value of a `<select>` for what is stored. A role id is never one of the two words: ids are hex. */
export function roleChoiceOf(stored: StoredRoleState): string {
  return stored.state === 'role' ? stored.roleId : stored.state === ROLE_CHOICE_NONE ? ROLE_CHOICE_NONE : ROLE_CHOICE_INHERIT;
}

/** The stored role as a select option, or null. */
export function storedRoleOption(stored: StoredRoleState): { id: string; name: string } | null {
  return stored.state === 'role' ? { id: stored.roleId, name: stored.roleName } : null;
}

export function roleInputOf(choice: string): RoleAssignmentInput {
  if (choice === ROLE_CHOICE_INHERIT) return { state: 'inherit' };
  if (choice === ROLE_CHOICE_NONE) return { state: 'none' };
  return { state: 'role', roleId: choice };
}

/** "レビュー担当［システム］", "なし［リポジトリで明示］". Empty for an ambiguous answer. */
export function effectiveRoleLabel(effective: EffectiveRole, t: RoleTranslate): string {
  if (effective.kind === 'ambiguous') return '';
  if (effective.kind === 'role') {
    const name = effective.role.name;
    if (effective.source === 'instance') return t('agentRoles.label.roleInstance', { name });
    if (effective.source === 'repository') return t('agentRoles.label.roleRepository', { name });
    return t('agentRoles.label.roleSystem', { name });
  }
  if (effective.reason === 'unsupported-tool') return t('agentRoles.label.noneUnsupported');
  if (effective.reason === 'no-default') return t('agentRoles.label.noneDefault');
  return effective.source === 'instance'
    ? t('agentRoles.label.noneInstance')
    : t('agentRoles.label.noneRepository');
}

/** Why git or the settings left the answer open, with the roots that disagree. */
export function ambiguityReasonText(effective: EffectiveRole, t: RoleTranslate): string | null {
  if (effective.kind !== 'ambiguous') return null;
  const roots = effective.roots
    .map((root) => {
      const state =
        root.state.state === 'role'
          ? root.state.roleName
          : t(root.state.state === 'none' ? 'agentRoles.choice.none' : 'agentRoles.ambiguous.rootInherits');
      return `${root.path} (${state})`;
    })
    .join(', ');
  return t(
    effective.reason === 'root-settings-differ'
      ? 'agentRoles.ambiguous.rootSettingsDiffer'
      : 'agentRoles.ambiguous.membershipUndetermined',
    { roots },
  );
}

/**
 * The line under a selector. `inherited` says the value comes from above, which is
 * what separates "継承中: なし［リポジトリで明示］" from a choice made on this very row.
 */
export function roleSourceText(effective: EffectiveRole, inherited: boolean, t: RoleTranslate): string {
  const reason = ambiguityReasonText(effective, t);
  if (reason) return reason;
  const label = effectiveRoleLabel(effective, t);
  return t(inherited ? 'agentRoles.source.inherited' : 'agentRoles.source.assigned', { label });
}

/** The name alone, for "既定（レビュー担当）" and "次回: PM". */
export function effectiveRoleName(effective: EffectiveRole, t: RoleTranslate): string {
  if (effective.kind === 'role') return effective.role.name;
  return t(effective.kind === 'ambiguous' ? 'agentRoles.application.ambiguous' : 'agentRoles.choice.none');
}

export interface RoleApplicationView {
  /** The text of the status. */
  text: string;
  /** Offer the existing per-instance restart: what runs is not known to be what is set. */
  restartable: boolean;
  /** The server says the next launch differs from the one running. */
  pending: boolean;
}

/**
 * What a session runs with beside what its next start would use. Never says applied:
 * a setting is only a setting until `launched` confirms it. `restartPending` decides
 * "適用待ち", and is not worked out here.
 *
 * @returns null when there is no role anywhere to speak of, which is the ordinary
 *   state of a worktree with no roles and must not add a chip to every header
 */
export function roleApplicationView(
  entry: InstanceRoleEntry,
  isRunning: boolean,
  t: RoleTranslate,
): RoleApplicationView | null {
  if (!entry.supported) return null;
  const { effectiveNext: next, launched, requested, restartPending } = entry.application;
  const nextName = effectiveRoleName(next, t);
  const nextText = t('agentRoles.application.next', { name: nextName });

  if (!isRunning) {
    return next.kind === 'none' ? null : { text: nextText, restartable: false, pending: false };
  }

  const launchedWithRole = launched !== null && launched.roleName !== null;
  const requestedRole = requested !== null && requested.roleName !== null;
  if (next.kind === 'none' && restartPending !== 'yes' && !launchedWithRole && !requestedRole) return null;

  const startupName =
    launched === null
      ? t('agentRoles.application.unknown')
      : launched.roleName ?? t('agentRoles.choice.none');
  const startupText = t('agentRoles.application.startup', { name: startupName });
  if (restartPending === 'no') return { text: startupText, restartable: false, pending: false };

  const separator = t('agentRoles.application.separator');
  if (restartPending === 'yes') {
    return {
      text: [startupText, nextText, t('agentRoles.application.pending')].join(separator),
      restartable: true,
      pending: true,
    };
  }
  // Not known either way: both sides are shown, and nothing is claimed about them.
  return {
    text: next.kind === 'none' ? startupText : [startupText, nextText].join(separator),
    restartable: true,
    pending: false,
  };
}

/** The tool's own notes: what a role means there that it does not mean elsewhere. */
export function roleToolNoteKeys(cliToolId: string): string[] {
  if (cliToolId === 'opencode') return ['agentRoles.personaNote'];
  if (cliToolId === 'opencode-v2') return ['agentRoles.personaNote', 'agentRoles.replacesDefaultNote'];
  return [];
}
