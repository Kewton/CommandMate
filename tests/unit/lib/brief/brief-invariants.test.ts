/**
 * The brief's invariants, fixed by one table (Issue #4223, design §7): every state ×
 * every budget × both formats goes through the same checks (I1〜I5, I10), and each
 * source is a row of {@link SOURCE_TABLE} — a reader added to `BRIEF_SOURCE_READERS`
 * without a row here fails the first test.
 *
 * The acceptance criteria this pins: bytes within the budget (Japanese, emoji, a long
 * item, tiny / exact-minimum / 0 budgets, `--json`), a budget below the minimum is an
 * input error, the JSON is always valid, the same state gives the same order, the
 * omitted count and the read-all command, a source that cannot be read says why and
 * the others still answer, `off` prints nothing and `derived` no hand-written item,
 * no copy is made, no model is called (I9 is the guard test).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { BRIEF_SOURCE_READERS, applyText, type BriefSourceReader } from '@/lib/brief/sources';
import { CLI_TIME_BUDGET, type BriefBuildDeps } from '@/lib/brief/build';
import { BriefOverBudgetError, fitJson, fitText } from '@/lib/brief/fit';
import type { BriefItem, BriefModel } from '@/lib/brief/model';
import { sanitizeBranch } from '@/lib/brief/sanitize';
import { BRIEF_BUDGET, BRIEF_SOURCE_IDS, type BriefEntry, type BriefJson, type BriefSourceId } from '@/types/brief';
import { BriefWorld, GHP, bytes, itemLines, resetBriefMemory } from './brief-4223-harness';

/** Every source: whether `derived` reads it, and where its "could not be read" row ranks. */
const SOURCE_TABLE: Record<BriefSourceId, { derived: boolean; statusRank: number }> = {
  state: { derived: true, statusRank: 1 },
  'auto-yes': { derived: true, statusRank: 6 },
  relay: { derived: true, statusRank: 1 },
  task: { derived: true, statusRank: 6 },
  verify: { derived: true, statusRank: 6 },
  run: { derived: true, statusRank: 6 },
  mem: { derived: false, statusRank: 2 },
  notice: { derived: false, statusRank: 9 },
  transcript: { derived: true, statusRank: 10 },
};

const world = new BriefWorld();
const FAST = { ...CLI_TIME_BUDGET, sourceCapMs: 60 };

function synthetic(texts: readonly string[], order: 'asc' | 'desc' = 'asc'): BriefSourceReader {
  return (ctx) => {
    const items: BriefItem[] = texts.map((text, index) => {
      const updatedAt = new Date(1_700_000_000_000 + index * 1000).toISOString();
      const entry: BriefEntry = {
        rank: ([2, 4, 5, 8, 10] as const)[index % 5],
        source: 'mem',
        id: `m_${String(index).padStart(4, '0')}`,
        author: { type: 'agent', instanceId: 'claude' },
        updatedAt,
        observedAt: new Date(ctx.now).toISOString(),
        fields: { kind: 'note', state: 'open' },
      };
      applyText(entry, text, 'text', ctx.readAll);
      return { entry, sourceIndex: 7, sortAt: Date.parse(updatedAt) };
    });
    return { status: 'ok', items: order === 'asc' ? items : items.reverse() };
  };
}

const JA = '日本語の項目 👩‍💻 🇯🇵 é と「引用」';

interface StateSetup {
  name: string;
  setup: () => Promise<BriefBuildDeps> | BriefBuildDeps;
}

