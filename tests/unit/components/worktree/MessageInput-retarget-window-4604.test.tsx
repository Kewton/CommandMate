/**
 * Issue #4604 (設計書 §3.1・§3.4.1・§5): #4607's T-a bench (a press right after the commit of a To
 * change, before its passive effects — `layout` — and again after them — `act`) with the rows #4604
 * adds:
 *
 * - the store holds the "unknown" shape (a tag that could not be stored as a list), or this page holds
 *   the draft's unstorable mark (nothing could be stored) — × the eight press points × the three ways
 *   the To changes × the three shapes (PC split pane, mobile composer, `/sessions` tile) × the timing.
 *   (#4607's file keeps the readable and unreadable stores: the store × shape table is cut on that
 *   diagonal — the four stores are each run once across the two files.)
 * - W-1: a `/sessions` tile whose instance changes under a draft with no tag — the brief's three choices,
 *   Enter, [send], the form's submit, #4503's resend [yes]: nothing is sent to the new instance (its
 *   draft is another; develop sent the previous instance's text from the brief in one press).
 *
 * T-b (one oracle, 案 A'): every POST holds when (i) the text's tag names the POST's To (a readable
 * list), or (ii) the POST's To is the To of the question the person last said yes to (the "unknown" and
 * the page's mark have no target: only (ii)). A press point missing at `layout` (where everything is
 * still on screen) fails the row; a row that POSTs nothing leaves no brief either (r4 check P3-2).
 *
 * @vitest-environment jsdom
 */
import React, { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
import { getInstanceDraftKey, getRetargetTagKey, getSplitDraftKey, readRetargetUnstorable, writeRetarget } from '@/lib/drafts/message-draft';
import { releasePageMarks } from '@tests/helpers/draft-store-fault-4604';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
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

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));

const WT = 'wt-4604-window';
const TEXT = 'hello agent';
const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};

interface Target {
  id: string;
  tool: CLIToolType;
}

const ORIGINAL: Target = { id: 'codex-2', tool: 'codex' };
const CURRENT: Target = { id: 'claude-2', tool: 'claude' };
type Change = 'tool' | 'instance' | 'both';
const NEXTS: Record<Change, Target> = {
  tool: { id: 'claude-2', tool: 'codex' },
  instance: { id: 'claude-3', tool: 'claude' },
  both: { id: 'claude-3', tool: 'codex' },
};
const CANDIDATES: Target[] = [CURRENT, ...Object.values(NEXTS)];

interface Shape {
  name: string;
  mobile: boolean;
  tile: boolean;
  props: { splitIndex?: number; draftScope?: 'split' | 'instance' };
  key: string;
}

const SHAPES: Shape[] = [
  { name: 'PC split pane', mobile: false, tile: false, props: { splitIndex: 1 }, key: getSplitDraftKey(WT, 1) },
  { name: 'mobile composer', mobile: true, tile: false, props: { splitIndex: 0 }, key: getSplitDraftKey(WT, 0) },
  { name: '/sessions tile', mobile: false, tile: true, props: { draftScope: 'instance' }, key: getInstanceDraftKey(WT, CURRENT.id) },
];

type Press = 'band-yes' | 'brief-short' | 'brief-full' | 'brief-decline' | 'enter' | 'send-button' | 'form-submit' | 'resend-yes';
const PRESSES: Press[] = ['band-yes', 'brief-short', 'brief-full', 'brief-decline', 'enter', 'send-button', 'form-submit', 'resend-yes'];
type Store = 'unknown' | 'unstorable' | 'untagged';
type Timing = 'layout' | 'act';

const describeTo = (to: Target) => `${to.id} (${to.tool})`;
const sameTo = (a: Target | null, b: Target) => a !== null && a.id === b.id && a.tool === b.tool;

/** What the band on screen names as the To now (one of the candidates; the original is not one). */
function bandTo(): Target | null {
  const band = screen.queryByTestId('message-input-retarget-confirm');
  if (!band) return null;
  const named = CANDIDATES.filter((to) => (band.textContent ?? '').includes(describeTo(to)));
  expect(named).toHaveLength(1);
  return named[0];
}

/** T-b: the To the question the person last answered yes to named, and each POST with it. */
const oracle = {
  lastYes: null as Target | null,
  posts: [] as Array<{ to: Target; lastYes: Target | null }>,
};

