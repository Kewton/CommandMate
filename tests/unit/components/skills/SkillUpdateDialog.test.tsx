/**
 * SkillUpdateDialog (Issue #1243)
 *
 * Pins the update surface's contract: the badge and picker appear only when a
 * strictly newer published version exists, the picker offers exact versions
 * (never "latest"), the plan request names the selected version, and both the
 * updatable and the blocked plan are rendered with the server's own reasons —
 * including the risk-increase notice, which is the one confirmation contract
 * this Issue ships ahead of apply (#1244).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { SkillUpdateDialog } from '@/components/skills/SkillUpdateDialog';
import type { SkillUpdatePlanDto } from '@/components/skills/types';
import { makeVersion } from './fixtures';

const fetchMock = vi.fn();

function makeUpdatePlan(overrides: Partial<SkillUpdatePlanDto> = {}): SkillUpdatePlanDto {
  return {
    token: 'a'.repeat(48),
    expiresAt: '2026-08-05T00:10:00Z',
    updatable: true,
    blockers: [],
    nextActionKey: 'skills.update.nextAction.updatable',
    requiresRiskAcknowledgement: false,
    riskAcknowledgementMessageKey: null,
    riskIncreased: false,
    riskIncreaseMessageKey: null,
    update: {
      fromVersion: '1.2.0',
      toVersion: '1.3.0',
      latestVersion: '1.3.0',
      reasonCode: 'SKILL_UPDATE_RECOMMEND_HIGHEST_COMPATIBLE',
      prerelease: false,
    },
    target: {
      worktreeId: 'wt-1',
      worktreeName: 'demo-worktree',
      repositoryName: 'CommandMate',
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: 'f'.repeat(40),
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper'],
      roots: [
        {
          installRoot: '.agents/skills/release-helper',
          rootPrefix: '.agents/skills',
          clean: true,
          receiptDigest: 'c'.repeat(64),
          currentTreeHash: 'd'.repeat(64),
        },
      ],
      currentTreeHash: 'd'.repeat(64),
      plannedTreeHash: 'e'.repeat(64),
    },
    skill: {
      id: 'release-helper',
      name: 'Release Helper',
      version: '1.3.0',
      summary: 'Walks an agent through the release checklist.',
      description: 'Long description.',
      capabilities: [],
      expectedOutcomes: [],
      provider: { name: 'CommandMate' },
      license: 'MIT',
      homepage: null,
      declaredPermissions: ['filesystem_read'],
      requirements: { commands: [], networkHosts: [] },
      declaredRisk: 'low',
      computedRisk: 'low',
      effectiveRisk: 'low',
      riskRationale: 'Reads bundled reference material only.',
      executablePaths: [],
      scriptPaths: [],
      compatibility: {
        commandmate: {
          status: 'compatible',
          reasonCode: 'SKILL_COMPAT_SATISFIED',
          messageKey: 'skills.compatibility.reason.satisfied',
          message: 'CommandMate 0.11.4 satisfies the required range ">=0.11.0".',
          requiredRange: '>=0.11.0',
          currentVersion: '0.11.4',
        },
        agents: [],
      },
      source: { repository: 'Kewton/commandmate-skills', ref: 'v1.3.0', commit: 'a'.repeat(40) },
      artifact: {
        assetName: 'release-helper-1.3.0.tar.gz',
        sha256: 'b'.repeat(64),
        size: 20480,
        format: 'tar.gz',
      },
    },
    securityDiff: {
      risk: {
        from: { declared: 'low', computed: 'low', effective: 'low' },
        to: { declared: 'low', computed: 'low', effective: 'low' },
        increased: false,
      },
      permissions: { added: [], removed: [], unchanged: ['filesystem_read'] },
      executables: { added: [], removed: [] },
      scripts: { added: [], removed: [] },
      requirements: { commands: [], networkHosts: [] },
      changelogs: [{ version: '1.3.0', changelog: 'Adds the new checklist.' }],
      agents: { from: [], to: [] },
    },
    receipt: {
      path: '.agents/skills/release-helper/.commandmate-receipt.json',
      sha256: 'f'.repeat(64),
      size: 512,
    },
    files: [
      {
        path: '.agents/skills/release-helper/SKILL.md',
        relativePath: 'SKILL.md',
        change: 'update',
        generated: false,
        recordedSha256: '1'.repeat(64),
        candidateSha256: '2'.repeat(64),
        currentSha256: '1'.repeat(64),
        localState: 'match',
        size: 128,
        executable: false,
        binary: false,
        diff: '@@ -1,1 +1,1 @@\n-old step\n+new step',
        diffTruncated: false,
        additions: 1,
        deletions: 1,
      },
    ],
    stats: {
      added: 0,
      updated: 1,
      removed: 0,
      unchanged: 3,
      localModified: 0,
      localMissing: 0,
      localUnknown: 0,
      irregular: 0,
    },
    warnings: [],
    ...overrides,
  };
}

function planFetch(plan: SkillUpdatePlanDto) {
  fetchMock.mockImplementation(async (url: string) => {
    if (!(url as string).endsWith('/update-plan')) {
      throw new Error(`unexpected request: ${url}`);
    }
    return { ok: true, status: 200, json: async () => ({ plan }) } as unknown as Response;
  });
}

const VERSIONS = [
  makeVersion({ version: '1.3.0' }),
  makeVersion({ version: '1.2.0' }),
  makeVersion({ version: '1.0.0' }),
];

function renderDialog(overrides: Partial<React.ComponentProps<typeof SkillUpdateDialog>> = {}) {
  return render(
    <SkillUpdateDialog
      skillId="release-helper"
      skillName="Release Helper"
      worktreeId="wt-1"
      installedVersion="1.2.0"
      versions={VERSIONS}
      {...overrides}
    />
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillUpdateDialog availability', () => {
  it('shows nothing but an up-to-date note when no newer version is published', () => {
    renderDialog({ installedVersion: '1.3.0' });

    expect(screen.getByTestId('skill-update-uptodate')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-update-badge')).not.toBeInTheDocument();
  });

  it('offers only strictly newer versions in the picker, newest preselected', () => {
    renderDialog();

    expect(screen.getByTestId('skill-update-badge')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-update-trigger'));

    const select = screen.getByTestId('skill-update-version-select') as HTMLSelectElement;
    const options = [...select.querySelectorAll('option')].map((option) => option.value);
    // 1.2.0 (installed) and 1.0.0 (older) are not update candidates.
    expect(options).toEqual(['1.3.0']);
    expect(select.value).toBe('1.3.0');
  });
});

describe('SkillUpdateDialog plan', () => {
  it('requests the plan for the selected exact version and renders the diff', async () => {
    planFetch(makeUpdatePlan());
    renderDialog();

    fireEvent.click(screen.getByTestId('skill-update-trigger'));
    fireEvent.click(screen.getByTestId('skill-update-build'));

    await screen.findByTestId('skill-update-plan');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/wt-1/skills/release-helper/update-plan');
    expect(JSON.parse(init.body as string)).toEqual({ version: '1.3.0' });

    expect(screen.getByTestId('skill-update-next-action')).toHaveTextContent(
      'skills.update.nextAction.updatable'
    );
    expect(screen.getByTestId('skill-update-stats')).toHaveTextContent(
      'added=0,updated=1,removed=0,unchanged=3'
    );
    expect(screen.getByTestId('skill-update-file')).toHaveTextContent('SKILL.md');
    expect(screen.getByTestId('skill-update-changelogs')).toHaveTextContent(
      'Adds the new checklist.'
    );
    expect(screen.queryByTestId('skill-update-risk-increase')).not.toBeInTheDocument();
  });

  it('renders a blocked plan with every blocker and the resolution step', async () => {
    planFetch(
      makeUpdatePlan({
        updatable: false,
        nextActionKey: 'skills.update.nextAction.blocked',
        blockers: [
          {
            code: 'SKILL_UPDATE_LOCAL_CHANGES',
            path: '.agents/skills/release-helper/SKILL.md',
            messageKey: 'skills.update.blocked.localChanges',
            detail: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
          },
        ],
      })
    );
    renderDialog();

    fireEvent.click(screen.getByTestId('skill-update-trigger'));
    fireEvent.click(screen.getByTestId('skill-update-build'));

    await screen.findByTestId('skill-update-plan');
    expect(screen.getByTestId('skill-update-next-action')).toHaveTextContent(
      'skills.update.nextAction.blocked'
    );
    const blockers = screen.getByTestId('skill-update-blockers');
    expect(blockers).toHaveTextContent('.agents/skills/release-helper/SKILL.md');
    expect(blockers).toHaveTextContent('skills.update.blocked.localChanges');
  });

  it('surfaces the risk-increase contract as its own notice', async () => {
    planFetch(
      makeUpdatePlan({
        riskIncreased: true,
        riskIncreaseMessageKey: 'skills.update.riskIncreaseAcknowledgement',
        requiresRiskAcknowledgement: true,
        riskAcknowledgementMessageKey: 'skills.update.highRiskAcknowledgement',
      })
    );
    renderDialog();

    fireEvent.click(screen.getByTestId('skill-update-trigger'));
    fireEvent.click(screen.getByTestId('skill-update-build'));

    await screen.findByTestId('skill-update-plan');
    expect(screen.getByTestId('skill-update-risk-increase')).toHaveTextContent(
      'skills.update.riskIncreaseAcknowledgement'
    );
    expect(screen.getByTestId('skill-update-high-risk')).toHaveTextContent(
      'skills.update.highRiskAcknowledgement'
    );
  });

  it('reports a refusal with the server code instead of swallowing it', async () => {
    fetchMock.mockImplementation(async () => {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'No update.', code: 'SKILL_UPDATE_UP_TO_DATE' }),
      } as unknown as Response;
    });
    renderDialog();

    fireEvent.click(screen.getByTestId('skill-update-trigger'));
    fireEvent.click(screen.getByTestId('skill-update-build'));

    await waitFor(() => {
      expect(screen.getByTestId('skill-update-error')).toHaveTextContent(
        'code=SKILL_UPDATE_UP_TO_DATE'
      );
    });
    expect(screen.getByTestId('skill-update-error')).toHaveTextContent(
      'skills.operation.error.updateUpToDate'
    );
  });
});
