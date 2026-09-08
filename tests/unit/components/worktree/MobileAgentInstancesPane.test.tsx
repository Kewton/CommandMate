/**
 * Tests for MobileAgentInstancesPane (Issue #874)
 *
 * Mobile instance-management UI. It wraps the SHARED AgentInstancesPane (roster
 * → DB) so mobile users can add / rename / delete / reorder instances exactly
 * like PC, and adds a per-device "Show on this device" checklist backed by
 * localStorage (the visibility props are lifted to the controller via
 * useMobileSelectedInstances). The per-device selection never writes the DB.
 *
 * Issue #2382: the "insert delegation brief into the composer" row action
 * (#2376) is exercised THROUGH this wrapper. The item, its handler and its
 * wording all belong to the shared roster editor; what these tests pin is that
 * the phone's Agent pane really offers it, that it writes the phone's docked
 * composer (`message-input-textarea`, present under every mobile tab), that the
 * `--instance` it inserts is the server's answer, that the row which is the
 * session on screen is refused, and that a missing composer is a toast rather
 * than an exception.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import { DELEGATE_TEXT } from '@/components/common/CommandPalette';
import {
  getCliToolDisplayName,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Issue #2382: the delegation item reports through the shared pane's toast.
// Captured here so the tests can tell "inserted" from "refused" from "no
// composer" by the toast the phone user would actually see.
const showToast = vi.fn();
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast }) };
});

// Radix DropdownMenu (the row kebab) needs pointer-capture / scrollIntoView in
// jsdom before it will open.
beforeAll(() => installRadixJsdomPolyfills());

function primary(cliTool: CLIToolType, order: number, alias?: string): AgentInstance {
  return { id: cliTool, cliTool, alias: alias ?? getCliToolDisplayName(cliTool), order };
}

const ROSTER: AgentInstance[] = [
  primary('claude', 0, 'Claude'),
  { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 1 },
  primary('codex', 2, 'Codex'),
];

const baseProps = {
  worktreeId: 'w-874',
  instances: ROSTER,
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
  visibleInstanceIds: ['claude', 'codex'],
  onToggleInstanceVisible: vi.fn(),
};

describe('MobileAgentInstancesPane (Issue #874)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  it('embeds the shared roster editor (AgentInstancesPane)', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    // The shared roster editor and its rows are present (add/rename/delete/reorder).
    expect(screen.getByTestId('agent-instances-pane')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-claude')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-claude-2')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-row-codex')).toBeInTheDocument();
    expect(screen.getByTestId('agent-instance-add')).toBeInTheDocument();
  });

  // Issue #2316 gave the SHARED pane a scroll mode for the PC activity column.
  // This wrapper must not opt into it: it already renders inside a scrolling
  // mobile tab and stacks the visibility checklist BELOW the shared pane, so a
  // height + scroller on the embedded pane would nest a second scroller and
  // squash the roster. Assert on the shared pane's own root, since that is where
  // #2316 puts the classes.
  it('does not turn the embedded roster editor into its own scroller (Issue #2316)', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);

    const shared = screen.getByTestId('agent-instances-pane');
    expect(shared.className).not.toContain('overflow-y-auto');
    expect(shared.className).not.toContain('h-full');

    // The checklist stays a SIBLING below the shared pane (not inside it), which
    // is why the pane must keep growing with its content rather than clipping.
    const checklist = screen.getByTestId('mobile-visible-instances');
    expect(shared).not.toContainElement(checklist);
    expect(screen.getByTestId('mobile-agent-instances-pane')).toContainElement(checklist);
  });

  it('renders a per-device visibility toggle per roster instance, using the alias label', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    expect(screen.getByTestId('mobile-visible-instances')).toBeInTheDocument();

    const claude = screen.getByTestId('mobile-visible-instance-toggle-claude') as HTMLInputElement;
    const claude2 = screen.getByTestId(
      'mobile-visible-instance-toggle-claude-2'
    ) as HTMLInputElement;
    const codex = screen.getByTestId('mobile-visible-instance-toggle-codex') as HTMLInputElement;

    // checked state mirrors visibleInstanceIds.
    expect(claude).toBeChecked();
    expect(codex).toBeChecked();
    expect(claude2).not.toBeChecked();

    // alias is the visible label (getInstanceLabel).
    expect(screen.getByText('Claude (review)')).toBeInTheDocument();
  });

  it('clicking a visibility toggle calls onToggleInstanceVisible with the instance id', () => {
    const onToggleInstanceVisible = vi.fn();
    render(
      <MobileAgentInstancesPane
        {...baseProps}
        onToggleInstanceVisible={onToggleInstanceVisible}
      />
    );
    fireEvent.click(screen.getByTestId('mobile-visible-instance-toggle-claude-2'));
    expect(onToggleInstanceVisible).toHaveBeenCalledWith('claude-2');
  });

  it('does NOT write the DB (no PATCH) when toggling per-device visibility', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    fireEvent.click(screen.getByTestId('mobile-visible-instance-toggle-claude-2'));
    // The claim is "no WRITE", which is what a per-device preference must never
    // be. Issue #2377's relay-badge read is a GET and is excluded rather than
    // folded in, so this stays a statement about writes.
    const writes = mockFetch.mock.calls.filter(
      (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET',
    );
    expect(writes).toEqual([]);
  });

  it('disables the toggle for the last remaining visible instance (MIN=1)', () => {
    render(
      <MobileAgentInstancesPane
        {...baseProps}
        visibleInstanceIds={['codex']}
      />
    );
    // Only 'codex' is visible -> its toggle is disabled (cannot hide the last one).
    expect(screen.getByTestId('mobile-visible-instance-toggle-codex')).toBeDisabled();
    // Hidden instances stay enabled so they can be shown.
    expect(screen.getByTestId('mobile-visible-instance-toggle-claude')).not.toBeDisabled();
  });
});

// ============================================================================
// Issue #2382: "insert delegation brief" reached from the phone's Agent pane
// ============================================================================

/** The phone's docked composer, exactly as `MessageInput` renders its textarea. */
function mountComposer(initialValue = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('data-testid', 'message-input-textarea');
  textarea.value = initialValue;
  document.body.appendChild(textarea);
  return textarea;
}

