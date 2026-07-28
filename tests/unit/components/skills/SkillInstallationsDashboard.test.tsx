/**
 * SkillInstallationsDashboard (Issue #1248)
 *
 * The applied-state screen. These tests pin the distinctions the Issue is about:
 * every install root is rendered separately (so `.claude/skills` drift is
 * visible, not folded into a single healthy-looking line), a scan that failed is
 * never rendered as "nothing installed", an unreachable Catalog disables the
 * update claim rather than silently reporting everything current, and a failed
 * operation offers the way back to retrying it.
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

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SkillInstallationsDashboard } from '@/components/skills/SkillInstallationsDashboard';
import type {
  SkillInstallRootStatus,
  SkillInstallationStatusEntry,
  SkillOperationAuditRecord,
} from '@/components/skills/types';

interface Route {
  status?: number;
  body: unknown;
}

const fetchMock = vi.fn();

function routeFetch(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = url.split('?')[0];
    const route = routes[path];
    if (!route) throw new Error(`unexpected request: ${url}`);
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body } as unknown as Response;
  });
}

function makeRoot(overrides: Partial<SkillInstallRootStatus> = {}): SkillInstallRootStatus {
  return {
    root: '.agents/skills/release-helper',
    rootPrefix: '.agents/skills',
    present: true,
    receiptSha256: 'c'.repeat(64),
    version: '1.2.0',
    modifiedFiles: 0,
    missingFiles: 0,
    unmanagedFiles: 0,
    irregularPaths: 0,
    truncated: false,
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<SkillInstallationStatusEntry> = {}
): SkillInstallationStatusEntry {
  return {
    worktreeId: 'wt-1',
    worktreeName: 'feature/demo',
    repositoryName: 'CommandMate',
    skillId: 'release-helper',
    version: '1.2.0',
    status: 'installed',
    latestVersion: null,
    installRoots: [
      makeRoot(),
      makeRoot({ root: '.claude/skills/release-helper', rootPrefix: '.claude/skills' }),
    ],
    effectiveRisk: 'low',
    source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: 'a'.repeat(40) },
    artifactSha256: 'b'.repeat(64),
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeAudit(
  overrides: Partial<SkillOperationAuditRecord> = {}
): SkillOperationAuditRecord {
  return {
    id: 'audit-1',
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    bindingHash: 'bind-1',
    operation: 'install',
    state: 'SUCCEEDED',
    result: 'succeeded',
    actorType: 'user',
    actorId: 'user-1',
    worktreeId: 'wt-1',
    skillId: 'release-helper',
    skillVersion: '1.2.0',
    fromVersion: null,
    toVersion: '1.2.0',
    sourceOrigin: 'github-release',
    sourceRepository: 'Kewton/commandmate-skills',
    sourceRef: 'v1.2.0',
    sourceCommit: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    errorCode: null,
    errorMessage: null,
    recordedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function installations(entries: SkillInstallationStatusEntry[], overrides = {}): Route {
  return {
    body: {
      scannedAt: 1_700_000_000_000,
      worktreeCount: 1,
      truncated: false,
      unreadableWorktreeIds: [],
      catalogAvailable: true,
      installations: entries,
      ...overrides,
    },
  };
}

function operations(records: SkillOperationAuditRecord[]): Route {
  return { body: { operations: records, hasMore: false, nextCursor: null } };
}

const NO_OPERATIONS = operations([]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applied state listing', () => {
  it('renders every install root separately so secondary-root drift stays visible', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({
          status: 'modified',
          installRoots: [
            makeRoot(),
            makeRoot({
              root: '.claude/skills/release-helper',
              rootPrefix: '.claude/skills',
              modifiedFiles: 2,
            }),
          ],
        }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    await screen.findByTestId('skill-dashboard-list');
    const roots = screen.getAllByTestId('skill-dashboard-root');
    expect(roots).toHaveLength(2);
    expect(roots[0]).toHaveTextContent('.agents/skills/release-helper');
    expect(roots[1]).toHaveTextContent('.claude/skills/release-helper');
    expect(screen.getByTestId('skill-dashboard-drift')).toHaveTextContent('modified=2');
  });

  it('flags a root that is absent on disk', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({
          status: 'missing',
          installRoots: [
            makeRoot(),
            makeRoot({
              root: '.claude/skills/release-helper',
              rootPrefix: '.claude/skills',
              present: false,
              receiptSha256: null,
              version: null,
            }),
          ],
        }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    const roots = await screen.findAllByTestId('skill-dashboard-root');
    expect(roots[0]).toHaveTextContent('dashboard.rootPresent');
    expect(roots[1]).toHaveTextContent('dashboard.rootMissing');
  });

  it('explains each state rather than only labelling it', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry({ status: 'unmanaged' })]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    expect(await screen.findByTestId('skill-dashboard-hint')).toHaveTextContent(
      'dashboard.statusHint.unmanaged'
    );
  });

  it('puts the entries needing attention first', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({ skillId: 'clean-skill', status: 'installed' }),
        makeEntry({ skillId: 'broken-skill', status: 'missing' }),
        makeEntry({ skillId: 'stale-skill', status: 'update_available', latestVersion: '2.0.0' }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    const items = await screen.findAllByTestId('skill-dashboard-item');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('broken-skill'),
      expect.stringContaining('stale-skill'),
      expect.stringContaining('clean-skill'),
    ]);
  });

  it('shows the version a Skill would move to when an update exists', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({ status: 'update_available', latestVersion: '2.0.0' }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    expect(await screen.findByTestId('skill-dashboard-item')).toHaveTextContent('1.2.0 → 2.0.0');
  });
});

describe('states that must not be conflated', () => {
  it('renders a failed scan as an error, never as an empty list', async () => {
    routeFetch({
      '/api/skills/installations': {
        status: 500,
        body: { error: 'boom', code: 'SKILL_INSTALLATIONS_INTERNAL_ERROR' },
      },
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    await screen.findByTestId('skill-dashboard-error');
    expect(screen.queryByTestId('skill-dashboard-empty')).toBeNull();
    expect(screen.getByTestId('skill-dashboard-error')).toHaveTextContent(
      'SKILL_INSTALLATIONS_INTERNAL_ERROR'
    );
  });

  it('warns that updates are unknowable when the Catalog is unreachable', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()], { catalogAvailable: false }),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    expect(await screen.findByTestId('skill-dashboard-catalog-unavailable')).toBeInTheDocument();
  });

  it('says the list is incomplete when the scan hit its bound', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()], { truncated: true }),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    expect(await screen.findByTestId('skill-dashboard-truncated')).toBeInTheDocument();
  });

  it('names worktrees that could not be scanned', async () => {
    routeFetch({
      '/api/skills/installations': installations([], { unreadableWorktreeIds: ['wt-gone'] }),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);

    expect(await screen.findByTestId('skill-dashboard-unreadable')).toHaveTextContent('wt-gone');
  });
});

describe('filters', () => {
  it('narrows by state without refetching', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({ skillId: 'clean-skill', status: 'installed' }),
        makeEntry({ skillId: 'broken-skill', status: 'missing' }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-dashboard-list');

    fireEvent.change(screen.getByTestId('skill-dashboard-filter-status'), {
      target: { value: 'missing' },
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('skill-dashboard-item')).toHaveLength(1);
    });
    expect(screen.getByTestId('skill-dashboard-item')).toHaveTextContent('broken-skill');
  });

  it('narrows by Skill name', async () => {
    routeFetch({
      '/api/skills/installations': installations([
        makeEntry({ skillId: 'release-helper' }),
        makeEntry({ skillId: 'other-skill' }),
      ]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-dashboard-list');

    fireEvent.change(screen.getByTestId('skill-dashboard-search'), {
      target: { value: 'release' },
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('skill-dashboard-item')).toHaveLength(1);
    });
  });

  it('distinguishes "no Skills at all" from "nothing matches the filter"', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry({ skillId: 'release-helper' })]),
      '/api/skills/operations': NO_OPERATIONS,
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-dashboard-list');

    fireEvent.change(screen.getByTestId('skill-dashboard-search'), {
      target: { value: 'nothing-like-this' },
    });

    await screen.findByTestId('skill-dashboard-no-results');
    expect(screen.queryByTestId('skill-dashboard-empty')).toBeNull();
  });
});

describe('rebuilding the index', () => {
  it('posts to the reindex route and rescans so the result is visible', async () => {
    let scans = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      if (path === '/api/skills/reindex') {
        expect(init?.method).toBe('POST');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            scannedWorktrees: 1,
            indexed: 2,
            removed: 1,
            skipped: [],
            unreadableWorktreeIds: [],
          }),
        } as unknown as Response;
      }
      if (path === '/api/skills/installations') {
        scans += 1;
        return {
          ok: true,
          status: 200,
          json: async () => installations(scans === 1 ? [] : [makeEntry()]).body,
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => NO_OPERATIONS.body } as unknown as Response;
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-dashboard-empty');

    fireEvent.click(screen.getByTestId('skill-dashboard-reindex'));

    await screen.findByTestId('skill-dashboard-reindex-result');
    expect(screen.getByTestId('skill-dashboard-reindex-result')).toHaveTextContent('indexed=2');
    await waitFor(() => expect(scans).toBe(2));
    await screen.findByTestId('skill-dashboard-list');
  });

  it('reports a failed rebuild with its code', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()]),
      '/api/skills/operations': NO_OPERATIONS,
      '/api/skills/reindex': {
        status: 500,
        body: { error: 'boom', code: 'SKILL_REINDEX_INTERNAL_ERROR' },
      },
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-dashboard-list');

    fireEvent.click(screen.getByTestId('skill-dashboard-reindex'));

    expect(await screen.findByTestId('skill-dashboard-reindex-error')).toHaveTextContent(
      'SKILL_REINDEX_INTERNAL_ERROR'
    );
  });
});

describe('operation history', () => {
  it('shows the version transition and the source coordinates', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()]),
      '/api/skills/operations': operations([
        makeAudit({ operation: 'uninstall', fromVersion: '1.2.0', toVersion: null }),
      ]),
    });

    render(<SkillInstallationsDashboard />);

    const item = await screen.findByTestId('skill-history-item');
    expect(item).toHaveTextContent('from=1.2.0');
    expect(item).toHaveTextContent('history.operation.uninstall');
    expect(item).toHaveTextContent('a'.repeat(12));
  });

  it('offers a way back to retrying a failed operation', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()]),
      '/api/skills/operations': operations([
        makeAudit({
          result: 'failed',
          errorCode: 'SKILL_INSTALL_CONFLICT',
          errorMessage: 'destination exists',
        }),
      ]),
    });

    render(<SkillInstallationsDashboard />);

    await screen.findByTestId('skill-history-failure');
    expect(screen.getByTestId('skill-history-failure')).toHaveTextContent('SKILL_INSTALL_CONFLICT');
    expect(screen.getByTestId('skill-history-retry')).toHaveAttribute(
      'href',
      '/skills/release-helper'
    );
  });

  it('renders a failed log read as an error, never as an empty log', async () => {
    routeFetch({
      '/api/skills/installations': installations([makeEntry()]),
      '/api/skills/operations': {
        status: 500,
        body: { error: 'boom', code: 'SKILL_OPERATIONS_INTERNAL_ERROR' },
      },
    });

    render(<SkillInstallationsDashboard />);

    await screen.findByTestId('skill-history-error');
    expect(screen.queryByTestId('skill-history-empty')).toBeNull();
  });

  it('refetches when the outcome filter changes', async () => {
    const seen: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/api/skills/operations') {
        seen.push(url);
        return { ok: true, status: 200, json: async () => NO_OPERATIONS.body } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => installations([makeEntry()]).body,
      } as unknown as Response;
    });

    render(<SkillInstallationsDashboard />);
    await screen.findByTestId('skill-history-empty');

    fireEvent.change(screen.getByTestId('skill-history-filter-result'), {
      target: { value: 'failed' },
    });

    await waitFor(() => {
      expect(seen.some((url) => url.includes('result=failed'))).toBe(true);
    });
  });
});
