/**
 * Positive controls for useSessionsDefaultFilter (Issue #4388), without touching the
 * repository: the hook's source is copied into a fresh `os.tmpdir()` directory with
 * one guard removed, and the scenario of useSessionsDefaultFilter-4388.test.ts must
 * then break its invariant (I1 / I2 / I3 and I3' / I3'' / I6 / I6' / I7 / I8). The temp directory is removed after each case.
 *
 * Runs in the node environment (a module outside the project can only be imported
 * there) with vitest's own jsdom environment set up on the global by hand.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinEnvironments } from 'vitest/environments';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';
import type * as HookModule from '@/hooks/useSessionsDefaultFilter';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getCalls: Array<Deferred<unknown>> = [];
const putCalls: Array<{ body: SessionsFilterCondition; d: Deferred<unknown> }> = [];

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getDefaultFilter: vi.fn(() => {
        const d = deferred<unknown>();
        getCalls.push(d);
        return d.promise;
      }),
      putDefaultFilter: vi.fn((body: SessionsFilterCondition) => {
        const d = deferred<unknown>();
        putCalls.push({ body, d });
        return d.promise;
      }),
    },
  };
});

const EMPTY: SessionsFilterCondition = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };
const cond = (over: Partial<SessionsFilterCondition>): SessionsFilterCondition => ({ ...EMPTY, ...over });
const stored = (filter: SessionsFilterCondition) => ({ success: true, filter, configured: true });

const HOOK_SOURCE = path.resolve(__dirname, '../../../src/hooks/useSessionsDefaultFilter.ts');

let rtl: typeof import('@testing-library/react');
let react: typeof import('react');

let teardownDom: (() => unknown) | null = null;
beforeAll(async () => {
  const env = await builtinEnvironments.jsdom.setup(globalThis, {});
  teardownDom = () => env.teardown(globalThis);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rtl = await import('@testing-library/react');
  react = await import('react');
});

afterAll(async () => {
  await teardownDom?.();
});

let dir: string | null = null;
let loaded: typeof HookModule | null = null;
beforeEach(() => {
  getCalls.length = 0;
  putCalls.length = 0;
});
afterEach(() => {
  rtl.cleanup();
  loaded?.resetSessionsDefaultFilterSaveQueueForTests();
  loaded = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

type Mutation = { from: string; to: string };
async function loadHook(mutate?: Mutation | Mutation[]): Promise<typeof HookModule> {
  let src = fs.readFileSync(HOOK_SOURCE, 'utf8');
  for (const m of mutate === undefined ? [] : Array.isArray(mutate) ? mutate : [mutate]) {
    expect(src).toContain(m.from);
    src = src.replace(m.from, m.to);
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4388-mutant-'));
  const file = path.join(dir, 'useSessionsDefaultFilter.ts');
  fs.writeFileSync(file, src);
  loaded = (await import(/* @vite-ignore */ file)) as typeof HookModule;
  return loaded;
}

interface Props {
  rolesReadiness: HookModule.SessionsRolesReadiness;
  existingRoleIds: readonly string[] | null;
}

function mount(useHook: typeof HookModule.useSessionsDefaultFilter, initial: Props, reactStrictMode = false) {
  return rtl.renderHook(
    (props: Props) => {
      const [current, setCurrent] = react.useState<SessionsFilterCondition>(EMPTY);
      const df = useHook({ current, ...props, apply: setCurrent });
      const userSets = (c: SessionsFilterCondition) => {
        df.noteUserChange();
        setCurrent(c);
      };
      return { current, df, userSets };
    },
    { initialProps: initial, reactStrictMode }
  );
}

