/**
 * A late poll answer must not put an old value back, for what the detail poll carries
 * beside the roster (Issue #4145, after #4133's roster), and the poll rests while the
 * tab is hidden.
 *
 * Positive controls: every "old answer" test and the hidden tests fail on the code
 * before this Issue. Negative controls: answers in order, reads made after a save, a
 * newer failed request and visible ticks all behave as they did.
 *
 * An operation of worktree A that finishes after the switch to B changes nothing of B.
 * The screen is one controller instance with a new id (page.tsx sets no key), so what A
 * captured is still running, and a save's generation or a read's sequence is shared.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4145',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast: vi.fn() }) };
});

import {
  AUTO_YES_CONTRACT_REFRESH_MS,
  useWorktreeDetailController,
} from '@/hooks/useWorktreeDetailController';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-4145';
const OTHER_WORKTREE_ID = 'wt-other';

function jsonReply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const worktreeBody = (overrides: Record<string, unknown> = {}, id = WORKTREE_ID): unknown => ({
  id,
  name: 'feature/4145',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  status: 'in_progress',
  ...overrides,
});

interface Stub {
  /** Worktree GETs, in the order they left, waiting for the test to answer them. */
  details: Array<(reply: Response) => void>;
  /** Likewise `/current-output`, when `holdOutput` is on. */
  outputs: Array<(reply: Response) => void>;
  /** Likewise the kill and the Auto-Yes POST, when held. */
  kills: Array<(reply: Response) => void>;
  autoYesPosts: Array<(reply: Response) => void>;
  calls: string[];
}

function stubFetch(options: {
  holdOutput?: boolean;
  holdKill?: boolean;
  holdAutoYesPost?: boolean;
  autoYesInstances?: Record<string, unknown>;
} = {}): Stub {
  const stub: Stub = { details: [], outputs: [], kills: [], autoYesPosts: [], calls: [] };
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    stub.calls.push(url);
    if (url.includes('/current-output')) {
      if (options.holdOutput) return new Promise<Response>((resolve) => stub.outputs.push(resolve));
      return Promise.resolve(jsonReply(200, { isRunning: false }));
    }
    if (url.includes('/messages')) return Promise.resolve(jsonReply(200, []));
    if (url.includes('/kill-session')) {
      if (options.holdKill) return new Promise<Response>((resolve) => stub.kills.push(resolve));
      return Promise.resolve(jsonReply(200, { success: true, message: 'ok' }));
    }
    if (url.includes('/auto-yes')) {
      if (init?.method === 'POST') {
        if (options.holdAutoYesPost) return new Promise<Response>((resolve) => stub.autoYesPosts.push(resolve));
        return Promise.resolve(jsonReply(200, { enabled: true, expiresAt: 123 }));
      }
      return Promise.resolve(jsonReply(200, { instances: options.autoYesInstances ?? {} }));
    }
    if (/\/api\/worktrees\/[^/?]+$/.test(url)) {
      return new Promise<Response>((resolve) => stub.details.push(resolve));
    }
    return Promise.resolve(jsonReply(404, {}));
  }) as unknown as typeof fetch;
  return stub;
}

async function mounted(options: Parameters<typeof stubFetch>[0] = {}) {
  const stub = stubFetch(options);
  const hook = renderHook(
    ({ worktreeId }) => useWorktreeDetailController({ worktreeId }),
    { initialProps: { worktreeId: WORKTREE_ID } },
  );
  await waitFor(() => expect(stub.details).toHaveLength(1));
  return { ...hook, stub };
}

type Hook = Awaited<ReturnType<typeof mounted>>;

/** Leave one more worktree GET, unanswered. */
async function issueAnother(hook: Hook): Promise<void> {
  const before = hook.stub.details.length;
  void act(() => {
    void hook.result.current.handleRetry();
  });
  await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
}

async function settle(resolve: (reply: Response) => void, reply: Response): Promise<void> {
  await act(async () => {
    resolve(reply);
    await new Promise((done) => setTimeout(done, 0));
  });
}

const answer = (hook: Hook, index: number, reply: Response): Promise<void> =>
  settle(hook.stub.details[index], reply);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // A roster answer moves the active instance, and that is saved per worktree.
  window.localStorage.clear();
});

