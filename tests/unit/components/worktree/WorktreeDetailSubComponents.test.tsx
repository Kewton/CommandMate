// DesktopHeader per-instance status row tests — Issue #749, instance-keyed in #869. WorktreeInfoFields covered separately in WorktreeInfoFields-copy.test.tsx
/**
 * @vitest-environment jsdom
 *
 * Issue #749 / #869: PC DesktopHeader per-agent-instance session status row.
 *
 * Verifies the per-instance status row rendered to the LEFT of the worktree
 * status dropdown in DesktopHeader: per-instance rendering, status → dot/spinner
 * class mapping (via the real SIDEBAR_STATUS_CONFIG), active highlight
 * (aria-pressed + cyan background), click → onActiveInstanceChange, alias-based
 * label text (getInstanceLabel), and backward compatibility (no row when the
 * `instances` roster is omitted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import {
  getCliToolDisplayName,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

// Issue #1277: DesktopHeader's wording (agent status pills, Home/Info, status
// dropdown) is now dictionary-driven, so resolve keys through the REAL
// locales/en/*.json — the global echo mock in tests/setup.ts would happily
// return `worktree.detail.info` for a key that does not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

type SessionStatusMap = NonNullable<Worktree['sessionStatusByCli']>;

/**
 * Issue #869: build a PRIMARY-instance roster (id === cliTool) from a list of
 * CLI tools. Primaries default their alias to the CLI tool's display name, so
 * `getInstanceLabel` yields "Claude"/"Codex" and the labels/aria match the
 * pre-#869 display-name expectations.
 */
function mkInstances(clis: CLIToolType[]): AgentInstance[] {
  return clis.map((cliTool, order) => ({
    id: cliTool,
    cliTool,
    alias: getCliToolDisplayName(cliTool),
    order,
  }));
}

/** Minimal valid props for DesktopHeader (per-instance props omitted by default). */
const baseProps = {
  worktreeName: 'feature/749-worktree',
  repositoryName: 'CommandMate',
  status: 'idle' as const,
  onBackClick: vi.fn(),
  onInfoClick: vi.fn(),
};

