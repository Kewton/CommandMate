/**
 * Issue #4345 1c: a stand-in worktree page for the surfaces it draws — registered and published as
 * `useWorktreeDetailController` does, its opening already made and read — with the one host
 * (`HandoffDialogHost`) beside it, and the page's registration holder handed to what it draws through
 * `HandoffPageOwnerContext`, as `WorktreeDetailRefactored` does. The real page's own entries (and its
 * detail read, the one recovery) are driven in `useWorktreeDetailController-page-entries-auth-4345`.
 *
 * A test file using this mocks `next/navigation` (`usePathname` → `/worktrees/wt-a`) and `next-intl`.
 * The case runner ({@link runEntryCase}) answers one entry as asked and everything else normally.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { HandoffPageOwnerContext } from '@/hooks/useHandoffPageOwner';
import { beginHandoffOpening, handoffStoreSnapshot, patchHandoffOpening, type HandoffOpeningToken } from '@/lib/handoff/close-rule';
import {
  beginHandoffPageRequest,
  handoffRegistrySnapshot,
  publishHandoffPageView,
  registerHandoffPage,
  reportHandoffPageAuthenticated,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';
import type { HandoffPageOwner } from '@/lib/handoff/page-owner';
import type { HandoffReadResponse } from '@/lib/handoff/types';

export const PAGE_WORKTREE = 'wt-a';
const TARGET = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' } as const;

export const HANDOFF_READ_VIEW = {
  ok: true,
  request: {
    id: 'r1', worktreeId: PAGE_WORKTREE, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  },
  proposals: [],
  direct: [],
};

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The dialog's own requests (its mode and its request's read), or `null` for any other. */
export function answerHandoffDialog(url: string): Response | null {
  if (url.includes('/mem/mode')) return json(200, { ok: true, mode: 'on', features: { popup: true } });
  if (url.includes('/mem/handoff/requests/r1')) return json(200, HANDOFF_READ_VIEW);
  return null;
}

export interface StandInPage {
  readonly registration: HandoffPageRegistration;
  readonly owner: HandoffPageOwner;
  readonly token: HandoffOpeningToken;
}

/** A page of {@link PAGE_WORKTREE} registered, its view published, its opening made and read. */
export function standInPage(): StandInPage {
  const registration = registerHandoffPage(PAGE_WORKTREE);
  publishHandoffPageView(registration, { target: TARGET, onClose: () => undefined, onStop: async () => 'stopped' });
  const own = beginHandoffOpening(PAGE_WORKTREE, TARGET);
  patchHandoffOpening(own.token, { created: 'done', view: HANDOFF_READ_VIEW as unknown as HandoffReadResponse, text: 'the request text' });
  return { registration, owner: { current: registration }, token: own.token };
}

export const handoffDialog = (): Element | null => document.querySelector('[data-testid="handoff-dialog"]');
export const settle = (): Promise<void> => act(async () => new Promise((done) => setTimeout(done, 0)));

/** The host, and `children` under the page's holder (`owner` `null`: drawn outside any page). */
export function PageTree({ owner, children }: { owner: HandoffPageOwner | null; children?: React.ReactNode }) {
  return (
    <>
      <HandoffDialogHost />
      {owner ? <HandoffPageOwnerContext.Provider value={owner}>{children}</HandoffPageOwnerContext.Provider> : children}
    </>
  );
}

/** The page's detail read succeeded (the one recovery; the real read is driven in the controller's file). */
export function recoverByDetailRead(registration: HandoffPageRegistration): void {
  act(() => {
    reportHandoffPageAuthenticated(beginHandoffPageRequest(registration));
  });
}

/** The opening as it was: the same token, not closed. */
export function expectOpeningKept(token: HandoffOpeningToken): void {
  const opening = handoffStoreSnapshot().opening;
  expect(opening?.token).toBe(token);
  expect(opening?.closed).toBe(false);
}

/** One entry of a surface: how its request is told apart, its normal answer, what draws it and presses it. */
export interface EntryCase {
  matches: (url: string, method: string) => boolean;
  ok: () => Response;
  ui: () => React.ReactElement;
  /**
   * After the surface is drawn (omitted: drawing it sends the request). Presses through `fireEvent`
   * or wraps its own calls in `act`.
   */
  trigger?: () => unknown;
}

/** What the entry under test answers: a status, or `0` for no response. */
export interface EntryAnswer {
  status: number | undefined;
  calls: number;
}

/**
 * A `fetch` for the case: the dialog's own requests, the entry (answered by `answer.status` when set,
 * else normally, counted), and `fallback` for the rest.
 */
