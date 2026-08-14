/**
 * Showing the model on the worktree detail screen (Issue #1783).
 *
 * Four surfaces, one rule: **render the model when there is one, and render
 * nothing at all when there is not**. The second half is the part worth testing.
 * Most sessions never report a model — gemini and copilot never send one, and
 * neither does any tool whose hooks are not configured — so a component that
 * falls back to "Unknown" puts a permanent, meaningless badge on every row of
 * the busiest screen in the app.
 *
 * next-intl is mocked with the REAL `locales/en/*.json` rather than the echo
 * mock in `tests/setup.ts`. The echo mock drops interpolation parameters, so
 * `t('detail.statusPillWithModel', { model })` would come back as the bare key
 * and an assertion that the model reached the label would pass without the
 * model ever being substituted.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import {
  DesktopHeader,
  buildModelByInstance,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const MODEL = 'claude-opus-5[1m]';

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const ROSTER: AgentInstance[] = [
  primary('claude', 0, 'Claude'),
  primary('codex', 1, 'Codex'),
];

// =============================================================================
// The primary surface: the split's session title bar
// =============================================================================

describe('TerminalSplitPane session title bar', () => {
  function renderPane(agentModel?: string | null) {
    return render(
      <TerminalSplitPane
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={primary('claude', 0, 'Claude')}
        availableInstances={ROSTER}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        agentModel={agentModel}
        terminal={<div data-testid="terminal-body">term</div>}
        footer={<div data-testid="footer-body">footer</div>}
      />
    );
  }

  it('renders the model beside the alias when one is known', () => {
    renderPane(MODEL);
    const badge = screen.getByTestId('split-agent-model-0');
    // The literal value the agent sent, `[1m]` suffix and all — the tool's
    // spelling is not parsed, reformatted or stripped.
    expect(badge.textContent).toBe(MODEL);
  });

  it('renders nothing when the model is null', () => {
    renderPane(null);
    expect(screen.queryByTestId('split-agent-model-0')).toBeNull();
  });

  it('renders nothing when the prop is omitted entirely', () => {
    renderPane(undefined);
    expect(screen.queryByTestId('split-agent-model-0')).toBeNull();
  });

  it('renders nothing for an empty string, which is not a model', () => {
    renderPane('');
    expect(screen.queryByTestId('split-agent-model-0')).toBeNull();
  });

  it('leaves the alias in the selector trigger untouched', () => {
    // The model is a sibling of the selector, not a second string inside its
    // `max-w-[12rem]` trigger — folding it in would eat the alias.
    renderPane(MODEL);
    const trigger = screen.getByTestId('cli-selector-0');
    expect(trigger.textContent).toContain('Claude');
    expect(trigger.textContent).not.toContain(MODEL);
  });
});

// =============================================================================
// The header status row: tooltip only
// =============================================================================

describe('DesktopHeader instance status pill', () => {
  const baseProps = {
    worktreeName: 'feature/1783',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onBackClick: vi.fn(),
    onInfoClick: vi.fn(),
  };

  /** A per-instance status map with the flags a working (pill) instance has. */
  function statusMap(
    model?: string | null
  ): NonNullable<Worktree['sessionStatusByInstance']> {
    return {
      claude: {
        isRunning: true,
        isWaitingForResponse: false,
        isProcessing: true,
        ...(model !== undefined ? { model } : {}),
      },
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('puts the model in the pill tooltip, resolved through the real dictionary', () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('claude', 0, 'Claude')]}
        sessionStatusByInstance={statusMap(MODEL)}
      />
    );

    const pill = screen.getByTestId('desktop-agent-status-claude');
    expect(pill.getAttribute('title')).toContain(MODEL);
    expect(pill.getAttribute('aria-label')).toContain(MODEL);
    // The dictionary entry is a real sentence, not the key echoed back.
    expect(pill.getAttribute('title')).not.toContain('statusPillWithModel');
  });

  it('does not spend row width on it — the visible pill text is unchanged', () => {
    const { rerender } = render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('claude', 0, 'Claude')]}
        sessionStatusByInstance={statusMap(null)}
      />
    );
    const withoutModel = screen.getByTestId('desktop-agent-status-claude').textContent;

    rerender(
      <DesktopHeader
        {...baseProps}
        instances={[primary('claude', 0, 'Claude')]}
        sessionStatusByInstance={statusMap(MODEL)}
      />
    );
    const withModel = screen.getByTestId('desktop-agent-status-claude').textContent;

    expect(withModel).toBe(withoutModel);
    expect(withModel).not.toContain(MODEL);
  });

  it('leaves the label byte-identical to pre-#1783 when no model is known', () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('claude', 0, 'Claude')]}
        sessionStatusByInstance={statusMap(null)}
      />
    );
    const pill = screen.getByTestId('desktop-agent-status-claude');
    // `{label}: {status}` with no trailing model clause and no dangling
    // punctuation from an interpolation that was handed an empty string.
    expect(pill.getAttribute('aria-label')).toBe('Claude: Running');
  });

  it('carries the model on the idle icon-only variant too', () => {
    render(
      <DesktopHeader
        {...baseProps}
        instances={[primary('claude', 0, 'Claude')]}
        sessionStatusByInstance={{
          claude: {
            isRunning: false,
            isWaitingForResponse: false,
            isProcessing: false,
            model: MODEL,
          },
        }}
      />
    );
    // Idle instances collapse to a dot whose only affordance is the tooltip.
    expect(
      screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')
    ).toContain(MODEL);
  });
});

