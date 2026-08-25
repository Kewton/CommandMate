/**
 * Showing what a session costs and how full it is (Issue #2042).
 *
 * The Issue's two acceptance criteria are what this file is organised around:
 *
 *  1. **opencode's numbers must be opencode's numbers.** The fixtures here are
 *    the ones measured off a live 1.18.22 session
 *    (`docs/design/opencode-server-live-verification.md` §14): `$0.03`,
 *    `8.5K (1%)` on the footer, `17.0K` and `$0.03` from `opencode stats`. Both
 *    figures are in the payload and they are **different numbers for different
 *    questions** — the chip shows the context one, the tooltip labels both.
 *  2. **claude must be untouched.** Every tool but opencode publishes no session
 *    at all, so every surface here has to render byte-identically to pre-#2042.
 *    That is asserted by rendering the same component with and without the new
 *    props and comparing the DOM, not by eyeballing a snapshot file.
 *
 * next-intl is mocked with the REAL `locales/en/*.json` rather than the echo
 * mock in `tests/setup.ts`, which drops interpolation parameters — a `1%` that
 * never reached the template would otherwise pass.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import {
  DesktopHeader,
  formatAgentModelLabel,
  formatAgentSessionCost,
  formatAgentSessionTooltip,
  formatAgentSessionUsage,
  formatAgentTokenCount,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { sumAgentSessionTokens, type AgentSessionSnapshot } from '@/types/agent-session';
import { getCliToolDisplayName, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { createRealIntlMock } from '@tests/helpers/real-intl';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

/**
 * The live session, exactly as the server publishes it after two turns.
 *
 * `tokens` are the session's cumulative counts (`opencode stats`: input 6,
 * output 11, cache read 8.5K, cache write 8.5K → 17.0K); `context.tokens` is the
 * last assistant turn's footprint, which is what the TUI's own footer shows.
 */
const MEASURED: AgentSessionSnapshot = {
  session: {
    id: 'ses_measured',
    title: 'One-word response: PONG',
    agent: 'build',
    model: 'claude-sonnet-4.6',
    provider: 'github-copilot',
    cost: 0.0346026,
    tokens: {
      input: 6,
      output: 11,
      reasoning: 0,
      cacheRead: 8482,
      cacheWrite: 8500,
      total: null,
    },
    at: 1_700_000_000_000,
  },
  context: {
    tokens: 8_508,
    limit: 1_000_000,
    percent: 1,
    sessionAt: 1_700_000_000_000,
    at: 1_700_000_000_100,
  },
};

const EMPTY: AgentSessionSnapshot = { session: null, context: null };

/**
 * The `t` a component would get, resolved through the real English dictionary.
 *
 * The same factory the `vi.mock` above installs, called directly: the
 * formatters take `t` as a parameter precisely so they can be driven without a
 * React tree, and going through the real dictionary is what makes an assertion
 * on an interpolated `1%` mean anything.
 */
function realT(): (key: string, values?: Record<string, string | number>) => string {
  return createRealIntlMock('en').useTranslations('worktree');
}

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

/**
 * A render's markup with React's own per-render ids neutralised.
 *
 * Radix mints `id="radix-_r_6_"` from a counter that advances with every render
 * in the file, so two identical trees rendered at different times differ in that
 * attribute and in nothing else. Comparing raw `innerHTML` would therefore fail
 * for a reason that has nothing to do with this Issue — and, worse, would keep
 * failing after someone "fixed" it by changing the markup.
 */
function stableHtml(html: string): string {
  return html.replace(/(radix-)?_r_[0-9a-z]+_/g, '_id_');
}

// =============================================================================
// The sum the display layer does, and the server deliberately does not
// =============================================================================