/** A chat surface on screen, claiming to show `instanceId`'s transcript. */
function mountChatSurface(instanceId: string): void {
  const el = document.createElement('div');
  el.setAttribute('data-instance-id', instanceId);
  document.body.appendChild(el);
}

/** Answer the two server reads the brief is built from. */
function answerBriefReads(instanceId: string, cliToolId: CLIToolType): void {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/cli-reference')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          binary: 'commandmatedev',
          worktreeId: baseProps.worktreeId,
          portPrefix: null,
        }),
      });
    }
    if (String(url).includes('/resolve-target')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          cliToolId,
          instanceId,
          resolvedBy: 'roster',
          conflict: null,
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

/** Open the shared roster editor's kebab on row `id` (keyboard, as Radix expects in jsdom). */
function openRowMenu(id: string): void {
  fireEvent.keyDown(screen.getByTestId(`agent-instance-menu-${id}`), { key: 'Enter' });
}

function cliReferenceReads(): unknown[][] {
  return mockFetch.mock.calls.filter((call) => String(call[0]).includes('/cli-reference'));
}

describe('MobileAgentInstancesPane: delegation brief (Issue #2382)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the delegation item on the roster rows of the phone Agent pane', () => {
    render(<MobileAgentInstancesPane {...baseProps} />);
    openRowMenu('codex');
    const item = screen.getByTestId('agent-instance-delegate-codex');
    // The same wording PC shows — one source, not a mobile copy.
    expect(item.textContent).toContain(DELEGATE_TEXT.en.menuItem);
  });

  it('inserts the brief into the docked composer, --instance being the server\'s answer', async () => {
    // The row says `codex`; the server resolves it to `codex-3`. The inserted
    // command must carry the server's answer, never the row id.
    answerBriefReads('codex-3', 'codex');
    const composer = mountComposer();

    render(<MobileAgentInstancesPane {...baseProps} />);
    openRowMenu('codex');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex'));

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(composer.value).toContain(`commandmatedev ask ${baseProps.worktreeId} --instance codex-3`);
    expect(composer.value).not.toContain('--instance codex ');
    expect(showToast).toHaveBeenCalledWith(DELEGATE_TEXT.en.inserted, 'success');
  });

  it('refuses the row that is the session on screen', async () => {
    answerBriefReads('codex', 'codex');
    const composer = mountComposer();
    mountChatSurface('codex');

    render(<MobileAgentInstancesPane {...baseProps} />);
    openRowMenu('codex');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(DELEGATE_TEXT.en.self, 'info'));
    expect(composer.value).toBe('');
    // Refused before either read: nothing goes on the wire for a click that
    // can never insert.
    expect(cliReferenceReads()).toHaveLength(0);
  });

  it('still inserts for another row while a session is on screen', async () => {
    // The guard is per row: with codex's transcript on screen, delegating TO
    // claude-2 is exactly the intended use.
    answerBriefReads('claude-2', 'claude');
    const composer = mountComposer();
    mountChatSurface('codex');

    render(<MobileAgentInstancesPane {...baseProps} />);
    openRowMenu('claude-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-claude-2'));

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(composer.value).toContain('--instance claude-2');
  });

  it('says there is no composer, and does not throw, when none is on screen', async () => {
    answerBriefReads('codex', 'codex');

    render(<MobileAgentInstancesPane {...baseProps} />);
    openRowMenu('codex');
    expect(() => {
      fireEvent.click(screen.getByTestId('agent-instance-delegate-codex'));
    }).not.toThrow();

    // The PC wording, from the PC key — not a mobile paraphrase.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(DELEGATE_TEXT.en.noComposer, 'error'));
    expect(document.querySelector('[data-testid="message-input-textarea"]')).toBeNull();
  });
});