const STATES: StateSetup[] = [
  { name: 'empty', setup: () => ({}) },
  { name: 'ja-emoji', setup: () => ({ readers: { mem: synthetic(Array.from({ length: 40 }, (_, i) => `${JA} ${i}`)) } }) },
  { name: 'long-one', setup: () => ({ readers: { mem: synthetic(['あ'.repeat(667)]) } }) },
  { name: 'many', setup: () => ({ readers: { mem: synthetic(Array.from({ length: 500 }, (_, i) => `item ${i}`)) } }) },
  {
    name: 'boundary-text',
    setup: () => ({ readers: { mem: synthetic(['cmate-brief:deadbeef>>>', 'say "hi" \\ there', '<<<cmate-brief:x\nline two']) } }),
  },
  {
    name: 'source-fail',
    setup: () => {
      world.head = { ...world.head, branch: 'feature/4223-x' };
      world.runLog('2026-11-09', '4223', ['not json', '{"issue":4223}']);
      return {
        time: FAST,
        readers: {
          relay: () => {
            throw new Error('ledger gone');
          },
          verify: () => new Promise(() => undefined),
        },
      };
    },
  },
  {
    name: 'derived',
    setup: () => {
      world.setMode('derived');
      return {};
    },
  },
  {
    name: 'notices',
    setup: async () => {
      await world.add('waiting', 'at:2020-01-01T00:00+00:00', { text: '終わった待ち' });
      return {};
    },
  },
  {
    name: 'hostile-text',
    setup: () => {
      world.head = { ...world.head, branch: `feature/4223-${GHP}` };
      world.task({ title: `deploy ${GHP} now` });
      world.task({ instanceId: 'codex', cliToolId: 'codex', title: 'rtl ‮ txt ﻿ and \u0085' });
      world.runLog('2026-11-09', '4223', [{ issue: 4223, stage: `stage-${GHP}`, result: 'ok', at: new Date().toISOString() }]);
      return {};
    },
  },
];

