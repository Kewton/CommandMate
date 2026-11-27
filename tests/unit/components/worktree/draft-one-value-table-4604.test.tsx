/**
 * Issue #4604 S13 (構造の直し、#4616 を含む): the table of the one value — written before the fix, red on
 * develop 0882e72e4 (two and three keys per draft), green once a draft is one value under one key.
 *
 * The invariants (s12/enabler-return-4604-rootcause-c8.md §3; s13/brief-4604-s13.md):
 * - I1: every operation changes one draft's store with one `setItem` / `removeItem` on one key.
 * - I2: in every state of the store, a stored text has its mark (a tag, or "unknown") in the same value —
 *   after every single write of any tab.
 * - I3: whatever the store holds, a composer opened afresh sends to a changed To only after a question.
 *
 * Rows (written so that they do not depend on the stored value's shape — `tests/helpers/draft-ledger-4604.ts`):
 * - 表の生成元: the write points of `MessageInput.tsx` and `message-draft.ts`, listed by machine, pinned
 *   here (each one is driven by a G1 row). The fix rewrites this table (it is the source of the rows).
 * - G1 書き込みの数え (I1): per operation, the writes to the draft's keys and how many keys — `toEqual`
 *   one write on one key (送信 楽観・待つ, 遅らせた保存, 切り替え, 戻し, 追記, 移動, 409, #4503 の印).
 * - 写しの数: a draft's keys in the store (3 → 1) and a send's writes (→ 1).
 * - G2 2 タブの書き込みの交差 (I2・I3): two tabs (two real composers, one document each: the `storage`
 *   events and the in-page channels reach the other tab only), each operation split into its writes
 *   (counted by a dry run from the same state), every order of the two write sequences enumerated
 *   (C(n+m, n)); I2 is checked after every write, I3 by a composer opened afresh at the end. An order
 *   where one tab's writes are contiguous runs live (that operation runs, for real, between two writes
 *   of the other's — reads see the store as it is then); an order that splits both replays the recorded
 *   writes. Pairs: 送信×遅らせた保存 (P2-1), 送信×切り替え, 409×遅らせた保存, 戻し×遅らせた保存.
 * - G3 監視の口: the ledger checks I2 after every write (the hook any #4604 test can run under) — a
 *   negative control (one tab's whole flow: no violation), a positive control (a bare text write is
 *   named), and P2-1 named at its write.
 * - #4616: the store is full (a value with the tag does not fit, a short one does), two tabs hold the
 *   same tag — they do not write back and forth without end, and Enter → question → yes sends once.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup, within, type RenderResult } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ApiError } from '@/lib/api-client';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import {
  appendToStoredDraft,
  getInstanceDraftKey,
  moveDraft,
  newRetargetTag,
  returnRetargetedText,
} from '@/lib/drafts/message-draft';
import { releasePageMarks, stripComments } from '@tests/helpers/draft-store-fault-4604';
import {
  choose,
  contiguousAt,
  draftKeysInStore,
  installDraftLedger,
  interleavings,
  raw,
  type DraftLedger,
  type DraftLedgerOptions,
  type LedgerWrite,
  type Tab,
} from '@tests/helpers/draft-ledger-4604';
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
// Two tabs are two documents: the in-page channels of the draft reach the calling tab's composers only.
vi.mock('@/lib/drafts/message-draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drafts/message-draft')>();
  const { perTab } = await import('@tests/helpers/draft-ledger-4604');
  return {
    ...actual,
    subscribeRetargetedText: perTab(actual.subscribeRetargetedText),
    subscribeDraftAppend: perTab(actual.subscribeDraftAppend),
  };
});
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups, filteredGroups: mockCommandGroups, allCommands: [], loading: false, error: null, isCatalogStale: false,
  })),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const WT = 'wt-4604-one-value';
const I = 'codex-2';
const I2 = 'codex-3';
const K = getInstanceDraftKey(WT, I);
const K2 = getInstanceDraftKey(WT, I2);
const ORIGINAL = { instanceId: I, cliToolId: 'codex' };
/**
 * The text the fence stopped. A command body (`!…`): the send reads no start preview, so a send's writes
 * run within its press (an operation another tab's whole operation can run inside of).
 */
