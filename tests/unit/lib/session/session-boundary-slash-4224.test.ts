/**
 * Which bodies are commands to the tool (Issue #4224, PM review P2): nothing is put in front
 * of one and the boundary is left for the next send. Any first word starting with `/`
 * (`/plugin:cmd`, `/mcp__srv__prompt`, `/prompts:name`) and any body starting with `!` (a
 * shell escape) — a brief in front would turn the command into plain text. D1's pattern
 * `/^\/[a-z][a-z0-9-]*$/` missed all but the first kind (the controls below fail with it).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hooks = vi.hoisted(() => ({ onOwnership: null as null | (() => void), onPromptGuard: null as null | (() => void) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => {
    const once = hooks.onOwnership;
    hooks.onOwnership = null;
    once?.();
    return { verdict: 'owned', sessionPath: null };
  }),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => {
    const once = hooks.onPromptGuard;
    hooks.onPromptGuard = null;
    once?.();
    return { waiting: false };
  }),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => globalThis.__briefTools?.[id] }) },
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  isSessionRunning: vi.fn(async () => true),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));

import { bindWorld, closeWorld, launch, makeWorld, rows, typed, type World } from './session-brief-4274-harness';
import { entrance, realPort, sendPinned } from './brief-d2-4224-harness';
import { isResetCommandBody, isSlashCommandBody } from '@/lib/session/session-boundary';

const BRIEF = /^<<<cmate-brief:[0-9a-f]{8}\n/;

/** Bodies typed as the tool's commands: never briefed, the row stays pending. */
const COMMANDS = [
  '/model',
  '/review-pr 12',
  '/plugin:cmd args',
  '/mcp__srv__prompt',
  '/prompts:name',
  '/Compact',
  '/clear',
  '  /model',
  '!ls',
  '! git status',
  '!',
];
/** Bodies that are words for the agent: briefed as before. */
const WORDS = ['hello', 'see /model', 'it is done!', '/', ' text with ! inside'];
/** The ones D1's pattern did not take for commands (the positive controls). */
const MISSED_BY_D1 = COMMANDS.filter((body) => !/^\/[a-z][a-z0-9-]*$/.test(body.trim().split(/\s/, 1)[0] ?? ''));

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
});
afterEach(() => {
  closeWorld(world);
});

describe('isSlashCommandBody: the table', () => {
  it.each(COMMANDS)('%j is a command', (body) => {
    expect(isSlashCommandBody(body)).toBe(true);
  });
  it.each(WORDS)('%j is not a command', (body) => {
    expect(isSlashCommandBody(body)).toBe(false);
  });
  it('(control) the table has bodies D1’s pattern missed — the table fails with it', () => {
    expect(MISSED_BY_D1).toEqual(['/plugin:cmd args', '/mcp__srv__prompt', '/prompts:name', '/Compact', '!ls', '! git status', '!']);
  });
  it('the reset commands are unchanged (a reset is still a command, and only the listed words reset)', () => {
    expect(isResetCommandBody('claude', '/clear')).toBe(true);
    expect(isResetCommandBody('claude', '/plugin:clear')).toBe(false);
    expect(isResetCommandBody('codex', '!new')).toBe(false);
  });
});

describe('the send: a command is not briefed and does not consume the boundary', () => {
  it.each(COMMANDS.filter((body) => body !== '/clear'))('%j: typed as it is, the launch row stays pending, the next words are briefed', async (body) => {
    realPort(world);
    launch('claude');
    await sendPinned(world, 'claude', body, entrance(world, 'claude'));
    expect(typed(world, 'claude')).toEqual([body]);
    expect(rows(world, 'claude').filter((row) => row.kind === 'launch')[0]?.state).toBe('pending');
    await sendPinned(world, 'claude', 'hello', entrance(world, 'claude'));
    expect(typed(world, 'claude')[1]).toMatch(BRIEF);
  });

  it('negative: words are briefed on the launch row as before', async () => {
    realPort(world);
    launch('claude');
    await sendPinned(world, 'claude', 'see /model', entrance(world, 'claude'));
    expect(typed(world, 'claude')[0]).toMatch(BRIEF);
    expect(rows(world, 'claude').filter((row) => row.kind === 'launch')[0]?.state).toBe('sent');
  });
});