describe('sumAgentSessionTokens', () => {
  it('reproduces what `opencode stats` printed for the measured session', () => {
    // 6 + 11 + 0 + 8482 + 8500. `opencode stats` showed "Avg Tokens/Session 17.0K".
    expect(sumAgentSessionTokens(MEASURED.session!.tokens)).toBe(16_999);
  });

  it('is NOT the context figure — the two answer different questions', () => {
    expect(sumAgentSessionTokens(MEASURED.session!.tokens)).not.toBe(MEASURED.context!.tokens);
  });

  it('prefers the agent’s own total when it ever publishes one', () => {
    expect(
      sumAgentSessionTokens({ ...MEASURED.session!.tokens, total: 12_345 })
    ).toBe(12_345);
  });

  it('answers null when the agent said nothing, rather than 0', () => {
    expect(
      sumAgentSessionTokens({
        input: null,
        output: null,
        reasoning: null,
        cacheRead: null,
        cacheWrite: null,
        total: null,
      })
    ).toBeNull();
    expect(sumAgentSessionTokens(null)).toBeNull();
  });

  it('skips the nulls rather than counting them as zero', () => {
    expect(
      sumAgentSessionTokens({
        input: 5,
        output: null,
        reasoning: null,
        cacheRead: null,
        cacheWrite: 10,
        total: null,
      })
    ).toBe(15);
  });
});

// =============================================================================
// The formatters
// =============================================================================

describe('formatAgentModelLabel with a persona', () => {
  it('puts the persona in front, giving "build · claude-sonnet-4.6"', () => {
    expect(formatAgentModelLabel('claude-sonnet-4.6', null, 'build')).toBe(
      'build · claude-sonnet-4.6'
    );
  });

  it('keeps the effort between them when both are known', () => {
    expect(formatAgentModelLabel('gpt-5.6-sol', 'xhigh', 'build')).toBe(
      'build · gpt-5.6-sol · xhigh'
    );
  });

  it('leaves every pre-#2042 call byte-identical', () => {
    // The regression that would be easiest to ship: a leading separator on
    // every claude and codex row.
    expect(formatAgentModelLabel('gpt-5.6-sol', 'xhigh')).toBe('gpt-5.6-sol · xhigh');
    expect(formatAgentModelLabel('gpt-5.6-sol', null, null)).toBe('gpt-5.6-sol');
    expect(formatAgentModelLabel('gpt-5.6-sol', null, undefined)).toBe('gpt-5.6-sol');
    expect(formatAgentModelLabel('gpt-5.6-sol', null, '')).toBe('gpt-5.6-sol');
  });

  it('still answers null with no model, whatever the persona', () => {
    expect(formatAgentModelLabel(null, null, 'build')).toBeNull();
  });

  it('composes onto an already-formatted label, which is how the split pane uses it', () => {
    const parentFormatted = formatAgentModelLabel('claude-sonnet-4.6', 'high');
    expect(formatAgentModelLabel(parentFormatted, null, 'build')).toBe(
      'build · claude-sonnet-4.6 · high'
    );
  });
});

describe('formatAgentTokenCount', () => {
  it('uses the agent’s own compact form, so "8.5K" matches its footer', () => {
    expect(formatAgentTokenCount(8_508, 'en')).toBe('8.5K');
  });

  it('answers null for a count nobody reported', () => {
    expect(formatAgentTokenCount(null)).toBeNull();
    expect(formatAgentTokenCount(undefined)).toBeNull();
  });
});

describe('formatAgentSessionCost', () => {
  it('prints what the agent’s own footer printed', () => {
    expect(formatAgentSessionCost(0.0346026, 'en')).toBe('$0.03');
  });

  it('opens up to the precision `opencode stats` prints, for the tooltip', () => {
    expect(formatAgentSessionCost(0.0346026, 'en', 4)).toBe('$0.0346');
  });

  it('answers null for a cost nobody reported, rather than $0.00', () => {
    expect(formatAgentSessionCost(null, 'en')).toBeNull();
  });
});

