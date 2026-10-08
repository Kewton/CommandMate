/**
 * Issue #3445: the plan previews tell "has uncommitted changes" apart from
 * "could not check" (git status unread), and never show the latter as clean.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations:
    (namespace?: string) =>
    (key: string, params?: Record<string, string | number>) => {
      const full = namespace ? `${namespace}.${key}` : key;
      if (!params) return full;
      const rendered = Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',');
      return `${full}(${rendered})`;
    },
  useLocale: () => 'en',
}));

import {
  SkillInstallPlanPreview,
  SkillUninstallPlanPreview,
} from '@/components/skills/SkillPlanPreview';
import { makeInstallPlan, makeUninstallPlan } from './fixtures';

describe('SkillPlanPreview working tree (Issue #3445)', () => {
  it('install: shows "status unknown" and its caveat, not dirty or clean', () => {
    const base = makeInstallPlan();
    render(
      <SkillInstallPlanPreview
        plan={{
          ...base,
          warnings: ['SKILL_PREVIEW_WORKING_TREE_STATUS_UNKNOWN'],
          target: { ...base.target, workingTreeDirty: true, workingTreeUnknown: true },
        }}
      />
    );

    expect(screen.getByText('skills.target.workingTreeStatusUnknown')).toBeInTheDocument();
    expect(screen.getByText('skills.plan.warning.workingTreeStatusUnknown')).toBeInTheDocument();
    expect(screen.queryByText('skills.target.workingTreeDirty')).toBeNull();
    expect(screen.queryByText('skills.target.workingTreeClean')).toBeNull();
  });

  it('install: dirty still reads as dirty', () => {
    const base = makeInstallPlan();
    render(
      <SkillInstallPlanPreview plan={{ ...base, target: { ...base.target, workingTreeDirty: true } }} />
    );

    expect(screen.getByText('skills.target.workingTreeDirty')).toBeInTheDocument();
  });

  it('uninstall: shows "status unknown"', () => {
    const base = makeUninstallPlan();
    render(
      <SkillUninstallPlanPreview
        plan={{ ...base, target: { ...base.target, workingTreeDirty: true, workingTreeUnknown: true } }}
      />
    );

    expect(screen.getByText('skills.target.workingTreeStatusUnknown')).toBeInTheDocument();
    expect(screen.queryByText('skills.target.workingTreeDirty')).toBeNull();
  });
});
