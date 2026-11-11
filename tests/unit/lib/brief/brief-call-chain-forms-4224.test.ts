/**
 * The walk of who builds a brief, widened to every form (Issue #4224, D2 design §3, C1〜C14,
 * R1〜R6, and the 2nd review ⑥).
 *
 * The table below is checked against `src/` itself: every function that can reach
 * `buildBrief` — through C's port (`getBriefProvider().build`), an element access, a
 * dynamic import, a destructured alias, `.bind`, an object holding the provider — is a row,
 * with whether it repeats the call (a loop, a callback of `forEach` / `map` / a retry
 * helper, recursion). A reference the walk cannot follow fails (R2). The send's walk stops
 * at `SendBrief.plan` (R4), which reads no lifetime itself; the lifetimes come from the
 * entrance, whose two pins are checked to be taken in the stretch that reads the worktree
 * and the one that resolves the instance (⑥).
 *
 * Each self-test adds a source to `src/` in memory (no file is written) and runs the same
 * selection and comparison: the positive controls fail the table, the negative ones do not.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { callsIn, sameStretch, sendCallers, wideChain, wideChainSources, type Ref } from './brief-call-chain-wide';

const ROOT = process.cwd();
const BUILD: Ref[] = [{ module: 'src/lib/brief/build', name: 'buildBrief' }];
const PINS: Ref[] = [
  { module: 'src/lib/brief/build', name: 'pinBriefLifetime' },
  { module: 'src/lib/session/session-brief', name: 'pinBriefWorktree' },
  { module: 'src/lib/session/session-brief', name: 'pinBriefRequest' },
];
/** R4: the send's walk stops here (it reads no lifetime itself; the entrance's pin is handed in). */
const STOPS = new Set(['src/lib/session/session-brief.ts:SendBrief.plan']);

/** Every caller of the chain of `buildBrief` in src, and whether it repeats a build. */
const TABLE: Record<string, { retries: boolean }> = {
  'src/app/api/worktrees/[id]/mem/brief/route.ts:GET': { retries: false },
  // Issue #4227 G-PR3 (G-3): the start preview builds C's JSON once (briefForRoute's own rule inside).
  'src/app/api/worktrees/[id]/mem/start-preview/route.ts:GET': { retries: false },
  'src/lib/handoff/preview.ts:handoffStartPreview': { retries: false },
  'src/lib/brief/provider.ts:build': { retries: false },
  'src/lib/brief/service.ts:briefForRoute': { retries: true },
  'src/lib/session/session-brief.ts:SendBrief.plan': { retries: false },
  'src/lib/session/session-brief.ts:buildWithTimeout': { retries: false },
};

/** R5: every caller that makes a pin, none in a repetition. */
const PIN_TABLE: Record<string, { retries: boolean }> = {
  'src/app/api/worktrees/[id]/mem/brief/route.ts:GET': { retries: false },
  // Issue #4227 G-PR3 (G-3): through briefForRoute, once.
  'src/app/api/worktrees/[id]/mem/start-preview/route.ts:GET': { retries: false },
  'src/lib/handoff/preview.ts:handoffStartPreview': { retries: false },
  'src/app/api/worktrees/[id]/send/route.ts:POST': { retries: false },
  'src/app/api/worktrees/[id]/send/route.ts:handleSend': { retries: false },
  'src/lib/brief/service.ts:briefForRoute': { retries: false },
};

/** R6: the send service's callers and the brief each names. */
const SEND_TABLE = [
  { caller: 'src/app/api/worktrees/[id]/send/route.ts:handleSend', brief: "body.brief ?? 'auto'" },
  { caller: 'src/lib/relay/relay-delivery.ts:<module>', brief: '(none)' },
  { caller: 'src/lib/timer-manager.ts:executeTimer', brief: '(none)' },
];

function sourcesUnder(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourcesUnder(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out[path.relative(ROOT, full).split(path.sep).join('/')] = readFileSync(full, 'utf8');
  }
  return out;
}

let cached: Record<string, string> | null = null;
const src = (): Record<string, string> => (cached ??= sourcesUnder(path.join(ROOT, 'src')));

function chain(extra: Record<string, string> = {}, roots = BUILD) {
  const all = { ...src(), ...extra };
  return wideChain(wideChainSources(all, roots, STOPS), roots, STOPS);
}

