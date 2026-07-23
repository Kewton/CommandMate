/**
 * WorktreeSkillsPane (Issue #1441)
 *
 * The worktree-scoped Skills surface reused by the PC Activity Bar (#1441) and
 * the mobile screen (#1442). These tests pin the wiring the Issue calls out:
 * the installed list is read through the #1440 client (`fetchWorktreeInstalledSkills`,
 * i.e. `GET /api/worktrees/[id]/skills`) rather than a hand-rolled fetch, and
 * selecting a Skill drives {@link SkillInstallPanel} with the worktree fixed —
 * no target picker, so plan/install runs against exactly this checkout.
 *
 * The fetch mock answers per URL, so a request to an unexpected route fails
 * loudly rather than sliding past.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

import { WorktreeSkillsPane } from '@/components/skills/WorktreeSkillsPane';
import { makeCatalogMeta, makeSkill, makeInstallPlan, makeInstallResponse } from './fixtures';
import type { InstalledSkillDto } from '@/components/skills/types';

interface Route {
  status?: number;
  body: unknown;
}

const fetchMock = vi.fn();

function routeFetch(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url: string) => {
    const match = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (!match) throw new Error(`unexpected request: ${url}`);
    const route = routes[match];
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body } as unknown as Response;
  });
}

function requestsTo(suffix: string): number {
  return fetchMock.mock.calls.filter((call: unknown[]) =>
    (call[0] as string).endsWith(suffix)
  ).length;
}

function makeInstalled(overrides: Partial<InstalledSkillDto> = {}): InstalledSkillDto {
  return {
    skillId: 'release-helper',
    version: '1.2.0',
    installRoot: '.agents/skills/release-helper',
    receiptSha256: 'c'.repeat(64),
    artifactSha256: 'b'.repeat(64),
    source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: 'a'.repeat(40) },
    effectiveRisk: 'low',
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const CATALOG = { body: { catalog: makeCatalogMeta(), skills: [makeSkill()] } };
const INSTALLED = { body: { worktreeId: 'wt-1', skills: [makeInstalled()] } };
const INSTALLED_EMPTY = { body: { worktreeId: 'wt-1', skills: [] } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorktreeSkillsPane list', () => {
  it('reads the installed list through the #1440 worktree endpoint', async () => {
    routeFetch({ '/api/skills': CATALOG, '/api/worktrees/wt-1/skills': INSTALLED });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    // The installed section is populated from GET /api/worktrees/wt-1/skills,
    // not a bespoke fetch — this is the wiring #1441 must not leave dangling.
    await screen.findByTestId('worktree-skills-installed-release-helper');
    expect(requestsTo('/api/worktrees/wt-1/skills')).toBe(1);
    expect(
      screen.getByTestId('worktree-skills-installed-release-helper')
    ).toHaveTextContent('version=1.2.0');
  });

  it('renders the Catalog list from GET /api/skills', async () => {
    routeFetch({ '/api/skills': CATALOG, '/api/worktrees/wt-1/skills': INSTALLED_EMPTY });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    expect(await screen.findByTestId('worktree-skills-catalog-release-helper')).toHaveTextContent(
      'Release Helper'
    );
    expect(screen.getByTestId('worktree-skills-installed-empty')).toBeInTheDocument();
  });

  it('shows each Catalog Skill summary in the DOM (Phase 1)', async () => {
    routeFetch({ '/api/skills': CATALOG, '/api/worktrees/wt-1/skills': INSTALLED_EMPTY });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    // The summary is what tells a user what a Skill does before installing —
    // assert the real text lands in the DOM, not merely that state updated.
    const summary = await screen.findByTestId('worktree-skills-catalog-summary-release-helper');
    expect(summary).toHaveTextContent('Walks an agent through the release checklist.');
  });

  it('borrows name and summary from the Catalog for installed Skills (Phase 2)', async () => {
    routeFetch({ '/api/skills': CATALOG, '/api/worktrees/wt-1/skills': INSTALLED });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    const row = await screen.findByTestId('worktree-skills-installed-release-helper');
    // The install index only carries a skillId; the Catalog supplies the name.
    expect(row).toHaveTextContent('Release Helper');
    expect(
      screen.getByTestId('worktree-skills-installed-summary-release-helper')
    ).toHaveTextContent('Walks an agent through the release checklist.');
  });

  it('falls back to the skillId with no summary when the Catalog lacks the installed Skill (Phase 2 limit)', async () => {
    routeFetch({
      '/api/skills': CATALOG,
      '/api/worktrees/wt-1/skills': {
        body: { worktreeId: 'wt-1', skills: [makeInstalled({ skillId: 'ghost-skill' })] },
      },
    });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    const row = await screen.findByTestId('worktree-skills-installed-ghost-skill');
    expect(row).toHaveTextContent('ghost-skill');
    expect(
      screen.queryByTestId('worktree-skills-installed-summary-ghost-skill')
    ).not.toBeInTheDocument();
  });

  it('surfaces an installed-list failure without falling back to an empty list', async () => {
    routeFetch({
      '/api/skills': CATALOG,
      '/api/worktrees/wt-1/skills': {
        status: 500,
        body: { error: 'boom', code: 'SKILL_INSTALLED_LIST_INTERNAL_ERROR' },
      },
    });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    const error = await screen.findByTestId('worktree-skills-installed-error');
    expect(error).toHaveTextContent('SKILL_INSTALLED_LIST_INTERNAL_ERROR');
    expect(screen.queryByTestId('worktree-skills-installed-empty')).not.toBeInTheDocument();
  });
});

describe('WorktreeSkillsPane detail', () => {
  it('installs into the fixed worktree with no target picker', async () => {
    routeFetch({
      '/api/skills': CATALOG,
      '/api/worktrees/wt-1/skills': INSTALLED_EMPTY,
      '/plan': { body: { plan: makeInstallPlan() } },
      '/install': { body: makeInstallResponse() },
    });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    fireEvent.click(await screen.findByTestId('worktree-skills-catalog-release-helper'));

    // The shared install panel is mounted, but its target selector is not: the
    // worktree is fixed by the pane, so plan/install runs against wt-1 directly.
    const panel = await screen.findByTestId('skill-install-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.queryByTestId('skill-target-selector')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('skill-install-action'));
    await screen.findByTestId('skill-install-plan');

    const planCall = fetchMock.mock.calls.find((call: unknown[]) =>
      (call[0] as string).endsWith('/plan')
    );
    expect(planCall?.[0]).toBe('/api/worktrees/wt-1/skills/release-helper/plan');

    fireEvent.click(screen.getByTestId('skill-install-confirm'));
    expect(await screen.findByTestId('skill-install-result')).toHaveTextContent(
      'skills.install.nextAction.succeeded'
    );
  });

  it('returns to the list and re-reads the installed index', async () => {
    routeFetch({ '/api/skills': CATALOG, '/api/worktrees/wt-1/skills': INSTALLED });

    render(<WorktreeSkillsPane worktreeId="wt-1" />);

    fireEvent.click(await screen.findByTestId('worktree-skills-catalog-release-helper'));
    await screen.findByTestId('skill-install-panel');

    fireEvent.click(screen.getByTestId('worktree-skills-back'));

    // Back on the list, and the installed endpoint was polled again on return.
    await screen.findByTestId('worktree-skills-catalog-release-helper');
    await waitFor(() => expect(requestsTo('/api/worktrees/wt-1/skills')).toBe(2));
  });
});
