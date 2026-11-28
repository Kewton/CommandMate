/**
 * Issue #4604 (設計書 §5, v3 §2.3 の列): sequences of the person's and the page's steps over two
 * composers of one worktree — X (it switches instance i1 ↔ i2, `/sessions` tile scope) and Y (it shows
 * i1, mounted for its send only: two composers of one key that stay mounted in one page overwrite each
 * other's plain text, #4419, not this issue) — and another tab (the store alone, with its
 * `StorageEvent`).
 *
 * Words: `return` (the fence hands a text back into i1's draft, tagged with i1's tool now) · `type` ·
 * `switch` · `otherSend` (Y opens i1's draft afresh in this page, presses Enter once, and goes) · `otherTab` (another tab sent i1's draft after a yes: its text and
 * tags go from the store) · `reload` (the composers mount again) · `wait` (600 ms) · `fault` (the store's
 * fault changes: none · `:retarget` setItem throws · `:retarget` getItem throws · i2's text getItem
 * throws) · `enter` (X's Enter) · `yes` · `no` · `rosterRefresh` (i1's tool flips) · `409` (X's next
 * POST is stopped by the fence, `not_sent`).
 *
 * The oracle (案 A'), at every POST: each handed-back word in the POST was either going to the POST's
 * To (its tag's original), or covered by a yes the person gave in that composer while the word was in
 * it — for the To that yes named. At the end ("消さない判定"): every word the sequence put in is in a
 * composer, in the store, in a POST, or a toast said something could not be kept.
 *
 * Issue #4604 accept r1c (PM の処分, 案 i): a yes covers the words of the composer that gave it only — X's,
 * Y's and another tab's yes are each their own (#4604 comment 7185751687: another tab's yes is not this
 * tab's). More words, in their own seeds: `otherTab409` (another tab's send of i1's stored text is stopped
 * by the fence: it writes the tag into the store, with its `StorageEvent`; the stored text's words are
 * handed back, going to i1's To now) · `otherTabValue` (another tab writes a value back — a tag, or a new
 * "unknown" — with its event) · `yYes` (Y opens i1's draft, presses Enter, says yes when asked, and goes).
 *
 * Issue #4604 accept r1d (PM の処分, 案 A = 案 i + INV-S1 の広げ): the model's rule for a saved text — a
 * composer that writes its text into the store writes first every mark it holds (received or taken in).
 * So, after every step: each handed-back word in a stored text has its mark in the store next to it (a tag
 * naming its original, or an "unknown" — then everyone asks) — whoever opens that text asks. Checked in
 * the r1d seeds and the r1d fixed columns (`checkStore`), from the step a word is handed back (the 409's
 * refusal, `return`, another tab's 409); a sequence that has made the store fail (`fault` rtSet / rtGet) is
 * not checked from then on (the known limit: a mark that could not be stored). One more word for them:
 * `otherTab409u` (another tab's 409 whose list did not fit: only the short "unknown" went in).
 *
 * Seeds 1〜300, lengths 8〜20 (a small PRNG; a failing seed prints its sequence). Fixed columns F1・F2・F5・
 * F20・F21 (shape 3, V2-A)・F22 (V2-B, both shapes) in v4's form.
 *
 * Limits: `reload` mounts the composers again in the same document (this page's mark stays — a real
 * reload starts a new page; the known limit's road is `MessageInput-store-write-fail-4604`'s). A word
 * typed less than 600 ms before `reload` is not counted lost: an unmount writes no waiting save
 * (#4419, before this issue).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup, within, screen } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ApiError } from '@/lib/api-client';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import {
  getInstanceDraftKey,
  getRetargetTagKey,
  newRetargetTag,
  newRetargetGeneration,
  readRetargetTagState,
  returnRetargetedText,
  writeRetarget,
  type RetargetOp,
  type RetargetStorage,
} from '@/lib/drafts/message-draft';
import { installStoreFaults, isRetargetKey, otherTabWrites, rawStore, releasePageMarks, type StoreFaultRule } from '@tests/helpers/draft-store-fault-4604';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
const { sendMessageMock, fetchStartPreviewMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn(), fetchStartPreviewMock: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock, uploadImageFile: vi.fn() } };
});
vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({ groups: mockCommandGroups, filteredGroups: mockCommandGroups, allCommands: [], loading: false, error: null, isCatalogStale: false })),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const WT = 'wt-4604-columns';
const I1 = 'codex-2';
const I2 = 'codex-3';
const K1 = getInstanceDraftKey(WT, I1);
const K2 = getInstanceDraftKey(WT, I2);
const OTHER_TOOL: Record<string, CLIToolType> = { codex: 'claude', claude: 'codex' };

interface World {
  xInstance: string;
  tools: Record<string, CLIToolType>;
  mounted: boolean;
  /** Y is mounted for its send only (a composer that opens the draft afresh, sends, and goes). */
  yMounted: boolean;
}
const toast = vi.fn();