const FENCED = '!fenced 4604 hello';
const PLAIN = 'plain words';
/** I2's scenario rule: a stored text holding the fenced text carries its mark. */
const tagged = (text: string): boolean => text.includes(FENCED);

const RACE_TIMEOUT_MS = 60_000;

const toast = vi.fn();
const optimisticSend = vi.fn();

function fence(): ApiError {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason: 'tool-changed',
    target: { worktreeId: WT, instanceId: I, cliToolId: 'codex' },
    current: null,
    requestId: 'r-1',
    sendOutcome: 'not_sent',
  });
}
const unknown500 = () => new ApiError('submit could not be confirmed', 500, { error: 'submit could not be confirmed', sendOutcome: 'unknown' });

interface OneProps {
  tool: CLIToolType;
  instanceId?: string;
  /** The PC page's road (`onOptimisticSend`); else the awaited road. */
  optimistic?: boolean;
}
function One({ tool, instanceId = I, optimistic = false }: OneProps) {
  return (
    <MessageInput
      worktreeId={WT}
      cliToolId={tool}
      instanceId={instanceId}
      draftScope="instance"
      isSessionRunning
      onMessageSent={vi.fn()}
      showToast={toast}
      onOptimisticSend={optimistic ? optimisticSend : undefined}
    />
  );
}

let ledger: DraftLedger;
function takeLedger(options: Partial<DraftLedgerOptions> = {}): DraftLedger {
  ledger?.restore();
  ledger = installDraftLedger({ drafts: [K], tabs: ['a', 'b'], tagged, ...options });
  return ledger;
}

/** One tab's composer: its own render root (another document as far as the store's events go). */
interface TabView {
  name: Tab;
  view: RenderResult;
  props: OneProps;
}
function mount(name: Tab, props: OneProps): TabView {
  const view = ledger.as(name, () => render(<One {...props} />));
  return { name, view, props };
}
function rerender(t: TabView, props: Partial<OneProps>) {
  t.props = { ...t.props, ...props };
  ledger.as(t.name, () => t.view.rerender(<One {...t.props} />));
}
const textarea = (t: TabView) => within(t.view.container).getByTestId('message-input-textarea') as HTMLTextAreaElement;
const band = (t: TabView) => within(t.view.container).queryByTestId('message-input-retarget-confirm');
const yesButton = (t: TabView) => within(t.view.container).getByTestId('message-input-retarget-confirm-yes');
const type = (t: TabView, value: string) => ledger.as(t.name, () => fireEvent.change(textarea(t), { target: { value } }));
const enter = (t: TabView) => ledger.as(t.name, () => fireEvent.keyDown(textarea(t), { key: 'Enter', code: 'Enter' }));

async function settle(tab: Tab | null = null, ms = 10) {
  const prev = ledger.actor;
  ledger.actor = tab;
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  } finally {
    ledger.actor = prev;
  }
}

/** Every composer goes, the store and this page's marks are emptied (a new world). */
async function reset() {
  cleanup();
  ledger.dropSaves();
  ledger.dropQueue();
  ledger.nest = null;
  ledger.bridge = true;
  window.localStorage.clear();
  releasePageMarks([K, K2]);
  ledger.violations.length = 0;
  ledger.armed = false;
}

beforeEach(() => {
  window.localStorage.clear();
  toast.mockReset();
  optimisticSend.mockReset();
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string) => ({ id: 's', role: 'user', content, timestamp: new Date() }));
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
  takeLedger();
});
afterEach(() => {
  cleanup();
  ledger.restore();
  vi.restoreAllMocks();
  releasePageMarks([K, K2]);
  window.localStorage.clear();
});

/* ------------------------------------------------------------------------------------------------
 * The arrangements (each from an empty store, through real composers only — no value is seeded).
 * ---------------------------------------------------------------------------------------------- */