describe('R1 / R2 the table names every way to a build in src', () => {
  it('the callers of buildBrief, C’s port included, and whether each repeats', () => {
    const found = chain();
    expect(found.callers).toEqual(TABLE);
    expect(found.unresolved).toEqual([]);
  });

  it('R5: every maker of a pin, none in a repetition', () => {
    const found = chain({}, PINS);
    expect(found.callers).toEqual(PIN_TABLE);
    expect(Object.values(found.callers).every((row) => !row.retries)).toBe(true);
  });

  it('R6: the send service’s callers and their brief, read off the syntax', () => {
    const callers = sendCallers(src());
    // relay-delivery's caller is an inner function; the row names where the call sits.
    expect(callers.map((row) => row.brief)).toEqual(callers.map((row) => SEND_TABLE.find((entry) => entry.caller.split(':')[0] === row.caller.split(':')[0])?.brief));
    expect(callers.map((row) => row.caller.split(':')[0]).sort()).toEqual(SEND_TABLE.map((row) => row.caller.split(':')[0]).sort());
  });
});

/** A self-test: the source `text` added as `file`; what the walk finds about it. */
function withExtra(file: string, text: string) {
  return chain({ [file]: text });
}

const EXTRA = 'src/lib/brief/extra.ts';

describe('C1〜C11 every form reaches the table (positive) — and look-alikes do not (negative)', () => {
  const forms: Array<[string, string, string, boolean | 'unresolved']> = [
    ['C1 the port through getBriefProvider()', "import { getBriefProvider } from '@/lib/session/brief-provider';\nexport async function viaPort(r: never) { return getBriefProvider().build(r); }\n", 'viaPort', false],
    ['C1 the port held in a const', "import { getBriefProvider } from '@/lib/session/brief-provider';\nexport async function held(r: never) { const p = getBriefProvider(); return p.build(r); }\n", 'held', false],
    ['C2 an object holding buildBrief', "import { buildBrief } from './build';\nconst port = { make: buildBrief };\nexport async function viaObject(a: never) { return port.make(a, a); }\n", 'viaObject', false],
    ['C2 an object holding a bound buildBrief', "import { buildBrief } from './build';\nconst port = { bound: buildBrief.bind(null) };\nexport async function viaBound(a: never) { return port.bound(a, a); }\n", 'viaBound', false],
    ['C3 an element access', "import * as b from './build';\nexport async function viaElement(a: never) { return b['buildBrief'](a, a); }\n", 'viaElement', false],
    ['C5 a dynamic import awaited', "export async function viaDynamic(a: never) { return (await import('./build')).buildBrief(a, a); }\n", 'viaDynamic', false],
    ['C5 a dynamic import held', "export async function viaHeld(a: never) { const m = await import('./build'); return m.buildBrief(a, a); }\n", 'viaHeld', false],
    ['C5 a dynamic import then', "export function viaThen(a: never) { return import('./build').then((m) => m.buildBrief(a, a)); }\n", 'viaThen', false],
    ['C6 a destructured dynamic import', "export async function viaDestructured(a: never) { const { buildBrief: make } = await import('./build'); return make(a, a); }\n", 'viaDestructured', false],
    ['C6 a destructured namespace', "import * as ns from './build';\nconst { buildBrief: make } = ns;\nexport async function viaNs(a: never) { return make(a, a); }\n", 'viaNs', false],
    ['C7 .bind', "import { buildBrief } from './build';\nexport async function viaBind(a: never) { const f = buildBrief.bind(null, a); return f(a); }\n", 'viaBind', false],
    ['C7 .call', "import { buildBrief } from './build';\nexport async function viaCall(a: never) { return buildBrief.call(null, a, a); }\n", 'viaCall', false],
    ['C8 forEach', "import { buildBrief } from './build';\nexport function viaEach(ids: never[]) { ids.forEach((id) => buildBrief(id, id)); }\n", 'viaEach', true],
    ['C8 Promise.all + map', "import { buildBrief } from './build';\nexport async function viaMap(ids: never[]) { await Promise.all(ids.map((id) => buildBrief(id, id))); }\n", 'viaMap', true],
    ['C9 a retry helper', "import { buildBrief } from './build';\ndeclare function withRetry<T>(f: () => T): T;\nexport async function viaRetry(a: never) { return withRetry(() => buildBrief(a, a)); }\n", 'viaRetry', true],
    ['C11 mutual recursion', "import { buildBrief } from './build';\nexport async function ping(a: never): Promise<unknown> { return pong(a); }\nexport async function pong(a: never): Promise<unknown> { await buildBrief(a, a); return ping(a); }\n", 'ping', true],
  ];

  it.each(forms)('%s is a caller', (_name, text, fn, retries) => {
    const found = withExtra(EXTRA, text);
    expect(found.callers[`${EXTRA}:${fn}`]).toEqual({ retries });
    expect(found.callers).not.toEqual(TABLE); // the table comparison fails until it has a row
  });

  it.each([
    ['C4 a computed element of the chain’s namespace', "import * as b from './build';\nexport async function viaKey(a: never, key: string) { return (b as never as Record<string, (x: never, y: never) => unknown>)[key](a, a); }\nexport async function direct(a: never, key: 'buildBrief') { return b[key](a, a); }\n"],
    ['C10 buildBrief handed as a value', "import { buildBrief } from './build';\ndeclare function withRetry<T>(f: T): T;\nexport const run = () => withRetry(buildBrief);\n"],
    ['C10 buildBrief in an array', "import { buildBrief } from './build';\nexport const run = (a: never) => [buildBrief].map((f) => f(a, a));\n"],
  ])('%s is an unresolved reference (R2: fails rather than passes)', (_name, text) => {
    expect(withExtra(EXTRA, text).unresolved.length).toBeGreaterThan(0);
  });

  it.each([
    ['C1 a class that only declares a build method', "export class Other { build(): number { return 1; } }\n"],
    ['C2 the word build in a string or comment', "// build\nexport const label = 'build';\n"],
    ['C3 another element of the namespace', "import * as b from './build';\nexport function other() { return b['BRIEF_CHANGE_REASONS']; }\n"],
    ['C4 a computed element of an unrelated record', "const local: Record<string, () => number> = {};\nexport function viaLocal(key: string) { return local[key](); }\n"],
    ['C5 a dynamic import of another module', "export async function draws() { const r = await import('./render'); return r.bytesOf('x'); }\n"],
    ['C6 the same name destructured from another module', "export async function other() { const { buildBrief } = await import('./sanitize') as never as { buildBrief: () => number }; return buildBrief(); }\n"],
    ['C7 an unrelated .bind', "const f = (x: number) => x;\nexport const g = f.bind(null, 1);\n"],
    ['C10 a type position', "import type { buildBrief } from './build';\nexport type B = typeof buildBrief;\n"],
  ])('%s is not a caller (negative)', (_name, text) => {
    const found = withExtra(EXTRA, text);
    expect(found.callers).toEqual(TABLE);
    expect(found.unresolved).toEqual([]);
  });

  it.each([
    ['C8 withMemTarget (once)', "import { buildBrief } from './build';\ndeclare function withMemTarget<T>(a: never, b: never, c: never, f: () => T): T;\nexport async function once(a: never) { return withMemTarget(a, a, a, () => buildBrief(a, a)); }\n", 'once'],
    ['C9 withinMs (once)', "import { buildBrief } from './build';\nimport { withinMs } from './deadline';\nexport async function bounded(a: never) { return withinMs(buildBrief(a, a), 1, () => null); }\n", 'bounded'],
    ['C11 two levels, no cycle', "import { buildBrief } from './build';\nexport async function outer(a: never) { return inner(a); }\nasync function inner(a: never) { return buildBrief(a, a); }\n", 'outer'],
  ])('%s is a caller that does not repeat (negative)', (_name, text, fn) => {
    expect(withExtra(EXTRA, text).callers[`${EXTRA}:${fn}`]).toEqual({ retries: false });
  });
});

