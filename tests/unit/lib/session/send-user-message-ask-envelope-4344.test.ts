/**
 * The send service types an ask's envelope where M3 says (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.2 M3): after a claimed brief, right
 * before the operator's body. The History row keeps the body alone, and the
 * attempt record knows the text actually typed (`typedContent` recomputed).
 * Without `askEnvelopeId` the typed text is byte for byte as before.
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

import { bindWorld, closeWorld, launch, makeWorld, typed, WT, type World } from './session-brief-4274-harness';
import { entrance, realPort } from './brief-d2-4224-harness';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { formatAskEnvelope, stripAskEnvelope } from '@/lib/ask/envelope';
import { afterDeliveredBrief, normalizeUserTurnContent } from '@/lib/history/user-turn-recorder';
import { getMessages } from '@/lib/db';

const ASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRIEF = /^<<<cmate-brief:[0-9a-f]{8}\n/;

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
});
afterEach(() => {
  closeWorld(world);
});

async function sendAsk(content: string, askEnvelopeId?: string) {
  return sendUserMessage(world.db, {
    worktreeId: WT,
    content,
    cliToolId: 'claude',
    brief: 'auto',
    briefPin: entrance(world, 'claude'),
    ...(askEnvelopeId ? { askEnvelopeId } : {}),
  });
}

describe('sendUserMessage: the ask envelope (Issue #4344, M3)', () => {
  it.each(['hi', 'line one\nline two'])('no brief: the envelope is the first line, the body follows (%j)', async (body) => {
    const result = await sendAsk(body, ASK);
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual([`${formatAskEnvelope(ASK)}\n${body}`]);
    // History keeps the body alone.
    const users = getMessages(world.db, WT, { limit: 10 }).filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).toEqual([body]);
    // The attempt is known by the text typed (`typedContent` recomputed), not by the body.
    expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })?.typedDigest).toBeDefined();
  });

  it.each(['hi', 'line one\nline two'])('with a brief: brief, then the envelope, then the body (%j)', async (body) => {
    realPort(world);
    launch('claude');
    await sendAsk(body, ASK);
    const [text] = typed(world, 'claude');
    expect(text).toMatch(BRIEF);
    expect(text.endsWith(`>>>\n\n${formatAskEnvelope(ASK)}\n${body}`)).toBe(true);
    const stripped = stripAskEnvelope(text);
    expect(stripped?.askId).toBe(ASK);
    expect(afterDeliveredBrief(normalizeUserTurnContent(stripped!.text))).toBe(normalizeUserTurnContent(body));
  });

  it('negative control: without askEnvelopeId the typed text is the body, as before', async () => {
    await sendAsk('hi');
    expect(typed(world, 'claude')).toEqual(['hi']);
    expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })?.typedDigest).toBeUndefined();
  });
});
