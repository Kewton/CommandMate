/**
 * Showing the reasoning effort beside the model (Issue #1784).
 *
 * #1783 put the model on four surfaces under one rule — render it when there is
 * one, render nothing when there is not. This Issue appends "· <effort>" to that
 * string, and the rule it must not break is the second half: the effort is
 * unknown far more often than it is known (no hook publishes one; a Claude
 * banner is gone the moment it scrolls out of tmux's history), so "model with no
 * effort" is the common case and has to keep looking exactly as it did.
 *
 * The formatting lives in one exported function rather than in four JSX
 * expressions, so the pane header, the roster rows, the mobile sheet and the
 * header pill's tooltip cannot drift; this suite drives the function directly
 * and then checks that each surface actually renders what it produced.
 *
 * next-intl is mocked with the REAL `locales/en/*.json` rather than the echo
 * mock in `tests/setup.ts`, which drops interpolation parameters — an assertion
 * that the effort reached a `title` would otherwise pass without it ever being
 * substituted.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import {
  buildModelByInstance,
  DesktopHeader,
  formatAgentModelLabel,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const MODEL = 'gpt-5.6-sol';
const EFFORT = 'xhigh';
const LABEL = 'gpt-5.6-sol · xhigh';

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const ROSTER: AgentInstance[] = [primary('codex', 0, 'Codex')];

// =============================================================================
// The one place the string is built
// =============================================================================

describe('formatAgentModelLabel', () => {
  it('appends the effort when one is known', () => {
    expect(formatAgentModelLabel(MODEL, EFFORT)).toBe(LABEL);
  });

  it('leaves the #1783 string byte-identical when the effort is unknown', () => {
    // The common case, and the regression that would be easiest to ship: a
    // trailing separator on every model-only row.
    expect(formatAgentModelLabel(MODEL, null)).toBe(MODEL);
    expect(formatAgentModelLabel(MODEL, undefined)).toBe(MODEL);
    expect(formatAgentModelLabel(MODEL, '')).toBe(MODEL);
  });

  it('answers null with no model, so every `label && …` guard still reads "show nothing"', () => {
    expect(formatAgentModelLabel(null, EFFORT)).toBeNull();
    expect(formatAgentModelLabel(undefined, undefined)).toBeNull();
    expect(formatAgentModelLabel('', EFFORT)).toBeNull();
  });
});

// =============================================================================
// The projection the roster panes are fed
// =============================================================================

describe('buildModelByInstance', () => {
  it('carries the effort through', () => {
    expect(
      buildModelByInstance({
        codex: {
          isRunning: true,
          isWaitingForResponse: false,
          isProcessing: false,
          model: MODEL,
          reasoningEffort: EFFORT,
        },
      })
    ).toEqual({ codex: LABEL });
  });

  it('keeps a model-only instance on the bare model', () => {
    expect(
      buildModelByInstance({
        codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false, model: MODEL },
      })
    ).toEqual({ codex: MODEL });
  });

  it('drops an instance that has an effort but somehow no model', () => {
    // Unreachable through the API — the resolver cannot produce it — but the
    // projection must not invent a row labelled "· xhigh".
    expect(
      buildModelByInstance({
        codex: {
          isRunning: true,
          isWaitingForResponse: false,
          isProcessing: false,
          reasoningEffort: EFFORT,
        },
      })
    ).toEqual({});
  });
});

// =============================================================================
// The surfaces
// =============================================================================

describe('TerminalSplitPane session title bar', () => {
  function renderPane(agentModel: string | null) {
    return render(
      <TerminalSplitPane
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="codex"
        instanceId="codex"
        instance={primary('codex', 0, 'Codex')}
        availableInstances={ROSTER}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        agentModel={agentModel}
        terminal={<div data-testid="terminal-body">term</div>}
        footer={<div data-testid="footer-body">footer</div>}
      />
    );
  }

  it('shows "<model> · <effort>" and puts the same string in the tooltip', () => {
    renderPane(formatAgentModelLabel(MODEL, EFFORT));
    const badge = screen.getByTestId('split-agent-model-0');
    expect(badge).toHaveTextContent(LABEL);
    expect(badge).toHaveAttribute('title', `Model: ${LABEL}`);
  });

  it('shows the model alone when no effort is known', () => {
    renderPane(formatAgentModelLabel(MODEL, null));
    expect(screen.getByTestId('split-agent-model-0')).toHaveTextContent(MODEL);
    expect(screen.getByTestId('split-agent-model-0').textContent).not.toContain('·');
  });

  it('renders nothing at all when neither is known', () => {
    renderPane(formatAgentModelLabel(null, null));
    expect(screen.queryByTestId('split-agent-model-0')).toBeNull();
  });
});

describe('AgentInstancesPane row', () => {
  it('renders the effort on the model line', () => {
    render(
      <AgentInstancesPane
        instances={ROSTER}
        worktreeId="w-1"
        onInstancesChange={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
        modelByInstance={{ codex: LABEL }}
      />
    );
    expect(screen.getByTestId('agent-instance-model-codex')).toHaveTextContent(LABEL);
  });
});

describe('DesktopHeader instance status pill', () => {
  const baseProps = {
    worktreeName: 'feature/1784',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onBackClick: vi.fn(),
    onInfoClick: vi.fn(),
  };

  function renderHeader(status: Record<string, unknown>) {
    return render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('codex', 0, 'Codex')]}
        sessionStatusByInstance={
          {
            codex: { isRunning: true, isWaitingForResponse: false, isProcessing: true, ...status },
          } as NonNullable<Worktree['sessionStatusByInstance']>
        }
      />
    );
  }

  it('carries the effort in the tooltip, resolved through the real dictionary', () => {
    renderHeader({ model: MODEL, reasoningEffort: EFFORT });
    const pill = screen.getByTestId('desktop-agent-status-codex');
    expect(pill.getAttribute('title')).toContain(LABEL);
    expect(pill.getAttribute('aria-label')).toContain(LABEL);
    expect(pill.getAttribute('title')).not.toContain('statusPillWithModel');
  });

  it('still spends no row width on it — the visible pill text is unchanged', () => {
    // #1783's constraint, restated: MAX_HEADER_AGENT_PILLS budgets this row, so
    // a second visible string per pill would push working instances into the
    // overflow menu.
    const { rerender } = renderHeader({});
    const bare = screen.getByTestId('desktop-agent-status-codex').textContent;
    rerender(
      <DesktopHeader
        {...baseProps}
        instances={[primary('codex', 0, 'Codex')]}
        sessionStatusByInstance={
          {
            codex: {
              isRunning: true,
              isWaitingForResponse: false,
              isProcessing: true,
              model: MODEL,
              reasoningEffort: EFFORT,
            },
          } as NonNullable<Worktree['sessionStatusByInstance']>
        }
      />
    );
    expect(screen.getByTestId('desktop-agent-status-codex').textContent).toBe(bare);
  });
});

describe('MobileAgentInstancesPane row', () => {
  it('renders the effort on the model line', () => {
    render(
      <MobileAgentInstancesPane
        instances={ROSTER}
        worktreeId="w-1"
        onInstancesChange={vi.fn()}
        visibleInstanceIds={['codex']}
        onToggleInstanceVisible={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
        modelByInstance={{ codex: LABEL }}
      />
    );
    expect(screen.getByTestId('mobile-visible-instance-model-codex')).toHaveTextContent(LABEL);
  });
});