function Page({ world }: { world: World }) {
  if (!world.mounted) return null;
  return (
    <>
      <div data-testid="X">
        <MessageInput worktreeId={WT} cliToolId={world.tools[world.xInstance]} instanceId={world.xInstance} draftScope="instance" isSessionRunning onMessageSent={vi.fn()} showToast={toast} />
      </div>
      {world.yMounted && (
        <div data-testid="Y">
          <MessageInput worktreeId={WT} cliToolId={world.tools[I1]} instanceId={I1} draftScope="instance" isSessionRunning onMessageSent={vi.fn()} showToast={toast} />
        </div>
      )}
    </>
  );
}
const ta = (c: 'X' | 'Y') => within(screen.getByTestId(c)).getByTestId('message-input-textarea') as HTMLTextAreaElement;
const q = (c: 'X' | 'Y', id: string) => within(screen.getByTestId(c)).queryByTestId(id);

type Fault = 'none' | 'rtSet' | 'rtGet' | 'textGet2';
const FAULTS: Record<Fault, StoreFaultRule[]> = {
  none: [],
  rtSet: [{ method: 'setItem', key: isRetargetKey }],
  rtGet: [{ method: 'getItem', key: isRetargetKey }],
  textGet2: [{ method: 'getItem', key: (k) => k === K2 }],
};

interface Target {
  instanceId: string;
  cliToolId: string;
}
const same = (a: Target, b: Target) => a.instanceId === b.instanceId && a.cliToolId === b.cliToolId;

/** Who posts or says yes: the composers X and Y of this page, or another tab. */
type Poster = 'X' | 'Y' | 'otherTab';