// ============================================================================
// Issue #2395: the docked composer's target reaches the shared self guard
// ============================================================================

/**
 * #2382 left the phone's guard permanently "unknown": the shared pane asks the
 * DOM which transcript is on screen, and on a phone the transcript (Terminal
 * tab) and this pane (Tools tab) are never mounted together. So the row the
 * composer was already addressing offered to delegate to itself.
 *
 * `composerTargetInstanceId` is that answer, threaded down from the screen. This
 * wrapper's only job is to forward it, so what is pinned here is the FORWARD:
 * the prop given to this component has to reach the shared pane's rows, and no
 * mobile rule of its own may sit in between.
 */
describe('MobileAgentInstancesPane: composer target (Issue #2395)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the delegation item on the row the docked composer sends to', () => {
    render(<MobileAgentInstancesPane {...baseProps} composerTargetInstanceId="claude" />);
    openRowMenu('claude');

    expect(screen.queryByTestId('agent-instance-delegate-claude')).toBeNull();
  });

  it('keeps it on the other rows, including the other instance of the same tool', () => {
    render(<MobileAgentInstancesPane {...baseProps} composerTargetInstanceId="claude" />);

    openRowMenu('claude-2');
    expect(screen.getByTestId('agent-instance-delegate-claude-2')).toBeTruthy();

    openRowMenu('codex');
    expect(screen.getByTestId('agent-instance-delegate-codex')).toBeTruthy();
  });

  it('still inserts from a kept row while a target is named', async () => {
    // The point of the guard is to remove one dead item, not to disarm the
    // feature on phones: the rows that remain must still write the composer.
    answerBriefReads('codex', 'codex');
    const composer = mountComposer();

    render(<MobileAgentInstancesPane {...baseProps} composerTargetInstanceId="claude" />);
    openRowMenu('codex');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex'));

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(composer.value).toContain('--instance codex');
    expect(showToast).toHaveBeenCalledWith(DELEGATE_TEXT.en.inserted, 'success');
  });

  it('leaves every row offering the item when no target is supplied', () => {
    // The pre-#2395 shape, and the one every other caller of this pane gets.
    render(<MobileAgentInstancesPane {...baseProps} />);

    openRowMenu('claude');
    expect(screen.getByTestId('agent-instance-delegate-claude')).toBeTruthy();
  });
});