describe('DesktopHeader per-instance status row (Issue #749 / #869)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders a desktop-agent-status-${instanceId} button for each instance', () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude', 'codex'])} />);

      expect(screen.getByTestId('desktop-agent-status-row')).toBeDefined();
      expect(screen.getByTestId('desktop-agent-status-claude')).toBeDefined();
      expect(screen.getByTestId('desktop-agent-status-codex')).toBeDefined();
    });

    it('does NOT render the status row when instances is omitted (backward compat)', () => {
      render(<DesktopHeader {...baseProps} />);
      expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    });

    it('does NOT render the status row when instances is an empty array', () => {
      render(<DesktopHeader {...baseProps} instances={[]} />);
      expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    });

    it('renders two instances of the SAME CLI tool with distinct aliases (Claude × 2)', () => {
      const dualClaude: AgentInstance[] = [
        { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
        { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
      ];
      render(<DesktopHeader {...baseProps} instances={dualClaude} />);
      expect(screen.getByTestId('desktop-agent-status-claude')).toBeDefined();
      expect(screen.getByTestId('desktop-agent-status-claude-2')).toBeDefined();
      // Issue #1078: idle instances collapse to icon-only dots; the alias label
      // lives on the button's aria-label (and the hover tooltip), not inline text.
      expect(screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')).toBe(
        'Primary: Idle'
      );
      expect(screen.getByTestId('desktop-agent-status-claude-2').getAttribute('aria-label')).toBe(
        'Review: Idle'
      );
    });
  });

  // Issue #1078: the status visual is unified on <StatusDot> (no blue spinner).
  // running/waiting → glow/blink (working), idle/ready → static dot. No animate-spin.
  describe('status → StatusDot class mapping (Issue #1078)', () => {
    it('idle → muted static dot (no session status entry)', () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain('bg-muted-foreground');
      expect(span?.className).not.toContain('animate-spin');
    });

    it('ready → success static dot (isRunning only)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain('bg-success');
      expect(span?.className).not.toContain('animate-spin');
    });

    it('waiting → warning dot with blink (isWaitingForResponse)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain('bg-warning');
      expect(span?.className).not.toContain('animate-spin');
    });

    it('running → success dot with glow, NOT a spinner (isProcessing)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      expect(span?.className).toContain('bg-success');
      expect(span?.className).toContain('animate-status-glow');
      expect(span?.className).not.toContain('animate-spin');
      expect(span?.className).not.toContain('border-info');
    });
  });

  describe('active highlight', () => {
    it('active instance has aria-pressed=true + cyan active class; others aria-pressed=false', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          activeInstanceId="codex"
        />
      );
      const active = screen.getByTestId('desktop-agent-status-codex');
      const inactive = screen.getByTestId('desktop-agent-status-claude');

      expect(active.getAttribute('aria-pressed')).toBe('true');
      expect(active.className).toContain('bg-accent-100');
      expect(active.className).toContain('dark:bg-accent-900/30');

      expect(inactive.getAttribute('aria-pressed')).toBe('false');
      expect(inactive.className).not.toContain('bg-accent-100');
    });
  });

  describe('click → onActiveInstanceChange', () => {
    it('calls onActiveInstanceChange with the clicked instanceId', () => {
      const onActiveInstanceChange = vi.fn();
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          activeInstanceId="claude"
          onActiveInstanceChange={onActiveInstanceChange}
        />
      );
      fireEvent.click(screen.getByTestId('desktop-agent-status-codex'));
      expect(onActiveInstanceChange).toHaveBeenCalledTimes(1);
      expect(onActiveInstanceChange).toHaveBeenCalledWith('codex');
    });

    it('does not throw when onActiveInstanceChange is omitted', () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
      expect(() =>
        fireEvent.click(screen.getByTestId('desktop-agent-status-claude'))
      ).not.toThrow();
    });
  });

  describe('aria-label text (real SIDEBAR_STATUS_CONFIG labels)', () => {
    it('uses "${alias}: ${label}" — e.g. "Claude: Running" and "Codex: Idle"', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      expect(screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')).toBe(
        'Claude: Running'
      );
      expect(screen.getByTestId('desktop-agent-status-codex').getAttribute('aria-label')).toBe(
        'Codex: Idle'
      );
    });

    it('icon span (first child) has the status class, no title, and no role (Issue #751)', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      const button = screen.getByTestId('desktop-agent-status-claude');
      const iconSpan = button.querySelector('span');
      // Issue #1078: StatusDot waiting uses the semantic `bg-warning` token.
      expect(iconSpan?.className).toContain('bg-warning');
      // The decorative StatusDot carries no title/role (the button labels itself).
      expect(iconSpan?.getAttribute('title')).toBeNull();
      expect(iconSpan?.getAttribute('role')).toBeNull();
      // Working instances stay labelled pills with visible inline text.
      expect(button.textContent).toContain('Claude: Waiting for response');
    });
  });

  describe('Issue #1078: working instances labelled, idle collapsed to icon dots', () => {
    it('renders visible text "Claude: Running" for a working (pill) instance', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      expect(screen.getByText('Claude: Running')).toBeDefined();
    });

    it('idle instance is icon-only: label on aria-label, NOT visible inline text', () => {
      const sessionStatusByCli: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          sessionStatusByCli={sessionStatusByCli}
        />
      );
      // Idle codex collapses to an icon-only dot — no inline "Codex: Idle" text.
      expect(screen.queryByText('Codex: Idle')).toBeNull();
      expect(screen.getByTestId('desktop-agent-status-codex').getAttribute('aria-label')).toBe(
        'Codex: Idle'
      );
    });

    it('idle instance is wrapped in a tooltip, but its content is absent until hover', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
        />
      );
      // Idle dots use a hover tooltip for the full label; nothing with
      // role="tooltip" is present on initial render (no accidental double label).
      expect(screen.queryByRole('tooltip')).toBeNull();
      const codex = screen.getByTestId('desktop-agent-status-codex');
      expect(codex.closest('[data-testid="tooltip-wrapper"]')).not.toBeNull();
    });

    // Issue #1364: this `placement="bottom"` tooltip sits in the header's
    // horizontally-packed instance row and was missing from #1341's impact
    // list. Like the sidebar's, it must escape to document.body on hover rather
    // than render as a clipped absolute child.
    it('portals the idle-instance tooltip to document.body on hover (Issue #1364)', async () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude', 'codex'])} />);

      const codex = screen.getByTestId('desktop-agent-status-codex');
      fireEvent.mouseEnter(codex.closest('[data-testid="tooltip-wrapper"]')!);

      const tooltip = await screen.findByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveTextContent('Codex: Idle');
      expect(tooltip).toHaveAttribute('data-placement', 'bottom');
      expect(tooltip.parentElement).toBe(document.body);
      expect(tooltip.className).toMatch(/\bfixed\b/);
      // a11y (#730): the label is not double-announced via aria-describedby.
      expect(tooltip).toHaveAttribute('aria-hidden', 'true');
      expect(codex).not.toHaveAttribute('aria-describedby');
    });

    it('row container uses gap-2 (Issue #751)', () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
      const row = screen.getByTestId('desktop-agent-status-row');
      expect(row.className).toContain('gap-2');
    });
  });

  describe('polling auto-update (memo re-render on sessionStatusByCli change)', () => {
    it('updates the indicator when a new sessionStatusByCli reference arrives (idle → running)', () => {
      // Simulate the parent poll producing a fresh worktree.sessionStatusByCli object.
      const { rerender } = render(
        <DesktopHeader {...baseProps} instances={mkInstances(['claude'])} sessionStatusByCli={{}} />
      );
      let span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      // idle: muted static dot, never a spinner
      expect(span?.className).toContain('bg-muted-foreground');
      expect(span?.className).not.toContain('animate-spin');

      // Next poll: claude is now processing → new object identity (memo must re-render).
      const updated: SessionStatusMap = {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      };
      rerender(
        <DesktopHeader {...baseProps} instances={mkInstances(['claude'])} sessionStatusByCli={updated} />
      );
      span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
      // running: success dot with glow (unified StatusDot), not a spinner
      expect(span?.className).toContain('bg-success');
      expect(span?.className).toContain('animate-status-glow');
      expect(span?.className).not.toContain('animate-spin');
      expect(screen.getByTestId('desktop-agent-status-claude').getAttribute('aria-label')).toBe(
        'Claude: Running'
      );
    });
  });
});