function clickYes(el: HTMLElement) {
  oracle.lastYes = bandTo();
  el.click();
}

const PRESS_TESTID: Partial<Record<Press, string>> = {
  'band-yes': 'message-input-retarget-confirm-yes',
  'brief-short': 'session-start-brief-short',
  'brief-full': 'session-start-brief-full',
  'brief-decline': 'session-start-brief-decline',
  'send-button': 'send-message-button',
  'resend-yes': 'message-input-resend-confirm-yes',
};

/** One press, with the DOM's own events (no `act`: it runs inside the commit's layout effect too). */
let pressMissing: Press | null = null;
function press(kind: Press, mustExist = false) {
  const testId = PRESS_TESTID[kind];
  if (testId) {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) {
      if (mustExist) pressMissing = kind;
      return;
    }
    if (kind === 'band-yes') clickYes(el);
    else el.click();
    return;
  }
  const textarea = document.querySelector('[data-testid="message-input-textarea"]') as HTMLTextAreaElement | null;
  if (!textarea) return;
  if (kind === 'enter') {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  } else {
    textarea.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
}

function Harness({ to, shape, pressOnCommit }: { to: Target; shape: Shape; pressOnCommit: Press | null }) {
  const pressed = useRef(false);
  useLayoutEffect(() => {
    // After the commit of the To change (the DOM and the handlers are this render's), before the
    // passive effects of that commit ran.
    if (pressOnCommit && !pressed.current && !sameTo(to, CURRENT)) {
      pressed.current = true;
      press(pressOnCommit, true);
    }
  }, [to, pressOnCommit]);
  return <MessageInput worktreeId={WT} cliToolId={to.tool} instanceId={to.id} isSessionRunning onMessageSent={vi.fn()} {...shape.props} />;
}

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function sendOnce(shape: Shape) {
  if (shape.mobile) fireEvent.click(screen.getByTestId('send-message-button'));
  else pressEnter();
}

function expectPostsHoldTheInvariant(store: Store) {
  for (const post of oracle.posts) {
    // (i) is for a readable list only: neither the "unknown" nor the page's mark names a target. A draft
    // with no tag (W-1) is a plain text: it may go where it is sent — but never from another draft.
    const tagged = store === 'untagged';
    const answered = post.lastYes !== null && sameTo(post.to, post.lastYes);
    expect({ post: post.to, lastYes: post.lastYes, ok: tagged || answered }).toEqual({ post: post.to, lastYes: post.lastYes, ok: true });
  }
}

beforeEach(() => {
  pressMissing = null;
  mobile.value = false;
  window.localStorage.clear();
  oracle.lastYes = null;
  oracle.posts = [];
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string, options: { cliToolId: CLIToolType; instanceId?: string }) => {
    oracle.posts.push({ to: { id: options.instanceId ?? options.cliToolId, tool: options.cliToolId }, lastYes: oracle.lastYes });
    return { id: `s-${oracle.posts.length}`, role: 'user', content, timestamp: new Date() };
  });
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  releasePageMarks(SHAPES.map((shape) => shape.key));
  window.localStorage.clear();
});

const CASES: Array<[string, Shape, Press, Change, Store, Timing]> = [];
for (const timing of ['layout', 'act'] as Timing[]) {
  for (const shape of SHAPES) {
    for (const kind of PRESSES) {
      // Enter inserts a newline on the mobile composer: it is not a send there.
      if (kind === 'enter' && shape.mobile) continue;
      for (const change of ['tool', 'instance', 'both'] as Change[]) {
        for (const store of ['unknown', 'unstorable'] as Store[]) {
          CASES.push([`${timing} / ${shape.name} / ${kind} / ${change} / ${store}`, shape, kind, change, store, timing]);
        }
        // W-1: the tile's instance changes under a draft with no tag (the band is never up for it).
        if (shape.tile && change !== 'tool' && kind !== 'band-yes') {
          CASES.push([`${timing} / ${shape.name} / ${kind} / ${change} / untagged`, shape, kind, change, 'untagged', timing]);
        }
      }
    }
  }
}

