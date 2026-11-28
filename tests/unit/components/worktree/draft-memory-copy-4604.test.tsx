/**
 * Issue #4604 S13 (記憶の写しの軸, s13/enabler-4604-memory-copy.md §3): the table of the one value
 * (`draft-one-value-table-4604.test.tsx`) counts the store's writes and watches the store only. The facts
 * of a draft have a second copy — the composer's memory (`retargetTagsRef`, `retargetUnknownRef`) — and the
 * roads that carry a written value's marks into that memory are one per writer, each carrying less than
 * the value. These rows add that copy to the table. Written before the fix: red on 6f11e42d7 where a road
 * carries less than the value (it is the source of the rows: the fix rewrites the road table).
 *
 * - A1 記憶の書き点の生成元: the memory's write points (`retargetTagsRef.current =`,
 *   `retargetUnknownRef.current =`, `releasedUnknownRef`), the in-page notices (`…Listeners…forEach`) and
 *   this page's marks (`unstorable.set/delete`), listed by machine and pinned; then one row per value
 *   writer: what the written value may hold that the composer showing the text did not hold, and what
 *   the road from that write to the composer's memory carries (read from the source). A road carrying
 *   less is red.
 * - A2 I4 (weak form): while an open composer shows a non-empty text, if the key's value makes a
 *   composer opened afresh ask (POST 0, or the band), that open composer asks too — on its own memory:
 *   another tab lets the value go (it sent it: the key goes, the `storage` event reaches the open
 *   composers), then the open composer's Enter must not POST. Checked after every task of a pair's
 *   order (a write and the notices of one task run within that task; no other composer's Enter runs
 *   inside it). Observed by behaviour only (Enter, the POSTs, the band): no probe is added to src.
 *   The strong form (memory ⊇ value) is not here (§6: it is the design's to decide).
 * - A3 I3 for every open composer: at the end of an order, besides the composer opened afresh, each
 *   composer still open that shows the fenced text: one Enter → POST 0 or the question.
 * - A4 the pairs from the writers of A1 (送信・保存・切り替え・409・戻し・追記・移動・復元の移し) × the
 *   other tab's 送信（はい） and 保存 — both orders of the two tasks, the other tab's events delivered
 *   after each (the write-level interleavings of two tasks are G2's rows in the table, not repeated).
 * - A5 the seeds: the store's five read shapes (absent・list・unknown・junk・throws), as the one value for
 *   every writer but 復元の移し, and as the keys of before for 復元の移し (the restore's migration).
 * - (i) #728's legacy key copy into split 0 when the store is full: the old text is not lost
 *   (review-4604-s13-a.md P1-1).
 * - (ii) #4616 受入 1: a full store; between b's question and its yes, tab a's debounced save runs — the
 *   yes still covers (the "unknown" generation is reused), POST 1.
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
  DRAFT_STORAGE_KEY_PREFIX,
  appendToStoredDraft,
  getDraftValueKey,
  getInstanceDraftKey,
  getRetargetTagKey,
  getSplitDraftKey,
  moveDraft,
  newRetargetTag,
  readRetargetStore,
  returnRetargetedText,
  type RetargetTag,
} from '@/lib/drafts/message-draft';
import { draftValue, releasePageMarks, stripComments } from '@tests/helpers/draft-store-fault-4604';
import {
  draftKeysInStore,
  installDraftLedger,
  raw,
  type DraftLedger,
  type DraftLedgerOptions,
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

const WT = 'wt-4604-memory';
const I = 'codex-2';
const K = getInstanceDraftKey(WT, I);
/** The tile's switch goes here. */
const K2 = getInstanceDraftKey(WT, 'codex-3');
/** 移動's `from` (the instance that went from the roster). */
const KS = getInstanceDraftKey(WT, 'codex-1');
/** Every tag's original target: the composers' To is this instance with another tool — every tag asks. */
const ORIGINAL = { instanceId: I, cliToolId: 'codex' };
const TO: CLIToolType = 'claude';
/** The fenced text (a command body: its send reads no start preview). */
const FENCED = '!fenced 4604 memory';
const PLAIN = 'plain words';
const tagged = (text: string): boolean => text.includes(FENCED);
const SEED_GENERATION = 'g-seed-0';

const RACE_TIMEOUT_MS = 60_000;

const toast = vi.fn();

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

function defaultSend() {
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (_wt: string, content: string) => ({ id: 's', role: 'user', content, timestamp: new Date() }));
}
const posts = (): number => sendMessageMock.mock.calls.length;