/**
 * Issue #784 / #869: PC DesktopHeader session kill button.
 *
 * Regression restored after #728 (split-ification removed the terminal-header
 * kill button) + #755 (Desktop/Mobile split). Kill controls remain keyed on the
 * CLI tool backing the ACTIVE instance (a CLI session is per worktree+tool), so
 * the active instance's `cliTool` is resolved from the `instances` roster +
 * `activeInstanceId`. This suite verifies the kill button between the per-agent
 * status row and the worktree status dropdown: it renders only when the active
 * CLI session is running, calls onKillSession on click, and is backward
 * compatible (no button when the handler is omitted or the session is idle).
 */
describe('DesktopHeader session kill button (Issue #784 / #869)', () => {
  const runningStatus: SessionStatusMap = {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering condition', () => {
    it('renders the kill button when the active CLI session is running', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          activeInstanceId="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
    });

    it('does NOT render the kill button when the active CLI session is not running', () => {
      const idleStatus: SessionStatusMap = {
        claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
      };
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          activeInstanceId="claude"
          sessionStatusByCli={idleStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when there is no session status entry for the active CLI', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude', 'codex'])}
          activeInstanceId="codex"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      // codex has no entry → button hidden
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when onKillSession is omitted (backward compat)', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          activeInstanceId="claude"
          sessionStatusByCli={runningStatus}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });

    it('does NOT render the kill button when activeInstanceId is omitted', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    });
  });

  describe('accessibility + interaction', () => {
    it('has aria-label="End session"', () => {
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          activeInstanceId="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={vi.fn()}
        />
      );
      expect(screen.getByTestId('desktop-kill-session').getAttribute('aria-label')).toBe(
        'End session'
      );
    });

    it('calls onKillSession when clicked', () => {
      const onKillSession = vi.fn();
      render(
        <DesktopHeader
          {...baseProps}
          instances={mkInstances(['claude'])}
          activeInstanceId="claude"
          sessionStatusByCli={runningStatus}
          onKillSession={onKillSession}
        />
      );
      fireEvent.click(screen.getByTestId('desktop-kill-session'));
      expect(onKillSession).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Issue #875: per-instance status resolution. The status dot/spinner and the
 * "End" button must resolve each instance's status from `sessionStatusByInstance`
 * (keyed by instanceId) so alias instances (instanceId !== cliToolId) show their
 * own status. The per-CLI map is only a fallback when an instance entry is absent.
 */
describe('DesktopHeader per-instance status resolution (Issue #875)', () => {
  type InstanceStatusMap = NonNullable<Worktree['sessionStatusByInstance']>;

  const dualClaude: AgentInstance[] = [
    { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
    { id: 'claude-2', cliTool: 'claude', alias: 'Photon', order: 1 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows independent status for two instances of the same CLI tool', () => {
    // Primary idle, alias processing — same backing CLI tool.
    const sessionStatusByInstance: InstanceStatusMap = {
      claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
      'claude-2': { isRunning: true, isWaitingForResponse: false, isProcessing: true },
    };
    render(
      <DesktopHeader
        {...baseProps}
        instances={dualClaude}
        sessionStatusByInstance={sessionStatusByInstance}
      />
    );

    const primarySpan = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
    const aliasSpan = screen.getByTestId('desktop-agent-status-claude-2').querySelector('span');

    // Primary → idle muted dot, no spinner (Issue #1078 unified StatusDot).
    expect(primarySpan?.className).toContain('bg-muted-foreground');
    expect(primarySpan?.className).not.toContain('animate-spin');
    // Alias → running success dot with glow, never a spinner.
    expect(aliasSpan?.className).toContain('bg-success');
    expect(aliasSpan?.className).toContain('animate-status-glow');
    expect(aliasSpan?.className).not.toContain('animate-spin');
  });

  it('renders the "End" button for an alias instance whose own session is running', () => {
    // Primary not running; alias running. Button must follow the active alias.
    const sessionStatusByInstance: InstanceStatusMap = {
      claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
      'claude-2': { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    };
    render(
      <DesktopHeader
        {...baseProps}
        instances={dualClaude}
        activeInstanceId="claude-2"
        sessionStatusByInstance={sessionStatusByInstance}
        onKillSession={vi.fn()}
      />
    );
    expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
  });

  it('hides the "End" button for an alias whose own session is idle even if the primary (same tool) is running', () => {
    const sessionStatusByInstance: InstanceStatusMap = {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      'claude-2': { isRunning: false, isWaitingForResponse: false, isProcessing: false },
    };
    render(
      <DesktopHeader
        {...baseProps}
        instances={dualClaude}
        activeInstanceId="claude-2"
        sessionStatusByInstance={sessionStatusByInstance}
        onKillSession={vi.fn()}
      />
    );
    // Keyed by instance, not by tool → no button for the idle alias.
    expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
  });

  it('falls back to the per-CLI map when no per-instance entry exists (backward compat)', () => {
    const sessionStatusByCli: SessionStatusMap = {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    };
    render(
      <DesktopHeader
        {...baseProps}
        instances={mkInstances(['claude'])}
        activeInstanceId="claude"
        sessionStatusByCli={sessionStatusByCli}
        onKillSession={vi.fn()}
      />
    );
    // No sessionStatusByInstance → primary resolves via sessionStatusByCli.
    const span = screen.getByTestId('desktop-agent-status-claude').querySelector('span');
    expect(span?.className).toContain('bg-success');
    expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
  });
});

/**
 * Issue #786 / #869: DesktopHeader per-instance indicator as a drag source.
 *
 * The `desktop-agent-status-${instanceId}` button is draggable so it can be
 * dropped on a terminal split to switch that split's instance. The existing
 * click behavior (#749/#751: onActiveInstanceChange) MUST be preserved — click
 * and drag are mutually exclusive (S3-002). The drag payload is now an agent
 * instanceId carried on the dedicated AGENT_INSTANCE_DND_MIME type.
 */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    types: Object.keys(store),
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, val: string) => {
      store[type] = val;
    },
  };
}

describe('DesktopHeader agent indicator drag source (Issue #786 / #869)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks each instance indicator button as draggable', () => {
    render(<DesktopHeader {...baseProps} instances={mkInstances(['claude', 'codex'])} />);
    const btn = screen.getByTestId('desktop-agent-status-claude');
    expect(btn.getAttribute('draggable')).toBe('true');
  });

  it('onDragStart writes the instanceId to dataTransfer with effectAllowed=move', () => {
    render(<DesktopHeader {...baseProps} instances={mkInstances(['claude', 'codex'])} />);
    const btn = screen.getByTestId('desktop-agent-status-codex');
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(btn, { dataTransfer });
    expect(dataTransfer.getData(AGENT_INSTANCE_DND_MIME)).toBe('codex');
    expect(dataTransfer.effectAllowed).toBe('move');
  });

  it('onDragStart / onDragEnd invoke the optional publish callbacks with the instanceId', () => {
    const onAgentDragStart = vi.fn();
    const onAgentDragEnd = vi.fn();
    render(
      <DesktopHeader
        {...baseProps}
        instances={mkInstances(['claude'])}
        onAgentDragStart={onAgentDragStart}
        onAgentDragEnd={onAgentDragEnd}
      />
    );
    const btn = screen.getByTestId('desktop-agent-status-claude');
    fireEvent.dragStart(btn, { dataTransfer: makeDataTransfer() });
    expect(onAgentDragStart).toHaveBeenCalledTimes(1);
    expect(onAgentDragStart).toHaveBeenCalledWith('claude');
    fireEvent.dragEnd(btn, { dataTransfer: makeDataTransfer() });
    expect(onAgentDragEnd).toHaveBeenCalledTimes(1);
  });

  it('applies a drag-active visual on dragStart and removes it on dragEnd', () => {
    render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
    const btn = screen.getByTestId('desktop-agent-status-claude');
    expect(btn.className).not.toMatch(/opacity-50/);
    fireEvent.dragStart(btn, { dataTransfer: makeDataTransfer() });
    expect(btn.className).toMatch(/opacity-50/);
    expect(btn.className).toMatch(/cursor-grabbing/);
    fireEvent.dragEnd(btn, { dataTransfer: makeDataTransfer() });
    expect(btn.className).not.toMatch(/opacity-50/);
  });

  it('removes the drag-active visual on dragEnd even if onAgentDragEnd is omitted', () => {
    render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
    const btn = screen.getByTestId('desktop-agent-status-claude');
    fireEvent.dragStart(btn, { dataTransfer: makeDataTransfer() });
    expect(btn.className).toMatch(/opacity-50/);
    fireEvent.dragEnd(btn, { dataTransfer: makeDataTransfer() });
    expect(btn.className).not.toMatch(/opacity-50/);
  });

  // S3-002 regression guard: a plain click (no drag) must still fire
  // onActiveInstanceChange exactly once. #749/#751 click → active-instance switch
  // is a core behavior that the new draggable attribute must not break.
  it('(regression) click-only (no drag) fires onActiveInstanceChange exactly once', () => {
    const onActiveInstanceChange = vi.fn();
    render(
      <DesktopHeader
        {...baseProps}
        instances={mkInstances(['claude', 'codex'])}
        activeInstanceId="claude"
        onActiveInstanceChange={onActiveInstanceChange}
      />
    );
    fireEvent.click(screen.getByTestId('desktop-agent-status-codex'));
    expect(onActiveInstanceChange).toHaveBeenCalledTimes(1);
    expect(onActiveInstanceChange).toHaveBeenCalledWith('codex');
  });

  it('does not throw when onAgentDragStart / onAgentDragEnd are omitted', () => {
    render(<DesktopHeader {...baseProps} instances={mkInstances(['claude'])} />);
    const btn = screen.getByTestId('desktop-agent-status-claude');
    expect(() => {
      fireEvent.dragStart(btn, { dataTransfer: makeDataTransfer() });
      fireEvent.dragEnd(btn, { dataTransfer: makeDataTransfer() });
    }).not.toThrow();
  });

  // Mobile path: WorktreeDetailMobile structurally never renders DesktopHeader
  // (the agent status row is the only draggable element). Without `instances` —
  // the Mobile-equivalent prop state — no draggable agent indicator exists, so
  // drag-drop is completely inert on Mobile (no regression).
  it('renders no draggable agent indicator when the row is absent (Mobile parity)', () => {
    const { container } = render(<DesktopHeader {...baseProps} />);
    expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  });

  // Issue #917: the PC display-size selector must be reachable from the worktree
  // detail page. The global Header is suppressed on /worktrees/[id] (useLayoutConfig
  // showGlobalNav:false), so DesktopHeader surfaces the selector in its top bar.
  // PcDisplaySizeContext has a non-throwing default (isMobile:false) so it renders
  // without an explicit provider.
  describe('PC display-size selector (Issue #917)', () => {
    it('renders the display-size selector in the desktop top bar', () => {
      render(<DesktopHeader {...baseProps} />);
      expect(screen.getByTestId('pc-display-size-select')).toBeDefined();
    });

    it('keeps the selector present alongside the per-instance status row', () => {
      render(<DesktopHeader {...baseProps} instances={mkInstances(['claude', 'codex'])} />);
      expect(screen.getByTestId('desktop-agent-status-row')).toBeDefined();
      expect(screen.getByTestId('pc-display-size-select')).toBeDefined();
    });
  });
});