export function entryFetch(entry: EntryCase, answer: EntryAnswer, fallback: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const dialogAnswer = answerHandoffDialog(url);
    if (dialogAnswer) return dialogAnswer;
    if (entry.matches(url, method)) {
      answer.calls += 1;
      if (answer.status === undefined) return entry.ok();
      if (answer.status === 0) throw new TypeError('Failed to fetch');
      return json(answer.status, { error: `e${answer.status}`, success: false });
    }
    return fallback(url, init);
  };
}

export type OwnerKind = 'page' | 'old' | 'none';

/**
 * The host drawn with the page's dialog shown; then the surface drawn under the owner and its entry
 * pressed, answering `status`. Answers the page (the current registration's when `owner` is `old`).
 */
export async function runEntryCase(entry: EntryCase, answer: EntryAnswer, status: number | undefined, owner: OwnerKind = 'page'): Promise<StandInPage> {
  const page = standInPage();
  let held: HandoffPageOwner | null = page.owner;
  let current = page;
  if (owner === 'old') {
    // A page made again: the surface still holds the old registration; the new one is current.
    const again = registerHandoffPage(PAGE_WORKTREE);
    publishHandoffPageView(again, { target: TARGET, onClose: () => undefined, onStop: async () => 'stopped' });
    current = { ...page, registration: again, owner: { current: again } };
  }
  if (owner === 'none') held = null;
  const { rerender } = render(<PageTree owner={held} />);
  await waitFor(() => expect(handoffDialog()).not.toBeNull());
  answer.status = status;
  rerender(<PageTree owner={held}>{entry.ui()}</PageTree>);
  await settle();
  // Not wrapped in one act: a trigger presses through `fireEvent` (each its own act, so a render
  // lands between two presses) or wraps its own calls.
  if (entry.trigger) await entry.trigger();
  await waitFor(() => expect(answer.calls).toBeGreaterThan(0), { timeout: 4000 });
  await settle();
  await settle();
  return current;
}

export const sessionExpired = (): boolean => handoffRegistrySnapshot().authExpired;

/**
 * The controls of 1c for each entry of `cases` (the fetch answering the rest with `fallback`):
 * positive — its 401 expires the session, the host draws nothing, the opening stays, the detail
 * read's success brings the same opening back; negative — 403, 409, no response, an older
 * registration's 401 and a 401 drawn outside any page leave the session as it is.
 */
export function describeEntryCases(
  label: string,
  cases: Record<string, EntryCase>,
  fallback: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  const names = Object.keys(cases);
  const arm = (name: string): EntryAnswer => {
    const answer: EntryAnswer = { status: undefined, calls: 0 };
    global.fetch = vi.fn(entryFetch(cases[name], answer, fallback)) as unknown as typeof fetch;
    return answer;
  };

  describe(`[#4345 1c] ${label}: each entry's 401 — expired, hidden, the opening kept; the detail read's success brings it back`, () => {
    it.each(names)('%s answers 401', async (name) => {
      const answer = arm(name);
      const page = await runEntryCase(cases[name], answer, 401);
      expect(sessionExpired()).toBe(true);
      expect(handoffDialog()).toBeNull();
      expectOpeningKept(page.token);
      answer.status = undefined;
      recoverByDetailRead(page.registration);
      expect(sessionExpired()).toBe(false);
      await waitFor(() => expect(handoffDialog()).not.toBeNull());
      expectOpeningKept(page.token);
    });
  });

  describe(`[#4345 1c] ${label}: (negative controls) the session is left as it is`, () => {
    it.each(names.flatMap((name) => [403, 409, 0].map((status) => [name, status] as const)))('%s answers %s', async (name, status) => {
      const answer = arm(name);
      const page = await runEntryCase(cases[name], answer, status);
      expect(sessionExpired()).toBe(false);
      expect(handoffDialog()).not.toBeNull();
      expectOpeningKept(page.token);
    });

    it.each(names)('%s: a 401 of a request that left under an older registration', async (name) => {
      const answer = arm(name);
      await runEntryCase(cases[name], answer, 401, 'old');
      expect(sessionExpired()).toBe(false);
      expect(handoffDialog()).not.toBeNull();
    });

    it.each(names)('%s: a 401 drawn outside any page (no owner)', async (name) => {
      const answer = arm(name);
      await runEntryCase(cases[name], answer, 401, 'none');
      expect(sessionExpired()).toBe(false);
      expect(handoffDialog()).not.toBeNull();
    });
  });
}
