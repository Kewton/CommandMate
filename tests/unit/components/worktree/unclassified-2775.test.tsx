/**
 * The PC worktree screen draws an unreadable frame as "cannot tell"
 * (Issue #2775): the header's worktree-level dot, its per-instance pills, and
 * the split title bar's dot.
 *
 * Every surface takes the same entry the list API publishes and reads it
 * through `isUnclassifiedCliStatus`, so the fixtures are the helper's own
 * shapes (see `worktree-status-unclassified-2775.test.ts`). The positive
 * `running` case is asserted beside each one: the Issue's hardest constraint is
 * that a running with evidence keeps its glow, byte for byte.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { deriveWorktreeStatus } from '@/components/worktree/WorktreeDetailSubComponents';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());
beforeEach(() => cleanup());

type Entry = NonNullable<Worktree['sessionStatusByInstance']>[string];

const UNCLASSIFIED: Entry = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING: Entry = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

/** An empty alias falls back to the tool's display name ("Codex"). */
function inst(id: string, cliTool: CLIToolType, order = 0): AgentInstance {
  return { id, cliTool, alias: '', order };
}

/** Render the header the way `WorktreeDetailDesktop` does, from one payload. */
function renderHeader(byInstance: Record<string, Entry>, instances: AgentInstance[], activeInstanceId: string) {
  const worktree = {
    id: 'wt-2775',
    name: 'feature/2775',
    path: '/repo/wt',
    repositoryPath: '/repo',
    repositoryName: 'repo',
    sessionStatusByCli: byInstance,
    sessionStatusByInstance: byInstance,
  } as Worktree;
  const active = instances.find((i) => i.id === activeInstanceId)!;
  render(
    <DesktopHeader
      worktreeName="feature/2775"
      repositoryName="repo"
      onInfoClick={vi.fn()}
      status={deriveWorktreeStatus(worktree, false, active.cliTool)}
      sessionStatusByCli={worktree.sessionStatusByCli}
      sessionStatusByInstance={worktree.sessionStatusByInstance}
      instances={instances}
      activeInstanceId={activeInstanceId}
      onActiveInstanceChange={vi.fn()}
    />,
  );
}

/** The StatusDot inside one agent pill / dot button. */
function agentDot(instanceId: string): HTMLElement {
  const button = screen.getByTestId(`desktop-agent-status-${instanceId}`);
  return button.querySelector('span.rounded-full') as HTMLElement;
}

describe('[#2775] DesktopHeader', () => {
  it('the worktree-level dot reads "cannot tell" for an unclassified active session', () => {
    renderHeader({ codex: UNCLASSIFIED }, [inst('codex', 'codex')], 'codex');
    const dot = screen.getByTestId('desktop-status-indicator');

    expect(dot.className).not.toMatch(/animate-status-glow/);
    expect(dot.className).not.toMatch(/bg-success/);
    expect(dot.className).toContain('bg-transparent');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.getAttribute('aria-label')).toBe('Unknown');
  });

  it('the worktree-level dot keeps its glow and wording for a positive running', () => {
    renderHeader({ codex: THINKING }, [inst('codex', 'codex')], 'codex');
    const dot = screen.getByTestId('desktop-status-indicator');

    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.className).toMatch(/bg-success/);
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('aria-label')).toBe('Running - Processing');
  });

  it('an unclassified pill is worded Unknown and drawn as the ring; a working one is untouched', () => {
    renderHeader(
      { codex: UNCLASSIFIED, claude: THINKING },
      [inst('codex', 'codex', 0), inst('claude', 'claude', 1)],
      'codex',
    );

    const codex = screen.getByTestId('desktop-agent-status-codex');
    expect(within(codex).getByText('Codex: Unknown')).toBeInTheDocument();
    expect(agentDot('codex').className).toContain('bg-transparent');
    expect(agentDot('codex').className).not.toMatch(/animate-status-glow/);

    const claude = screen.getByTestId('desktop-agent-status-claude');
    expect(within(claude).getByText('Claude: Running')).toBeInTheDocument();
    expect(agentDot('claude').className).toMatch(/animate-status-glow/);
    expect(agentDot('claude').className).not.toContain('bg-transparent');
  });

  it('an inactive unclassified instance collapses to an icon dot labelled Unknown', () => {
    renderHeader(
      { codex: UNCLASSIFIED, claude: THINKING },
      [inst('claude', 'claude', 0), inst('codex', 'codex', 1)],
      'claude',
    );

    expect(screen.getByTestId('desktop-agent-status-codex')).toHaveAttribute('aria-label', 'Codex: Unknown');
    expect(agentDot('codex').className).toContain('bg-transparent');
  });
});

describe('[#2775] TerminalSplitPane title-bar dot', () => {
  function renderPane(props: Partial<React.ComponentProps<typeof TerminalSplitPane>>) {
    render(
      <TerminalSplitPane
        worktreeId="wt-2775"
        splitIndex={0}
        cliToolId="codex"
        instanceId="codex"
        instance={inst('codex', 'codex')}
        availableInstances={[inst('codex', 'codex')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        terminal={<div />}
        footer={<div />}
        {...props}
      />,
    );
    return screen.getByTestId('split-status-indicator-0');
  }

  it('draws the ring and titles it Unknown for an unclassified ready', () => {
    const dot = renderPane({ status: 'ready', statusUnclassified: true });

    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).not.toMatch(/animate-status-glow/);
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.getAttribute('title')).toBe('Unknown');
  });

  it('leaves a running dot glowing whatever the flag says', () => {
    const dot = renderPane({ status: 'running', statusUnclassified: true });

    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('title')).toBe('Running');
  });

  it('is unchanged when the flag is absent', () => {
    const dot = renderPane({ status: 'ready' });

    expect(dot.className).toMatch(/bg-success/);
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('title')).toBe('Ready');
  });
});
