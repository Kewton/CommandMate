/**
 * SkillTargetSelector (Issue #1233)
 *
 * The screen's job is to make "which checkout am I about to modify?" answerable
 * before anything is written, so the tests assert that each target names its
 * repository, branch, agents and working tree state — and that a state nobody
 * inspected is reported as unknown rather than rendered as clean.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations:
    (namespace?: string) =>
    (key: string) => (namespace ? `${namespace}.${key}` : key),
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { SkillTargetSelector, toSkillTargetOption } from '@/components/skills/SkillTargetSelector';
import type { Worktree } from '@/types/models';

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'demo-wt',
    name: 'feature/demo',
    path: '/srv/worktrees/demo',
    repositoryPath: '/srv/repos/CommandMate',
    repositoryName: 'CommandMate',
    branch: 'feature/demo',
    ...overrides,
  };
}

function listResponse(worktrees: Worktree[]) {
  return { ok: true, status: 200, json: async () => ({ worktrees }) } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toSkillTargetOption', () => {
  it('keeps the synced and live branch distinct', () => {
    const option = toSkillTargetOption(
      makeWorktree({
        branch: 'feature/demo',
        gitStatus: {
          currentBranch: 'feature/other',
          initialBranch: 'feature/demo',
          isBranchMismatch: true,
          commitHash: 'abc1234',
          isDirty: true,
        },
      })
    );
    expect(option).toMatchObject({
      syncedBranch: 'feature/demo',
      liveBranch: 'feature/other',
      dirty: true,
    });
  });

  it('reports an uninspected working tree as unknown rather than clean', () => {
    expect(toSkillTargetOption(makeWorktree()).dirty).toBeNull();
  });

  it('prefers agent instance aliases and de-duplicates them', () => {
    const option = toSkillTargetOption(
      makeWorktree({
        agentInstances: [
          { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
          { id: 'claude-2', cliTool: 'claude', alias: 'Claude', order: 1 },
          { id: 'codex', cliTool: 'codex', alias: '', order: 2 },
        ],
      })
    );
    expect(option.agents).toEqual(['Claude', 'codex']);
  });

  it('falls back to the selected agents when no roster exists', () => {
    expect(toSkillTargetOption(makeWorktree({ selectedAgents: ['claude', 'codex'] })).agents).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('prefers the repository display alias over the raw name', () => {
    expect(
      toSkillTargetOption(makeWorktree({ repositoryDisplayName: 'My Project' })).repositoryName
    ).toBe('My Project');
  });
});

describe('SkillTargetSelector', () => {
  it('lists each registered worktree with its repository, branch and agents', async () => {
    fetchMock.mockResolvedValue(
      listResponse([makeWorktree({ selectedAgents: ['claude'] }), makeWorktree({ id: 'other-wt', name: 'main' })])
    );
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-selector')).toBeTruthy());
    expect(screen.getByTestId('skill-target-option-demo-wt').textContent).toContain('CommandMate');
    expect(screen.getByTestId('skill-target-option-demo-wt').textContent).toContain('feature/demo');
    expect(screen.getByTestId('skill-target-option-demo-wt').textContent).toContain('claude');
    expect(screen.getByTestId('skill-target-option-other-wt')).toBeTruthy();
  });

  it('renders no filesystem path', async () => {
    fetchMock.mockResolvedValue(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-selector')).toBeTruthy());
    expect(document.body.textContent).not.toContain('/srv/worktrees/demo');
  });

  it('reports an uninspected working tree distinctly from a clean one', async () => {
    fetchMock.mockResolvedValue(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-option-demo-wt')).toBeTruthy());
    const text = screen.getByTestId('skill-target-option-demo-wt').textContent ?? '';
    expect(text).toContain('skills.target.workingTreeUnknown');
    expect(text).not.toContain('skills.target.workingTreeClean');
  });

  it('emits the worktree ID and nothing else on selection', async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValue(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-option-demo-wt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('skill-target-option-demo-wt'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('demo-wt');
  });

  it('exposes exactly one selected radio, so two targets cannot be chosen', async () => {
    fetchMock.mockResolvedValue(
      listResponse([makeWorktree(), makeWorktree({ id: 'other-wt', name: 'main' })])
    );
    render(<SkillTargetSelector selectedWorktreeId="demo-wt" onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-selector')).toBeTruthy());
    const checked = screen.getAllByRole('radio').filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].getAttribute('data-testid')).toBe('skill-target-option-demo-wt');
  });

  it('does not select while disabled', async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValue(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={onSelect} disabled />);

    await waitFor(() => expect(screen.getByTestId('skill-target-option-demo-wt')).toBeTruthy());
    fireEvent.click(screen.getByTestId('skill-target-option-demo-wt'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('states that the listed branch may lag the live one', async () => {
    fetchMock.mockResolvedValue(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('skill-target-branch-notice')).toBeTruthy());
  });

  it('distinguishes a failed load from an empty list', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { unmount } = render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('skill-target-error')).toBeTruthy());
    expect(screen.queryByTestId('skill-target-empty')).toBeNull();
    unmount();

    fetchMock.mockResolvedValue(listResponse([]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('skill-target-empty')).toBeTruthy());
    expect(screen.queryByTestId('skill-target-error')).toBeNull();
  });

  it('retries after a failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    fetchMock.mockResolvedValueOnce(listResponse([makeWorktree()]));
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('skill-target-retry')).toBeTruthy());
    fireEvent.click(screen.getByTestId('skill-target-retry'));
    await waitFor(() => expect(screen.getByTestId('skill-target-option-demo-wt')).toBeTruthy());
  });

  it('treats a malformed list as a failure rather than an empty Catalog', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    render(<SkillTargetSelector selectedWorktreeId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('skill-target-error')).toBeTruthy());
  });
});