const MUTANTS = {
  I1: { from: '    if (touched.current) return;\n', to: '' },
  // Judge deleted roles from whatever list is passed, even when roles are unavailable.
  I2: {
    from: "const roleIdsForDefault = rolesReadiness === 'ready' && existingRoleIds ? existingRoleIds : knownRoleIds;",
    to: 'const roleIdsForDefault = existingRoleIds ? existingRoleIds : knownRoleIds;',
  },
  // I3 / I3': send every save at once instead of waiting for the one that is out.
  I3: { from: '    if (target.busy) {\n', to: '    if (false) {\n' },
  // I3'': the wait belongs to one mount (a lane per mount), as before the module queue.
  I3pp: [
    { from: '  const saveSeq = useRef(0);\n', to: '  const saveSeq = useRef(0);\n  const [laneOfMount] = useState(() => Math.random().toString(36));\n' },
    { from: 'sendSerially(SESSIONS_DEFAULT_FILTER_PATH, ', to: 'sendSerially(SESSIONS_DEFAULT_FILTER_PATH + laneOfMount, ' },
  ],
  I6: { from: 'if (result.droppedRoleIds.length > 0 && isEmptyFilter', to: 'if (false && isEmptyFilter' },
  // I6': a second "empty" judgement that does not trim.
  I6p: {
    from: '&& isEmptyFilter(result.condition)) {',
    to: "&& !(result.condition.branchPattern !== '' || result.condition.roleIds.length > 0 || result.condition.includeNoRole || result.condition.includeAmbiguous)) {",
  },
  I7: { from: '      if (!active) return;\n', to: '      if (!mounted.current) return;\n' },
  // I8: the saved default's deleted ids shown whatever the page shows now.
  I8: { from: 'if (stored && !differs) for', to: 'if (stored) for' },
};

/** The server handles every PUT that reached it, newest first; returns what it holds last. */
async function serverHandlesNewestFirst(): Promise<string | null> {
  let value: string | null = null;
  const handled = new Set<number>();
  for (;;) {
    const waiting = putCalls.map((_, i) => i).filter((i) => !handled.has(i));
    if (waiting.length === 0) return value;
    for (const i of waiting.reverse()) {
      handled.add(i);
      value = putCalls[i].body.branchPattern;
      await rtl.act(async () => putCalls[i].d.resolve(stored(putCalls[i].body)));
    }
  }
}

async function scenarioI1(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<string> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  rtl.act(() => result.current.userSets(cond({ branchPattern: 'mine' })));
  await rtl.act(async () => getCalls[0].resolve(stored(cond({ branchPattern: 'default' }))));
  return result.current.current.branchPattern;
}

async function scenarioI2(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<string[]> {
  const { result } = mount(useHook, { rolesReadiness: 'unavailable', existingRoleIds: [] });
  await rtl.act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['review'] }))));
  return result.current.df.droppedRoleIds;
}

async function scenarioI3(
  useHook: typeof HookModule.useSessionsDefaultFilter
): Promise<{ server: string | null; shown: string | undefined }> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  await rtl.act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
  rtl.act(() => void result.current.df.saveAsDefault());
  rtl.act(() => result.current.userSets(cond({ branchPattern: 'second' })));
  rtl.act(() => void result.current.df.saveAsDefault());
  const server = await serverHandlesNewestFirst();
  return { server, shown: result.current.df.defaults?.branchPattern };
}

async function scenarioI3pp(
  useHook: typeof HookModule.useSessionsDefaultFilter
): Promise<{ server: string | null; shown: string | undefined }> {
  const first = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  await rtl.act(async () => getCalls[0].resolve({ success: true, filter: EMPTY, configured: false }));
  rtl.act(() => first.result.current.userSets(cond({ branchPattern: 'A' })));
  rtl.act(() => void first.result.current.df.saveAsDefault());
  first.unmount();
  const second = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  await rtl.act(async () => getCalls[1].resolve({ success: true, filter: EMPTY, configured: false }));
  rtl.act(() => second.result.current.userSets(cond({ branchPattern: 'B' })));
  rtl.act(() => void second.result.current.df.saveAsDefault());
  const server = await serverHandlesNewestFirst();
  return { server, shown: second.result.current.df.defaults?.branchPattern };
}

async function scenarioI6p(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<string[]> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  await rtl.act(async () => getCalls[0].resolve(stored(cond({ branchPattern: '  ', roleIds: ['gone'] }))));
  return result.current.current.roleIds;
}

async function scenarioI8(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<string[]> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: ['review'] });
  await rtl.act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
  rtl.act(() => result.current.userSets(cond({ roleIds: ['review'] })));
  return result.current.df.droppedRoleIds;
}

