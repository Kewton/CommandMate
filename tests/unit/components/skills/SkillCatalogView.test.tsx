/**
 * SkillCatalogView (Issue #1232)
 *
 * The load states are the point of these tests: a Catalog that failed to load
 * and a Catalog that is genuinely empty must never render the same way, and a
 * stale snapshot must never render as current.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The global next-intl mock in tests/setup.ts drops interpolation params, which
// would hide exactly the values these tests care about (the failure code, the
// result counts). This variant renders them so an assertion can see them.
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

import { SkillCatalogView } from '@/components/skills/SkillCatalogView';
import { makeCatalogMeta, makeIncompatibleSkill, makeSkill, makeUnknownSkill } from './fixtures';
import type { SkillDto } from '@/components/skills/types';

function mockListResponse(skills: SkillDto[], catalog = makeCatalogMeta()) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ catalog, skills }),
  } as unknown as Response;
}

function mockErrorResponse(code: string, status = 503) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'boom', code }),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillCatalogView loading', () => {
  it('shows a loading state before the Catalog resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SkillCatalogView />);
    expect(screen.getByTestId('skill-catalog-loading')).toBeInTheDocument();
  });
});

describe('SkillCatalogView error state', () => {
  it('reports a retrieval failure instead of rendering an empty Catalog', async () => {
    fetchMock.mockResolvedValue(mockErrorResponse('SKILL_CATALOG_FETCH_FAILED'));
    render(<SkillCatalogView />);

    expect(await screen.findByTestId('skill-catalog-error')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-catalog-empty')).not.toBeInTheDocument();
    expect(screen.getByText(/SKILL_CATALOG_FETCH_FAILED/)).toBeInTheDocument();
  });

  it('surfaces a transport failure the same way, with a retry that refetches', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    fetchMock.mockResolvedValueOnce(mockListResponse([makeSkill()]));
    render(<SkillCatalogView />);

    fireEvent.click(await screen.findByTestId('skill-catalog-retry'));

    expect(await screen.findByTestId('skill-card-release-helper')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SkillCatalogView empty state', () => {
  it('distinguishes a genuinely empty Catalog from a failure', async () => {
    fetchMock.mockResolvedValue(mockListResponse([]));
    render(<SkillCatalogView />);

    expect(await screen.findByTestId('skill-catalog-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-catalog-error')).not.toBeInTheDocument();
  });
});

describe('SkillCatalogView freshness', () => {
  it('announces a stale/offline snapshot with its reason rather than as current', async () => {
    fetchMock.mockResolvedValue(
      mockListResponse(
        [makeSkill()],
        makeCatalogMeta({
          stale: true,
          offline: true,
          state: 'stale',
          staleReason: 'SKILL_CATALOG_RATE_LIMITED',
        })
      )
    );
    render(<SkillCatalogView />);

    const banner = await screen.findByTestId('skill-catalog-stale');
    expect(banner).toHaveTextContent('skills.catalog.staleHeading');
    expect(banner).toHaveTextContent('skills.catalog.offlineNotice');
    expect(banner).toHaveTextContent('skills.catalog.reason.rateLimited');
    expect(screen.queryByTestId('skill-catalog-fresh')).not.toBeInTheDocument();
  });

  it('marks a confirmed-current Catalog as such', async () => {
    fetchMock.mockResolvedValue(mockListResponse([makeSkill()]));
    render(<SkillCatalogView />);

    expect(await screen.findByTestId('skill-catalog-fresh')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-catalog-stale')).not.toBeInTheDocument();
  });
});

describe('SkillCatalogView list rendering', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      mockListResponse([makeSkill(), makeIncompatibleSkill(), makeUnknownSkill()])
    );
  });

  it('renders every entry with its compatibility and declared-risk badge', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    expect(screen.getByTestId('skill-card-future-skill')).toBeInTheDocument();
    expect(screen.getByTestId('skill-card-mystery-skill')).toBeInTheDocument();
    expect(screen.getAllByTestId('skill-compatibility-incompatible')).not.toHaveLength(0);
    expect(screen.getAllByTestId('skill-declared-risk-high')).not.toHaveLength(0);
  });

  it('never labels an unknown verdict as compatible', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-mystery-skill');

    const unknownBadge = screen.getByTestId('skill-compatibility-unknown');
    expect(unknownBadge).toHaveTextContent('skills.compatibility.status.unknown');
    expect(unknownBadge).not.toHaveTextContent('skills.compatibility.status.compatible');
  });

  it('links each card to its detail route', async () => {
    render(<SkillCatalogView />);
    const card = await screen.findByTestId('skill-card-release-helper');
    expect(card).toHaveAttribute('href', '/skills/release-helper');
  });

  it('reports how many of the total are shown', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');
    expect(screen.getByTestId('skill-result-count')).toHaveTextContent('shown=3,total=3');
  });
});

describe('SkillCatalogView search and filters', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      mockListResponse([makeSkill(), makeIncompatibleSkill(), makeUnknownSkill()])
    );
  });

  it('narrows the list by free-text search', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    fireEvent.change(screen.getByTestId('skill-search-input'), { target: { value: 'mystery' } });

    await waitFor(() => {
      expect(screen.queryByTestId('skill-card-release-helper')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('skill-card-mystery-skill')).toBeInTheDocument();
  });

  it('excludes unknown-compatibility entries from the compatible filter', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    fireEvent.change(screen.getByTestId('skill-filter-compatibility'), {
      target: { value: 'compatible' },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('skill-card-mystery-skill')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('skill-card-future-skill')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-card-release-helper')).toBeInTheDocument();
  });

  it('filters by declared risk', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    fireEvent.change(screen.getByTestId('skill-filter-risk'), { target: { value: 'high' } });

    await waitFor(() => {
      expect(screen.queryByTestId('skill-card-release-helper')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('skill-card-future-skill')).toBeInTheDocument();
  });

  it('shows a no-match state that is not the empty-Catalog state', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    fireEvent.change(screen.getByTestId('skill-search-input'), { target: { value: 'nothing' } });

    expect(await screen.findByTestId('skill-catalog-no-results')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-catalog-empty')).not.toBeInTheDocument();
  });

  it('restores the full list when the filters are reset', async () => {
    render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-release-helper');

    fireEvent.change(screen.getByTestId('skill-search-input'), { target: { value: 'nothing' } });
    await screen.findByTestId('skill-catalog-no-results');

    fireEvent.click(screen.getByTestId('skill-filter-reset'));

    expect(await screen.findByTestId('skill-card-release-helper')).toBeInTheDocument();
    expect(screen.getByTestId('skill-card-future-skill')).toBeInTheDocument();
  });
});

describe('SkillCatalogView touch accessibility', () => {
  it('never hides a badge or warning behind a hover-only class', async () => {
    fetchMock.mockResolvedValue(mockListResponse([makeIncompatibleSkill()]));
    const { container } = render(<SkillCatalogView />);
    await screen.findByTestId('skill-card-future-skill');

    expect(container.querySelectorAll('[class*="opacity-0"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="group-hover:opacity"]')).toHaveLength(0);
  });
});
