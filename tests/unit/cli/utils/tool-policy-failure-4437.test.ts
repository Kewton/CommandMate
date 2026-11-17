/**
 * Issue #4437 PR2: the tool policy's 409 as exit 33 (I7), and nothing else as 33.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_POLICY_DENIAL_EXITS,
  ToolPolicyDeniedError,
  formatToolPolicyDenialLines,
  isToolPolicyDenied,
  toolPolicyDenialFromResponse,
  toolPolicyRefusalJson,
} from '../../../../src/cli/utils/tool-policy-failure';
import { ApiError } from '../../../../src/cli/utils/api-client';
import { RoleExitCode, StrictRespondExitCode, ToolPolicyExitCode } from '../../../../src/cli/types';
import {
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_URL,
  RELAY_TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
  decideToolPolicy,
  formatToolPolicyDenial,
} from '../../../../src/lib/tool-policy/policy';

const UNLOCK = 'Set CM_ANTIGRAVITY_USAGE=api-key (or CM_ANTIGRAVITY_USAGE=enterprise) on the server and restart it, if you use Antigravity with an API key or an enterprise plan.';

const POLICY = {
  tool: 'antigravity',
  operation: 'send',
  origin: 'session',
  reason: 'ANTIGRAVITY_CONSUMER_TERMS',
  declaration: 'personal',
  links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
  unlock: UNLOCK,
};

const SEND_409 = { error: TOOL_POLICY_DENIED_MESSAGE, code: TOOL_POLICY_DENIED, policy: POLICY, sendOutcome: 'not_sent' };
const RELAY_409 = {
  error: TOOL_POLICY_DENIED_MESSAGE,
  code: RELAY_TOOL_POLICY_DENIED,
  policy: { ...POLICY, operation: 'relay', origin: 'relay', endpoint: 'to' },
};

describe('the two codes map to exit 33 (I7)', () => {
  it('33 is ToolPolicyExitCode.DENIED, apart from the role\'s 32 and the strict respond\'s 40 / 41', () => {
    expect(TOOL_POLICY_DENIAL_EXITS).toEqual({ TOOL_POLICY_DENIED: 33, RELAY_TOOL_POLICY_DENIED: 33 });
    expect(ToolPolicyExitCode.DENIED).toBe(33);
    expect(RoleExitCode.NOT_SENT).toBe(32);
    expect(StrictRespondExitCode.NOT_SENT).toBe(40);
  });

  it.each([[SEND_409], [RELAY_409]])('409 %#: a ToolPolicyDeniedError with exit 33, not an ApiError', (payload) => {
    const error = toolPolicyDenialFromResponse(409, payload, { instanceId: 'antigravity', cliToolId: 'antigravity' });
    expect(error).toBeInstanceOf(ToolPolicyDeniedError);
    expect(isToolPolicyDenied(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error?.exitCode).toBe(33);
    expect(error?.sent).toBe(false);
    expect(error?.code).toBe(payload.code);
    expect(error?.request).toEqual({ instanceId: 'antigravity', cliToolId: 'antigravity' });
  });

  it.each([
    ['the role\'s 409', 409, { error: 'x', code: 'ROLE_CONDITION_UNMET', sendOutcome: 'not_sent' }],
    ['PROMPT_WAITING', 409, { error: 'x', code: 'PROMPT_WAITING' }],
    ['a relay chain refusal', 409, { error: 'x', code: 'RELAY_CHAIN_BLOCKED' }],
    ['the bind conflict', 409, { error: 'x', code: 'RELAY_BIND_CONFLICT' }],
    ['the code on a 403', 403, SEND_409],
    ['the code on a 500', 500, SEND_409],
    ['no body', 409, undefined],
  ])('negative control — %s is not this refusal', (_label, status, payload) => {
    expect(toolPolicyDenialFromResponse(status, payload)).toBeNull();
  });
});

describe('what stderr says (I7, I8)', () => {
  it('line 1 is the reason as `Error [<code>]: <sentence>`, line 2 the terms and the FAQ', () => {
    const lines = formatToolPolicyDenialLines(toolPolicyDenialFromResponse(409, SEND_409)!);
    const decision = decideToolPolicy({ tool: 'antigravity', operation: 'send', origin: 'session', declaration: 'personal' });
    expect(lines[0]).toBe(`Error [TOOL_POLICY_DENIED]: ${formatToolPolicyDenial(decision, 'en').split('\n')[0]}`);
    expect(lines[0]).toContain('nothing was typed');
    expect(lines[1]).toContain(ANTIGRAVITY_TERMS_URL);
    expect(lines[1]).toContain(ANTIGRAVITY_FAQ_URL);
    expect(lines[2]).toBe(`To lift it: ${UNLOCK}`);
    expect(lines[3]).toContain('sent: false');
    expect(lines[3]).toContain('origin=session');
    expect(lines.join('\n')).not.toMatch(/safe to send it again/);
  });

  it('a relay names its refused end; a body without policy still gets the shared sentence and links', () => {
    const relay = formatToolPolicyDenialLines(toolPolicyDenialFromResponse(409, RELAY_409)!);
    expect(relay[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
    expect(relay[3]).toContain('The relay was not opened');
    expect(relay[3]).toContain('`to` end');
    const bare = formatToolPolicyDenialLines(toolPolicyDenialFromResponse(409, { code: TOOL_POLICY_DENIED })!);
    expect(bare[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: CommandMate did not run this/);
    expect(bare[1]).toContain(ANTIGRAVITY_TERMS_URL);
    expect(bare[2]).toContain('CM_ANTIGRAVITY_USAGE=api-key');
  });
});

describe('the --json refusal (design §3.4)', () => {
  it('names the target, sent: false and the refusal', () => {
    const error = toolPolicyDenialFromResponse(409, { ...SEND_409, policy: { ...POLICY, operation: 'ask' } })!;
    expect(toolPolicyRefusalJson(error, 'wt-1', { instanceId: 'antigravity', cliToolId: 'antigravity' })).toEqual({
      worktreeId: 'wt-1',
      instanceId: 'antigravity',
      cliToolId: 'antigravity',
      sent: false,
      refusal: {
        code: 'TOOL_POLICY_DENIED',
        reason: 'ANTIGRAVITY_CONSUMER_TERMS',
        operation: 'ask',
        origin: 'session',
        message: formatToolPolicyDenialLines(error)[0].replace('Error [TOOL_POLICY_DENIED]: ', ''),
        links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
        unlock: UNLOCK,
      },
    });
  });

  it('with no target of the command\'s own, the refused request\'s; a relay carries its end', () => {
    const error = toolPolicyDenialFromResponse(409, RELAY_409, { from: {}, to: {} })!;
    const json = toolPolicyRefusalJson(error, 'wt-1');
    expect(json).toMatchObject({ instanceId: null, cliToolId: 'antigravity', sent: false });
    expect(json.refusal).toMatchObject({ code: 'RELAY_TOOL_POLICY_DENIED', operation: 'relay', endpoint: 'to' });
  });
});
