/**
 * Verification reachability parity, PC vs mobile (Issue #2064)
 * @vitest-environment jsdom
 *
 * The two shells offer Verification through different furniture — the PC
 * Activity Bar's icon column, the mobile Tools tab's sub-tab row — and before
 * #2064 they disagreed about *whether* it was offered at all: the PC entry is a
 * static row of `ACTIVITIES`, while the mobile row filtered its `verification`
 * tab out whenever the caller supplied no verification state.
 *
 * This file pins the two together at the level the user experiences: can I get
 * to Verification from this screen? A future change that hides one side has to
 * hide the other, or fail here.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ACTIVITIES } from '@/config/activity-bar-config';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/MemoPane', () => ({
  MemoPane: () => <div data-testid="memo-pane" />,
}));
vi.mock('@/components/worktree/ExecutionLogPane', () => ({
  ExecutionLogPane: () => <div data-testid="execution-log-pane" />,
}));
vi.mock('@/components/worktree/AgentSettingsPane', () => ({
  AgentSettingsPane: () => <div data-testid="agent-settings-pane" />,
}));
vi.mock('@/components/worktree/VerificationPane', () => ({
  VerificationPane: () => <div data-testid="verification-pane-stub" />,
}));
vi.mock('@/components/skills/WorktreeSkillsPane', () => ({
  WorktreeSkillsPane: () => <div data-testid="worktree-skills-pane" />,
}));
vi.mock('@/components/worktree/MobileAgentInstancesPane', () => ({
  MobileAgentInstancesPane: () => <div data-testid="mobile-agent-instances-pane" />,
}));

/** VerificationPane is stubbed, so only the object's presence matters. */
const VERIFICATION = {} as never;

const PANE_PROPS = {
  worktreeId: 'wt-1',
  selectedAgents: ['claude'] as CLIToolType[],
  onSelectedAgentsChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
  verification: VERIFICATION,
};

describe('Verification reachability parity (Issue #2064)', () => {
  it('the PC Activity Bar always lists Verification', () => {
    expect(ACTIVITIES.map((activity) => activity.id)).toContain('verification');
  });

  it('the mobile Tools tab always lists Verification too', () => {
    render(<NotesAndLogsPane {...PANE_PROPS} />);
    expect(screen.getByText('schedule.verificationTab')).toBeInTheDocument();
  });

  it('neither surface can be made to hide it by withholding state', () => {
    // The PC side takes no state to decide with — the row is a constant. The
    // mobile side used to take an optional `verification` and filter the tab
    // out when it was absent; #2064 made the prop required, so "withholding
    // state" is no longer expressible. Asserting that here keeps the intent
    // visible if someone makes the prop optional again: this render is the one
    // that would then need a `verification` of its own to stay honest.
    const pcOffers = ACTIVITIES.some((activity) => activity.id === 'verification');

    const { unmount } = render(<NotesAndLogsPane {...PANE_PROPS} />);
    const mobileOffers = screen.queryByText('schedule.verificationTab') !== null;
    unmount();

    expect(mobileOffers).toBe(pcOffers);
  });
});