interface Tabs {
  a: TabView;
  b: TabView;
}

/**
 * P2-1's state: tab a (the PC page's road) had FENCED handed back with its tag (the history's 409: 戻し);
 * tab b heard the tag (it took it in); the tool of I changed (both tabs read the roster again); a's Enter
 * asked (its band is up); b typed — its save is held (it runs where an order puts it). The events stop
 * here (bridge off): what follows happens before either tab hears the other.
 */
async function arrangeSendRace(): Promise<Tabs> {
  const tag = newRetargetTag(ORIGINAL);
  const a = mount('a', { tool: 'codex', optimistic: true });
  const b = mount('b', { tool: 'codex' });
  await settle();
  ledger.fireSaves('a');
  ledger.fireSaves('b');
  await ledger.deliver();
  let handed = false;
  ledger.as('a', () => act(() => {
    handed = returnRetargetedText(K, { text: FENCED, tag });
  }));
  expect(handed).toBe(true);
  await settle('a');
  ledger.fireSaves('a');
  await ledger.deliver();
  rerender(a, { tool: 'claude' });
  rerender(b, { tool: 'claude' });
  await settle();
  enter(a);
  await settle('a', 30);
  expect(band(a)).not.toBeNull();
  expect(textarea(a).value).toBe(FENCED);
  type(b, `${FENCED} more`);
  await settle('b');
  expect(ledger.pendingSaves('b')).toBe(1);
  ledger.dropQueue();
  ledger.bridge = false;
  return { a, b };
}

/** Tab a (awaited road) and tab b both show FENCED (a typed it; b opened after); b typed more (held). */
async function arrange409Race(): Promise<Tabs> {
  const a = mount('a', { tool: 'codex' });
  await settle();
  ledger.fireSaves('a');
  type(a, FENCED);
  await settle('a');
  ledger.fireSaves('a');
  const b = mount('b', { tool: 'codex' });
  await settle('b');
  expect(textarea(b).value).toBe(FENCED);
  ledger.fireSaves('b');
  await ledger.deliver();
  type(b, `${FENCED} more`);
  await settle('b');
  expect(ledger.pendingSaves('b')).toBe(1);
  sendMessageMock.mockRejectedValueOnce(fence());
  ledger.dropQueue();
  ledger.bridge = false;
  return { a, b };
}

/** Tab b's draft PLAIN is stored; b typed more (held). Tab a is the page whose history hands a text back. */
async function arrangeReturnRace(): Promise<Tabs> {
  const a = mount('a', { tool: 'codex', optimistic: true });
  const b = mount('b', { tool: 'codex' });
  await settle();
  ledger.fireSaves('a');
  ledger.fireSaves('b');
  type(b, PLAIN);
  await settle('b');
  ledger.fireSaves('b');
  await ledger.deliver();
  type(b, `${PLAIN} more`);
  await settle('b');
  expect(ledger.pendingSaves('b')).toBe(1);
  ledger.dropQueue();
  ledger.bridge = false;
  return { a, b };
}

/* ------------------------------------------------------------------------------------------------
 * The operations: `outer` runs one alone (its writes are its tab's); `inner` runs it whole and
 * synchronously between two writes of another operation (null: it cannot — it waits on a promise).
 * ---------------------------------------------------------------------------------------------- */

interface Op {
  name: string;
  tab: Tab;
  outer: (t: Tabs) => Promise<void>;
  inner: ((t: Tabs) => void) | null;
}

