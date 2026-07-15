/**
 * @vitest-environment jsdom
 *
 * Issue #1199: OnboardingChecklist display gating and completion latch.
 *
 * The latch is the #1072 regression guard: once every step has been observed
 * complete, the checklist must never come back — not even when kill-session
 * clears `lastUserMessageAt` and re-opens step 2.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnboardingChecklist } from '@/components/home/OnboardingChecklist';
import { ONBOARDING_DISMISSED_KEY } from '@/lib/onboarding';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...rest}>
      {children}
    </a>
  ),
}));

const REPO: RepositorySummary = {
  path: '/repo',
  name: 'repo',
  worktreeCount: 1,
  visible: true,
  enabled: true,
};

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'main',
    path: '/repo',
    repositoryPath: '/repo',
    repositoryName: 'repo',
    ...overrides,
  } as Worktree;
}

/** A worktree that has received a user message (ISO string, as over the wire). */
const MESSAGED = makeWorktree({
  lastUserMessageAt: '2026-07-15T10:00:00.000Z' as unknown as Date,
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OnboardingChecklist — new user (Issue #1199)', () => {
  it('renders with both steps incomplete when there is no data', () => {
    render(<OnboardingChecklist worktrees={[]} repositories={[]} />);

    expect(screen.getByTestId('onboarding-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-step-registerRepository')).toHaveAttribute(
      'data-complete',
      'false'
    );
    expect(screen.getByTestId('onboarding-step-sendFirstMessage')).toHaveAttribute(
      'data-complete',
      'false'
    );
  });

  it('marks step 1 complete once a repository exists', () => {
    render(<OnboardingChecklist worktrees={[makeWorktree()]} repositories={[REPO]} />);

    expect(screen.getByTestId('onboarding-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-step-registerRepository')).toHaveAttribute(
      'data-complete',
      'true'
    );
    expect(screen.getByTestId('onboarding-step-sendFirstMessage')).toHaveAttribute(
      'data-complete',
      'false'
    );
  });

  it('links each step to an existing flow', () => {
    render(<OnboardingChecklist worktrees={[]} repositories={[]} />);

    expect(screen.getByTestId('onboarding-action-registerRepository')).toHaveAttribute(
      'href',
      '/repositories'
    );
    expect(screen.getByTestId('onboarding-action-sendFirstMessage')).toHaveAttribute(
      'href',
      '/sessions'
    );
  });
});

describe('OnboardingChecklist — existing user (Issue #1199)', () => {
  it('never renders for a user who already completed every step', () => {
    render(<OnboardingChecklist worktrees={[MESSAGED]} repositories={[REPO]} />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });

  it('latches completion so it cannot reappear', () => {
    render(<OnboardingChecklist worktrees={[MESSAGED]} repositories={[REPO]} />);

    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe('true');
  });

  it('stays hidden after kill-session clears lastUserMessageAt', () => {
    // First visit: fully onboarded -> latch.
    const { unmount } = render(
      <OnboardingChecklist worktrees={[MESSAGED]} repositories={[REPO]} />
    );
    unmount();

    // kill-session nulls last_user_message_at, re-opening step 2.
    render(<OnboardingChecklist worktrees={[makeWorktree()]} repositories={[REPO]} />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });
});

describe('OnboardingChecklist — dismiss (Issue #1199)', () => {
  it('persists a manual dismiss across remounts', () => {
    const { unmount } = render(
      <OnboardingChecklist worktrees={[]} repositories={[]} />
    );

    fireEvent.click(screen.getByTestId('onboarding-dismiss'));
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe('true');

    unmount();
    render(<OnboardingChecklist worktrees={[]} repositories={[]} />);
    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });

  it('ignores a corrupted localStorage value instead of hiding', () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, '{"__proto__":{"polluted":1}}');

    render(<OnboardingChecklist worktrees={[]} repositories={[]} />);

    expect(screen.getByTestId('onboarding-checklist')).toBeInTheDocument();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('OnboardingChecklist — gating (Issue #1199)', () => {
  it('renders nothing and latches nothing during the first load', () => {
    render(<OnboardingChecklist worktrees={[]} repositories={[]} isLoading />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBeNull();
  });

  it('renders nothing and latches nothing when the worktrees fetch failed', () => {
    // A 500 leaves worktrees empty with isLoading false — an existing user must
    // not be told to register a repository.
    render(
      <OnboardingChecklist
        worktrees={[]}
        repositories={[]}
        error={new Error('boom')}
      />
    );

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBeNull();
  });
});

describe('OnboardingChecklist — hydration (Issue #1199)', () => {
  /**
   * The latch lives in localStorage, which the first render cannot read. render()
   * from RTL flushes effects before asserting, so it cannot see the frame that
   * actually gets painted — renderToString can. If this renders anything, a
   * dismissed user gets a frame of checklist on every warm navigation to Home.
   */
  it('paints nothing before effects run, even when not dismissed', () => {
    const html = renderToString(
      <OnboardingChecklist worktrees={[]} repositories={[]} />
    );

    expect(html).toBe('');
  });
});

describe('OnboardingChecklist — polling (Issue #1199)', () => {
  it('does not write to localStorage on every re-render', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const { rerender } = render(
      <OnboardingChecklist worktrees={[MESSAGED]} repositories={[REPO]} />
    );
    const afterFirstRender = setItem.mock.calls.length;

    // Each poll hands down a fresh array identity with identical content.
    for (let i = 0; i < 5; i++) {
      rerender(
        <OnboardingChecklist worktrees={[{ ...MESSAGED }]} repositories={[{ ...REPO }]} />
      );
    }

    expect(setItem.mock.calls.length).toBe(afterFirstRender);
  });
});