describe('[#4145] what the detail poll carries beside the roster', () => {
  it('two reads crossing: the older answer does not put back the record or what came with it', async () => {
    const hook = await mounted();
    await issueAnother(hook);
    await answer(hook, 1, jsonReply(200, worktreeBody({
      name: 'newer',
      sessionStatusByCli: { claude: { isRunning: false } },
      selectedAgents: ['claude', 'codex'],
      vibeLocalModel: 'newer-model',
      vibeLocalContextWindow: 2048,
    })));
    await answer(hook, 0, jsonReply(200, worktreeBody({
      name: 'older',
      sessionStatusByCli: { claude: { isRunning: true } },
      selectedAgents: ['gemini', 'opencode'],
      vibeLocalModel: 'older-model',
      vibeLocalContextWindow: 1024,
    })));
    const current = hook.result.current;
    expect(current.worktree?.name).toBe('newer');
    expect(current.worktree?.sessionStatusByCli?.claude?.isRunning).toBe(false);
    expect(current.selectedAgents).toEqual(['claude', 'codex']);
    expect(current.vibeLocalModel).toBe('newer-model');
    expect(current.vibeLocalContextWindow).toBe(2048);
  });

  it('answers in order are all taken (negative control)', async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'first', vibeLocalModel: 'first-model' })));
    expect(hook.result.current.worktree?.name).toBe('first');
    await issueAnother(hook);
    await answer(hook, 1, jsonReply(200, worktreeBody({ name: 'second', vibeLocalModel: 'second-model' })));
    expect(hook.result.current.worktree?.name).toBe('second');
    expect(hook.result.current.vibeLocalModel).toBe('second-model');
  });

  it('a newer request that failed does not throw away the older answer (negative control)', async () => {
    const hook = await mounted();
    await issueAnother(hook);
    await answer(hook, 1, jsonReply(500, {}));
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'older' })));
    expect(hook.result.current.worktree?.name).toBe('older');
  });

  it('a read from before Info saved, answered after it: the saved record stays', async () => {
    const hook = await mounted();
    act(() => hook.result.current.setWorktree(worktreeBody({ name: 'saved' }) as Worktree));
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'from before' })));
    expect(hook.result.current.worktree?.name).toBe('saved');
  });

  it('a read made after Info saved is taken: another client may have changed it since (negative control)', async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'first' })));
    act(() => hook.result.current.setWorktree(worktreeBody({ name: 'saved' }) as Worktree));
    await issueAnother(hook);
    await answer(hook, 1, jsonReply(200, worktreeBody({ name: 'elsewhere' })));
    expect(hook.result.current.worktree?.name).toBe('elsewhere');
  });

  it.each([
    ['model', 'handleVibeLocalModelChange', 'vibeLocalModel', 'saved-model'],
    ['context window', 'handleVibeLocalContextWindowChange', 'vibeLocalContextWindow', 4096],
  ] as const)('a read from before the vibe-local %s was saved: the saved value stays', async (_label, handler, field, saved) => {
    const hook = await mounted();
    act(() => (hook.result.current[handler] as (value: unknown) => void)(saved));
    await answer(hook, 0, jsonReply(200, worktreeBody({ vibeLocalModel: 'from before', vibeLocalContextWindow: 1 })));
    expect(hook.result.current[field]).toBe(saved);
  });

  it('a save of one thing leaves the rest of the answer alone (negative control)', async () => {
    const hook = await mounted();
    act(() => hook.result.current.handleVibeLocalModelChange('saved-model'));
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'record', selectedAgents: ['claude', 'codex'] })));
    expect(hook.result.current.worktree?.name).toBe('record');
    expect(hook.result.current.selectedAgents).toEqual(['claude', 'codex']);
  });

  it("the previous worktree's answer does not land on this worktree's screen", async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    await issueAnother(hook);
    const leftForA = hook.stub.details.length - 1;
    const before = hook.stub.details.length;
    hook.rerender({ worktreeId: OTHER_WORKTREE_ID });
    await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
    await answer(hook, leftForA, jsonReply(200, worktreeBody({ name: 'A, late', vibeLocalModel: 'A-model' })));
    expect(hook.result.current.worktree?.name).toBe('A');
    expect(hook.result.current.vibeLocalModel).toBeNull();
    await answer(hook, before, jsonReply(200, worktreeBody({ name: 'B' }, OTHER_WORKTREE_ID)));
    expect(hook.result.current.worktree?.id).toBe(OTHER_WORKTREE_ID);
  });

  it('late failures of requests older than an answer taken do not raise the stale banner', async () => {
    const hook = await mounted();
    await issueAnother(hook);
    await issueAnother(hook);
    await issueAnother(hook);
    await answer(hook, 3, jsonReply(200, worktreeBody({ name: 'newest' })));
    await answer(hook, 0, jsonReply(500, {}));
    await answer(hook, 1, jsonReply(500, {}));
    await answer(hook, 2, jsonReply(500, {}));
    expect(hook.result.current.isReconnecting).toBe(false);
  });

  it('three failures after the last answer taken still raise it (negative control)', async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody()));
    await issueAnother(hook);
    await issueAnother(hook);
    await issueAnother(hook);
    for (let i = 1; i <= 3; i += 1) {
      await answer(hook, i, jsonReply(500, {}));
    }
    expect(hook.result.current.isReconnecting).toBe(true);
  });
});