describe('formatAgentSessionUsage', () => {
  it('builds the chip opencode’s footer builds: "$0.03 · 8.5K (1%)"', () => {
    expect(formatAgentSessionUsage(MEASURED.session, MEASURED.context, realT(), 'en')).toBe(
      '$0.03 · 8.5K (1%)'
    );
  });

  it('drops the percentage when the model’s window is unknown', () => {
    expect(
      formatAgentSessionUsage(
        MEASURED.session,
        { ...MEASURED.context!, limit: null, percent: null },
        realT(),
        'en'
      )
    ).toBe('$0.03 · 8.5K');
  });

  it('shows the cost alone before the first context measurement lands', () => {
    expect(formatAgentSessionUsage(MEASURED.session, null, realT(), 'en')).toBe('$0.03');
  });

  it('answers null when the agent published neither', () => {
    expect(formatAgentSessionUsage(null, null, realT(), 'en')).toBeNull();
    expect(formatAgentSessionUsage(undefined, undefined, realT(), 'en')).toBeNull();
  });
});

describe('formatAgentSessionTooltip', () => {
  it('labels the cumulative spend and the context separately', () => {
    const tooltip = formatAgentSessionTooltip(MEASURED.session, MEASURED.context, realT(), 'en');
    // The two numbers a reader must not confuse, each said in full.
    expect(tooltip).toContain('Spent this session: 16,999 tokens');
    expect(tooltip).toContain('Context in use: 8,508 of 1,000,000 tokens (1%)');
    expect(tooltip).toContain('Session: One-word response: PONG');
    expect(tooltip).toContain('Agent: build');
    expect(tooltip).toContain('Cost so far: $0.0346');
    // The dictionary actually resolved; an echo mock would leave the key here.
    expect(tooltip).not.toContain('agentSession.');
  });

  it('says so when the window is unknown instead of implying a percentage', () => {
    const tooltip = formatAgentSessionTooltip(
      MEASURED.session,
      { ...MEASURED.context!, limit: null, percent: null },
      realT(),
      'en'
    );
    expect(tooltip).toContain('Context in use: 8,508 tokens (window unknown)');
  });

  it('answers null when nothing is known', () => {
    expect(formatAgentSessionTooltip(null, null, realT(), 'en')).toBeNull();
  });
});

// =============================================================================
// The split pane header
// =============================================================================

