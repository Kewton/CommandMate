/**
 * Issue #4607 r4 (INV-V2c''', 設計書 §3.4.1): the send's check compares the To of the very render
 * whose handler runs — the same value the POST's options are built from — with the To the answer
 * holds. A press that lands after the commit of a render that changed the To, before its passive
 * effects ran (React 19 runs them in a later task for a non-sync commit: the roster read again after
 * a 409 `tool-changed`, a poll), sees the new To in its handler and in the DOM. A check that read a
 * copy written by a passive effect saw the old To there and sent to the new one in one press.
 *
 * T-a (one bench): the parent presses from its `useLayoutEffect` right after the commit of the To
 * change (`layout`), and the same table again after the effects ran (`act`). Press points: the band's
 * [yes], the brief's three choices, Enter (PC), the [send] button, the form's submit, #4503's resend
 * [yes]. × how the To changes (the tool only, the instance only, both) × the store (readable with a
 * tag / its `getItem` throws) × the shape (a PC split pane, the mobile composer, a /sessions tile).
 * Enter is not a send on the mobile composer (it inserts a newline): no Enter row there.
 *
 * T-b (one oracle): every POST is judged by one rule, not by an expectation written per press —
 * (i) the text's tag names the POST's To (the store is readable), or (ii) the POST's To (instance and
 * tool) is the To the question the person last answered yes to named. A press that POSTs nothing
 * leaves either no band or a band that names the To now. What is left on screen is then answered once
 * (the band's [yes], the brief's [send without reading]) and every POST is judged again.
 * A /sessions tile whose instance changes shows another draft: nothing is POSTed and neither the band
 * nor the brief is left (the old draft and its tag stay under the old instance's keys).
 *
 * @vitest-environment jsdom
 */
import React, { useLayoutEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { mockCommandGroups, getTextarea, typeMessage, pressEnter } from '@tests/helpers/message-input-test-utils';
import { getInstanceDraftKey, getRetargetTagKey, getSplitDraftKey, readRetargetStore } from '@/lib/drafts/message-draft';
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

const WT = 'wt-4607-window';
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
type Store = 'readable' | 'unreadable';
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
function press(kind: Press) {
  const testId = PRESS_TESTID[kind];
  if (testId) {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) return;
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
      press(pressOnCommit);
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
    const tagged = store === 'readable' && sameTo(post.to, ORIGINAL);
    const answered = post.lastYes !== null && sameTo(post.to, post.lastYes);
    expect({ post: post.to, lastYes: post.lastYes, ok: tagged || answered }).toEqual({ post: post.to, lastYes: post.lastYes, ok: true });
  }
}

beforeEach(() => {
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
  window.localStorage.clear();
});

const CASES: Array<[string, Shape, Press, Change, Store, Timing]> = [];
for (const timing of ['layout', 'act'] as Timing[]) {
  for (const shape of SHAPES) {
    for (const kind of PRESSES) {
      // Enter inserts a newline on the mobile composer: it is not a send there.
      if (kind === 'enter' && shape.mobile) continue;
      for (const change of ['tool', 'instance', 'both'] as Change[]) {
        for (const store of ['readable', 'unreadable'] as Store[]) {
          CASES.push([`${timing} / ${shape.name} / ${kind} / ${change} / ${store}`, shape, kind, change, store, timing]);
        }
      }
    }
  }
}

describe('[#4607 r4] a press between the commit of a To change and its passive effects (T-a × T-b)', () => {
  it.each(CASES)('%s', async (_name, shape, kind, change, store, timing) => {
    mobile.value = shape.mobile;
    const tagKey = getRetargetTagKey(shape.key);
    if (store === 'readable') {
      window.localStorage.setItem(tagKey, JSON.stringify([{ id: 't-w', original: { instanceId: ORIGINAL.id, cliToolId: ORIGINAL.tool } }]));
    } else {
      const real = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
        if (k === tagKey) throw new DOMException('denied', 'SecurityError');
        return real.call(this, k);
      });
    }
    if (kind === 'resend-yes') {
      // #4503: this draft's text has a send whose outcome is unknown, to this target.
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
    } else {
      expect(bandTo()).toEqual(CURRENT);
    }
    if (holdsYesAtBrief) {
      // The person said yes to CURRENT; the brief is up and the yes is held for its send.
      clickYes(screen.getByTestId('message-input-retarget-confirm-yes'));
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

    expect(sendMessageMock.mock.calls.length).toBeLessThanOrEqual(1);
    expectPostsHoldTheInvariant(store);
    if (shape.tile && change !== 'tool') {
      // Another instance shows another draft: nothing sent, nothing left to answer.
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-input-retarget-confirm')).toBeNull();
      expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
      // Issue #4604 S13: the marks are in the draft's one value — still the list.
      if (store === 'readable') expect(readRetargetStore(shape.key).kind).toBe('list');
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
    }
    expect(sendMessageMock.mock.calls.length).toBeLessThanOrEqual(1);
    expectPostsHoldTheInvariant(store);
    // Nothing went to the To it was not meant for — and a POST, if any, is the text once.
    for (const call of sendMessageMock.mock.calls) expect(call[1]).toBe(TEXT);
    expect(getTextarea()).toBeInTheDocument();
  });
});
