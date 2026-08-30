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
 *
 * The renders that matter withhold `verification` entirely. A stub state of
 * `{}` — the obvious thing to pass when the pane is mocked — is TRUTHY, so the
 * deleted guard (`verification ? SUB_TABS : SUB_TABS.filter(…)`) returns the
 * full row for it and an assertion made against `{}` passes just as well on
 * develop as on the fix. Only the absent state separates the two.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ACTIVITIES } from '@/config/activity-bar-config';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { WorktreeVerificationState } from '@/hooks/useWorktreeVerification';

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

/** VerificationPane is stubbed, so the state's contents are never read. */
const VERIFICATION = {} as unknown as WorktreeVerificationState;

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

/**
 * The same render with the state WITHHELD — the only shape that can tell the
 * fix from the bug.
 *
 * The cast is deliberate rather than a workaround. #2064 made the prop required
 * so production cannot reach this state; the guard it replaced branched on
 * exactly this state, so a test that cannot produce it pins nothing. Restoring
 * `const subTabs = verification ? SUB_TABS : SUB_TABS.filter(t => t.id !== 'verification')`
 * in `NotesAndLogsPane.tsx` must turn the assertions below red.
 */
const PANE_PROPS_WITHOUT_STATE = {
  ...PANE_PROPS,
  verification: undefined as unknown as WorktreeVerificationState,
};

describe('Verification reachability parity (Issue #2064)', () => {
  // The reference side. It takes no state to decide with — the row is a
  // constant — which is precisely why the mobile side had to stop deciding too.
  // This assertion is not what #2064 changed; it is the thing mobile must match.
  it('the PC Activity Bar always lists Verification', () => {
    expect(ACTIVITIES.map((activity) => activity.id)).toContain('verification');
  });

  it('the mobile Tools tab lists Verification when state is supplied', () => {
    render(<NotesAndLogsPane {...PANE_PROPS} />);
    expect(screen.getByText('schedule.verificationTab')).toBeInTheDocument();
  });

  it('the mobile Tools tab lists Verification with NO state supplied', () => {
    // The deleted guard's own branch. Red against develop, green against #2064.
    render(<NotesAndLogsPane {...PANE_PROPS_WITHOUT_STATE} />);
    expect(screen.getByText('schedule.verificationTab')).toBeInTheDocument();
  });

  it('neither surface can be made to hide it by withholding state', () => {
    const pcOffers = ACTIVITIES.some((activity) => activity.id === 'verification');

    const { unmount } = render(<NotesAndLogsPane {...PANE_PROPS_WITHOUT_STATE} />);
    const mobileOffers = screen.queryByText('schedule.verificationTab') !== null;
    unmount();

    expect(mobileOffers).toBe(pcOffers);
    // Spelled out so a `false === false` parity — both surfaces hiding it —
    // cannot pass as agreement.
    expect(mobileOffers).toBe(true);
  });
});