/** The oracle's ledger. */
class Ledger {
  /** A handed-back word, and the target it was going to. */
  returned = new Map<string, Target>();
  /** A word a yes covered, and the To that yes named — per composer (r1c: a yes is its composer's only). */
  coveredBy = new Map<Poster, Map<string, Target>>();
  cover(who: Poster, word: string, to: Target) {
    let words = this.coveredBy.get(who);
    if (!words) {
      words = new Map();
      this.coveredBy.set(who, words);
    }
    words.set(word, to);
  }
  /** Every word put in. */
  words = new Set<string>();
  /** Words typed whose debounced save has not run yet, and the ones an unmount dropped (#4419: an
   * unmount writes nothing — before this issue, and not its subject). */
  unsaved = new Set<string>();
  dropped = new Set<string>();
  posts: Array<{ content: string; to: Target }> = [];
  violations: string[] = [];
  /** r1d: the words handed back so far (the 409's refusal, `return`, another tab's 409). */
  handedBack = new Set<string>();
  /** r1d: the store failed in this sequence (from then on the saved-text rule is not checked). */
  storeFailed = false;
  /** r1d (INV-S1 の広げ): a stored text's handed-back words have their marks in the store next to it. */
  checkStore(after: string) {
    if (this.storeFailed) return;
    for (const key of [K1, K2]) {
      const text = rawStore().get(key) ?? '';
      const raw = rawStore().get(getRetargetTagKey(key));
      let marks: unknown = null;
      try {
        marks = raw === null ? null : JSON.parse(raw);
      } catch {
        marks = 'junk';
      }
      const asksAll = marks !== null && !Array.isArray(marks);
      for (const w of text.split(/\s+/)) {
        const original = this.returned.get(w);
        if (!w || !this.handedBack.has(w) || !original || asksAll) continue;
        const tags = Array.isArray(marks) ? (marks as Array<{ original?: Target }>) : [];
        if (tags.some((tag) => tag.original !== undefined && same(tag.original, original))) continue;
        this.violations.push(`after ${after}: ${w} is stored under ${key === K1 ? 'i1' : 'i2'} without its mark`);
      }
    }
  }
  judge(content: string, to: Target, who: Poster) {
    this.posts.push({ content, to });
    for (const w of content.split(/\s+/)) {
      const original = this.returned.get(w);
      if (!original || same(original, to)) continue;
      const yes = this.coveredBy.get(who)?.get(w);
      if (yes && same(yes, to)) continue;
      this.violations.push(`${who}'s POST of ${w} (to ${to.instanceId}/${to.cliToolId}, going to ${original.instanceId}/${original.cliToolId}) without a yes`);
    }
  }
}

let ledger: Ledger;
let world: World;
let view: ReturnType<typeof render>;
let faults: ReturnType<typeof installStoreFaults>;
let refuseNext = false;
/** Run while a refused POST is awaited (another tab acting during X's await). */
let duringAwait: (() => void) | null = null;
/** Whether Y asked at its last send. */
let yAsked = false;
let seq = 0;
/** The composer whose POST the mock judges now (Y while Y is acting). */
let poster: Poster = 'X';
/** r1d: whether the saved-text rule is checked after each step. */
let checkStore = false;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}
function rerender() {
  view.rerender(<Page world={world} />);
}
const xTo = (): Target => ({ instanceId: world.xInstance, cliToolId: world.tools[world.xInstance] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  window.localStorage.clear();
  toast.mockReset();
  ledger = new Ledger();
  refuseNext = false;
  duringAwait = null;
  poster = 'X';
  checkStore = false;
  world = { xInstance: I1, tools: { [I1]: 'codex', [I2]: 'codex' }, mounted: true, yMounted: false };
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string, options: { cliToolId: string; instanceId?: string }) => {
    const to = { instanceId: options.instanceId ?? options.cliToolId, cliToolId: options.cliToolId };
    if (refuseNext) {
      refuseNext = false;
      for (const w of content.split(/\s+/)) if (w) ledger.handedBack.add(w);
      const meanwhile = duringAwait;
      duringAwait = null;
      meanwhile?.();
      throw new ApiError('The send target changed', 409, {
        error: 'The send target changed', code: 'SEND_TARGET_CHANGED', reason: 'tool-changed',
        target: { worktreeId: WT, instanceId: to.instanceId, cliToolId: to.cliToolId }, current: null, requestId: 'r', sendOutcome: 'not_sent',
      });
    }
    ledger.judge(content, to, poster);
    return { id: `s-${ledger.posts.length}`, role: 'user', content, timestamp: new Date() };
  });
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
  faults = installStoreFaults([]);
  view = render(<Page world={world} />);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  releasePageMarks([K1, K2]);
  window.localStorage.clear();
});