describe('TerminalSplitPane session title bar', () => {
  function renderPane(props: { agentModel?: string | null; agentUsage?: string | null; agentUsageDetail?: string | null }) {
    return render(
      <TerminalSplitPane
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="opencode"
        instanceId="opencode"
        instance={primary('opencode', 0, 'opencode')}
        availableInstances={[primary('opencode', 0, 'opencode')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        terminal={<div data-testid="terminal-body">term</div>}
        footer={<div data-testid="footer-body">footer</div>}
        {...props}
      />
    );
  }

  it('shows "$0.03 · 8.5K (1%)" beside the model', () => {
    renderPane({
      agentModel: 'build · claude-sonnet-4.6',
      agentUsage: '$0.03 · 8.5K (1%)',
      agentUsageDetail: 'Context in use: 8,508 of 1,000,000 tokens (1%)',
    });
    expect(screen.getByTestId('split-agent-model-0')).toHaveTextContent(
      'build · claude-sonnet-4.6'
    );
    const usage = screen.getByTestId('split-agent-usage-0');
    expect(usage).toHaveTextContent('$0.03 · 8.5K (1%)');
    expect(usage).toHaveAttribute('title', 'Context in use: 8,508 of 1,000,000 tokens (1%)');
  });

  it('falls back to a labelled tooltip when no detail was composed', () => {
    renderPane({ agentUsage: '$0.03' });
    expect(screen.getByTestId('split-agent-usage-0')).toHaveAttribute(
      'title',
      'Session usage — $0.03'
    );
  });

  it('renders nothing at all for a tool that publishes no cost', () => {
    renderPane({ agentModel: 'claude-sonnet-4.6' });
    expect(screen.queryByTestId('split-agent-usage-0')).toBeNull();
  });

  it('leaves the claude header byte-identical to pre-#2042', () => {
    // Acceptance criterion 2, as a DOM comparison rather than a stored snapshot:
    // the same render with the new props omitted, and with them explicitly null.
    const before = render(
      <TerminalSplitPane
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={primary('claude', 0, 'Claude')}
        availableInstances={[primary('claude', 0, 'Claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        agentModel="claude-sonnet-4.6"
        terminal={<div>term</div>}
        footer={<div>footer</div>}
      />
    ).container.innerHTML;

    const after = render(
      <TerminalSplitPane
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={primary('claude', 0, 'Claude')}
        availableInstances={[primary('claude', 0, 'Claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        agentModel={formatAgentModelLabel('claude-sonnet-4.6', null, EMPTY.session?.agent)}
        agentUsage={formatAgentSessionUsage(EMPTY.session, EMPTY.context, realT(), 'en')}
        agentUsageDetail={formatAgentSessionTooltip(EMPTY.session, EMPTY.context, realT(), 'en')}
        terminal={<div>term</div>}
        footer={<div>footer</div>}
      />
    ).container.innerHTML;

    expect(stableHtml(after)).toBe(stableHtml(before));
  });
});

// =============================================================================
// The desktop header's instance pills
// =============================================================================

describe('DesktopHeader instance status pill', () => {
  const baseProps = {
    worktreeName: 'feature/2042',
    repositoryName: 'CommandMate',
    status: 'idle' as const,
    onBackClick: vi.fn(),
    onInfoClick: vi.fn(),
  };

  function renderHeader(
    cliTool: CLIToolType,
    status: Record<string, unknown>,
    agentSessionByInstance?: Record<string, AgentSessionSnapshot>
  ) {
    return render(
      <DesktopHeader
        {...baseProps}
        instances={[primary(cliTool, 0)]}
        sessionStatusByInstance={
          {
            [cliTool]: {
              isRunning: true,
              isWaitingForResponse: false,
              isProcessing: true,
              ...status,
            },
          } as NonNullable<Worktree['sessionStatusByInstance']>
        }
        agentSessionByInstance={agentSessionByInstance}
      />
    );
  }

  it('carries the persona and the usage in the tooltip', () => {
    renderHeader('opencode', { model: 'claude-sonnet-4.6' }, { opencode: MEASURED });
    const pill = screen.getByTestId('desktop-agent-status-opencode');
    expect(pill.getAttribute('title')).toContain('build · claude-sonnet-4.6');
    expect(pill.getAttribute('title')).toContain('$0.03 · 8.5K (1%)');
    expect(pill.getAttribute('aria-label')).toContain('$0.03 · 8.5K (1%)');
    // Resolved through the real dictionary, not echoed as a key.
    expect(pill.getAttribute('title')).not.toContain('statusPillWith');
  });

  it('spends no row width on it — the visible pill text is unchanged', () => {
    // #1783's constraint, restated for #2042: MAX_HEADER_AGENT_PILLS budgets
    // this row, so a second visible string per pill would push a working
    // instance into the "+N" overflow.
    renderHeader('opencode', { model: 'claude-sonnet-4.6' });
    const bare = screen.getByTestId('desktop-agent-status-opencode').textContent;
    screen.getByTestId('desktop-agent-status-opencode').remove();

    renderHeader('opencode', { model: 'claude-sonnet-4.6' }, { opencode: MEASURED });
    expect(screen.getByTestId('desktop-agent-status-opencode').textContent).toBe(bare);
  });

  it('leaves a claude pill byte-identical to pre-#2042', () => {
    const before = renderHeader('claude', { model: 'claude-sonnet-4.6' }).container.innerHTML;
    const after = renderHeader('claude', { model: 'claude-sonnet-4.6' }, {
      claude: EMPTY,
    }).container.innerHTML;
    expect(stableHtml(after)).toBe(stableHtml(before));
  });

  it('leaves an instance with no split byte-identical', () => {
    // The sparse-map case: the roster has an instance the panes never polled.
    const before = renderHeader('opencode', { model: 'claude-sonnet-4.6' }).container.innerHTML;
    const after = renderHeader('opencode', { model: 'claude-sonnet-4.6' }, {
      'opencode-2': MEASURED,
    }).container.innerHTML;
    expect(stableHtml(after)).toBe(stableHtml(before));
  });
});
