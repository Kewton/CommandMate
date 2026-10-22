/**
 * Reading agy's call (`<conversationId>:<stepIdx>`) off its hook bodies
 * (Issue #3820, design `docs/design/auto-yes-measurement-3820.md` §2.1・§2.4,
 * PR 3): the `PreToolUse` the permission route receives, and the
 * `post_tool_use` the relay posts. A body without a numeric `stepIdx` has no
 * call id — read as before.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildHookCallId } from '@/lib/hooks/permission-request-payload';
import {
  parseAntigravityPermissionRequest,
  readAntigravityPermissionCallId,
} from '@/lib/hooks/sources/antigravity/source';
import { readToolCallEndedCallId } from '@/lib/hooks/agent-event-intake';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/antigravity');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

describe('[#3820 PR 3] buildHookCallId', () => {
  it('pairs the conversation with the step', () => {
    expect(buildHookCallId(CONVERSATION, 25)).toBe(`${CONVERSATION}:25`);
    expect(buildHookCallId('c', 0)).toBe('c:0');
  });

  it.each([
    ['a string step', CONVERSATION, '25'],
    ['a negative step', CONVERSATION, -1],
    ['a fractional step', CONVERSATION, 2.5],
    ['an unsafe step', CONVERSATION, Number.MAX_SAFE_INTEGER + 1],
    ['no step', CONVERSATION, undefined],
    ['no conversation', null, 25],
    ['an empty conversation', '', 25],
    ['a conversation that is not an id', 'a b/c', 25],
    ['a long conversation', 'x'.repeat(129), 25],
  ])('has none for %s', (_label, conversationId, stepIdx) => {
    expect(buildHookCallId(conversationId as string | null, stepIdx)).toBeNull();
  });
});

describe('[#3820 PR 3] agy’s PreToolUse', () => {
  it('names the call of the captured fixture', () => {
    expect(readAntigravityPermissionCallId(fixture('pre-tool-use.json'))).toBe(`${CONVERSATION}:16`);
  });

  it('has none for a body without stepIdx, and the parse is the same either way (negative control)', () => {
    const body = fixture('pre-tool-use.json');
    const withoutStep = { ...body };
    delete withoutStep.stepIdx;
    expect(readAntigravityPermissionCallId(withoutStep)).toBeNull();
    expect(readAntigravityPermissionCallId({ ...body, stepIdx: '16' })).toBeNull();
    expect(readAntigravityPermissionCallId(null)).toBeNull();
    expect(parseAntigravityPermissionRequest(withoutStep)).toEqual(parseAntigravityPermissionRequest(body));
    expect(parseAntigravityPermissionRequest(body)).not.toHaveProperty('callId');
  });
});

describe('[#3820 PR 3] the relay’s post_tool_use', () => {
  const relayed = { tool: 'antigravity', event: 'post_tool_use', sessionId: CONVERSATION, detail: 'run_command' };

  it('names the call from the session id and stepIdx', () => {
    expect(readToolCallEndedCallId({ event: 'post_tool_use', sessionId: CONVERSATION }, { ...relayed, stepIdx: 25 })).toBe(
      `${CONVERSATION}:25`
    );
  });

  it('falls back to agy’s own conversationId when no session id was read', () => {
    expect(
      readToolCallEndedCallId({ event: 'post_tool_use', sessionId: undefined }, { conversationId: CONVERSATION, stepIdx: 25 })
    ).toBe(`${CONVERSATION}:25`);
  });

  it('has none for the old body, another event, or a non-numeric step', () => {
    expect(readToolCallEndedCallId({ event: 'post_tool_use', sessionId: CONVERSATION }, relayed)).toBeNull();
    expect(readToolCallEndedCallId({ event: 'stop', sessionId: CONVERSATION }, { ...relayed, stepIdx: 25 })).toBeNull();
    expect(readToolCallEndedCallId({ event: 'post_tool_use', sessionId: CONVERSATION }, { ...relayed, stepIdx: '25' })).toBeNull();
  });
});