/** Tab a says yes and its send goes (the PC page's road, a command body: within the press). */
const sendA: Op = {
  name: '送信',
  tab: 'a',
  async outer(t) {
    // A plain DOM click (not inside `act`): an operation run between its writes may use `act` itself.
    ledger.as('a', () => yesButton(t.a).click());
    await settle('a', 30);
  },
  inner(t) {
    yesButton(t.a).click();
  },
};
/** Tab b's debounced save runs. */
const saveB: Op = {
  name: '遅らせた保存',
  tab: 'b',
  async outer() {
    expect(ledger.fireSaves('b')).toBe(1);
    await settle('b');
  },
  inner() {
    ledger.fireSaves('b');
  },
};
/** Tab b's tile switches to another instance with its save still held. */
const switchB: Op = {
  name: '切り替え',
  tab: 'b',
  async outer(t) {
    rerender(t.b, { instanceId: I2 });
    await settle('b');
  },
  inner(t) {
    rerender(t.b, { instanceId: I2 });
  },
};
/** Tab a's awaited send of FENCED is stopped by the fence (409 not_sent): its tag goes in. */
const fence409A: Op = {
  name: '409',
  tab: 'a',
  async outer(t) {
    const before = sendMessageMock.mock.calls.length;
    ledger.actor = 'a';
    try {
      await act(async () => {
        fireEvent.keyDown(textarea(t.a), { key: 'Enter', code: 'Enter' });
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } finally {
      ledger.actor = null;
    }
    expect(sendMessageMock.mock.calls.length - before).toBe(1);
  },
  inner: null,
};
/** Tab a's history hands FENCED back with its tag (戻し: `returnRetargetedText`). */
const returnA: Op = {
  name: '戻し',
  tab: 'a',
  async outer() {
    ledger.as('a', () => act(() => {
      returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) });
    }));
    await settle('a');
  },
  inner() {
    returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) });
  },
};

interface Race {
  arrange: () => Promise<Tabs>;
  X: Op;
  Y: Op;
}

/** I3: a composer opened afresh on the changed To (claude) — if it shows the fenced text, Enter does not POST. */
async function freshEnter(): Promise<string | null> {
  cleanup();
  ledger.dropSaves();
  ledger.dropQueue();
  const before = sendMessageMock.mock.calls.length;
  const fresh = mount('fresh', { tool: 'claude' });
  await settle('fresh');
  const shown = textarea(fresh).value;
  enter(fresh);
  await settle('fresh', 30);
  const posts = sendMessageMock.mock.calls.length - before;
  return tagged(shown) && posts > 0 ? `a fresh composer showing ${JSON.stringify(shown)}: Enter → POST ${posts}, no question` : null;
}

interface OrderResult {
  order: string;
  mode: 'live' | 'replay';
  i2: string[];
  i3: string | null;
}

type Recorded = Pick<LedgerWrite, 'method' | 'key' | 'value'>;

/** The dry run: from one arranged state, X alone, then (the store put back) Y alone — their writes. */
async function dryRun(race: Race): Promise<{ s0: Map<string, string>; x: Recorded[]; y: Recorded[] }> {
  const t = await race.arrange();
  const s0 = new Map(draftKeysInStore(K).map((key) => [key, raw.get(key) as string]));
  const putBack = () => {
    for (const key of draftKeysInStore(K)) raw.remove(key);
    for (const [key, value] of s0) raw.set(key, value);
  };
  const take = (from: number, tab: Tab): Recorded[] =>
    ledger.writesOf(K, from, tab).filter((w) => !w.refused).map(({ method, key, value }) => ({ method, key, value }));
  let from = ledger.writes.length;
  await race.X.outer(t);
  const x = take(from, race.X.tab);
  putBack();
  from = ledger.writes.length;
  await race.Y.outer(t);
  const y = take(from, race.Y.tab);
  await reset();
  return { s0, x, y };
}

/**
 * G2: every order of X's and Y's writes. I2 after each write, I3 at the end. Returns the counts and the
 * orders that broke I2 or I3.
 */
