/**
 * The three-way choice for a session or a repository: from the level above, none,
 * or a role (Issue #4117). A native select, so a phone gets its own picker.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { AgentRoleSummary } from '@/types/agent-roles';
import { ROLE_CHOICE_INHERIT, ROLE_CHOICE_NONE } from './role-display';

export interface RoleChoiceSelectProps {
  value: string;
  /** The first option, which says what "from above" currently is. */
  inheritLabel: string;
  roles: readonly AgentRoleSummary[];
  /** What is stored, shown even while the list is still on its way or lacks it. */
  storedRole?: { id: string; name: string } | null;
  disabled?: boolean;
  ariaLabel: string;
  testId: string;
  onChange: (choice: string) => void;
}

export function RoleChoiceSelect({
  value,
  inheritLabel,
  roles,
  storedRole = null,
  disabled = false,
  ariaLabel,
  testId,
  onChange,
}: RoleChoiceSelectProps): React.ReactElement {
  const t = useTranslations('common');
  return (
    <select
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 text-sm border border-input rounded-md px-2 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
    >
      <option value={ROLE_CHOICE_INHERIT}>{inheritLabel}</option>
      <option value={ROLE_CHOICE_NONE}>{t('agentRoles.choice.none')}</option>
      {storedRole && !roles.some((role) => role.id === storedRole.id) && (
        <option value={storedRole.id}>{storedRole.name}</option>
      )}
      {roles.map((role) => (
        <option key={role.id} value={role.id}>
          {role.name}
        </option>
      ))}
    </select>
  );
}