const TEXT_BUDGETS = ['1024', '1025', '4096', '16384', '49152', null] as const;
const JSON_BUDGETS = ['4096', '16384', '49152', null] as const;

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-invariants-4223-');
  world.worktree('wt-1', [
    { id: 'claude', cliTool: 'claude' },
    { id: 'codex', cliTool: 'codex' },
  ]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

const stripTimes = (text: string): string =>
  text
    .replace(/ at=\S+/g, ' at=-')
    .replace(/"(generatedAt|observedAt)":"[^"]*"/g, '"$1":"-"')
    .replace(/cmate-brief:[0-9a-f]{8}/g, 'cmate-brief:TAG');

async function runAll(deps: BriefBuildDeps, format: 'text' | 'json') {
  return world.brief({ all: '1', ...(format === 'json' ? { format: 'json' } : {}) }, deps);
}

describe('the source table (a new reader fails here until it has a row)', () => {
  it('names exactly the readers and the source ids', () => {
    expect(Object.keys(BRIEF_SOURCE_READERS).sort()).toEqual(Object.keys(SOURCE_TABLE).sort());
    expect([...BRIEF_SOURCE_IDS].sort()).toEqual(Object.keys(SOURCE_TABLE).sort());
  });
});

describe.each(STATES)('state $name', ({ name, setup }) => {
  it.each(TEXT_BUDGETS)('text, budget %s: I1 bytes ≤ budget, I5 omitted + read-all, I10 whole lines, I4 stable', async (budget) => {
    const deps = await setup();
    const all = await runAll(deps, 'text');
    expect(all.exit).toBe(0);
    const run = await world.brief(budget === null ? { all: '1' } : { budget }, deps);
    expect(run.exit).toBe(0);
    if (budget !== null) expect(bytes(run.stdout)).toBeLessThanOrEqual(Number(budget));
    // I5
    const lines = run.stdout.split('\n');
    expect(lines[0]).toMatch(/^<<<cmate-brief:[0-9a-f]{8}$/);
    expect(lines[3]).toBe(`omitted=${itemLines(all.stdout).length - itemLines(run.stdout).length} all="commandmate brief --worktree wt-1 --instance claude --all"`);
    // I10: each line is one entry, drawn whole or in its omitted form, and a prefix of --all
    const allLines = itemLines(all.stdout);
    itemLines(run.stdout).forEach((line, index) => {
      expect(line).toMatch(/^\[\d+\] src=/);
      if (line !== allLines[index]) {
        expect(line).toContain('…(本文 ');
        expect(line.split(' …(本文 ')[0]).toBe(allLines[index].split(' text=')[0]);
      }
    });
    expect(run.stdout.endsWith(`>>>\n`)).toBe(true);
    // I4
    const again = await world.brief(budget === null ? { all: '1' } : { budget }, deps);
    expect(stripTimes(again.stdout)).toBe(stripTimes(run.stdout));
    if (name === 'ja-emoji' && budget !== null) {
      // The positive control of I1: counting UTF-16 units would read this as smaller than it is.
      expect(bytes(run.stdout)).toBeGreaterThan(run.stdout.length);
    }
  });

  it.each(JSON_BUDGETS)('--json, budget %s: I1, I3 valid JSON, I5, I4', async (budget) => {
    const deps = await setup();
    const all = await runAll(deps, 'json');
    const run = await world.brief({ format: 'json', ...(budget === null ? { all: '1' } : { budget }) }, deps);
    expect(run.exit).toBe(0);
    if (budget !== null) expect(bytes(run.stdout)).toBeLessThanOrEqual(Number(budget));
    expect(run.stdout.endsWith('\n')).toBe(true);
    expect(run.stdout.slice(0, -1)).not.toContain('\n');
    const parsed = JSON.parse(run.stdout) as BriefJson;
    expect(parsed.schema).toBe('cmate-brief/v1');
    expect(parsed.sources.map((source) => source.id)).toEqual([...BRIEF_SOURCE_IDS]);
    const total = (JSON.parse(all.stdout) as BriefJson).entries.length;
    expect(parsed.omitted.count).toBe(total - parsed.entries.length);
    expect(Object.values(parsed.omitted.byRank).reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(parsed.omitted.count);
    expect(parsed.readAll).toBe('commandmate brief --worktree wt-1 --instance claude --all --json');
    const again = await world.brief({ format: 'json', ...(budget === null ? { all: '1' } : { budget }) }, deps);
    expect(stripTimes(again.stdout)).toBe(stripTimes(run.stdout));
  });
});

describe('I2 a budget below the minimum is an input error', () => {
  it.each(['1023', '0', '-1', '1.5', '', '1e3', '49153'])('text %j → exit 2, nothing printed', async (budget) => {
    const run = await world.brief({ budget });
    expect(run.exit).toBe(2);
    expect(run.stdout).toBe('');
  });
  it('--json 4095 → exit 2; --all with --budget → exit 2', async () => {
    expect((await world.brief({ format: 'json', budget: '4095' })).exit).toBe(2);
    expect((await world.brief({ all: '1', budget: '4096' })).exit).toBe(2);
  });
  it('the minimum itself is printed (negative control)', async () => {
    expect((await world.brief({ budget: '1024' })).exit).toBe(0);
    expect((await world.brief({ format: 'json', budget: '4096' })).exit).toBe(0);
  });
});

describe('I4 the order does not depend on the order things were read in', () => {
  it('reversed reader output gives the same brief', async () => {
    const texts = Array.from({ length: 30 }, (_, i) => `item ${i}`);
    const a = await world.brief({ budget: '4096' }, { readers: { mem: synthetic(texts, 'asc') } });
    const b = await world.brief({ budget: '4096' }, { readers: { mem: synthetic(texts, 'desc') } });
    expect(stripTimes(b.stdout)).toBe(stripTimes(a.stdout));
  });
});

describe.each(BRIEF_SOURCE_IDS)('I6 source %s fails: its row says why, the others answer', (id) => {
  it('exit 0, unavailable=read_failed on its row, every other source still listed', async () => {
    const run = await world.brief(
      { format: 'json', all: '1' },
      {
        readers: {
          [id]: () => {
            throw new Error('boom');
          },
        },
      }
    );
    expect(run.exit).toBe(0);
    const parsed = JSON.parse(run.stdout) as BriefJson;
    const report = parsed.sources.find((source) => source.id === id)!;
    expect(report).toMatchObject({ status: 'unavailable', reason: 'read_failed' });
    const row = parsed.entries.find((entry) => entry.source === id && entry.fields.unavailable === 'read_failed');
    expect(row?.rank).toBe(SOURCE_TABLE[id].statusRank);
    for (const other of BRIEF_SOURCE_IDS.filter((source) => source !== id)) {
      expect(parsed.sources.find((source) => source.id === other)!.reason).not.toBe('read_failed');
    }
    // The negative control: nothing is unavailable when everything reads.
    const fine = JSON.parse((await world.brief({ format: 'json', all: '1' })).stdout) as BriefJson;
    expect(fine.sources.filter((source) => source.status === 'unavailable').map((source) => source.id)).toEqual(['transcript']);
  });
});

describe('I6 the source-fail state in the text', () => {
  it('names each reason on its source and keeps the rest', async () => {
    const deps = await STATES.find((state) => state.name === 'source-fail')!.setup();
    const run = await world.brief({ all: '1' }, deps);
    expect(run.exit).toBe(0);
    expect(run.stdout).toContain('[1] src=relay unavailable=read_failed');
    expect(run.stdout).toContain('[6] src=verify unavailable=timeout');
    expect(run.stdout).toContain('[6] src=run unsupported=format');
    expect(run.stdout).toContain('[10] src=transcript instance=claude unavailable=no_turn_yet');
    expect(run.stdout).toContain('src=state');
    expect(run.stdout).toContain('src=auto-yes');
  });
});

describe('I7 off prints nothing; derived reads no hand-written item', () => {
  const spies = () => {
    const calls = { mem: 0, notice: 0 };
    return {
      calls,
      readers: {
        mem: (ctx: Parameters<BriefSourceReader>[0]) => {
          calls.mem += 1;
          return BRIEF_SOURCE_READERS.mem(ctx);
        },
        notice: (ctx: Parameters<BriefSourceReader>[0]) => {
          calls.notice += 1;
          return BRIEF_SOURCE_READERS.notice(ctx);
        },
      },
    };
  };

  it('off: exit 50, stdout empty, no source read', async () => {
    world.setMode('off');
    const spy = spies();
    for (const format of [null, 'json'] as const) {
      const run = await world.brief({ format }, { readers: spy.readers });
      expect(run.exit).toBe(50);
      expect(run.stdout).toBe('');
    }
    expect(spy.calls).toEqual({ mem: 0, notice: 0 });
  });

  it('derived: no src=mem / src=notice, S7・S8 never read, reported as skipped', async () => {
    await world.add('next', 'manual', { text: '手で書いた次の一手' });
    world.setMode('derived');
    const spy = spies();
    const text = await world.brief({ all: '1' }, { readers: spy.readers });
    const json = JSON.parse((await world.brief({ format: 'json', all: '1' }, { readers: spy.readers })).stdout) as BriefJson;
    expect(text.stdout).not.toContain('src=mem');
    expect(text.stdout).not.toContain('src=notice');
    expect(text.stdout).not.toContain('手で書いた次の一手');
    expect(text.stdout).toContain('mode=derived');
    expect(json.sources.filter((source) => source.status === 'skipped').map((source) => source.id)).toEqual(['mem', 'notice']);
    expect(spy.calls).toEqual({ mem: 0, notice: 0 });
    for (const [id, row] of Object.entries(SOURCE_TABLE)) {
      expect(json.sources.find((source) => source.id === id)!.status === 'skipped').toBe(!row.derived);
    }
  });

  it('on: the hand-written item is there (negative control)', async () => {
    await world.add('next', 'manual', { text: '手で書いた次の一手' });
    const text = await world.brief({ all: '1' });
    expect(text.stdout).toMatch(/\[5\] src=mem id=\S+ by=agent:claude .*text="手で書いた次の一手"/);
  });

  it('notices: an ended item reaches its creator as a notice row (S8)', async () => {
    await STATES.find((state) => state.name === 'notices')!.setup();
    const json = JSON.parse((await world.brief({ format: 'json', all: '1' })).stdout) as BriefJson;
    const notice = json.entries.find((entry) => entry.source === 'notice');
    expect(notice).toMatchObject({ rank: 9, fields: { end: 'time-passed', audience: 'creator' } });
    expect(json.includedNoticeIds).toEqual([notice!.id]);
    expect(JSON.stringify(json)).not.toContain('終わった待ち'); // the ended item itself is closed
  });
});

describe('I13 every free text goes through the exit check', () => {
  it('no secret, bidi control, BOM or C1 anywhere; withheld instead', async () => {
    const deps = await STATES.find((state) => state.name === 'hostile-text')!.setup();
    const outputs = [
      (await world.brief({ all: '1' }, deps)).stdout,
      (await world.brief({ budget: '4096' }, deps)).stdout,
      (await world.brief({ format: 'json', all: '1' }, deps)).stdout,
      (await world.brief({ format: 'json' }, deps)).stdout,
    ];
    for (const out of outputs) {
      expect(out).not.toContain(GHP);
      expect(out).not.toMatch(/[‮﻿\u0085]/);
      expect(out).not.toContain('\\u202e');
      expect(out).not.toContain('\\ufeff');
    }
    expect(outputs[0]).toContain('withheld=secret_like');
    expect(outputs[0]).toContain('withheld=control_char');
    expect(outputs[0]).toMatch(/branch=\(省略 \d+ bytes。commandmate mem mode で読む\)/);
    expect(JSON.parse(outputs[2]).target).toMatchObject({ branch: null, branchOmitted: { reason: 'secret_like' } });
  });

  it('a Japanese and emoji title passes as it is, with its source, author and time (negative control)', async () => {
    world.task({ title: JA });
    const out = (await world.brief({ all: '1' })).stdout;
    expect(out).toMatch(new RegExp(`\\[6\\] src=task id=\\S+ by=server updated=\\S+ .*text=${JSON.stringify(JA)}`));
  });
});

describe('I14 the fixed part fits the minimum in the worst case', () => {
  const worstItems = (count: number): BriefItem[] =>
    Array.from({ length: count }, (_, i) => ({
      entry: { rank: 10, source: 'mem', id: `m_${i}`, author: { type: 'server' }, updatedAt: null, observedAt: '2026-11-09T00:00:00.000Z', fields: {} },
      sourceIndex: 7,
      sortAt: null,
    }));
  const model = (branch: string, replace: boolean): BriefModel => ({
    fixed: {
      mode: 'derived',
      worktreeId: 'w'.repeat(200),
      instanceId: 'i'.repeat(64),
      cliToolId: 'command-code',
      repositoryId: 'r'.repeat(64),
      repositoryIdBytes: 64,
      branch: replace ? sanitizeBranch(branch) : { kind: 'ok', value: branch },
      detached: false,
      boundaryKind: 'auto_restart',
      generatedAt: '2026-11-09T03:12:45.120Z',
      readAll: `commandmate brief --worktree ${'w'.repeat(200)} --instance ${'i'.repeat(64)} --all`,
    },
    items: worstItems(99_999),
    sources: BRIEF_SOURCE_IDS.map((id) => ({ id, status: 'unsupported', reason: 'no_transcript_reader', observedAt: '2026-11-09T03:12:45.120Z' })),
  });

  it('text 1024 and --json 4096 hold the whole fixed part with 0 entries', () => {
    for (const branch of ['b'.repeat(128), 'b'.repeat(129), 'b'.repeat(8192)]) {
      const text = fitText(model(branch, true), { maxBytes: BRIEF_BUDGET.text.min, trailingNewline: true });
      expect(bytes(text.text) + 1).toBeLessThanOrEqual(BRIEF_BUDGET.text.min);
      expect(text.text.split('\n')[3]).toMatch(/^omitted=\d+ all=/);
      const json = fitJson(model(branch, true), BRIEF_BUDGET.json.min);
      expect(bytes(JSON.stringify(json.json)) + 1).toBeLessThanOrEqual(BRIEF_BUDGET.json.min);
      expect(json.json.omitted.count).toBe(99_999 - json.json.entries.length);
    }
  });

  it('the positive control: a branch that is not replaced overflows the minimum', () => {
    expect(() => fitText(model('b'.repeat(8192), false), { maxBytes: BRIEF_BUDGET.text.min, trailingNewline: true })).toThrow(BriefOverBudgetError);
    expect(() => fitJson(model('b'.repeat(8192), false), BRIEF_BUDGET.json.min)).toThrow(BriefOverBudgetError);
  });

  it('a replaced branch is not cut: it is named by its size', () => {
    const json = fitJson(model('b'.repeat(8192), true), BRIEF_BUDGET.json.min).json;
    expect(json.target.branch).toBeNull();
    expect(json.target.branchOmitted).toEqual({ bytes: 8192, reason: 'too_long' });
    expect(JSON.stringify(json)).not.toContain('bbbb');
  });
});