async function enumerate(race: Race): Promise<{ n: number; m: number; orders: number; live: number; bad: OrderResult[] }> {
  const { s0, x, y } = await dryRun(race);
  const orders = interleavings(x.length, y.length);
  const results: OrderResult[] = [];
  for (const order of orders) {
    const label = order.join('');
    const yAt = contiguousAt(order, 'Y');
    const xAt = contiguousAt(order, 'X');
    const plan =
      yAt !== null && race.Y.inner !== null
        ? { outer: race.X, inner: race.Y, at: yAt }
        : xAt !== null && race.X.inner !== null
          ? { outer: race.Y, inner: race.X, at: xAt }
          : null;
    if (plan !== null) {
      const t = await race.arrange();
      ledger.violations.length = 0;
      const inner = plan.inner;
      ledger.nest = { outer: plan.outer.tab, at: plan.at, inner: inner.tab, run: () => inner.inner!(t), done: false, base: ledger.writes.length };
      await plan.outer.outer(t);
      if (!ledger.nest.done) {
        ledger.nest.done = true;
        ledger.as(inner.tab, () => inner.inner!(t));
        await settle(inner.tab);
      }
      ledger.nest = null;
      const i2 = [...ledger.violations];
      const i3 = await freshEnter();
      results.push({ order: label, mode: 'live', i2, i3 });
    } else {
      // Both split: the recorded writes, in this order, over the arranged state.
      await reset();
      for (const [key, value] of s0) raw.set(key, value);
      ledger.checkI2('replay start');
      const xs = [...x];
      const ys = [...y];
      for (const [i, who] of order.entries()) {
        const w = (who === 'X' ? xs : ys).shift()!;
        if (w.method === 'setItem') raw.set(w.key, w.value as string);
        else raw.remove(w.key);
        ledger.checkI2(`replay #${i} ${who} ${w.method} ${w.key.slice(K.length) || 'K'}`);
      }
      const i2 = [...ledger.violations];
      const i3 = await freshEnter();
      results.push({ order: label, mode: 'replay', i2, i3 });
    }
    await reset();
  }
  expect(results).toHaveLength(choose(x.length + y.length, y.length));
  return {
    n: x.length,
    m: y.length,
    orders: results.length,
    live: results.filter((r) => r.mode === 'live').length,
    bad: results.filter((r) => r.i2.length > 0 || r.i3 !== null),
  };
}

/* ------------------------------------------------------------------------------------------------
 * 表の生成元: the write points, by machine.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The calls that write a draft's store (directly, or through a writer), per file — develop 0882e72e4.
 * Each is driven by a G1 row: `writeDraft`・`clearStoredDraft`・`clearSentDraft`・`releaseSentTags` (送信,
 * 遅らせた保存, 切り替え), `writeRetargetTold`・`writeRetarget` (409, 遅らせた保存, 切り替え, `storage` の
 * 書き戻し), `writeSendUnknownMark` (#4503 の印, 送信), `localStorage.*` in MessageInput (the legacy
 * key's migration — I1's one exception — and the writers above), `returnRetargetedText` (戻し),
 * `appendToStoredDraft` (追記), `moveDraft` (移動). The fix rewrites this table with its writers.
 */