// =============================================================================
// The roster panes
// =============================================================================

describe('AgentInstancesPane roster rows', () => {
  const baseProps = {
    worktreeId: 'w-1',
    instances: ROSTER,
    onInstancesChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
  };

  it('shows the model only for the instances that reported one', () => {
    render(<AgentInstancesPane {...baseProps} modelByInstance={{ claude: MODEL }} />);

    expect(screen.getByTestId('agent-instance-model-claude').textContent).toBe(MODEL);
    // codex is on the same roster and reported nothing. No row, no placeholder.
    expect(screen.queryByTestId('agent-instance-model-codex')).toBeNull();
  });

  it('renders no model row at all when the prop is omitted', () => {
    render(<AgentInstancesPane {...baseProps} />);
    expect(screen.queryByTestId('agent-instance-model-claude')).toBeNull();
    expect(screen.queryByTestId('agent-instance-model-codex')).toBeNull();
  });

  it('treats an explicit null the same as an absent entry', () => {
    render(<AgentInstancesPane {...baseProps} modelByInstance={{ claude: null }} />);
    expect(screen.queryByTestId('agent-instance-model-claude')).toBeNull();
  });

  it('keeps the alias input and the base-tool line intact', () => {
    // The model is a third line, not a replacement for either of the two the
    // roster editor already had.
    render(<AgentInstancesPane {...baseProps} modelByInstance={{ claude: MODEL }} />);
    expect(screen.getByTestId('agent-instance-alias-claude')).toBeDefined();
    // The alias lives in an <input> (no textContent), so what the row renders
    // as text is exactly the base-tool line followed by the new model line.
    expect(screen.getByTestId('agent-instance-row-claude').textContent).toBe(
      `${getCliToolDisplayName('claude')}${MODEL}`
    );
  });
});

describe('MobileAgentInstancesPane visibility rows', () => {
  const baseProps = {
    worktreeId: 'w-1',
    instances: ROSTER,
    onInstancesChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
    visibleInstanceIds: ['claude', 'codex'],
    onToggleInstanceVisible: vi.fn(),
  };

  it('adds the model as a third line under alias + tool name', () => {
    render(<MobileAgentInstancesPane {...baseProps} modelByInstance={{ claude: MODEL }} />);
    expect(screen.getByTestId('mobile-visible-instance-model-claude').textContent).toBe(MODEL);
    expect(screen.queryByTestId('mobile-visible-instance-model-codex')).toBeNull();
  });

  it('threads the map into the shared roster editor it wraps', () => {
    // The mobile pane renders AgentInstancesPane for the roster itself; a
    // pass-through that was forgotten would leave the shared editor blank on
    // mobile only.
    render(<MobileAgentInstancesPane {...baseProps} modelByInstance={{ claude: MODEL }} />);
    expect(screen.getByTestId('agent-instance-model-claude').textContent).toBe(MODEL);
  });

  it('renders nothing anywhere when no model is known', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    expect(screen.queryByTestId('mobile-visible-instance-model-claude')).toBeNull();
    expect(screen.queryByTestId('agent-instance-model-claude')).toBeNull();
  });
});

// =============================================================================
// The projection the panes are fed
// =============================================================================

describe('buildModelByInstance', () => {
  it('drops the status shape and keeps only instances with a model', () => {
    expect(
      buildModelByInstance({
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false, model: MODEL },
        codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        gemini: { isRunning: false, isWaitingForResponse: false, isProcessing: false, model: null },
      })
    ).toEqual({ claude: MODEL });
  });

  it('answers an empty object rather than undefined for a worktree with no status map', () => {
    expect(buildModelByInstance(undefined)).toEqual({});
  });
});

// =============================================================================
// Both locales carry the wording
// =============================================================================

describe('dictionary parity', () => {
  const keys: Array<[string, string]> = [
    ['detail', 'statusPillWithModel'],
    ['agentModel', 'label'],
    ['agentModel', 'modelLabel'],
  ];

  it.each(['en', 'ja'])('%s/worktree.json defines every model string', (locale) => {
    const dict = JSON.parse(
      readFileSync(join(process.cwd(), 'locales', locale, 'worktree.json'), 'utf8')
    ) as Record<string, Record<string, string>>;

    for (const [namespace, key] of keys) {
      expect(typeof dict[namespace]?.[key], `${locale} ${namespace}.${key}`).toBe('string');
    }
    // The two interpolated entries must actually keep their placeholders, or a
    // translation drops the value silently.
    expect(dict.detail.statusPillWithModel).toContain('{model}');
    expect(dict.agentModel.modelLabel).toContain('{model}');
  });
});