type Word = 'return' | 'type' | 'switch' | 'otherSend' | 'otherTab' | 'reload' | 'wait' | 'fault' | 'enter' | 'yes' | 'no' | 'rosterRefresh' | '409' | 'otherTab409' | 'otherTabValue' | 'yYes' | 'otherTab409u';
const WORDS: Word[] = ['return', 'type', 'switch', 'otherSend', 'otherTab', 'reload', 'wait', 'fault', 'enter', 'yes', 'no', 'rosterRefresh', '409'];
/** r1c: the words of another tab's 409, its value-carrying writes and Y's yes — in their own seeds. */
const WORDS_R1C: Word[] = [...WORDS, 'otherTab409', 'otherTabValue', 'yYes'];
/** r1d: and another tab's 409 that could keep only the short "unknown" — with the saved-text rule. */
const WORDS_R1D: Word[] = [...WORDS_R1C, 'otherTab409u'];

/**
 * r1c: another tab's write through the one road — it reads the store as it is (no fault of this page),
 * and each write it makes reaches this page as a `StorageEvent` (`otherTabWrites`).
 */
function otherTabRoad(draftKey: string, op: RetargetOp, full = false): void {
  const storage: RetargetStorage = {
    getItem: (key) => rawStore().get(key),
    setItem: (key, value) => {
      // r1d (`otherTab409u`): that tab's store is full — a long `:retarget` value does not go in.
      if (full && value.length > 60) throw new Error('full');
      otherTabWrites(key, value);
    },
    removeItem: (key) => otherTabWrites(key, null),
  };
  writeRetarget(draftKey, op, { storage, unstorable: new Map() });
}

