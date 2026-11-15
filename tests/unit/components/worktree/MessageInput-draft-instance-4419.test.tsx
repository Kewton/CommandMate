/**
 * Issue #4419 (再指示 1): the composer's draft with `draftScope="instance"` (the `/sessions` tile)
 * across a change of the instance it shows, on the paths that wait on the server — and the split
 * scope's (#728) legacy-key migration, which the instance scope must not take part in.
 *
 * - A send with the G-3 choice (#4227) is awaited. If the composer switched instance meanwhile,
 *   its success clears only the sent draft's stored copy — never the draft now on screen, its state
 *   or its waiting save.
 * - A G-3 question still open when the composer switches instance closes: it names the old
 *   instance's boundary, and answering it would send the next instance's draft with that id.
 *
 * Positive control: red before 再指示 1 (the success cleared the claude draft; the question stayed
 * open and sent the claude draft with antigravity's boundary). Negative control: the split scope
 * still migrates the worktree-only legacy key into split 0.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage } from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const { sendMessageMock, fetchStartPreviewMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() },
    handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
  };
});

vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const WT = 'wt-1';
const AGY_KEY = `commandmate:draft-message:${WT}:instance:antigravity`;
const CLAUDE_KEY = `commandmate:draft-message:${WT}:instance:claude`;
const AGY_DRAFT = 'only for antigravity';
const CLAUDE_DRAFT = 'only for claude';

const SHOWN = (id: string) => ({
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id, kind: 'launch' },
  preview: { open: { count: 3, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: ['state'] }, lastUpdatedAt: null },
});

function tileComposer(instance: 'antigravity' | 'claude') {
  return (
    <MessageInput
      worktreeId={WT}
      cliToolId={instance}
      instanceId={instance}
      draftScope="instance"
      isSessionRunning
      onOptimisticSend={vi.fn()}
    />
  );
}

async function askOnAntigravity() {
  fetchStartPreviewMock.mockResolvedValue(SHOWN('b-agy'));
  const view = render(tileComposer('antigravity'));
  typeMessage(AGY_DRAFT);
  await act(async () => {
    fireEvent.submit(getTextarea().closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(await screen.findByTestId('session-start-brief-dialog')).toBeInTheDocument();
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchStartPreviewMock.mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('[#4419 再指示 1] a G-3 send and an instance switch', () => {
  it('the send answers after the composer switched instance: the draft on screen stays, only the sent one is cleared', async () => {
    let answer!: (value: unknown) => void;
    sendMessageMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    window.localStorage.setItem(CLAUDE_KEY, CLAUDE_DRAFT);
    const view = await askOnAntigravity();
    fireEvent.click(screen.getByTestId('session-start-brief-full'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][1]).toBe(AGY_DRAFT);
    window.localStorage.setItem(AGY_KEY, AGY_DRAFT);

    view.rerender(tileComposer('claude'));
    await waitFor(() => expect(getTextarea().value).toBe(CLAUDE_DRAFT));
    await act(async () => {
      answer({ id: 'srv-1', role: 'user', content: AGY_DRAFT, timestamp: new Date() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getTextarea().value).toBe(CLAUDE_DRAFT);
    expect(window.localStorage.getItem(AGY_KEY)).toBeNull();
    // Past the debounce: the claude draft's save was not cancelled into an empty one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(window.localStorage.getItem(CLAUDE_KEY)).toBe(CLAUDE_DRAFT);
  });

  it('a question open when the composer switches instance closes, and nothing is sent with its boundary', async () => {
    window.localStorage.setItem(CLAUDE_KEY, CLAUDE_DRAFT);
    const view = await askOnAntigravity();
    fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
    view.rerender(tileComposer('claude'));
    await waitFor(() => expect(getTextarea().value).toBe(CLAUDE_DRAFT));
    await waitFor(() => expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull());
    expect(screen.queryByTestId('session-start-brief-full')).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('negative control: the same send with no switch clears the draft as before', async () => {
    sendMessageMock.mockResolvedValue({ id: 'srv-1', role: 'user', content: AGY_DRAFT, timestamp: new Date() });
    await askOnAntigravity();
    fireEvent.click(screen.getByTestId('session-start-brief-full'));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ cliToolId: 'antigravity', briefDetail: 'full', briefBoundary: 'b-agy' });
    await waitFor(() => expect(getTextarea().value).toBe(''));
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
  });
});

describe('[#4419 再指示 1] the legacy draft keys', () => {
  it('negative control: split scope, split 0 still migrates the worktree-only legacy key (#728)', async () => {
    window.localStorage.setItem(`commandmate:draft-message:${WT}`, 'legacy draft');
    render(<MessageInput worktreeId={WT} cliToolId="claude" splitIndex={0} />);
    await waitFor(() => expect(getTextarea().value).toBe('legacy draft'));
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:0`)).toBe('legacy draft');
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}`)).toBeNull();
  });

  it('instance scope neither shows nor migrates the split-0 or the legacy draft (they stay for the worktree screen)', async () => {
    window.localStorage.setItem(`commandmate:draft-message:${WT}`, 'legacy draft');
    window.localStorage.setItem(`commandmate:draft-message:${WT}:0`, 'split 0 draft');
    render(tileComposer('claude'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getTextarea().value).toBe('');
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}`)).toBe('legacy draft');
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:0`)).toBe('split 0 draft');
  });
});