describe('C12 / ⑥ the entrance and the stop (R4, the 2nd review ⑥)', () => {
  const ROUTE = 'src/app/api/worktrees/[id]/send/route.ts';
  const route = () => src()[ROUTE];

  it('the worktree is pinned in the stretch that reads it, the instance in the stretch that resolves it', () => {
    expect(sameStretch(ROUTE, route(), 'handleSend', 'getWorktreeById', 'pinBriefWorktree')).toBe(true);
    expect(sameStretch(ROUTE, route(), 'handleSend', 'validateSendRequest', 'pinBriefRequest')).toBe(true);
  });

  it('positive: the worktree pinned after the body is parsed fails the first check', () => {
    const moved = route()
      .replace(/const briefWorktreePin = worktree \? pinBriefWorktree\(db, id\) : null;/, 'let briefWorktreePin = null as ReturnType<typeof pinBriefWorktree> | null;')
      .replace('const body = parsed.body;', 'const body = parsed.body;\n    briefWorktreePin = pinBriefWorktree(db, id);');
    expect(moved).not.toBe(route());
    expect(sameStretch(ROUTE, moved, 'handleSend', 'getWorktreeById', 'pinBriefWorktree')).toBe(false);
  });

  it('positive: the instance pinned after the ownership check fails the second check', () => {
    const moved = route()
      .replace("const briefPin = pinBriefRequest(db, briefWorktreePin, instanceId ?? cliToolId);", '')
      .replace('const ownership = await checkSessionOwnership(sessionName, worktree.path);', 'const ownership = await checkSessionOwnership(sessionName, worktree.path);\n    const briefPin = pinBriefRequest(db, briefWorktreePin, instanceId ?? cliToolId);');
    expect(moved).not.toBe(route());
    expect(sameStretch(ROUTE, moved, 'handleSend', 'validateSendRequest', 'pinBriefRequest')).toBe(false);
  });

  const SESSION = 'src/lib/session/session-brief.ts';
  const READS = ['readInstanceLifetime', 'getWorktreeIncarnation', 'pinBriefLifetime', 'pinBriefRequest', 'pinBriefWorktree'];

  it('SendBrief.plan reads no lifetime of its own (the stop of the walk)', () => {
    expect(callsIn(SESSION, src()[SESSION], 'SendBrief', 'plan').filter((name) => READS.includes(name))).toEqual([]);
  });

  it('positive: a plan that reads the instance’s lifetime again is caught', () => {
    const changed = src()[SESSION].replace('lifetime = pin.instance;', 'lifetime = readInstanceLifetime(db, worktreeId, instanceId);');
    expect(changed).not.toBe(src()[SESSION]);
    expect(callsIn(SESSION, changed, 'SendBrief', 'plan')).toContain('readInstanceLifetime');
  });
});

