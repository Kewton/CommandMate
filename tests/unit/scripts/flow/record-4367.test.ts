/**
 * T-L (Issue #4367 PR1a, docs/design/flow-metrics-4367.md §7.2): the line boundary of the
 * flow record, for the writer (`appendTick`) and the reader (`readTicks`). Each case writes
 * under its own `fs.mkdtempSync(os.tmpdir())` dir, removed in afterEach.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendTick, flowDirOf, readTicks, repoSlug } from '../../../../scripts/flow/record.mjs';
import { TempDirs, holds } from './flow-fakes';

const temps = new TempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  temps.cleanup();
});

const SCOPE = { repo: 'Kewton/CommandMate', base: 'develop' };
const TZ = 'Asia/Tokyo';
const AT = '2026-11-13T01:00:00.000Z'; // 10:00 JST → 2026-11-13.jsonl
const FILE = '2026-11-13.jsonl';

function tickLine(tickId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    kind: 'tick',
    tickId,
    at: AT,
    repo: SCOPE.repo,
    base: SCOPE.base,
    window: { from: '2026-11-12T00:50:00.000Z', to: '2026-11-13T00:50:00.000Z' },
    metrics: { prCreated: { value: 1, coverage: 'search-observed', complete: false, fetchedAt: AT, limit: 1000 } },
    durationMs: 3,
    ...over,
  });
}
const tick = (tickId: string, over: Record<string, unknown> = {}) => JSON.parse(tickLine(tickId, over));
const A = tickLine('A');
const B = tickLine('B');

type Append = typeof appendTick;
type Read = typeof readTicks;

function dirWith(content: string | null): { dir: string; file: string } {
  const dir = path.join(temps.make(), 'kewton.commandmate');
  const file = path.join(dir, FILE);
  if (content !== null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { dir, file };
}

const ids = (read: ReturnType<Read>) => read.ticks.map((t: { tickId: string }) => t.tickId);

/** The rows of §7.2 as checks over a writer and a reader (T-M swaps one of them). */
const ROWS: Record<string, (append: Append, read: Read) => void> = {
  'L1 no file: made, 1 line / no records': (append, read) => {
    const { dir, file } = dirWith(null);
    expect(read(dir, SCOPE).exists).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${tickLine('C')}\n`);
  },
  'L2 empty: 1 line / no records': (append, read) => {
    const { dir, file } = dirWith('');
    const before = read(dir, SCOPE);
    expect(before.ticks).toEqual([]);
    expect(before.unfinishedFiles).toEqual([]);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${tickLine('C')}\n`);
  },
  'L3 A\\n: A\\nC\\n / A': (append, read) => {
    const { dir, file } = dirWith(`${A}\n`);
    expect(ids(read(dir, SCOPE))).toEqual(['A']);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${A}\n${tickLine('C')}\n`);
  },
  'L4 A\\nB (B complete JSON, no newline): nothing appended, bytes kept / A only, unfinished': (append, read) => {
    const { dir, file } = dirWith(`${A}\n${B}`);
    const r = read(dir, SCOPE);
    expect(ids(r)).toEqual(['A']);
    expect(r.unfinishedFiles).toEqual([file]);
    const w = append(dir, tick('C'), { tz: TZ });
    expect(w).toEqual({ ok: false, file, reason: 'unfinished-tail' });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${A}\n${B}`);
  },
  'L5 A\\nB (B cut in the middle): the same': (append, read) => {
    const half = B.slice(0, 20);
    const { dir, file } = dirWith(`${A}\n${half}`);
    const r = read(dir, SCOPE);
    expect(ids(r)).toEqual(['A']);
    expect(r.unfinishedFiles).toEqual([file]);
    expect(r.corruptLines).toBe(0);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${A}\n${half}`);
  },
  'L6 B (no newline from line 1): nothing appended / 0 records, unfinished (not "no records")': (append, read) => {
    const { dir, file } = dirWith(B);
    const r = read(dir, SCOPE);
    expect(r.exists).toBe(true);
    expect(r.ticks).toEqual([]);
    expect(r.unfinishedFiles).toEqual([file]);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(B);
  },
  'L7 A\\nX\\n (X not JSON): appended / A and C, 1 corrupt': (append, read) => {
    const { dir } = dirWith(`${A}\nnot json\n`);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    const r = read(dir, SCOPE);
    expect(ids(r)).toEqual(['A', 'C']);
    expect(r.corruptLines).toBe(1);
  },
  'L9 L4 fixed by a person (A\\n): appended / A, C': (append, read) => {
    const { dir, file } = dirWith(`${A}\n${B}`);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(false);
    fs.writeFileSync(file, `${A}\n`);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    expect(ids(read(dir, SCOPE))).toEqual(['A', 'C']);
  },
  "L10 another base's line A'\\n: appended / own scope only": (append, read) => {
    const { dir } = dirWith(`${tickLine('A-main', { base: 'main' })}\n${tickLine('A-other', { repo: 'Other/Repo' })}\n`);
    expect(append(dir, tick('C'), { tz: TZ }).ok).toBe(true);
    const r = read(dir, SCOPE);
    expect(ids(r)).toEqual(['C']);
    expect(r.corruptLines).toBe(0);
  },
};

describe('T-L: the line boundary (§7.2)', () => {
  it.each(Object.keys(ROWS))('%s', (row) => {
    ROWS[row](appendTick, readTicks);
  });

  it('L8 appendFileSync fails with ENOSPC before writing: not ok, A only', () => {
    const { dir, file } = dirWith(`${A}\n`);
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    expect(appendTick(dir, tick('C'), { tz: TZ })).toEqual({ ok: false, file, reason: 'write-failed', code: 'ENOSPC' });
    vi.restoreAllMocks();
    expect(fs.readFileSync(file, 'utf8')).toBe(`${A}\n`);
    expect(ids(readTicks(dir, SCOPE))).toEqual(['A']);
  });

  it('L8b only a prefix reached the disk, then ENOSPC: the next reader sees A + unfinished, the next writer refuses', () => {
    const { dir, file } = dirWith(`${A}\n`);
    const real = fs.appendFileSync.bind(fs);
    vi.spyOn(fs, 'appendFileSync').mockImplementation((target, data) => {
      real(target as string, String(data).slice(0, 30));
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    expect(appendTick(dir, tick('C'), { tz: TZ }).ok).toBe(false);
    vi.restoreAllMocks();
    const r = readTicks(dir, SCOPE);
    expect(ids(r)).toEqual(['A']);
    expect(r.unfinishedFiles).toEqual([file]);
    const before = fs.readFileSync(file, 'utf8');
    expect(appendTick(dir, tick('D'), { tz: TZ })).toEqual({ ok: false, file, reason: 'unfinished-tail' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('L8c a full line reached the disk and then the call threw: the reader reads that line (V2), nothing is repaired', () => {
    const { dir, file } = dirWith(`${A}\n`);
    const real = fs.appendFileSync.bind(fs);
    vi.spyOn(fs, 'appendFileSync').mockImplementation((target, data) => {
      real(target as string, String(data));
      throw Object.assign(new Error('close failed'), { code: 'EIO' });
    });
    expect(appendTick(dir, tick('C'), { tz: TZ }).ok).toBe(false);
    vi.restoreAllMocks();
    expect(ids(readTicks(dir, SCOPE))).toEqual(['A', 'C']);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${A}\n${tickLine('C')}\n`);
  });

  it('the file is named by the tz date of at; the dir is made 0700', () => {
    const { dir } = dirWith(null);
    const w = appendTick(dir, tick('C', { at: '2026-11-13T15:30:00.000Z' }), { tz: TZ });
    expect(w.ok && path.basename(w.file)).toBe('2026-11-14.jsonl');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('readTicks narrows to at in [from, to) when given', () => {
    const { dir } = dirWith(`${tickLine('early', { at: '2026-11-13T00:00:00.000Z' })}\n${tickLine('late', { at: '2026-11-13T02:00:00.000Z' })}\n`);
    const r = readTicks(dir, SCOPE, { from: Date.parse('2026-11-13T00:00:00.000Z'), to: Date.parse('2026-11-13T02:00:00.000Z') });
    expect(ids(r)).toEqual(['early']);
  });

  it('a line of the wrong shape is corrupt, not a record', () => {
    const { dir } = dirWith(`${tickLine('x', { v: 2 })}\n${tickLine('y', { kind: 'train' })}\n${tickLine('z', { window: null })}\n${A}\n`);
    const r = readTicks(dir, SCOPE);
    expect(ids(r)).toEqual(['A']);
    expect(r.corruptLines).toBe(3);
  });

  it('a file over the per-file limit, or past the total, is listed as truncated and not read', () => {
    const { dir } = dirWith(`${A}\n`);
    fs.writeFileSync(path.join(dir, '2026-11-12.jsonl'), `${tickLine('old', { at: '2026-11-12T01:00:00.000Z' })}\n`);
    const perFile = readTicks(dir, SCOPE, { maxFileBytes: 10 });
    expect(perFile.ticks).toEqual([]);
    expect(perFile.truncatedFiles.map((f: string) => path.basename(f))).toEqual(['2026-11-13.jsonl', '2026-11-12.jsonl']);
    const total = readTicks(dir, SCOPE, { maxTotalBytes: A.length + 1 });
    expect(ids(total)).toEqual(['A']);
    expect(total.truncatedFiles.map((f: string) => path.basename(f))).toEqual(['2026-11-12.jsonl']);
  });

  it('an unreadable record dir is unreadable, not "no records"', () => {
    const { dir } = dirWith(`${A}\n`);
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const r = readTicks(dir, SCOPE);
    expect(r.exists).toBe(true);
    expect(r.unreadable).toEqual([{ file: dir, code: 'EACCES' }]);
  });

  it('flowDirOf / repoSlug', () => {
    expect(flowDirOf({ CM_FLOW_DIR: '/x/flow' }, '/home/u')).toBe('/x/flow');
    expect(flowDirOf({ CM_FLOW_DIR: ' ' }, '/home/u')).toBe(path.join('/home/u', '.commandmate', 'flow'));
    expect(flowDirOf({}, '/home/u')).toBe(path.join('/home/u', '.commandmate', 'flow'));
    expect(repoSlug('Kewton/CommandMate')).toBe('kewton.commandmate');
    expect(repoSlug('Some+Owner/Repo Name')).toBe('some_owner.repo_name');
    const long = repoSlug(`o/${'r'.repeat(80)}`);
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^o\.r{49}\.[0-9a-f]{12}$/);
  });
});