const WRITE_POINTS: Record<string, Record<string, number>> = {
  'src/components/worktree/MessageInput.tsx': {
    'localStorage.setItem': 3,
    'localStorage.removeItem': 3,
    writeRetarget: 1,
    writeSendUnknownMark: 4,
    releaseRetargetTags: 1,
    writeRetargetTold: 7,
    writeDraft: 4,
    clearStoredDraft: 2,
    releaseSentTags: 3,
    clearSentDraft: 2,
  },
  'src/lib/drafts/message-draft.ts': {
    'localStorage.setItem': 3,
    writeRetarget: 3,
    'storage.removeItem': 1,
    'storage.setItem': 2,
    'localStorage.removeItem': 1,
  },
};
const WRITE_CALL = /(function\s+)?\b((?:window\.)?localStorage\.(?:setItem|removeItem)|storage\.(?:setItem|removeItem)|writeRetargetTold|writeRetarget|writeDraft|writeSendUnknownMark|releaseRetargetTags|releaseSentTags|clearStoredDraft|clearSentDraft|returnRetargetedText|appendToStoredDraft|moveDraft)\(/g;

describe('[#4604 S13 表の生成元] the write points of the draft store, listed by machine', () => {
  it('MessageInput.tsx and message-draft.ts write the store at the points this table lists (each driven by a G1 row)', () => {
    const found: Record<string, Record<string, number>> = {};
    for (const file of Object.keys(WRITE_POINTS)) {
      const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
      const counts: Record<string, number> = {};
      for (const match of src.matchAll(WRITE_CALL)) {
        if (match[1]) continue; // a definition, not a call
        const callee = match[2].replace(/^window\./, '');
        counts[callee] = (counts[callee] ?? 0) + 1;
      }
      found[file] = counts;
    }
    expect(found).toEqual(WRITE_POINTS);
  });
});

/* ------------------------------------------------------------------------------------------------
 * G1: one operation, one write, one key (I1).
 * ---------------------------------------------------------------------------------------------- */

type Counts = Record<string, { writes: number; keys: number }>;
/** The writes since `from` (by `actor` when given), per draft ('K' · 'K2'): how many, on how many keys. */
function countWrites(from: number, actor?: Tab): Counts {
  const out: Counts = {};
  for (const [name, draft] of [['K', K], ['K2', K2]] as const) {
    const writes = ledger.writesOf(draft, from, actor);
    if (writes.length > 0) out[name] = { writes: writes.length, keys: new Set(writes.map((w) => w.key)).size };
  }
  return out;
}
const ONE: Counts = { K: { writes: 1, keys: 1 } };

/** A composer of the awaited road with FENCED handed back into its draft (its own tag), To changed, asked. */
async function arrangeAwaitedAsked(): Promise<TabView> {
  const c = mount('c', { tool: 'codex' });
  await settle();
  ledger.fireSaves('c');
  ledger.as('c', () => act(() => {
    returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) });
  }));
  await settle('c');
  ledger.fireSaves('c');
  rerender(c, { tool: 'claude' });
  await settle('c');
  enter(c);
  await settle('c', 30);
  expect(band(c)).not.toBeNull();
  return c;
}

/** A composer of the awaited road whose typed FENCED is stored. */
async function arrangeAwaitedTyped(): Promise<TabView> {
  const c = mount('c', { tool: 'codex' });
  await settle();
  ledger.fireSaves('c');
  type(c, FENCED);
  await settle('c');
  ledger.fireSaves('c');
  return c;
}

/** P2-1's state, then a's send went and tab b heard it: b holds a tag it took in that the store lacks. */
async function arrangeTakenInMissing(): Promise<Tabs> {
  const t = await arrangeSendRace();
  ledger.bridge = true;
  await sendA.outer(t);
  await ledger.deliver();
  expect(ledger.pendingSaves('b')).toBe(1);
  return t;
}