async function step(word: Word, arg = 0) {
  switch (word) {
    case 'return': {
      const w = `r${++seq}`;
      ledger.words.add(w);
      const original = { instanceId: I1, cliToolId: world.tools[I1] };
      ledger.returned.set(w, original);
      act(() => {
        if (!returnRetargetedText(K1, { text: w, tag: newRetargetTag(original) })) ledger.words.delete(w); // not handed back (the toast's road)
        else ledger.handedBack.add(w);
      });
      break;
    }
    case 'type': {
      const w = `w${++seq}`;
      ledger.words.add(w);
      ledger.unsaved.add(w);
      const before = ta('X').value;
      fireEvent.change(ta('X'), { target: { value: before ? `${before} ${w}` : w } });
      break;
    }
    case 'switch':
      // The tile's switch writes the waiting save under its key (#4419).
      ledger.unsaved.clear();
      world = { ...world, xInstance: world.xInstance === I1 ? I2 : I1 };
      rerender();
      break;
    case 'otherSend':
      // Y opens i1's draft afresh (its own store read), presses Enter once, and goes (a question it
      // asks is left unanswered).
      world = { ...world, yMounted: true };
      rerender();
      await flush();
      poster = 'Y';
      fireEvent.keyDown(ta('Y'), { key: 'Enter', code: 'Enter' });
      await flush();
      poster = 'X';
      yAsked = q('Y', 'message-input-retarget-confirm') !== null;
      world = { ...world, yMounted: false };
      rerender();
      break;
    case 'otherTab': {
      // Another tab sent i1's draft after its person said yes (to i1's To now): what it saw is covered.
      const text = rawStore().get(K1) ?? '';
      for (const w of text.split(/\s+/)) if (ledger.returned.has(w)) ledger.cover('otherTab', w, { instanceId: I1, cliToolId: world.tools[I1] });
      for (const w of text.split(/\s+/)) if (w) ledger.posts.push({ content: w, to: { instanceId: I1, cliToolId: world.tools[I1] } });
      act(() => {
        otherTabWrites(K1, null);
        otherTabWrites(getRetargetTagKey(K1), null);
      });
      break;
    }
    case 'reload':
      for (const w of ledger.unsaved) ledger.dropped.add(w);
      ledger.unsaved.clear();
      world = { ...world, mounted: false };
      rerender();
      await flush();
      world = { ...world, mounted: true };
      rerender();
      break;
    case 'wait':
      ledger.unsaved.clear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      break;
    case 'fault': {
      const names: Fault[] = ['none', 'rtSet', 'rtGet', 'textGet2'];
      faults.set(FAULTS[names[arg % names.length]]);
      if (names[arg % names.length] === 'rtSet' || names[arg % names.length] === 'rtGet') ledger.storeFailed = true;
      break;
    }
    case 'enter':
      fireEvent.keyDown(ta('X'), { key: 'Enter', code: 'Enter' });
      break;
    case 'yes': {
      const yes = q('X', 'message-input-retarget-confirm-yes');
      if (!yes) break;
      for (const w of ta('X').value.split(/\s+/)) if (ledger.returned.has(w)) ledger.cover('X', w, xTo());
      fireEvent.click(yes);
      break;
    }
    case 'no': {
      const no = q('X', 'message-input-retarget-confirm-no');
      if (no) fireEvent.click(no);
      break;
    }
    case 'rosterRefresh':
      world = { ...world, tools: { ...world.tools, [I1]: OTHER_TOOL[world.tools[I1]] } };
      rerender();
      break;
    case '409': {
      // X's next POST is stopped by the fence: the text stays in X, tagged with the To it went to.
      refuseNext = true;
      const to = xTo();
      for (const w of ta('X').value.split(/\s+/)) if (w && !ledger.returned.has(w)) ledger.returned.set(w, to);
      break;
    }
    case 'otherTab409':
    case 'otherTab409u': {
      // Another tab sent i1's stored text and the fence stopped it: its tag goes into the store (through
      // the one road, in that tab), with the event this page hears; the words are handed back there.
      const original = { instanceId: I1, cliToolId: world.tools[I1] };
      for (const w of (rawStore().get(K1) ?? '').split(/\s+/)) {
        if (!w) continue;
        if (!ledger.returned.has(w)) ledger.returned.set(w, original);
        ledger.handedBack.add(w);
      }
      act(() => {
        otherTabRoad(K1, { kind: 'add', tags: [newRetargetTag(original)] }, word === 'otherTab409u');
      });
      break;
    }
    case 'otherTabValue':
      // Another tab writes a value back (a tag it holds, or a new "unknown"), with its event.
      act(() => {
        otherTabRoad(
          K1,
          arg % 2 === 0
            ? { kind: 'writeBack', tags: [newRetargetTag({ instanceId: I1, cliToolId: world.tools[I1] })] }
            : { kind: 'moveIn', from: { kind: 'unknown', generation: newRetargetGeneration(), tags: [] }, fromUnstorable: null },
        );
      });
      break;
    case 'yYes': {
      // Y opens i1's draft, presses Enter, says yes when asked (for its words, to its To), and goes.
      world = { ...world, yMounted: true };
      rerender();
      await flush();
      poster = 'Y';
      fireEvent.keyDown(ta('Y'), { key: 'Enter', code: 'Enter' });
      await flush();
      const yes = q('Y', 'message-input-retarget-confirm-yes');
      if (yes) {
        const yTo = { instanceId: I1, cliToolId: world.tools[I1] };
        for (const w of ta('Y').value.split(/\s+/)) if (ledger.returned.has(w)) ledger.cover('Y', w, yTo);
        fireEvent.click(yes);
        await flush();
      }
      poster = 'X';
      world = { ...world, yMounted: false };
      rerender();
      break;
    }
  }
  await flush();
  await flush();
  if (checkStore) ledger.checkStore(word);
}