/**
 * Issue #1078: idle-noise collapse + "+N" overflow in the desktop agent row.
 *
 * - running/waiting (working) or the active instance → labelled pill,
 * - idle/ready → icon-only dot (label via tooltip / aria-label),
 * - labelled pills beyond the budget (4) fold into a "+N" overflow menu so a
 *   working session never gets buried.
 */
describe('DesktopHeader agent-row idle collapse + overflow (Issue #1078)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function roster(n: number): AgentInstance[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `claude-${i}`,
      cliTool: 'claude' as CLIToolType,
      alias: `Agent ${i}`,
      order: i,
    }));
  }

  const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
  const waiting = { isRunning: true, isWaitingForResponse: true, isProcessing: false };

  it('running 1 + idle 5: the running one is labelled, idle stay icon-only, no overflow', () => {
    const instances = roster(6);
    const sessionStatusByInstance = { 'claude-0': running } as NonNullable<
      Worktree['sessionStatusByInstance']
    >;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        sessionStatusByInstance={sessionStatusByInstance}
      />
    );
    // Working instance is a labelled pill (visible text).
    expect(screen.getByText('Agent 0: Running')).toBeDefined();
    // Idle instances are icon-only (no visible "Agent N: Idle" text), but each
    // is still a reachable button carrying the full label on aria-label.
    expect(screen.queryByText('Agent 1: Idle')).toBeNull();
    expect(screen.getByTestId('desktop-agent-status-claude-5').getAttribute('aria-label')).toBe(
      'Agent 5: Idle'
    );
    // Idle dots never overflow — they are narrow.
    expect(screen.queryByTestId('desktop-agent-status-overflow')).toBeNull();
  });

  it('all idle: every instance renders as an icon-only dot, no overflow', () => {
    render(<DesktopHeader {...baseProps} instances={roster(6)} />);
    for (let i = 0; i < 6; i += 1) {
      expect(screen.getByTestId(`desktop-agent-status-claude-${i}`)).toBeDefined();
      expect(screen.queryByText(`Agent ${i}: Idle`)).toBeNull();
    }
    expect(screen.queryByTestId('desktop-agent-status-overflow')).toBeNull();
  });

  it('6 all working: keeps 4 pills inline and folds the remaining 2 into "+N"', () => {
    const instances = roster(6);
    const sessionStatusByInstance = Object.fromEntries(
      instances.map((inst) => [inst.id, running])
    ) as NonNullable<Worktree['sessionStatusByInstance']>;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        sessionStatusByInstance={sessionStatusByInstance}
      />
    );
    // First 4 remain inline as pills.
    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`desktop-agent-status-claude-${i}`)).toBeDefined();
    }
    // The rest collapse into a "+2" overflow trigger (closed menu → not inline).
    const overflow = screen.getByTestId('desktop-agent-status-overflow');
    expect(overflow.textContent).toContain('+2');
    expect(screen.queryByTestId('desktop-agent-status-claude-5')).toBeNull();
    // Issue #1078: folded working sessions still surface the living glow so a
    // running instance stays visible at a glance even when collapsed.
    const overflowDot = overflow.querySelector('span');
    expect(overflowDot?.className).toContain('bg-success');
    expect(overflowDot?.className).toContain('animate-status-glow');
    // Token discipline: the trigger uses semantic tokens, not raw grays.
    expect(overflow.className).toContain('text-muted-foreground');
    expect(overflow.className).toContain('hover:bg-muted');
    expect(overflow.className).not.toMatch(/text-gray-|bg-gray-/);
  });

  it('overflow with only waiting sessions surfaces the amber (waiting) glow', () => {
    const instances = roster(6);
    const sessionStatusByInstance = Object.fromEntries(
      instances.map((inst) => [inst.id, waiting])
    ) as NonNullable<Worktree['sessionStatusByInstance']>;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        sessionStatusByInstance={sessionStatusByInstance}
      />
    );
    const overflow = screen.getByTestId('desktop-agent-status-overflow');
    const overflowDot = overflow.querySelector('span');
    expect(overflowDot?.className).toContain('bg-warning');
    expect(overflowDot?.className).toContain('animate-status-blink');
  });

  it('overflow prefers a running glow over a waiting one when both are folded', () => {
    // First 4 (waiting) stay as pills; positions 4-5 (running, waiting) overflow.
    const instances = roster(6);
    const sessionStatusByInstance = {
      'claude-0': waiting,
      'claude-1': waiting,
      'claude-2': waiting,
      'claude-3': waiting,
      'claude-4': running,
      'claude-5': waiting,
    } as NonNullable<Worktree['sessionStatusByInstance']>;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        sessionStatusByInstance={sessionStatusByInstance}
      />
    );
    const overflow = screen.getByTestId('desktop-agent-status-overflow');
    const overflowDot = overflow.querySelector('span');
    // Running is folded → green glow wins over the folded waiting instance.
    expect(overflowDot?.className).toContain('bg-success');
    expect(overflowDot?.className).toContain('animate-status-glow');
  });
});
