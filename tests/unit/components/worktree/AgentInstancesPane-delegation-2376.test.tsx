/**
 * "Insert delegation brief into the composer" (Issue #2376).
 *
 * The roster pane's kebab gains one item that does not touch the roster: it
 * turns row B into a paragraph telling the session on screen how to delegate to
 * B, and puts that paragraph in the composer.
 *
 * What is pinned:
 *
 *   - the `--instance` value in the inserted text is the SERVER'S answer
 *     (`/resolve-target`), never the roster row the menu was opened from. Issue
 *     #1925 is the record of what a second authority on that question costs;
 *   - a failed read inserts NOTHING. A plausible, unverified command in a
 *     composer is one Enter away from reaching a live agent;
 *   - the row that is the session on screen is refused.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const showToast = vi.fn();
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast }) };
});

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
];

const baseProps = {
  worktreeId: 'anvil-develop',
  instances: INSTANCES,
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

/** A composer on screen, exactly as `MessageInput` renders one. */
function mountComposer(initialValue = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('data-testid', 'message-input-textarea');
  textarea.value = initialValue;
  document.body.appendChild(textarea);
  return textarea;
}

/** A visible chat surface claiming to show `instanceId`'s transcript. */
function mountChatSurface(instanceId: string): void {
  const el = document.createElement('div');
  el.setAttribute('data-instance-id', instanceId);
  document.body.appendChild(el);
}

/** Answer the two reads the brief is built from. */
function answerBriefReads(instanceId = 'codex-2', cliToolId = 'codex'): void {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/cli-reference')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          binary: 'commandmatedev',
          worktreeId: 'anvil-develop',
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

function openRowMenu(id: string): void {
  fireEvent.keyDown(screen.getByTestId(`agent-instance-menu-${id}`), { key: 'Enter' });
}

describe('AgentInstancesPane: delegation brief (Issue #2376)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the item on every row', () => {
    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    expect(screen.getByTestId('agent-instance-delegate-codex-2')).toBeTruthy();
  });

  it('inserts a brief whose --instance is the server\'s answer, not the row', async () => {
    // The row says `codex-2`; the server says `codex-3`. The brief must carry
    // the server's answer — that is the whole point of asking.
    answerBriefReads('codex-3', 'codex');
    const composer = mountComposer();

    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex-2'));

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(composer.value).toContain('commandmatedev ask anvil-develop --instance codex-3');
    expect(composer.value).not.toContain('--instance codex-2');
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('appends below a half-typed message rather than destroying it', async () => {
    answerBriefReads();
    const composer = mountComposer('draft in progress');

    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex-2'));

    await waitFor(() => expect(composer.value).not.toBe('draft in progress'));
    expect(composer.value.startsWith('draft in progress\n\n')).toBe(true);
  });

  it('inserts nothing when either read fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const composer = mountComposer();

    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(composer.value).toBe('');
  });

  it('refuses the row that is the session on screen', async () => {
    answerBriefReads();
    const composer = mountComposer();
    mountChatSurface('codex-2');

    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info'));
    expect(composer.value).toBe('');
    // Nothing was even read: refusing early is what keeps the two requests off
    // the wire for a click that can never insert.
    expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes('/cli-reference')))
      .toHaveLength(0);
  });

  it('says so when there is no composer to insert into', async () => {
    answerBriefReads();

    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    fireEvent.click(screen.getByTestId('agent-instance-delegate-codex-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });

  it('reads nothing until the item is clicked (#2054\'s zero-request rule)', () => {
    render(<AgentInstancesPane {...baseProps} />);
    openRowMenu('codex-2');
    expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes('/resolve-target')))
      .toHaveLength(0);
  });
});