describe('[#4604 S13 G1] one operation writes one draft once, on one key (I1)', () => {
  const rows: Array<{ op: string; expected: Counts; run: () => Promise<Counts> }> = [
    {
      op: '送信（楽観の道: 本文・#4503 の印・印の手放し）',
      expected: ONE,
      run: async () => {
        const t = await arrangeSendRace();
        const from = ledger.writes.length;
        await sendA.outer(t);
        return countWrites(from, 'a');
      },
    },
    {
      op: '送信（待つ道）',
      expected: ONE,
      run: async () => {
        const c = await arrangeAwaitedAsked();
        const from = ledger.writes.length;
        ledger.as('c', () => act(() => {
          yesButton(c).click();
        }));
        await settle('c', 30);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        return countWrites(from, 'c');
      },
    },
    {
      op: '遅らせた保存（取り込んだ印を保存が持たない）',
      expected: ONE,
      run: async () => {
        await arrangeTakenInMissing();
        const from = ledger.writes.length;
        await saveB.outer({} as Tabs);
        return countWrites(from, 'b');
      },
    },
    {
      op: '切り替え（保存待ちあり・取り込んだ印を保存が持たない）',
      expected: ONE,
      run: async () => {
        const t = await arrangeTakenInMissing();
        const from = ledger.writes.length;
        await switchB.outer(t);
        return countWrites(from, 'b');
      },
    },
    {
      op: '戻し（returnRetargetedText）',
      expected: ONE,
      run: async () => {
        const from = ledger.writes.length;
        ledger.as('lib', () => returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) }));
        return countWrites(from);
      },
    },
    {
      op: '追記（appendToStoredDraft、印のある下書きへ）',
      expected: ONE,
      run: async () => {
        ledger.as('lib', () => returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) }));
        const from = ledger.writes.length;
        ledger.as('lib', () => appendToStoredDraft(K, PLAIN));
        return countWrites(from);
      },
    },
    {
      op: '移動（moveDraft、印のある下書きを K から K2 へ）',
      expected: { K: { writes: 1, keys: 1 }, K2: { writes: 1, keys: 1 } },
      run: async () => {
        takeLedger({ drafts: [K, K2] });
        ledger.as('lib', () => returnRetargetedText(K, { text: FENCED, tag: newRetargetTag(ORIGINAL) }));
        const from = ledger.writes.length;
        expect(ledger.as('lib', () => moveDraft(K, K2))).toBe('moved');
        return countWrites(from);
      },
    },
    {
      op: '409（待つ道、柵の not_sent で印が付く）',
      expected: ONE,
      run: async () => {
        const c = await arrangeAwaitedTyped();
        sendMessageMock.mockRejectedValueOnce(fence());
        const from = ledger.writes.length;
        enter(c);
        await settle('c', 30);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        return countWrites(from, 'c');
      },
    },
    {
      op: '届いたか分からない（#4503 の印）',
      expected: ONE,
      run: async () => {
        const c = await arrangeAwaitedTyped();
        sendMessageMock.mockRejectedValueOnce(unknown500());
        const from = ledger.writes.length;
        enter(c);
        await settle('c', 30);
        expect(within(c.view.container).queryByTestId('message-input-send-unknown')).not.toBeNull();
        return countWrites(from, 'c');
      },
    },
  ];
  for (const row of rows) {
    it(`G1 ${row.op}`, async () => {
      expect(await row.run()).toEqual(row.expected);
    }, RACE_TIMEOUT_MS);
  }
});

/* ------------------------------------------------------------------------------------------------
 * 写しの数: keys per draft 3 → 1, a send's writes → 1.
 * ---------------------------------------------------------------------------------------------- */