interface OneProps {
  tool: CLIToolType;
  instanceId?: string;
  draftScope?: 'instance' | 'split';
}
function One({ tool, instanceId = I, draftScope = 'instance' }: OneProps) {
  return (
    <MessageInput
      worktreeId={WT}
      cliToolId={tool}
      instanceId={instanceId}
      draftScope={draftScope}
      isSessionRunning
      onMessageSent={vi.fn()}
      showToast={toast}
    />
  );
}

/** A read fault (the `throws` seed): on while `faultOn`, for the keys in `faultKeys`. */
let faultOn = false;
let faultKeys: string[] = [];
let ledger: DraftLedger;
function takeLedger(options: Partial<DraftLedgerOptions> = {}): DraftLedger {
  ledger?.restore();
  ledger = installDraftLedger({
    drafts: [K, K2, KS],
    tabs: ['a', 'b', 'probe'],
    tagged,
    readFault: (key) => faultOn && faultKeys.includes(key),
    ...options,
  });
  return ledger;
}

interface TabView {
  name: Tab;
  view: RenderResult;
  props: OneProps;
}
function mount(name: Tab, props: OneProps = { tool: TO }): TabView {
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
  faultOn = false;
  faultKeys = [];
  window.localStorage.clear();
  releasePageMarks([K, K2, KS]);
  ledger.violations.length = 0;
  ledger.armed = false;
  defaultSend();
}

beforeEach(() => {
  window.localStorage.clear();
  toast.mockReset();
  defaultSend();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue({ ok: true, show: false, attended: false });
  faultOn = false;
  faultKeys = [];
  takeLedger();
});
afterEach(() => {
  cleanup();
  ledger.restore();
  vi.restoreAllMocks();
  releasePageMarks([K, K2, KS]);
  window.localStorage.clear();
});

/* ------------------------------------------------------------------------------------------------
 * A1: the memory's write points and the roads from a value's write to the memory, by machine.
 * ---------------------------------------------------------------------------------------------- */

const MI = 'src/components/worktree/MessageInput.tsx';
const LIB = 'src/lib/drafts/message-draft.ts';
const source = (file: string): string => stripComments(readFileSync(join(process.cwd(), file), 'utf8'));