describe('[#4145] a current-output answer from before a local change', () => {
  const armedOff = { isRunning: true, autoYes: { enabled: false, expiresAt: null } };

  it('from before an Auto-Yes toggle: it does not turn the toggle back', async () => {
    const hook = await mounted({ holdOutput: true, autoYesInstances: { claude: { enabled: true, expiresAt: 123 } } });
    await act(async () => {
      await hook.result.current.makeAutoYesToggleHandler('claude')({ enabled: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(hook.result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
    await settle(hook.stub.outputs[0], jsonReply(200, armedOff));
    expect(hook.result.current.autoYesStateMap.get('claude')?.enabled).toBe(true);
  });

  it('left after the toggle: it is taken, the server may have turned it off (negative control)', async () => {
    const hook = await mounted({ holdOutput: true, autoYesInstances: { claude: { enabled: true, expiresAt: 123 } } });
    await act(async () => {
      await hook.result.current.makeAutoYesToggleHandler('claude')({ enabled: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    await act(async () => {
      void hook.result.current.fetchCurrentOutput();
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle(hook.stub.outputs[hook.stub.outputs.length - 1], jsonReply(200, armedOff));
    expect(hook.result.current.autoYesStateMap.get('claude')?.enabled).toBe(false);
  });

  const promptAnswer = {
    isRunning: true,
    isPromptWaiting: true,
    promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
  };

  it('from before the session was ended: the prompt of the ended session does not come back', async () => {
    const hook = await mounted({ holdOutput: true });
    await answer(hook, 0, jsonReply(200, worktreeBody()));
    act(() => hook.result.current.openActiveKillConfirm());
    await act(async () => {
      const killed = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
      hook.stub.details[hook.stub.details.length - 1](jsonReply(200, worktreeBody()));
      await killed;
    });
    await settle(hook.stub.outputs[0], jsonReply(200, promptAnswer));
    expect(hook.result.current.state.prompt.visible).toBe(false);
  });

  it('no session was ended: the same answer shows its prompt (negative control)', async () => {
    const hook = await mounted({ holdOutput: true });
    await settle(hook.stub.outputs[0], jsonReply(200, promptAnswer));
    expect(hook.result.current.state.prompt.visible).toBe(true);
  });
});

describe('[#4145] an operation from before a worktree switch, finishing after it', () => {
  const OK = { success: true, message: 'ok' };
  const promptAnswer = {
    isRunning: true,
    isPromptWaiting: true,
    promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
  };
  const askedForA = (hook: Hook, part: string) =>
    hook.stub.calls.filter((url) => url.includes(`/api/worktrees/${WORKTREE_ID}${part}`));

  /** On A, answered, then moved to B with B's GET still unanswered. Returns that GET's index. */
  async function switched(hook: Hook, beforeSwitch: () => void = () => {}): Promise<number> {
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    beforeSwitch();
    const before = hook.stub.details.length;
    hook.rerender({ worktreeId: OTHER_WORKTREE_ID });
    await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
    return before;
  }
  const answerB = (hook: Hook, index: number, overrides: Record<string, unknown> = {}) =>
    answer(hook, index, jsonReply(200, worktreeBody({ name: 'B', ...overrides }, OTHER_WORKTREE_ID)));

  it("A's Info save answered after the switch: not on B's screen, and B's read is not thrown away", async () => {
    const hook = await mounted();
    const forB = await switched(hook);
    act(() => hook.result.current.setWorktree(worktreeBody({ name: 'A saved' }) as Worktree));
    expect(hook.result.current.worktree?.name).not.toBe('A saved');
    await answerB(hook, forB);
    expect(hook.result.current.worktree?.id).toBe(OTHER_WORKTREE_ID);
    expect(hook.result.current.worktree?.name).toBe('B');
  });

  it("A's vibe-local save answered after the switch: B's read decides", async () => {
    const hook = await mounted();
    let saveModelForA = hook.result.current.handleVibeLocalModelChange;
    let saveWindowForA = hook.result.current.handleVibeLocalContextWindowChange;
    const forB = await switched(hook, () => {
      saveModelForA = hook.result.current.handleVibeLocalModelChange;
      saveWindowForA = hook.result.current.handleVibeLocalContextWindowChange;
    });
    act(() => {
      saveModelForA('A-model');
      saveWindowForA(1);
    });
    expect(hook.result.current.vibeLocalModel).not.toBe('A-model');
    await answerB(hook, forB, { vibeLocalModel: 'B-model', vibeLocalContextWindow: 2 });
    expect(hook.result.current.vibeLocalModel).toBe('B-model');
    expect(hook.result.current.vibeLocalContextWindow).toBe(2);
  });

  it("A's roster save answered after the switch: not on B's screen, and B's read is not thrown away", async () => {
    const hook = await mounted();
    let saveRosterForA = hook.result.current.handleAgentInstancesChange;
    const forB = await switched(hook, () => {
      saveRosterForA = hook.result.current.handleAgentInstancesChange;
    });
    act(() => saveRosterForA([{ id: 'a-only', cliTool: 'claude', alias: 'A only', order: 0 }]));
    expect(hook.result.current.agentInstances.map((row) => row.id)).not.toContain('a-only');
    await answerB(hook, forB, { agentInstances: [{ id: 'b-only', cliTool: 'codex', alias: 'B only', order: 0 }] });
    expect(hook.result.current.agentInstances.map((row) => row.id)).toEqual(['b-only']);
  });

  it("A's kill sent, then the switch: B's prompt and B's own kill dialog stay, no GET for A", async () => {
    const hook = await mounted({ holdOutput: true, holdKill: true });
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    act(() => hook.result.current.openActiveKillConfirm());
    let killing: Promise<void> = Promise.resolve();
    await act(async () => {
      killing = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(hook.stub.kills).toHaveLength(1);

    const before = hook.stub.details.length;
    hook.rerender({ worktreeId: OTHER_WORKTREE_ID });
    await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
    await answerB(hook, before);
    await settle(hook.stub.outputs[hook.stub.outputs.length - 1], jsonReply(200, promptAnswer));
    act(() => hook.result.current.openActiveKillConfirm());
    const askedAfterSwitch = hook.stub.details.length;
    hook.stub.calls.length = 0;

    await act(async () => {
      hook.stub.kills[0](jsonReply(200, OK));
      await killing;
    });
    expect(hook.result.current.state.prompt.visible).toBe(true);
    expect(hook.stub.details.length).toBe(askedAfterSwitch);
    expect(askedForA(hook, '')).toEqual([]);
    expect(hook.result.current.worktree?.id).toBe(OTHER_WORKTREE_ID);
    expect(hook.result.current.killTarget).not.toBeNull();
  });

  it("A's kill refused after the switch: nothing is left to retry against B", async () => {
    const hook = await mounted({ holdKill: true });
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    act(() => hook.result.current.openActiveKillConfirm());
    let killing: Promise<void> = Promise.resolve();
    await act(async () => {
      killing = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
    });
    const before = hook.stub.details.length;
    hook.rerender({ worktreeId: OTHER_WORKTREE_ID });
    await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
    await act(async () => {
      hook.stub.kills[0](jsonReply(500, {}));
      await killing;
    });
    expect(hook.result.current.killTarget).toBeNull();
  });

  it('a kill dialog left open does not survive the switch: confirming it would end B\'s session', async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    act(() => hook.result.current.openActiveKillConfirm());
    expect(hook.result.current.killTarget).not.toBeNull();
    hook.rerender({ worktreeId: OTHER_WORKTREE_ID });
    await waitFor(() => expect(hook.result.current.killTarget).toBeNull());
  });

  it("a GET A's code issues after the switch is not taken, and its failures do not count on B", async () => {
    const hook = await mounted();
    let retryForA = hook.result.current.handleRetry;
    const forB = await switched(hook, () => {
      retryForA = hook.result.current.handleRetry;
    });
    await answerB(hook, forB);

    const late = hook.stub.details.length;
    hook.stub.calls.length = 0;
    await act(async () => {
      void retryForA();
      await new Promise((done) => setTimeout(done, 0));
    });
    await answer(hook, late, jsonReply(200, worktreeBody({ name: 'A, late', vibeLocalModel: 'A-model' })));
    expect(hook.result.current.worktree?.name).toBe('B');
    expect(hook.result.current.vibeLocalModel).toBeNull();
    expect(askedForA(hook, '/messages')).toEqual([]);

    const failing = hook.stub.details.length;
    await act(async () => {
      void retryForA();
      void retryForA();
      void retryForA();
      await new Promise((done) => setTimeout(done, 0));
    });
    for (let i = 0; i < 3; i += 1) {
      await answer(hook, failing + i, jsonReply(500, {}));
    }
    expect(hook.result.current.isReconnecting).toBe(false);
  });

  it("A's Auto-Yes toggle answered after the switch: B's map is left alone", async () => {
    const hook = await mounted({ holdAutoYesPost: true });
    let toggleForA = hook.result.current.makeAutoYesToggleHandler('claude');
    const forB = await switched(hook, () => {
      toggleForA = hook.result.current.makeAutoYesToggleHandler('claude');
    });
    await answerB(hook, forB);
    let toggling: Promise<void> = Promise.resolve();
    await act(async () => {
      toggling = toggleForA({ enabled: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    hook.stub.calls.length = 0;
    await act(async () => {
      hook.stub.autoYesPosts[0](jsonReply(200, { enabled: true, expiresAt: 123 }));
      await toggling;
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(hook.result.current.autoYesStateMap.get('claude')?.enabled).not.toBe(true);
    expect(askedForA(hook, '/auto-yes')).toEqual([]);
  });

  it("a current-output read A's code asks for after the switch does not leave", async () => {
    const hook = await mounted({ holdOutput: true });
    let readForA = hook.result.current.fetchCurrentOutput;
    const forB = await switched(hook, () => {
      readForA = hook.result.current.fetchCurrentOutput;
    });
    await answerB(hook, forB);
    const waitingForB = hook.stub.outputs[hook.stub.outputs.length - 1];
    hook.stub.calls.length = 0;
    await act(async () => {
      await readForA();
    });
    expect(askedForA(hook, '/current-output')).toEqual([]);
    // Nor did it retire what B is waiting for.
    await settle(waitingForB, jsonReply(200, promptAnswer));
    expect(hook.result.current.state.prompt.visible).toBe(true);
  });

  it('no switch: a save, then a read made after it, is taken (negative control)', async () => {
    const hook = await mounted();
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'first' })));
    act(() => {
      hook.result.current.setWorktree(worktreeBody({ name: 'saved' }) as Worktree);
      hook.result.current.handleVibeLocalModelChange('saved-model');
      hook.result.current.handleAgentInstancesChange([{ id: 'saved', cliTool: 'claude', alias: 'Saved', order: 0 }]);
    });
    expect(hook.result.current.worktree?.name).toBe('saved');
    expect(hook.result.current.vibeLocalModel).toBe('saved-model');
    expect(hook.result.current.agentInstances.map((row) => row.id)).toEqual(['saved']);
    await issueAnother(hook);
    await answer(hook, 1, jsonReply(200, worktreeBody({
      name: 'elsewhere',
      vibeLocalModel: 'elsewhere-model',
      agentInstances: [{ id: 'elsewhere', cliTool: 'codex', alias: 'Elsewhere', order: 0 }],
    })));
    expect(hook.result.current.worktree?.name).toBe('elsewhere');
    expect(hook.result.current.vibeLocalModel).toBe('elsewhere-model');
    expect(hook.result.current.agentInstances.map((row) => row.id)).toEqual(['elsewhere']);
  });

  it('no switch: a kill clears the prompt, reads again and closes the dialog (negative control)', async () => {
    const hook = await mounted({ holdOutput: true, holdKill: true });
    await answer(hook, 0, jsonReply(200, worktreeBody({ name: 'A' })));
    await settle(hook.stub.outputs[0], jsonReply(200, promptAnswer));
    act(() => hook.result.current.openActiveKillConfirm());
    const asked = hook.stub.details.length;
    await act(async () => {
      const killing = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
      hook.stub.kills[0](jsonReply(200, OK));
      await new Promise((done) => setTimeout(done, 0));
      hook.stub.details[asked](jsonReply(200, worktreeBody({ name: 'A, re-read' })));
      await killing;
    });
    expect(hook.result.current.state.prompt.visible).toBe(false);
    expect(hook.result.current.worktree?.name).toBe('A, re-read');
    expect(hook.result.current.killTarget).toBeNull();
  });

  it("back on A before A's save is answered: it is A's, and it is taken (negative control)", async () => {
    const hook = await mounted();
    await switched(hook);
    const before = hook.stub.details.length;
    hook.rerender({ worktreeId: WORKTREE_ID });
    await waitFor(() => expect(hook.stub.details.length).toBe(before + 1));
    act(() => hook.result.current.setWorktree(worktreeBody({ name: 'A saved' }) as Worktree));
    expect(hook.result.current.worktree?.name).toBe('A saved');
    await answer(hook, before, jsonReply(200, worktreeBody({ name: 'from before' })));
    expect(hook.result.current.worktree?.name).toBe('A saved');
  });
});

describe('[#4145] the parent poll while the tab is hidden', () => {
  const IDLE_TICK_MS = 5000;
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  }

  afterEach(() => {
    if (originalVisibility) {
      Object.defineProperty(document, 'visibilityState', originalVisibility);
    } else {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  /** Loaded, with its fetch history cleared and only the interval's clock in the test's hands. */
  async function loaded(options: Parameters<typeof stubFetch>[0] = {}): Promise<Hook> {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hook = await mounted(options);
    await answer(hook, 0, jsonReply(200, worktreeBody()));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
    hook.stub.calls.length = 0;
    return hook;
  }

  const tick = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  const askedAbout = (hook: Hook, part: string) => hook.stub.calls.filter((url) => url.includes(part));

  it('visible: every tick asks (negative control)', async () => {
    const hook = await loaded();
    await tick(IDLE_TICK_MS);
    expect(askedAbout(hook, '/current-output')).toHaveLength(1);
    expect(hook.stub.calls.filter((url) => url.endsWith(`/api/worktrees/${WORKTREE_ID}`))).toHaveLength(1);
  });

  it('hidden: no tick asks anything', async () => {
    const hook = await loaded();
    setVisibility('hidden');
    await tick(IDLE_TICK_MS * 3);
    expect(hook.stub.calls).toEqual([]);
  });

  it('back: the visibilitychange reads at once, and the ticks go on', async () => {
    const hook = await loaded();
    setVisibility('hidden');
    await tick(IDLE_TICK_MS);
    expect(hook.stub.calls).toEqual([]);

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(askedAbout(hook, '/current-output')).toHaveLength(1);
    expect(askedAbout(hook, '/messages')).toHaveLength(1);
    expect(hook.stub.calls.filter((url) => url.endsWith(`/api/worktrees/${WORKTREE_ID}`))).toHaveLength(1);

    hook.stub.calls.length = 0;
    await tick(IDLE_TICK_MS);
    expect(askedAbout(hook, '/current-output')).toHaveLength(1);
  });

  it("the Auto-Yes map's re-read rests too, and comes back", async () => {
    const hook = await loaded({ autoYesInstances: { claude: { enabled: true, expiresAt: 999 } } });
    await waitFor(() => expect(hook.result.current.autoYesEnabled).toBe(true));
    hook.stub.calls.length = 0;
    setVisibility('hidden');
    await tick(AUTO_YES_CONTRACT_REFRESH_MS);
    expect(askedAbout(hook, '/auto-yes')).toEqual([]);

    setVisibility('visible');
    await tick(AUTO_YES_CONTRACT_REFRESH_MS);
    expect(askedAbout(hook, '/auto-yes')).toHaveLength(1);
  });
});