async function scenarioI6(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<string[]> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] });
  await rtl.act(async () => getCalls[0].resolve(stored(cond({ roleIds: ['gone'] }))));
  return result.current.current.roleIds;
}

async function scenarioI7(useHook: typeof HookModule.useSessionsDefaultFilter): Promise<boolean> {
  const { result } = mount(useHook, { rolesReadiness: 'ready', existingRoleIds: [] }, true);
  expect(getCalls).toHaveLength(2);
  await rtl.act(async () => getCalls[1].resolve(stored(cond({ branchPattern: '^feature/' }))));
  await rtl.act(async () => getCalls[0].reject(new Error('stale read failed')));
  return result.current.df.hasDefault;
}

describe('[#4388] useSessionsDefaultFilter guards (positive / negative controls)', () => {
  it('I1: the unmodified copy keeps the user change; without the "touched" guard the late default overwrites it', async () => {
    expect(await scenarioI1((await loadHook()).useSessionsDefaultFilter)).toBe('mine');
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    expect(await scenarioI1((await loadHook(MUTANTS.I1)).useSessionsDefaultFilter)).toBe('default');
  });

  it('I2: the unmodified copy reports nothing while roles are unavailable; judging anyway reports a live role as deleted', async () => {
    expect(await scenarioI2((await loadHook()).useSessionsDefaultFilter)).toEqual([]);
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    expect(await scenarioI2((await loadHook(MUTANTS.I2)).useSessionsDefaultFilter)).toEqual(['review']);
  });

  it('I3: the unmodified copy keeps the latest save; without the latest-request guard an older reply wins', async () => {
    // Unmodified: one PUT at a time, so the server and the page both end on the latest.
    expect(await scenarioI3((await loadHook()).useSessionsDefaultFilter)).toEqual({ server: 'second', shown: 'second' });
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    putCalls.length = 0;
    // Sent at once, the server takes the newer first and the older one is written (and shown) last.
    expect(await scenarioI3((await loadHook(MUTANTS.I3)).useSessionsDefaultFilter)).toEqual({ server: '', shown: '' });
  });

  it('I6: the unmodified copy keeps a default whose roles were all deleted narrowed; without the guard it widens to everything', async () => {
    expect(await scenarioI6((await loadHook()).useSessionsDefaultFilter)).toEqual(['gone']);
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    expect(await scenarioI6((await loadHook(MUTANTS.I6)).useSessionsDefaultFilter)).toEqual([]);
  });

  it('I7: the unmodified copy drops a stale GET failure under StrictMode; judged by the shared mounted flag it wipes the default', async () => {
    expect(await scenarioI7((await loadHook()).useSessionsDefaultFilter)).toBe(true);
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    expect(await scenarioI7((await loadHook(MUTANTS.I7)).useSessionsDefaultFilter)).toBe(false);
  });

  const reload = () => {
    fs.rmSync(dir!, { recursive: true, force: true });
    rtl.cleanup();
    getCalls.length = 0;
    putCalls.length = 0;
  };

  it("I3'': the unmodified copy waits across a remount; with a lane per mount the earlier visit's PUT is written last", async () => {
    expect(await scenarioI3pp((await loadHook()).useSessionsDefaultFilter)).toEqual({ server: 'B', shown: 'B' });
    reload();
    expect(await scenarioI3pp((await loadHook(MUTANTS.I3pp)).useSessionsDefaultFilter)).toEqual({ server: 'A', shown: 'B' });
  });

  it("I6': the unmodified copy treats a whitespace-only pattern as empty; a judgement of its own widens to everything", async () => {
    expect(await scenarioI6p((await loadHook()).useSessionsDefaultFilter)).toEqual(['gone']);
    reload();
    expect(await scenarioI6p((await loadHook(MUTANTS.I6p)).useSessionsDefaultFilter)).toEqual([]);
  });

  it('I8: the unmodified copy drops the notice once the deleted id leaves the condition; showing the saved one regardless keeps it', async () => {
    expect(await scenarioI8((await loadHook()).useSessionsDefaultFilter)).toEqual([]);
    reload();
    expect(await scenarioI8((await loadHook(MUTANTS.I8)).useSessionsDefaultFilter)).toEqual(['gone']);
  });
});