/** The text from `start`'s match to the end of the first `{ … }` block after it (braces counted). */
function blockAfter(src: string, start: RegExp): string {
  const at = src.search(start);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

/**
 * The memory's write points (MessageInput) and the page's notices and marks (message-draft), pinned. A new
 * point (a new copy of a mark, a new notice) turns this row red: add its road to the table below.
 */
const MEMORY_POINTS: Record<string, Record<string, number>> = {
  [MI]: {
    'retargetTagsRef.current =': 6,
    'retargetUnknownRef.current =': 4,
    'releasedUnknownRef.current.set': 1,
  },
  [LIB]: {
    'appendToStoredDraft → draftAppendListeners': 1,
    'moveDraft → draftAppendListeners': 1,
    'returnRetargetedText → retargetedTextListeners': 1,
    'unstorable.set': 2,
    'unstorable.delete': 2,
  },
};

function memoryPoints(file: string): Record<string, number> {
  const src = source(file);
  const counts: Record<string, number> = {};
  const add = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  for (const m of src.matchAll(/\b(retargetTagsRef|retargetUnknownRef)\.current\s*=(?![=>])/g)) add(`${m[1]}.current =`);
  for (const m of src.matchAll(/\breleasedUnknownRef\.current\.(set|delete|clear)\(/g)) add(`releasedUnknownRef.current.${m[1]}`);
  for (const m of src.matchAll(/\bunstorable\.(set|delete)\(/g)) add(`unstorable.${m[1]}`);
  // The in-page notices: a listener set's `forEach`, named by the exported function it is in.
  for (const m of src.matchAll(/\b(\w*[lL]isteners)(?:\.get\([^)]*\))?\??\.forEach\(/g)) {
    const before = src.slice(0, m.index);
    const fn = [...before.matchAll(/export function (\w+)/g)].pop()?.[1] ?? '?';
    const fnBody = blockAfter(src, new RegExp(`export function ${fn}\\(`));
    const channel = m[1] === 'listeners' ? (fnBody.match(/(\w+Listeners)\.get\(/)?.[1] ?? 'listeners') : m[1];
    add(`${fn} → ${channel}`);
  }
  return counts;
}

type Part = 'tags' | 'generation';
/** What a road's words carry: a tag, a generation, or the whole written value. */
const PART_OF: Record<string, Part[]> = {
  tag: ['tags'],
  tags: ['tags'],
  unknown: ['generation'],
  generation: ['generation'],
  value: ['tags', 'generation'],
  newValue: ['tags', 'generation'],
  marks: ['tags', 'generation'],
  retargetTagsRef: ['tags'],
  retargetUnknownRef: ['generation'],
};
function partsOf(expr: string): Part[] {
  const out = new Set<Part>();
  for (const word of expr.match(/[A-Za-z_]\w*/g) ?? []) for (const part of PART_OF[word] ?? []) out.add(part);
  return [...out].sort();
}
/** The memory a composer's own code sets in `body` (its `retargetTagsRef` / `retargetUnknownRef` assignments). */
function assignedParts(body: string): Part[] {
  const out = new Set<Part>();
  for (const m of body.matchAll(/\b(retargetTagsRef|retargetUnknownRef)\.current\s*=(?![=>])\s*([^;]*)/g)) {
    if (m[2].trim() === 'null') continue;
    for (const part of PART_OF[m[1]]) out.add(part);
  }
  return [...out].sort();
}

/** The listener call of a lib function's in-page notice: what it hands the composers. */
function noticeArgs(fn: string): string {
  const body = blockAfter(source(LIB), new RegExp(`export function ${fn}\\(`));
  return body.match(/\.forEach\(\(listener\) => listener\(([^;]*)\)\)/)?.[1] ?? '';
}
/** What the composer's own write gets back (`writeRetargetTold`'s return). */
function ownWriteReturn(): string {
  const body = blockAfter(source(MI), /const writeRetargetTold = useCallback\(/);
  return body.match(/return (\{[^}]*\});/)?.[1] ?? '';
}
/** The restore effect: from the draft-key effect's start to its cleanup. */
function restoreEffect(): string {
  const src = source(MI);
  const at = src.indexOf('draftKeyRef.current = draftKey;');
  return src.slice(at, src.indexOf('return () => {', at));
}

type WriterName = '送信' | '保存' | '切り替え' | '409' | '戻し' | '追記' | '移動' | '復元の移し';

interface RoadRow {
  /** The value writer (a call of the one road). */
  writer: string;
  /** Its call site (a line of the source). */
  site: { file: string; line: RegExp } | null;
  /** The road from the write to the memory of the composer showing the text. */
  road: string;
  /** What the written value may hold that the composer showing the text did not hold before the write. */
  needs: Part[];
  /** What the road carries (read from the source). */
  carries: () => Part[];
  /** The A4 writers this row drives. */
  ops: WriterName[];
}

/**
 * 「値を書く書き手 → 印を運ぶ道」. `needs` (the transition table, message-draft.ts): a value written over
 * junk / throws takes a new "unknown" generation (`writeRetarget`'s `asked && unreadable`), the short value
 * a new one (step 4), `moveIn` of a non-list a new one, `add` / `append` / `moveIn` a tag the composer did
 * not hold; `sent` and `moveOut` leave no text to show. `carries`: read from the source.
 */
const ROAD_TABLE: RoadRow[] = [
  {
    writer: '送信 (releaseSentTags: sent)',
    site: { file: MI, line: /writeRetarget\(key, \{ kind: 'sent'/ },
    road: 'the send clears the text (nothing shown)',
    needs: [],
    carries: () => assignedParts(blockAfter(source(MI), /const releaseSentTags = useCallback\(/)),
    ops: ['送信'],
  },
  {
    writer: '保存・切り替え (saveHeldDraft: save, through writeRetargetTold)',
    site: { file: MI, line: /writeRetargetTold\(key, \{$/ },
    road: "the own write's return (writeRetargetTold → { result, written })",
    needs: ['generation'],
    carries: () => [...new Set([...partsOf(ownWriteReturn()), ...assignedParts(blockAfter(source(MI), /const saveHeldDraft = useCallback\(/))])].sort(),
    ops: ['保存', '切り替え'],
  },
  {
    writer: '409 (keepRetargetTag: add, through writeRetargetTold)',
    site: { file: MI, line: /writeRetargetTold\(key, \{ kind: 'add'/ },
    road: "the tag set before the write + the own write's return",
    needs: ['generation', 'tags'],
    carries: () => [...new Set([...partsOf(ownWriteReturn()), ...assignedParts(blockAfter(source(MI), /const keepRetargetTag = useCallback\(/))])].sort(),
    ops: ['409'],
  },
  {
    writer: '復元の移し (the restore: restore)',
    site: { file: MI, line: /writeRetarget\(draftKey, \{ kind: 'restore' \}\)/ },
    road: 'the restore read (before or after its write)',
    needs: ['generation'],
    carries: () => {
      const effect = restoreEffect();
      const read = effect.indexOf('readDraft(draftKey)');
      const write = effect.indexOf("writeRetarget(draftKey, { kind: 'restore' })");
      // A read after the write holds what was written; a read before it holds what was there.
      return read > write ? ['generation', 'tags'] : ['tags'];
    },
    ops: ['復元の移し'],
  },
  {
    writer: "#728 の移し (migrateLegacyDraftKey: save into split 0's value)",
    site: { file: MI, line: /writeRetarget\(newKey, \{ kind: 'save'/ },
    road: 'the restore read after the migration',
    needs: ['generation'],
    carries: () => {
      const effect = restoreEffect();
      return effect.indexOf('migrateLegacyDraftKey(worktreeId)') < effect.indexOf('readDraft(draftKey)') ? ['generation', 'tags'] : [];
    },
    ops: [],
  },
  {
    writer: '#4503 の印 (writeSendUnknownMark: sendMark)',
    site: { file: LIB, line: /writeRetarget\(draftKey, \{ kind: 'sendMark'/ },
    road: 'markSendUnknown (no return, its own memory)',
    needs: ['generation'],
    carries: () => assignedParts(blockAfter(source(MI), /const markSendUnknown = useCallback\(/)),
    ops: [],
  },
  {
    writer: '戻し (returnRetargetedText: append with its tag)',
    site: { file: LIB, line: /writeRetarget\(draftKey, \{ kind: 'append', text, tags: \[tag\] \}/ },
    road: 'the in-page notice (subscribeRetargetedText)',
    needs: ['generation', 'tags'],
    carries: () => partsOf(noticeArgs('returnRetargetedText')),
    ops: ['戻し'],
  },
  {
    writer: '追記 (appendToStoredDraft: append)',
    site: { file: LIB, line: /writeRetarget\(key, \{ kind: 'append', text, tags: \[\] \}\)/ },
    road: 'the in-page notice (subscribeDraftAppend)',
    needs: ['generation'],
    carries: () => partsOf(noticeArgs('appendToStoredDraft')),
    ops: ['追記'],
  },
  {
    writer: '移動 (moveDraft: moveIn into `to`)',
    site: { file: LIB, line: /writeRetarget\(to, \{ kind: 'moveIn'/ },
    road: 'the in-page notice (subscribeDraftAppend)',
    needs: ['generation', 'tags'],
    carries: () => partsOf(noticeArgs('moveDraft')),
    ops: ['移動'],
  },
  {
    writer: '移動 (moveDraft: moveOut of `from`)',
    site: { file: LIB, line: /writeRetarget\(from, \{ kind: 'moveOut' \}\)/ },
    road: "`from`'s text goes (nothing shown)",
    needs: [],
    carries: () => [],
    ops: [],
  },
  {
    writer: 'releaseRetargetTags (release; src calls it nowhere)',
    site: { file: LIB, line: /writeRetarget\(draftKey, \{ kind: 'release'/ },
    road: '(no caller)',
    needs: [],
    carries: () => [],
    ops: [],
  },
  {
    writer: '別のタブ (any write of another tab)',
    site: null,
    road: 'storage (the value the event carries)',
    needs: ['generation', 'tags'],
    carries: () => partsOf(blockAfter(source(MI), /const onStorage = \(event: StorageEvent\) =>/).match(/parse\w+\(([^)]*)\)/)?.[1] ?? ''),
    ops: [],
  },
];

/** Lines that call the road and are not a writer of their own: `writeRetargetTold`'s forward. */
const FORWARDERS: Array<{ file: string; line: RegExp }> = [{ file: MI, line: /const result = writeRetarget\(key, op, \{ onShortUnknown, outcome \}\)/ }];

describe('[#4604 S13 A1 記憶の書き点の生成元] the memory copy\'s points and its roads, listed by machine', () => {
  it('MessageInput.tsx sets the memory, and message-draft.ts notifies the page and marks it, at the points this table lists', () => {
    expect({ [MI]: memoryPoints(MI), [LIB]: memoryPoints(LIB) }).toEqual(MEMORY_POINTS);
  });

  it('every call of the one road in the two files is a row of the road table (a new writer turns this red)', () => {
    const found: string[] = [];
    const claimed: string[] = [];
    for (const file of [MI, LIB]) {
      const lines = source(file).split('\n');
      lines.forEach((text, i) => {
        if (/(?<!function\s)\bwriteRetarget(?:Told)?\(/.test(text) && !/function writeRetarget/.test(text)) found.push(`${file}:${i + 1}`);
        for (const site of [...ROAD_TABLE.map((row) => row.site), ...FORWARDERS]) {
          if (site !== null && site.file === file && site.line.test(text)) claimed.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(claimed.sort()).toEqual(found.sort());
  });

  for (const row of ROAD_TABLE) {
    it(`A1 ${row.writer} → ${row.road}: carries what the written value may hold (${row.needs.join('・') || 'nothing'})`, () => {
      const carried = row.carries();
      expect({ missing: row.needs.filter((part) => !carried.includes(part)) }).toEqual({ missing: [] });
    });
  }
});

/* ------------------------------------------------------------------------------------------------
 * A5: the seeds — the store's five read shapes.
 * ---------------------------------------------------------------------------------------------- */

type Seed = 'absent' | 'list' | 'unknown' | 'junk' | 'throws';
const SEEDS: Seed[] = ['absent', 'list', 'unknown', 'junk', 'throws'];

/** The draft as the one value in the shape `seed` (`throws`: the value is there, its read throws while the fault is on). */
function seedValue(draftKey: string, seed: Seed, tag: RetargetTag): void {
  const key = getDraftValueKey(draftKey);
  if (seed === 'absent') raw.set(key, draftValue({ text: PLAIN }));
  if (seed === 'list' || seed === 'throws') raw.set(key, draftValue({ text: FENCED, tags: [tag] }));
  if (seed === 'unknown') raw.set(key, draftValue({ text: FENCED, unknown: SEED_GENERATION }));
  if (seed === 'junk') raw.set(key, JSON.stringify({ v: 1, text: FENCED, tags: 'broken' }));
  faultKeys = seed === 'throws' ? [key] : [];
}
/** The draft in the keys of before (its text, its `:retarget`) in the shape `seed`. */
function seedLegacy(draftKey: string, seed: Seed, tag: RetargetTag): void {
  const tagKey = getRetargetTagKey(draftKey);
  raw.set(draftKey, seed === 'absent' ? PLAIN : FENCED);
  if (seed === 'list' || seed === 'throws') raw.set(tagKey, JSON.stringify([tag]));
  if (seed === 'unknown') raw.set(tagKey, JSON.stringify({ unknown: SEED_GENERATION, tags: [] }));
  if (seed === 'junk') raw.set(tagKey, 'broken{');
  faultKeys = seed === 'throws' ? [tagKey] : [];
}

describe('[#4604 S13 A5 種] the seeds read in the five shapes of the store', () => {
  it('the shapes are the lib\'s RetargetStoreRead kinds (by machine)', () => {
    const block = source(LIB).match(/export type RetargetStoreRead =([\s\S]*?);\n/)?.[1] ?? '';
    expect([...block.matchAll(/kind: '(\w+)'/g)].map((m) => m[1])).toEqual(SEEDS);
  });
  for (const form of ['value', 'legacy'] as const) {
    it(`each seed (${form === 'value' ? 'the one value' : 'the keys of before'}) reads as its shape`, () => {
      const shapes: string[] = [];
      for (const seed of SEEDS) {
        window.localStorage.clear();
        (form === 'value' ? seedValue : seedLegacy)(K, seed, newRetargetTag(ORIGINAL));
        faultOn = true;
        shapes.push(readRetargetStore(K).kind);
        faultOn = false;
      }
      expect(shapes).toEqual(SEEDS);
    });
  }
});

/* ------------------------------------------------------------------------------------------------
 * A4: the pairs — the writers of A1 × the other tab's 送信（はい）and 保存, over the five seeds.
 * ---------------------------------------------------------------------------------------------- */

interface World {
  a: TabView | null;
  b: TabView;
  seed: Seed;
}

const shownOf = (t: TabView): string => textarea(t).value;
/** A text typed after what the composer shows (or alone, when it shows nothing). */
const typedAfter = (t: TabView, words: string): string => (shownOf(t).trim() === '' ? words : `${shownOf(t)} ${words}`);

/** The press and, when the band is up, the yes (one send of what the composer shows). */
async function sendWithYes(t: TabView) {
  enter(t);
  await settle(t.name, 30);
  if (band(t) !== null) {
    ledger.as(t.name, () => act(() => {
      yesButton(t).click();
    }));
    await settle(t.name, 30);
  }
}

/** Tab a's writers (A1's rows' ops). */
const WRITER_OPS: Record<WriterName, (w: World) => Promise<void>> = {
  async 送信(w) {
    const a = w.a!;
    if (shownOf(a).trim() === '') type(a, 'words a');
    await settle('a');
    await sendWithYes(a);
  },
  async 保存(w) {
    const a = w.a!;
    type(a, typedAfter(a, 'a'));
    await settle('a');
    ledger.fireSaves('a');
    await settle('a');
  },
  async 切り替え(w) {
    const a = w.a!;
    type(a, typedAfter(a, 'a'));
    await settle('a');
    rerender(a, { instanceId: 'codex-3' });
    await settle('a');
  },
  async '409'(w) {
    const a = w.a!;
    if (!tagged(shownOf(a))) type(a, typedAfter(a, FENCED));
    await settle('a');
    sendMessageMock.mockRejectedValueOnce(fence());
    await sendWithYes(a);
    defaultSend();
  },
  async 戻し() {
    ledger.as('a', () => act(() => {
      returnRetargetedText(K, { text: `${FENCED} returned`, tag: newRetargetTag(ORIGINAL) });
    }));
    await settle('a');
  },
  async 追記() {
    ledger.as('a', () => act(() => {
      appendToStoredDraft(K, 'appended words');
    }));
    await settle('a');
  },
  async 移動() {
    ledger.as('a', () => act(() => {
      moveDraft(KS, K);
    }));
    await settle('a');
  },
  async 復元の移し(w) {
    faultOn = true;
    w.a = mount('a');
    await settle('a');
    faultOn = false;
  },
};

type OtherName = '送信（はい）' | '保存';
/** Tab b's operations. */
const OTHER_OPS: Record<OtherName, (w: World) => Promise<void>> = {
  async '送信（はい）'(w) {
    type(w.b, 'hi b');
    await settle('b');
    await sendWithYes(w.b);
  },
  async 保存(w) {
    type(w.b, typedAfter(w.b, 'b'));
    await settle('b');
    ledger.fireSaves('b');
    await settle('b');
  },
};

const WRITERS: WriterName[] = ROAD_TABLE.flatMap((row) => row.ops);
const OTHERS: OtherName[] = ['送信（はい）', '保存'];

/** The world before the pair: the seed, then tab a's and tab b's composers (both on K, To changed). */
async function arrange(writer: WriterName, seed: Seed): Promise<World> {
  await reset();
  const tag = newRetargetTag(ORIGINAL);
  if (writer === '復元の移し') {
    // b is open before the keys of before are there; a's mount is the writer (its restore migrates).
    const b = mount('b');
    await settle('b');
    ledger.fireSaves('b');
    seedLegacy(K, seed, tag);
    return { a: null, b, seed };
  }
  seedValue(writer === '移動' ? KS : K, seed, tag);
  // The restore cannot read a `throws` seed; afterwards it reads (the fault is gone).
  faultOn = writer !== '移動';
  const a = mount('a');
  const b = mount('b');
  await settle();
  ledger.fireSaves('a');
  ledger.fireSaves('b');
  faultOn = writer === '移動';
  await ledger.deliver();
  return { a, b, seed };
}

const openOf = (w: World): TabView[] => [w.a, w.b].filter((t): t is TabView => t !== null);

/**
 * I4 (weak): if the key's value makes a composer opened afresh ask, each open composer showing a text asks
 * on its own memory — another tab lets the value go (the key goes; the event reaches the open composers),
 * then its Enter must not POST.
 */
async function probeI4(w: World, label: string): Promise<string[]> {
  const out: string[] = [];
  ledger.bridge = false;
  const fresh = mount('fresh');
  await settle('fresh');
  if (shownOf(fresh).trim() === '') type(fresh, 'probe words');
  const before = posts();
  enter(fresh);
  await settle('fresh', 30);
  const valueAsks = posts() === before;
  ledger.as('fresh', () => fresh.view.unmount());
  // The writes queued before the probe stay queued: another tab that lets the value go has heard them, and
  // the open composers hear them before its write (the events come in order).
  ledger.bridge = true;
  if (!valueAsks) return out;
  ledger.as('probe', () => {
    for (const key of draftKeysInStore(K)) window.localStorage.removeItem(key);
  });
  await ledger.deliver();
  for (const t of openOf(w)) {
    const shown = shownOf(t);
    if (shown.trim() === '') continue;
    const b = posts();
    enter(t);
    await settle(t.name, 30);
    const n = posts() - b;
    if (n > 0) out.push(`${label}: ${t.name} shows ${JSON.stringify(shown)}; the value asked a fresh composer; once another tab let it go, Enter → POST ${n}`);
  }
  return out;
}

/** I3 by a composer opened afresh (the table's `freshEnter`, on K). */
async function freshEnter(): Promise<string | null> {
  cleanup();
  ledger.dropSaves();
  ledger.dropQueue();
  const before = posts();
  const fresh = mount('fresh');
  await settle('fresh');
  const shown = shownOf(fresh);
  enter(fresh);
  await settle('fresh', 30);
  const n = posts() - before;
  return tagged(shown) && n > 0 ? `fresh: shows ${JSON.stringify(shown)}: Enter → POST ${n}, no question` : null;
}

interface ComboResult {
  i2: string[];
  i3: string[];
  i4: string[];
  orders: number;
  checkpoints: number;
}

/** One order of the pair; `cut` stops after that task with the I4 probe, else the end's checks. */
async function runOrder(writer: WriterName, other: OtherName, seed: Seed, order: 'XY' | 'YX', cut: number | null): Promise<{ i2: string[]; i3: string[]; i4: string[] }> {
  const w = await arrange(writer, seed);
  const X = async () => WRITER_OPS[writer](w);
  const Y = async () => OTHER_OPS[other](w);
  const deliver = async () => {
    await ledger.deliver();
  };
  const tasks: Array<[string, () => Promise<void>]> =
    order === 'XY'
      ? [[writer, X], ['deliver', deliver], [other, Y], ['deliver', deliver]]
      : [[other, Y], ['deliver', deliver], [writer, X], ['deliver', deliver]];
  for (const [i, [name, task]] of tasks.entries()) {
    await task();
    if (cut === i) return { i2: [], i3: [], i4: await probeI4(w, `${order} after #${i} ${name}`) };
  }
  // The end: each open composer showing the fenced text saves once more (I2 after it), then presses Enter (A3).
  for (const t of openOf(w)) {
    if (!tagged(shownOf(t))) continue;
    type(t, `${shownOf(t)} .`);
    await settle(t.name);
    ledger.fireSaves(t.name);
  }
  await ledger.deliver();
  const i2 = ledger.violations.map((v) => `${order} ${v}`);
  const i3: string[] = [];
  for (const t of openOf(w)) {
    const shown = shownOf(t);
    if (!tagged(shown)) continue;
    const before = posts();
    enter(t);
    await settle(t.name, 30);
    const n = posts() - before;
    if (n > 0) i3.push(`${order} open ${t.name}: shows ${JSON.stringify(shown)}: Enter → POST ${n}, no question`);
  }
  const fresh = await freshEnter();
  if (fresh !== null) i3.push(`${order} ${fresh}`);
  return { i2, i3, i4: [] };
}

const ORDERS = ['XY', 'YX'] as const;
/** The I4 checkpoints: after each task of the order XY (writer, its events, the other's op, its events). */
const CHECKPOINTS = [0, 1, 2, 3];

const results = new Map<string, Promise<ComboResult>>();
function combo(writer: WriterName, other: OtherName, seed: Seed): Promise<ComboResult> {
  const id = `${writer}|${other}|${seed}`;
  let result = results.get(id);
  if (result === undefined) {
    result = (async () => {
      const out: ComboResult = { i2: [], i3: [], i4: [], orders: 0, checkpoints: 0 };
      for (const order of ORDERS) {
        const r = await runOrder(writer, other, seed, order, null);
        out.i2.push(...r.i2);
        out.i3.push(...r.i3);
        out.orders += 1;
      }
      for (const cut of CHECKPOINTS) {
        const r = await runOrder(writer, other, seed, 'XY', cut);
        out.i4.push(...r.i4);
        out.checkpoints += 1;
      }
      await reset();
      return out;
    })();
    results.set(id, result);
  }
  return result;
}

describe('[#4604 S13 A4 組] the pairs come from the writers of A1 × the other tab\'s 送信（はい）and 保存', () => {
  it('the pairs: 8 writers (from the road table) × 2 other-tab ops × 5 seeds = 80, each in 2 orders with 4 I4 checkpoints', () => {
    expect({
      writers: WRITERS,
      pairs: WRITERS.length * OTHERS.length,
      combos: WRITERS.length * OTHERS.length * SEEDS.length,
      orders: ORDERS.length,
      checkpoints: CHECKPOINTS.length,
    }).toEqual({
      writers: ['送信', '保存', '切り替え', '409', '復元の移し', '戻し', '追記', '移動'],
      pairs: 16,
      combos: 80,
      orders: 2,
      checkpoints: 4,
    });
  });
});

for (const writer of WRITERS) {
  for (const other of OTHERS) {
    describe(`[#4604 S13 A4] ${writer}×別のタブの${other}`, () => {
      for (const seed of SEEDS) {
        it(`種 ${seed}: I2 after every write (both orders)`, async () => {
          expect((await combo(writer, other, seed)).i2).toEqual([]);
        }, RACE_TIMEOUT_MS);
        it(`種 ${seed}: I3 — every open composer and a fresh one, at the end (A3)`, async () => {
          expect((await combo(writer, other, seed)).i3).toEqual([]);
        }, RACE_TIMEOUT_MS);
        it(`種 ${seed}: I4 (weak) after every task of XY (A2)`, async () => {
          expect((await combo(writer, other, seed)).i4).toEqual([]);
        }, RACE_TIMEOUT_MS);
      }
    });
  }
}

/* ------------------------------------------------------------------------------------------------
 * (i) #728's legacy key, a full store. (ii) #4616 受入 1, a save between the question and the yes.
 * ---------------------------------------------------------------------------------------------- */

describe('[#4604 S13 (i) #728 の移し] the legacy key is copied into split 0\'s value — a full store loses no text', () => {
  const LEGACY = `${DRAFT_STORAGE_KEY_PREFIX}${WT}`;
  const SPLIT0 = getSplitDraftKey(WT, 0);
  const LONG = 'a long draft of before #728';

  it('(negative control) the store takes it: split 0 shows the old text and the legacy key goes', async () => {
    takeLedger({ drafts: [SPLIT0], tagged: undefined });
    raw.set(LEGACY, LONG);
    const c = mount('c', { tool: TO, draftScope: 'split' });
    await settle('c');
    expect({ shown: shownOf(c), legacy: raw.get(LEGACY) }).toEqual({ shown: LONG, legacy: null });
  });

  it('the store is full (split 0\'s value does not go in): the old text stays somewhere — shown, or under the legacy key', async () => {
    takeLedger({ drafts: [SPLIT0], tagged: undefined, refuse: (key) => key === getDraftValueKey(SPLIT0) });
    raw.set(LEGACY, LONG);
    const c = mount('c', { tool: TO, draftScope: 'split' });
    await settle('c');
    const kept = shownOf(c).includes(LONG) || raw.get(LEGACY) === LONG;
    expect({ kept, shown: shownOf(c), legacy: raw.get(LEGACY) }).toMatchObject({ kept: true });
  });
});

describe('[#4616 受入 1] a full store: a save between the question and the yes — the yes still covers', () => {
  it('b asks; tab a types and its debounced save runs; b\'s yes sends once (the "unknown" generation is reused)', async () => {
    const t1 = newRetargetTag(ORIGINAL);
    let full = false;
    takeLedger({ refuse: (_key, value) => full && value.includes(t1.id) });
    ledger.as('lib', () => returnRetargetedText(K, { text: FENCED, tag: t1 }));
    const a = mount('a');
    const b = mount('b');
    await settle();
    ledger.fireSaves('a');
    ledger.fireSaves('b');
    await ledger.deliver();
    full = true;
    ledger.as('a', () => act(() => {
      returnRetargetedText(K, { text: 'second', tag: newRetargetTag(ORIGINAL) });
    }));
    await settle('a');
    await ledger.deliver(40);
    enter(b);
    await settle('b', 30);
    expect(posts()).toBe(0);
    expect(band(b)).not.toBeNull();
    // Between the question and the yes: tab a types, its save runs (the store is still full).
    type(a, `${shownOf(a)} more`);
    await settle('a');
    expect(ledger.fireSaves('a')).toBe(1);
    await settle('a');
    await ledger.deliver(40);
    ledger.as('b', () => act(() => {
      yesButton(b).click();
    }));
    await settle('b', 30);
    expect({ posts: posts(), asksAgain: band(b) !== null }).toEqual({ posts: 1, asksAgain: false });
  }, RACE_TIMEOUT_MS);
});
