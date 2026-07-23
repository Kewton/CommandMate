/**
 * Palette refresh after a Skill install (Issue #1477)
 *
 * The regression: installing a Skill wrote the command to disk and the API
 * returned it, but the slash-command palette — mounted in a separate component
 * tree — kept showing the pre-install set until a full page reload. Nothing
 * bridged the install flow and the palette's data.
 *
 * This test wires the real {@link SkillInstallPanel} to a real palette
 * (`useSlashCommands` → `SlashCommandSelector` → `SlashCommandList`, the exact
 * composition MessageInput uses) and drives an install end to end. It asserts
 * the newly installed command actually appears in the palette DOM — not merely
 * that a refetch fired or that hook state changed.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

import { SkillInstallPanel } from '@/components/skills/SkillInstallPanel';
import { SlashCommandSelector } from '@/components/worktree/SlashCommandSelector';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import type { SlashCommandGroup } from '@/types/slash-commands';
import { makeInstallPlan, makeInstallResponse } from './fixtures';

const WORKTREE_ID = 'demo-wt';

/** What the palette API returns before the install: the skill is absent. */
const BASE_GROUPS: SlashCommandGroup[] = [
  {
    category: 'development',
    label: 'Development',
    commands: [
      {
        name: 'tdd-impl',
        description: 'Test-driven development',
        category: 'development',
        source: 'standard',
        filePath: '.claude/commands/tdd-impl.md',
      },
    ],
  },
];

/** What it returns after the install lands: the skill is now a command. */
const GROUPS_WITH_SKILL: SlashCommandGroup[] = [
  ...BASE_GROUPS,
  {
    category: 'skill',
    label: 'Skills',
    commands: [
      {
        name: 'release-helper',
        description: 'Walks an agent through the release checklist.',
        category: 'skill',
        source: 'skill',
        filePath: '.claude/skills/release-helper/SKILL.md',
      },
    ],
  },
];

/** A real palette: hook → selector → list, the same wiring MessageInput uses. */
function Palette() {
  const { groups } = useSlashCommands(WORKTREE_ID);
  return <SlashCommandSelector isOpen groups={groups} onSelect={() => {}} onClose={() => {}} />;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Skill install refreshes the palette (Issue #1477)', () => {
  it('surfaces the installed skill in the palette DOM without a reload', async () => {
    // The palette API answers with the skill only once the install has run.
    let installed = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/slash-commands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ groups: installed ? GROUPS_WITH_SKILL : BASE_GROUPS }),
        } as unknown as Response;
      }
      if (url.endsWith('/plan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ plan: makeInstallPlan() }),
        } as unknown as Response;
      }
      if (url.endsWith('/install')) {
        installed = true;
        return {
          ok: true,
          status: 200,
          json: async () => makeInstallResponse(),
        } as unknown as Response;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(
      <>
        <Palette />
        <SkillInstallPanel
          skillId="release-helper"
          version="1.2.0"
          blockedReason={null}
          worktreeId={WORKTREE_ID}
        />
      </>
    );

    // The palette renders its pre-install commands, and the skill is absent.
    expect(await screen.findByText('/tdd-impl')).toBeInTheDocument();
    expect(screen.queryByText('/release-helper')).not.toBeInTheDocument();

    // Walk the real install flow: build a plan, then apply it.
    fireEvent.click(screen.getByTestId('skill-install-action'));
    fireEvent.click(await screen.findByTestId('skill-install-confirm'));
    await screen.findByTestId('skill-install-result');

    // The install signalled the palette, which refetched and now lists the
    // command as a selectable row in the DOM.
    expect(await screen.findByText('/release-helper')).toBeInTheDocument();
  });
});