describe('[#4604] a press between the commit of a To change and its passive effects (T-a × T-b, the new rows)', () => {
  it('the rows are counted (unknown · unstorable × 23 press points × 3 changes × 2 timings, + W-1)', () => {
    expect(CASES.filter((c) => c[4] !== 'untagged')).toHaveLength(2 * 23 * 3 * 2);
    expect(CASES.filter((c) => c[4] === 'untagged')).toHaveLength(7 * 2 * 2);
  });

  it.each(CASES)('%s', async (_name, shape, kind, change, store, timing) => {
    mobile.value = shape.mobile;
    const tagKey = getRetargetTagKey(shape.key);
    if (store === 'unknown') {
      window.localStorage.setItem(tagKey, JSON.stringify({ unknown: 'g-w', tags: [] }));
    } else if (store === 'unstorable') {
      // Nothing could be stored for this draft: this page keeps its mark.
      const throwing = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('full'); } };
      writeRetarget(shape.key, { kind: 'add', tags: [{ id: 't-w', original: { instanceId: ORIGINAL.id, cliToolId: ORIGINAL.tool } }] }, { storage: throwing });
      expect(readRetargetUnstorable(shape.key)).not.toBeNull();
    }
    if (kind === 'resend-yes') {
      window.localStorage.setItem(`${shape.key}:send-unknown`, JSON.stringify({ text: TEXT, target: `${WT}\u0000${CURRENT.id}` }));
    }
    const holdsYesAtBrief = kind !== 'band-yes' && kind !== 'resend-yes';
    if (holdsYesAtBrief) fetchStartPreviewMock.mockResolvedValue(SHOWN);

    const view = render(<Harness to={CURRENT} shape={shape} pressOnCommit={null} />);
    typeMessage(TEXT);
    await settle();
    sendOnce(shape);
    await settle();
    if (kind === 'resend-yes') {
      expect(screen.getByTestId('message-input-resend-confirm-yes')).toBeInTheDocument();
    } else if (store !== 'untagged') {
      expect(bandTo()).toEqual(CURRENT);
    }
    if (holdsYesAtBrief) {
      if (store !== 'untagged') clickYes(screen.getByTestId('message-input-retarget-confirm-yes'));
      await screen.findByTestId('session-start-brief-decline');
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
    }
    expect(sendMessageMock).not.toHaveBeenCalled();

    const next = NEXTS[change];
    if (timing === 'layout') {
      view.rerender(<Harness to={next} shape={shape} pressOnCommit={kind} />);
    } else {
      view.rerender(<Harness to={next} shape={shape} pressOnCommit={null} />);
      await settle();
      act(() => press(kind));
    }
    await settle(50);
    // #4503's resend row names its own target (the instance): another instance's render does not draw it.
    if (!(kind === 'resend-yes' && change !== 'tool')) expect(pressMissing).toBeNull();

    expect(sendMessageMock.mock.calls.length).toBeLessThanOrEqual(1);
    expectPostsHoldTheInvariant(store);
    if (shape.tile && change !== 'tool') {
      // Another instance shows another draft: nothing sent, nothing left to answer.
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
      expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
      if (store === 'unknown') expect(window.localStorage.getItem(tagKey)).not.toBeNull();
      if (store === 'unstorable') expect(readRetargetUnstorable(shape.key)).not.toBeNull();
      return;
    }
    if (oracle.posts.length === 0) {
      const named = bandTo();
      if (named) expect(named).toEqual(next);
    }

    // Answer what is left once: the band (to the To now), then the brief.
    const yes = screen.queryByTestId('message-input-retarget-confirm-yes');
    if (yes) {
      act(() => clickYes(yes));
      await settle(20);
    }
    const decline = screen.queryByTestId('session-start-brief-decline');
    if (decline) {
      act(() => decline.click());
      await settle(20);
    }
    if (oracle.posts.length === 0) {
      const named = bandTo();
      if (named) expect(named).toEqual(next);
      // Nothing sent: the brief is not left up either.
      expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    }
    expect(sendMessageMock.mock.calls.length).toBeLessThanOrEqual(1);
    expectPostsHoldTheInvariant(store);
    for (const call of sendMessageMock.mock.calls) expect(call[1]).toBe(TEXT);
    expect(getTextarea()).toBeInTheDocument();
  });
});
