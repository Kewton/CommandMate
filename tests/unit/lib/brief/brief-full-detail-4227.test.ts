/**
 * H20: "全文を読む" (Issue #4227, design `docs/design/mem-ui-4227.md` §0.0 S-F, PM decision (a)).
 *
 * C's `fitText` takes `itemCap?: boolean` (default true = as before) and the provider's
 * `BriefRequest` takes `detail?: 'short' | 'full'`. `full` draws every entry that fits the
 * budget whole — no 512-byte omitted form — while the budget, `maxLines`, withheld bodies,
 * D2's required lead and the invisible-character replacement stay as they are.
 *
 * Built through C's real provider (`createMemBriefProvider`) on #4222's world, and `fitText`
 * on a model for the exact byte and line edges.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemBriefProvider } from '@/lib/brief/provider';
import { BriefOverBudgetError, fitText } from '@/lib/brief/fit';
import { PREVIOUS_END_LINE_MAX_BYTES } from '@/lib/brief/previous-end';
import type { BriefItem, BriefModel } from '@/lib/brief/model';
import { readInstanceLifetime } from '@/lib/db/session-brief-db';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { BRIEF_ITEM_MAX_BYTES, BRIEF_TEXT_FIXED_LINES, type BriefEntry } from '@/types/brief';
import { BriefWorld, bytes, resetBriefMemory } from './brief-4223-harness';

const HOUR = 3_600_000;
const OMITTED = /…\(本文 \d+ bytes を省略/;
const world = new BriefWorld();

function request(detail: BriefRequest['detail'] | 'absent', over: { maxBytes?: number; maxLines?: number; openedAt?: number } = {}): BriefRequest {
  const lifetime = readInstanceLifetime(world.db, 'wt-1', 'claude');
  return {
    target: {
      worktreeId: 'wt-1',
      worktreeIncarnation: getOrCreateWorktreeIncarnation(world.db, 'wt-1'),
      cliToolId: 'claude',
      instanceId: 'claude',
      instanceIncarnation: lifetime.incarnation,
      instanceOnRoster: lifetime.onRoster,
    },
    membership: { repositoryId: world.repo, readRepositoryIds: [world.repo], branch: 'feature/x', detached: false, mode: 'on' },
    boundary: { id: 'b-1', kind: 'launch', late: false, openedAt: over.openedAt ?? Date.now() },
    budget: { maxBytes: over.maxBytes ?? 49_152, maxLines: over.maxLines ?? 240 },
    ...(detail === 'absent' ? {} : { detail }),
    now: Date.now(),
  };
}

async function build(detail: BriefRequest['detail'] | 'absent', over: { maxBytes?: number; maxLines?: number; openedAt?: number } = {}) {
  resetBriefMemory();
  const state = createMemBriefProvider(() => world.db, world.briefDeps());
  return state.provider.build(request(detail, over));
}

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-full-detail-4227-');
  world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

describe('H20 (b) a 600-byte body through the real provider', () => {
  it('full: the body is drawn whole (no omitted form)', async () => {
    const text = 'x'.repeat(600);
    await world.add('note', undefined, { text });
    const built = await build('full');
    expect(built.body).toContain(JSON.stringify(text));
    expect(built.body).not.toMatch(OMITTED);
  });

  it('positive control: short and an absent detail keep the omitted form (the per-entry cap holds)', async () => {
    await world.add('note', undefined, { text: 'x'.repeat(600) });
    for (const detail of ['short', 'absent'] as const) {
      const built = await build(detail);
      expect(built.body, detail).toMatch(OMITTED);
      expect(built.body, detail).not.toContain('x'.repeat(600));
    }
  });

  it('(h) short and an absent detail build byte for byte the same text', async () => {
    await world.add('note', undefined, { text: 'y'.repeat(700) });
    await world.add('note', undefined, { text: 'short one' });
    // The same boundary for both (D2's lead depends on the boundary's opening, not on the detail).
    const openedAt = Date.now() + 1_000;
    const absent = await build('absent', { maxBytes: 4096, openedAt });
    const short = await build('short', { maxBytes: 4096, openedAt });
    // Only the generation time (`at=` on the state line) may differ between two builds.
    // and the fence's tag, a hash of the lines that carry it (D12): the content is compared, not the clock.
    const timeless = (body: string) => body.replace(/ at=\S+/g, ' at=-').replace(/cmate-brief:[0-9a-f]{8}/g, 'cmate-brief:-').replace(/observed=\S+/g, 'observed=-');
    expect(timeless(short.body)).toBe(timeless(absent.body));
    expect({ ...short, body: '' }).toEqual({ ...absent, body: '' });
  });
});

describe('H20 (g) invisible characters are still replaced in full', () => {
  it('a 600-byte body with U+200B: full shows it as [U+200B], never the raw character', async () => {
    await world.add('note', undefined, { text: `${'z'.repeat(600)}​end` });
    const built = await build('full');
    expect(built.body).not.toMatch(OMITTED);
    expect(built.body).not.toContain('​');
    expect(built.body).toContain('[U+200B]end');
  });
});

describe('H20 (f) D2’s required lead is still first in full', () => {
  it('after an unplanned end, the first data line is the lead, within D2’s own limit', async () => {
    await world.add('note', undefined, { text: 'w'.repeat(600) });
    world.message({ instanceId: 'claude', cliToolId: 'claude', role: 'user', content: 'earlier work', at: Date.now() - 2 * HOUR });
    const built = await build('full');
    // The first line of the data: right after C's fixed 4 lines (as D2's own test reads it).
    const lead = built.body.split('\n')[4];
    expect(lead).toMatch(/^終わる前の更新を確認できない（/);
    expect(bytes(lead)).toBeLessThanOrEqual(PREVIOUS_END_LINE_MAX_BYTES);
    expect(built.body).not.toMatch(OMITTED);
  });
});

// --- fitText on a model: the exact edges ------------------------------------

function entry(index: number, extra: Partial<BriefEntry> = {}): BriefEntry {
  return {
    rank: 5,
    source: 'mem',
    id: `item-${index}`,
    author: 'agent',
    updatedAt: null,
    observedAt: '2026-11-10T00:00:00.000Z',
    fields: { kind: 'note' },
    text: `${index}`.padEnd(600, 'q'),
    ...extra,
  } as BriefEntry;
}

function model(entries: BriefEntry[], lead?: string): BriefModel {
  return {
    fixed: {
      mode: 'on',
      worktreeId: 'w',
      instanceId: 'i',
      cliToolId: 'claude',
      repositoryId: 'r',
      repositoryIdBytes: 1,
      branch: null,
      detached: true,
      boundaryKind: 'launch',
      generatedAt: '2026-11-10T00:00:00.000Z',
      readAll: 'commandmate brief --all',
    },
    items: entries.map((e, i): BriefItem => ({ entry: e, sourceIndex: 1, sortAt: i })),
    sources: [],
    ...(lead ? { lead } : {}),
  };
}

describe('H20 (c) the whole budget still holds with itemCap:false', () => {
  const three = model([entry(1), entry(2), entry(3)]);
  const exact = bytes(fitText(three, { maxBytes: null, trailingNewline: false }).text);

  it('a budget exactly the three whole entries: all three, none omitted', () => {
    const fitted = fitText(three, { maxBytes: exact, trailingNewline: false, itemCap: false });
    expect(fitted.included).toHaveLength(3);
    expect(fitted.omitted).toBe(0);
    expect(fitted.text).not.toMatch(OMITTED);
  });

  it('one byte short: the last entry is dropped whole, `omitted` and `all=` say so, no BriefOverBudgetError', () => {
    let fitted: ReturnType<typeof fitText> | undefined;
    expect(() => {
      fitted = fitText(three, { maxBytes: exact - 1, trailingNewline: false, itemCap: false });
    }).not.toThrow(BriefOverBudgetError);
    expect(fitted!.included).toHaveLength(2);
    expect(fitted!.omitted).toBe(1);
    expect(fitted!.text).toContain('omitted=1 all=');
    expect(bytes(fitted!.text)).toBeLessThanOrEqual(exact - 1);
    expect(fitted!.text).not.toMatch(OMITTED);
  });

  it('positive control: the per-entry cap (default) would have drawn each in the omitted form', () => {
    const capped = fitText(three, { maxBytes: exact, trailingNewline: false });
    expect(capped.text).toMatch(OMITTED);
    expect(capped.included).toHaveLength(3);
  });
});

describe('H20 (d) the line budget still holds with itemCap:false', () => {
  const three = model([entry(1), entry(2), entry(3)]);

  it('maxLines exactly the fixed lines + 3: all three', () => {
    const fitted = fitText(three, { maxBytes: 49_152, trailingNewline: false, maxLines: BRIEF_TEXT_FIXED_LINES + 3, itemCap: false });
    expect(fitted.included).toHaveLength(3);
  });

  it('one line less: two, the third omitted whole', () => {
    const fitted = fitText(three, { maxBytes: 49_152, trailingNewline: false, maxLines: BRIEF_TEXT_FIXED_LINES + 2, itemCap: false });
    expect(fitted.included).toHaveLength(2);
    expect(fitted.omitted).toBe(1);
  });
});

describe('H20 (e) a withheld entry has no body in full either', () => {
  it('withheld= only, never a text', () => {
    const withheld = entry(9, { text: undefined, withheld: { code: 'secret_like', rule: 'github_token' } } as Partial<BriefEntry>);
    const fitted = fitText(model([withheld]), { maxBytes: 49_152, trailingNewline: false, itemCap: false });
    expect(fitted.text).toContain('withheld=secret_like:github_token');
    expect(fitted.text).not.toContain('text=');
  });
});

describe('H20 (h) itemCap omitted or true draws byte for byte what it drew before', () => {
  it('the same model, with and without the flag, and with itemCap:true', () => {
    const m = model([entry(1), entry(2, { text: 'small' }), entry(3)]);
    const before = fitText(m, { maxBytes: 4096, trailingNewline: true, maxLines: 40 });
    expect(fitText(m, { maxBytes: 4096, trailingNewline: true, maxLines: 40, itemCap: true })).toEqual(before);
    expect(before.text).toMatch(OMITTED);
    // (control) itemCap:false differs on the same input.
    expect(fitText(m, { maxBytes: 4096, trailingNewline: true, maxLines: 40, itemCap: false }).text).not.toBe(before.text);
  });

  it('the lead stays required: a lead that does not fit makes no text in full too', () => {
    const fitted = fitText(model([entry(1)], 'L'), { maxBytes: 49_152, trailingNewline: false, maxLines: BRIEF_TEXT_FIXED_LINES, itemCap: false });
    expect(fitted.leadUnfit).toBe(true);
  });

  it('BRIEF_ITEM_MAX_BYTES is the cap the omitted form keeps (the 600-byte entry is over it)', () => {
    expect(600).toBeGreaterThan(BRIEF_ITEM_MAX_BYTES);
  });
});