describe('T-M M5・M6・M12: the boundary guards removed turn their rows red (§7.5)', () => {
  // M5: the writer of run-log.mjs (F1) — adds a newline to the tail, then appends.
  const repairingAppend: Append = (dir, t, o) => {
    const file = path.join(dir, FILE);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
    }
    return appendTick(dir, t, o);
  };
  // M6: the reader takes a tail without a newline as a line.
  const tailReadingRead: Read = (dir, scope, o) => {
    const file = path.join(dir, FILE);
    const copyDir = temps.make('flow-4367-m6-');
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(path.join(copyDir, FILE), text.endsWith('\n') || text === '' ? text : `${text}\n`);
    }
    return readTicks(copyDir, scope, o);
  };
  // M12: the reader ignores the scope.
  const scopeBlindRead: Read = (dir, scope, o) => {
    const r = readTicks(dir, scope, o);
    const all = fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ...r, ticks: all };
  };

  it.each([
    ['M5 the tail repaired before the append', ['L4 A\\nB (B complete JSON, no newline): nothing appended, bytes kept / A only, unfinished', 'L5 A\\nB (B cut in the middle): the same', 'L6 B (no newline from line 1): nothing appended / 0 records, unfinished (not "no records")'], repairingAppend, readTicks],
    ['M6 the reader reads the unfinished tail', ['L4 A\\nB (B complete JSON, no newline): nothing appended, bytes kept / A only, unfinished'], appendTick, tailReadingRead],
    ['M12 the reader reads another scope', ["L10 another base's line A'\\n: appended / own scope only"], appendTick, scopeBlindRead],
  ] as Array<[string, string[], Append, Read]>)('%s', (_name, rows, append, read) => {
    for (const row of rows) {
      expect(holds(() => ROWS[row](appendTick, readTicks)), `${row} real`).toBe(true);
      expect(holds(() => ROWS[row](append, read)), `${row} mutant`).toBe(false);
    }
  });
});
