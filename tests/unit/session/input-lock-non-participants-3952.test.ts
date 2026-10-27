/**
 * Issue #3952: the input paths that stay OUT of the instance input lock, by
 * decision.
 *
 * - interrupt (Escape): never waits for a send, never joins, never invalidates.
 *   Waiting would delay the stop behind the very send it may be meant to stop;
 *   invalidating would turn a send whose body is partly typed into
 *   `input-lock-lost` (a wrong "nothing was typed"). The window this leaves —
 *   an Escape that lands while a body is being typed — is documented
 *   (cli-operations-guide, module-reference).
 * - a person's input — WebSocket `terminal_input`, `direct-input`,
 *   `special-keys` (the unsent bar's Run among them): neither refused nor held.
 *   What is typed while a send is in progress may be mixed into it or removed
 *   by its clean-up; the guide says so.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const events = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  sendSpecialKey: vi.fn(async (_s: string, key: string) => {
    events.list.push(`special:${key}`);
  }),
  sendDirectInputAndInvalidate: vi.fn(async () => {
    events.list.push('direct-input');
  }),
}));

import { CodexTool } from '@/lib/cli-tools/codex';
import { sendDirectInput } from '@/lib/cli-tools/direct-input';
import {
  currentInstanceInputTicket,
  resetInstanceInputLocks,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A send holding `session`'s composer until `release`; its ticket once admitted. */
function holdSend(session: string): {
  release: () => void;
  done: Promise<void>;
  ticket: () => InstanceInputTicket | null;
} {
  let release!: () => void;
  let held: InstanceInputTicket | null = null;
  const done = withInstanceInputLock(session, async (ticket) => {
    held = ticket;
    events.list.push('<send>');
    await new Promise<void>((resolve) => (release = resolve));
  });
  return { release: () => release(), done, ticket: () => held };
}

beforeEach(() => {
  events.list = [];
  resetInstanceInputLocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

describe('[#3952] interrupt does not wait for, join or end a send in progress', () => {
  it('the Escape goes out at once and the send keeps its ticket', async () => {
    const tool = new CodexTool();
    const session = tool.getSessionName('wt-3952');
    const held = holdSend(session);
    await flush();
    await tool.interrupt('wt-3952');
    expect(events.list).toEqual(['<send>', 'special:Escape']);
    expect(held.ticket()!.isCurrent()).toBe(true);
    held.release();
    await held.done;
  });

  it('pinned in the source: interrupt neither takes the lock nor invalidates it', () => {
    const base = read('src/lib/cli-tools/base.ts');
    const body = base.slice(base.indexOf('async interrupt('), base.indexOf('describeComposer(): ComposerSpec'));
    expect(body).toContain("sendSpecialKey(sessionName, 'Escape')");
    expect(body).not.toMatch(/withInstanceInputLock|invalidateInstanceInput|answerUnderInstanceInputLock/);
    expect(read('src/app/api/worktrees/[id]/interrupt/route.ts')).not.toMatch(/instance-input-lock/);
  });
});

describe('[#3952] a person’s input is neither refused nor held', () => {
  it('direct-input reaches the pane while a send holds the composer', async () => {
    const held = holdSend('mcbd-claude-wt-3952');
    await flush();
    await expect(sendDirectInput('claude', 'wt-3952', [{ type: 'text', text: 'x' }])).resolves.toBe('sent');
    expect(events.list).toEqual(['<send>', 'direct-input']);
    expect(currentInstanceInputTicket('mcbd-claude-wt-3952')).toBeNull();
    held.release();
    await held.done;
  });

  it.each([
    ['WebSocket terminal_input', 'src/lib/ws-server.ts'],
    ['direct-input', 'src/lib/cli-tools/direct-input.ts'],
    ['direct-input route', 'src/app/api/worktrees/[id]/direct-input/route.ts'],
    ['special-keys route (the unsent bar’s Run)', 'src/app/api/worktrees/[id]/special-keys/route.ts'],
  ])('pinned in the source: %s does not use the input lock', (_label, file) => {
    expect(read(file)).not.toMatch(/instance-input-lock/);
  });

  it('the guide says so, in both languages', () => {
    expect(read('docs/user-guide/cli-operations-guide.md')).toContain('入力ロック（#3952）');
    expect(read('docs/en/user-guide/cli-operations-guide.md')).toContain('input lock (#3952)');
  });
});