describe('[#4604 S13 写しの数] the copies of one draft in the store', () => {
  it('a draft holding a text, a #4503 mark and a handed-back tag is one key, and its send writes once', async () => {
    const c = await arrangeAwaitedTyped();
    sendMessageMock.mockRejectedValueOnce(unknown500());
    enter(c);
    await settle('c', 30);
    ledger.as('c', () => act(() => {
      returnRetargetedText(K, { text: 'returned', tag: newRetargetTag(ORIGINAL) });
    }));
    await settle('c');
    ledger.fireSaves('c');
    const keys = draftKeysInStore(K).length;
    // The tag's original is this To: the send goes without a question (the #4503 mark is another text's now).
    const from = ledger.writes.length;
    enter(c);
    await settle('c', 30);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const sendWrites = ledger.writesOf(K, from, 'c').length;
    expect({ keys, sendWrites }).toEqual({ keys: 1, sendWrites: 1 });
  }, RACE_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------------
 * G2: two tabs' writes, every order (I2 after each write, I3 at the end).
 * ---------------------------------------------------------------------------------------------- */

describe('[#4604 S13 G2] two tabs, every order of their writes: I2 after each, I3 at the end', () => {
  it('送信×遅らせた保存 (P2-1): a sends after its yes, b saves the text it holds the taken-in tag for', async () => {
    const report = await enumerate({ arrange: arrangeSendRace, X: sendA, Y: saveB });
    expect(report.bad).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('送信×切り替え: a sends after its yes, b\'s tile switches with its save held', async () => {
    const report = await enumerate({ arrange: arrangeSendRace, X: sendA, Y: switchB });
    expect(report.bad).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('409×遅らせた保存: a\'s awaited send is stopped by the fence (its tag goes in), b saves what it typed', async () => {
    const report = await enumerate({ arrange: arrange409Race, X: fence409A, Y: saveB });
    expect(report.bad).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('戻し×遅らせた保存: a\'s history hands FENCED back with its tag, b saves what it typed', async () => {
    const report = await enumerate({ arrange: arrangeReturnRace, X: returnA, Y: saveB });
    expect(report.bad).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------------
 * G3: the monitor (I2 after every write).
 * ---------------------------------------------------------------------------------------------- */

describe('[#4604 S13 G3] the monitor checks I2 after every write', () => {
  it('(negative control) one tab: type, save, the fence\'s 409, the To changes, asked, yes, sent — no write breaks I2', async () => {
    const c = await arrangeAwaitedTyped();
    sendMessageMock.mockRejectedValueOnce(fence());
    enter(c);
    await settle('c', 30);
    rerender(c, { tool: 'claude' });
    await settle('c');
    type(c, `${FENCED} more`);
    await settle('c');
    ledger.fireSaves('c');
    enter(c);
    await settle('c', 30);
    expect(band(c)).not.toBeNull();
    ledger.as('c', () => act(() => {
      yesButton(c).click();
    }));
    await settle('c', 30);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(ledger.violations).toEqual([]);
  }, RACE_TIMEOUT_MS);

  it('(positive control) once armed, a bare text write holding the fenced text is named', () => {
    ledger.armed = true;
    ledger.as('probe', () => window.localStorage.setItem(K, FENCED));
    expect(ledger.violations).toHaveLength(1);
    expect(ledger.violations[0]).toContain('probe');
  });

  it('P2-1 named at its write: b\'s save runs right after a\'s first write of its send', async () => {
    const t = await arrangeSendRace();
    ledger.violations.length = 0;
    ledger.nest = { outer: 'a', at: 1, inner: 'b', run: () => saveB.inner!(t), done: false, base: ledger.writes.length };
    await sendA.outer(t);
    if (!ledger.nest.done) {
      ledger.nest.done = true;
      saveB.inner!(t);
    }
    expect(ledger.violations).toEqual([]);
  }, RACE_TIMEOUT_MS);
});

/* ------------------------------------------------------------------------------------------------
 * #4616: a full store, two tabs holding the same tag.
 * ---------------------------------------------------------------------------------------------- */

describe('[#4616] a full store: two tabs holding the same tag do not write back and forth without end', () => {
  it('a text handed back in tab a goes in only as the short "unknown"; the tabs go quiet; b asks, and its yes sends once', async () => {
    const t1 = newRetargetTag(ORIGINAL);
    let full = false;
    // A full store: a value carrying t1 does not fit; a short one (no tag) does.
    takeLedger({ refuse: (_key, value) => full && value.includes(t1.id) });
    ledger.as('lib', () => returnRetargetedText(K, { text: FENCED, tag: t1 }));
    const a = mount('a', { tool: 'claude' });
    const b = mount('b', { tool: 'claude' });
    await settle();
    expect(textarea(b).value).toBe(FENCED);
    ledger.fireSaves('a');
    ledger.fireSaves('b');
    await ledger.deliver();
    full = true;
    ledger.as('a', () => act(() => {
      returnRetargetedText(K, { text: 'second', tag: newRetargetTag(ORIGINAL) });
    }));
    await settle('a');
    const from = ledger.writes.length;
    const delivered = await ledger.deliver(40);
    const writesWhileDelivering = ledger.writesOf(K, from).length;
    expect({ quiet: delivered.quiet, writesAtMost4: writesWhileDelivering <= 4 }).toEqual({ quiet: true, writesAtMost4: true });
    // Enter → the question; one round of the other tab's events; yes → POST 1 (#4616 受入 1・2).
    enter(b);
    await settle('b', 30);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(band(b)).not.toBeNull();
    await ledger.deliver(40);
    ledger.as('b', () => act(() => {
      yesButton(b).click();
    }));
    await settle('b', 30);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][2]).toMatchObject({ cliToolId: 'claude', instanceId: I });
    expect(textarea(a)).toBeTruthy();
  }, RACE_TIMEOUT_MS);
});