/** The end: every word is somewhere, or a toast said something could not be kept. */
async function expectNothingLost() {
  faults.set([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  const places = [ta('X').value, rawStore().get(K1) ?? '', rawStore().get(K2) ?? '', ...ledger.posts.map((p) => p.content)].join(' ').split(/\s+/);
  const lost = [...ledger.words].filter((w) => !places.includes(w) && !ledger.dropped.has(w));
  if (lost.length > 0) expect(toast).toHaveBeenCalled();
}

/** A small seeded PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sequenceOf(seed: number, words: readonly Word[] = WORDS): Array<[Word, number]> {
  const r = prng(seed);
  const length = 8 + Math.floor(r() * 13);
  return Array.from({ length }, () => [words[Math.floor(r() * words.length)], Math.floor(r() * 4)] as [Word, number]);
}

describe('[#4604] seeded sequences (seeds 1〜300, lengths 8〜20)', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
  it.each(SEEDS)('seed %i', async (seed) => {
    const words = sequenceOf(seed);
    for (const [word, arg] of words) await step(word, arg);
    expect({ seed, sequence: words.map(([w, a]) => (w === 'fault' ? `fault:${a % 4}` : w)).join(' '), violations: ledger.violations }).toEqual({
      seed,
      sequence: words.map(([w, a]) => (w === 'fault' ? `fault:${a % 4}` : w)).join(' '),
      violations: [],
    });
    await expectNothingLost();
  });
});

describe('[#4604 accept r1c] seeded sequences with another tab\'s 409, its value-carrying writes and Y\'s yes (seeds 1〜300)', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
  it.each(SEEDS)('seed %i', async (seed) => {
    const words = sequenceOf(seed, WORDS_R1C);
    for (const [word, arg] of words) await step(word, arg);
    const shown = words.map(([w, a]) => (w === 'fault' ? `fault:${a % 4}` : w)).join(' ');
    expect({ seed, sequence: shown, violations: ledger.violations }).toEqual({ seed, sequence: shown, violations: [] });
    await expectNothingLost();
  });
});

describe('[#4604 accept r1d] seeded sequences with the saved-text rule (INV-S1 の広げ, seeds 1〜300)', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
  it.each(SEEDS)('seed %i', async (seed) => {
    checkStore = true;
    const words = sequenceOf(seed, WORDS_R1D);
    for (const [word, arg] of words) await step(word, arg);
    const shown = words.map(([w, a]) => (w === 'fault' ? `fault:${a % 4}` : w)).join(' ');
    expect({ seed, sequence: shown, violations: ledger.violations }).toEqual({ seed, sequence: shown, violations: [] });
    await expectNothingLost();
  });
});

describe('[#4604 accept r1d] fixed columns (INV-S1 の広げ: another tab\'s 409, it sends, X saves the text)', () => {
  /** X shows i1's text; another tab's 409 (`which`); the tool changes; that tab sends; X types and saves. */
  async function xSavesAfterOtherTabSent(which: 'otherTab409' | 'otherTab409u') {
    checkStore = true;
    await step('type');
    await step('wait');
    await step(which);
    await step('rosterRefresh');
    await step('otherTab');
    await step('type');
    await step('wait');
  }

  it('R1 (the review): …X reloads — Enter asks', async () => {
    await xSavesAfterOtherTabSent('otherTab409');
    await step('reload');
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });

  it('R2 (the review): …X switches away and back — Enter asks', async () => {
    await xSavesAfterOtherTabSent('otherTab409');
    await step('switch');
    await step('switch');
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });

  it('R3: …a composer opens the draft afresh (Y) — it asks', async () => {
    await xSavesAfterOtherTabSent('otherTab409');
    await step('otherSend');
    expect(ledger.violations).toEqual([]);
    expect(yAsked).toBe(true);
  });

  it('R5: the short "unknown" (another tab\'s store is full) …X reloads — Enter asks', async () => {
    await xSavesAfterOtherTabSent('otherTab409u');
    await step('reload');
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });
});