describe('C13 a pin made in a repetition (R5)', () => {
  it('positive: a pin made inside the loop is a repeating maker', () => {
    const text = "import { pinBriefLifetime, buildBrief } from './build';\nexport async function again(db: never, ids: string[]) {\n  for (const id of ids) { const pinned = pinBriefLifetime(db, id, id); await buildBrief(db, { pinned } as never); }\n}\n";
    expect(chain({ [EXTRA]: text }, PINS).callers[`${EXTRA}:again`]).toEqual({ retries: true });
  });

  it('negative: made once before the loop, used inside (briefForRoute’s shape)', () => {
    const text = "import { pinBriefLifetime, buildBrief } from './build';\nexport async function once(db: never, ids: string[]) {\n  const pinned = pinBriefLifetime(db, 'w', 'i');\n  for (const id of ids) await buildBrief(db, { pinned, id } as never);\n}\n";
    expect(chain({ [EXTRA]: text }, PINS).callers[`${EXTRA}:once`]).toEqual({ retries: false });
  });
});

describe('C14 the send service’s callers (R6)', () => {
  it.each([
    ['an alias', "import { sendUserMessage } from '@/lib/session/send-user-message';\nconst send = sendUserMessage;\nexport async function viaAlias(db: never) { return send(db, { worktreeId: 'w', content: 'x', cliToolId: 'claude', brief: 'auto' } as never); }\n", "'auto'"],
    ['a spread', "import { sendUserMessage } from '@/lib/session/send-user-message';\nexport async function viaSpread(db: never, params: never) { return sendUserMessage(db, { ...(params as object) } as never); }\n", '(unresolved: spread)'],
  ])('positive: %s is a new row (the table comparison fails)', (_name, text, brief) => {
    const callers = sendCallers({ ...src(), 'src/lib/extra-send.ts': text });
    expect(callers.find((row) => row.caller.startsWith('src/lib/extra-send.ts'))?.brief).toBe(brief);
    expect(callers.length).toBe(SEND_TABLE.length + 1);
  });

  it('negative: the three callers today, as the table says', () => {
    expect(sendCallers(src())).toHaveLength(SEND_TABLE.length);
  });
});
