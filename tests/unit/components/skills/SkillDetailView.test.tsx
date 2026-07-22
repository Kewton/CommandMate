/**
 * SkillDetailView (Issue #1232)
 *
 * These tests pin the statements the screen is not allowed to drop: that a
 * declared risk is a claim, that permissions are not enforced, that `unknown`
 * is not `compatible`, and that a Skill which cannot run here says why instead
 * of offering an install.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The changelog renderer pulls in react-markdown and mermaid; the media-stripping
// contract it enforces is covered directly in skill-vocabulary.test.ts.
vi.mock('@/components/worktree/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

import { SkillDetailView } from '@/components/skills/SkillDetailView';
import { makeCatalogMeta, makeIncompatibleSkill, makeSkill, makeUnknownSkill } from './fixtures';
import type { SkillDto } from '@/components/skills/types';

function mockDetail(skill: SkillDto, catalog = makeCatalogMeta()) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ catalog, skill }),
  } as unknown as Response;
}

function mockError(code: string, status: number) {
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

describe('SkillDetailView required fields', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
  });

  it('renders every section a user needs before adopting a Skill', async () => {
    render(<SkillDetailView skillId="release-helper" />);
    await screen.findByTestId('skill-overview-section');

    for (const section of [
      'skill-install-section',
      'skill-capabilities-section',
      'skill-overview-section',
      'skill-compatibility-section',
      'skill-risk-section',
      'skill-permissions-section',
      'skill-requirements-section',
      'skill-contents-section',
      'skill-versions-section',
    ]) {
      expect(screen.getByTestId(section), section).toBeInTheDocument();
    }
  });

  it('shows provider, license, versions, source and package identity', async () => {
    render(<SkillDetailView skillId="release-helper" />);
    const overview = await screen.findByTestId('skill-overview-section');

    expect(overview).toHaveTextContent('CommandMate');
    expect(overview).toHaveTextContent('MIT');
    expect(overview).toHaveTextContent('1.2.0');
    expect(overview).toHaveTextContent('release-helper');

    const version = screen.getByTestId('skill-version-1.2.0');
    expect(version).toHaveTextContent('Kewton/commandmate-skills');
    expect(version).toHaveTextContent('a'.repeat(40));
    expect(version).toHaveTextContent('b'.repeat(64));
    expect(version).toHaveTextContent('release-helper-1.2.0.tar.gz');
    expect(version).toHaveTextContent('2026-07-01T00:00:00Z');
  });

  it('renders the changelog through the shared sanitized preview', async () => {
    render(<SkillDetailView skillId="release-helper" />);
    expect(await screen.findByTestId('markdown-content')).toHaveTextContent(
      'Adds the release checklist step.'
    );
  });

  it('never exposes an artifact URL or an absolute install path', async () => {
    const { container } = render(<SkillDetailView skillId="release-helper" />);
    await screen.findByTestId('skill-overview-section');

    const html = container.innerHTML;
    expect(html).not.toMatch(/releases\/download/);
    expect(html).not.toMatch(/\/Users\//);
    expect(html).not.toMatch(/\.agents\/skills/);
  });

  it('explains the Agent support vocabulary as a publisher claim', async () => {
    render(<SkillDetailView skillId="release-helper" />);
    const section = await screen.findByTestId('skill-compatibility-section');

    expect(section).toHaveTextContent('skills.compatibility.agentsNotice');
    expect(screen.getAllByTestId('skill-agent-claude-native')).not.toHaveLength(0);
  });
});

describe('SkillDetailView risk and permission wording', () => {
  it('separates the publisher declaration from the risk CommandMate computes', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
    render(<SkillDetailView skillId="release-helper" />);
    const section = await screen.findByTestId('skill-risk-section');

    expect(section).toHaveTextContent('skills.risk.declaredNotice');
    expect(screen.getByTestId('skill-computed-risk-unavailable')).toHaveTextContent(
      'skills.risk.computedUnavailable'
    );
  });

  it('states that a declared permission is not an enforcement', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
    render(<SkillDetailView skillId="release-helper" />);

    expect(await screen.findByTestId('skill-permission-declaration-notice')).toHaveTextContent(
      'skills.permissions.declarationOnlyNotice'
    );
  });

  it('warns visibly and in text when the publisher declares high risk', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeIncompatibleSkill()));
    render(<SkillDetailView skillId="future-skill" />);

    expect(await screen.findByTestId('skill-high-risk-warning')).toHaveTextContent(
      'skills.risk.highWarning'
    );
    expect(screen.getAllByTestId('skill-declared-risk-high')).not.toHaveLength(0);
  });

  it('says the Catalog carries no file or script list rather than showing none', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
    render(<SkillDetailView skillId="release-helper" />);

    expect(await screen.findByTestId('skill-contents-section')).toHaveTextContent(
      'skills.contents.unavailable'
    );
    expect(screen.getByTestId('skill-requirements-section')).toHaveTextContent(
      'skills.requirements.unavailable'
    );
  });
});

describe('SkillDetailView install gating', () => {
  it('disables the install path with the compatibility reason when incompatible', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeIncompatibleSkill()));
    render(<SkillDetailView skillId="future-skill" />);

    const action = await screen.findByTestId('skill-install-action');
    expect(action).toBeDisabled();
    expect(screen.getByTestId('skill-install-reason')).toHaveTextContent(
      'skills.detail.install.blockedNoVersion'
    );
  });

  it('reports an unknown verdict as unverified, never as compatible', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeUnknownSkill()));
    render(<SkillDetailView skillId="mystery-skill" />);

    await screen.findByTestId('skill-compatibility-section');
    expect(screen.queryByTestId('skill-compatibility-compatible')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('skill-compatibility-unknown')).not.toHaveLength(0);
    expect(screen.getByTestId('skill-compatibility-unknown-notice')).toHaveTextContent(
      'skills.compatibility.unverifiedNotice'
    );
  });

  it('blocks install on an unknown verdict, quoting the reason', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeUnknownSkill()));
    render(<SkillDetailView skillId="mystery-skill" />);

    const reason = await screen.findByTestId('skill-install-reason');
    expect(reason).toHaveTextContent('skills.detail.install.blockedIncompatible');
    expect(reason).toHaveTextContent('skills.compatibility.reason.rangeUnsupported');
  });

  it('mounts the install flow when the Skill is compatible (Issue #1431)', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
    render(<SkillDetailView skillId="release-helper" />);

    expect(await screen.findByTestId('skill-install-panel')).toBeInTheDocument();
    // Still nothing to install into until a target has been chosen, and the
    // reason says so rather than claiming the feature does not exist.
    expect(screen.getByTestId('skill-install-action')).toBeDisabled();
    expect(screen.getByTestId('skill-install-reason')).toHaveTextContent(
      'skills.plan.chooseTarget'
    );
  });

  it('offers uninstall even for a Skill the Catalog rules out installing', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeIncompatibleSkill()));
    render(<SkillDetailView skillId="future-skill" />);

    await screen.findByTestId('skill-install-panel');
    expect(screen.getByTestId('skill-uninstall-action')).toBeInTheDocument();
  });
});

describe('SkillDetailView failure states', () => {
  it('distinguishes a missing Skill from a Catalog failure', async () => {
    fetchMock.mockResolvedValue(mockError('SKILL_NOT_FOUND', 404));
    render(<SkillDetailView skillId="ghost" />);

    expect(await screen.findByTestId('skill-detail-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-detail-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-detail-retry')).not.toBeInTheDocument();
  });

  it('offers a retry when the Catalog itself could not be loaded', async () => {
    fetchMock.mockResolvedValue(mockError('SKILL_CATALOG_FETCH_FAILED', 503));
    render(<SkillDetailView skillId="release-helper" />);

    expect(await screen.findByTestId('skill-detail-error')).toHaveTextContent(
      'SKILL_CATALOG_FETCH_FAILED'
    );
    expect(screen.getByTestId('skill-detail-retry')).toBeInTheDocument();
  });

  it('surfaces a stale Catalog on the detail screen too', async () => {
    fetchMock.mockResolvedValue(
      mockDetail(
        makeSkill(),
        makeCatalogMeta({
          stale: true,
          offline: false,
          state: 'stale',
          staleReason: 'SKILL_CATALOG_MALFORMED',
        })
      )
    );
    render(<SkillDetailView skillId="release-helper" />);

    expect(await screen.findByTestId('skill-catalog-stale')).toHaveTextContent(
      'skills.catalog.reason.malformed'
    );
  });
});

describe('SkillDetailView mobile layout', () => {
  it('wraps long digests and commits so a 375px viewport has nothing to scroll sideways', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeSkill()));
    render(<SkillDetailView skillId="release-helper" />);
    const version = await screen.findByTestId('skill-version-1.2.0');

    const digest = Array.from(version.querySelectorAll('dd')).find((node) =>
      node.textContent?.includes('b'.repeat(64))
    );
    expect(digest?.className).toContain('break-all');
  });

  it('never places content behind a hover-only reveal', async () => {
    fetchMock.mockResolvedValue(mockDetail(makeIncompatibleSkill()));
    const { container } = render(<SkillDetailView skillId="future-skill" />);
    await screen.findByTestId('skill-risk-section');

    expect(container.querySelectorAll('[class*="opacity-0"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="group-hover:"]')).toHaveLength(0);
  });
});