describe('[#4604] fixed columns', () => {
  it('F1 (4 回目): a handed-back text in i1, i2\'s text cannot be read, X switches to i2 — the text is not shown there, Enter sends nothing of it', async () => {
    await step('return');
    expect(ta('X').value).toMatch(/^r\d+$/);
    faults.set(FAULTS.textGet2);
    await step('switch');
    expect(ta('X').value).toBe('');
    await step('enter');
    expect(ledger.posts).toEqual([]);
    expect(ledger.violations).toEqual([]);
  });

  it('F2 (5 回目): …then the store recovers and X goes i2 → i1 → i2 — i2 never shows the text, i1 asks once the tool changed', async () => {
    await step('return');
    faults.set(FAULTS.textGet2);
    await step('switch');
    await step('wait');
    faults.set([]);
    await step('switch');
    await step('switch');
    expect(ta('X').value).toBe('');
    await step('enter');
    await step('switch');
    await step('rosterRefresh');
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });

  it('F5: an older version\'s `:retarget` list is there when the composer opens — the To differs, it asks', async () => {
    cleanup();
    window.localStorage.setItem(K1, 'r-old');
    window.localStorage.setItem(getRetargetTagKey(K1), JSON.stringify([{ id: 'old', original: { instanceId: I1, cliToolId: 'claude' } }]));
    ledger.returned.set('r-old', { instanceId: I1, cliToolId: 'claude' });
    view = render(<Page world={world} />);
    await flush();
    await step('enter');
    expect(ledger.posts).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });

  it('F20 (N-1): a plain draft, a full store (the tag\'s value does not fit), the awaited 409 — remount, the tool changes: Enter asks', async () => {
    await step('type');
    await step('wait');
    faults.set([{ method: 'setItem', key: isRetargetKey, overBytes: 60 }]);
    await step('409');
    await step('enter');
    faults.set([]);
    await step('reload');
    await step('rosterRefresh');
    await step('enter');
    await step('otherSend');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
    expect(readRetargetTagState(K1).known).toBe(false);
  });

  it('F21 (shape 3, V2-A): another tab hands a text back during X\'s await, and the store cannot be read at the 409 — its tag is not written over', async () => {
    await step('rosterRefresh'); // i1 is claude now
    await step('type');
    await step('wait');
    // X's send goes to i1 (claude) and is refused; while it is awaited another tab hands a text back
    // into i1's draft (its tag names codex), and at the 409 the store's getItem throws.
    refuseNext = true;
    duringAwait = () => {
      const r = `r${++seq}`;
      ledger.words.add(r);
      ledger.returned.set(r, { instanceId: I1, cliToolId: 'codex' });
      const raw = rawStore();
      raw.set(K1, `${raw.get(K1) ?? ''}\n\n${r}`);
      raw.set(getRetargetTagKey(K1), JSON.stringify([{ id: 'other-tab', original: { instanceId: I1, cliToolId: 'codex' } }]));
      faults.set(FAULTS.rtGet);
    };
    for (const w of ta('X').value.split(/\s+/)) if (w) ledger.returned.set(w, xTo());
    await step('enter');
    faults.set([]);
    // The page opens again (the To is still claude): the other tab's text must still ask.
    await step('reload');
    expect(ta('X').value).toMatch(/r\d+/);
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
  });

  it('U4-1 (r1c): X shows i1\'s text, another tab\'s 409 tags it, the tool changes, that tab sends after its yes — X asks', async () => {
    await step('type');
    await step('wait');
    await step('otherTab409');
    await step('rosterRefresh');
    await step('otherTab');
    expect(ta('X').value).toMatch(/^w\d+$/);
    await step('enter');
    expect(ledger.violations).toEqual([]);
    expect(q('X', 'message-input-retarget-confirm')).not.toBeNull();
    await step('yes');
    expect(ledger.violations).toEqual([]);
    expect(ledger.posts.at(-1)?.to).toEqual(xTo());
  });

  it('F22 (V2-B): X\'s awaited 409 — Y (same draft, this page) and another tab (it reads the store) both ask', async () => {
    await step('type');
    await step('wait');
    await step('409');
    await step('enter');
    await step('rosterRefresh');
    await step('otherSend');
    expect(yAsked).toBe(true);
    const state = readRetargetTagState(K1);
    expect(state.known && state.tags.length > 0).toBe(true);
    expect(ledger.violations).toEqual([]);
  });
});
