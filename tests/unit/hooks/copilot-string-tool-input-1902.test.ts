/**
 * Copilot's string `tool_input` (Issue #1902).
 *
 * Copilot 1.0.80's `Edit` sends its apply-patch envelope as a **bare string**,
 * and `parseCopilotPermissionRequest` required a plain object. So the parse
 * answered null, null became `unknown-payload`, `unknown-payload` is a
 * no-decision, and every file edit copilot made drew a dialog no matter what
 * Auto-Yes or the contract said — while `Read` and `Bash`, whose `tool_input`
 * is an object, were adjudicated normally. The failure therefore looked like
 * "Auto-Yes works, except for edits", and the screen-scraping poller answered
 * the dialog two to four seconds later, which is why it was survivable at all.
 *
 * Three things are pinned here, and each one has a mutation that kills it:
 *
 *  1. **The Issue's raw payload is allowed**, and the object-shaped payloads it
 *     is contrasted against are allowed by the *same* case. Restoring
 *     `if (!isPlainObject(body.tool_input)) return null;` takes the string rows
 *     of that case red and leaves the object rows green — the exact signature
 *     of the bug.
 *  2. **Where the deny patterns are applied.** To the envelope's action headers
 *     (`*** Add File: note4.txt`), never to the hunk bodies. Both directions are
 *     asserted: a pattern naming the path suppresses, and a pattern that only
 *     occurs *inside the file being written* does not. Matching the body would
 *     make copilot's `Edit` stricter than Claude's `Edit`/`Write` for the same
 *     action — `PRIMARY_TOOL_INPUT_KEYS` excludes `Write.content` and
 *     `Edit.new_string` for exactly this reason — and an escalation nobody is
 *     watching is a stalled pipeline, not a safer one.
 *  3. **The rewrite is observable.** The adjudicated `tool_input` is not the one
 *     the agent sent, so §7 of `docs/design/multi-agent-state-architecture.md`
 *     requires it to carry a reason code out to the operator rather than living
 *     in the server log. `current-output-tool-input-normalization-1902.test.ts`
 *     pins the other end of that wire.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllAutoYesStates,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { collectToolInputMatchTexts } from '@/lib/hooks/permission-request-payload';
import {
  decidePermissionRequest,
  resolvePermissionRequest,
  type PermissionRequestSession,
} from '@/lib/hooks/permission-decision-service';
import {
  clearToolInputNormalizations,
  getLastToolInputNormalization,
} from '@/lib/hooks/tool-input-normalization-state';
import {
  collectPatchMatchTexts,
  MAX_PATCH_ACTION_LINES,
  readPermissionToolInput,
} from '@/lib/hooks/tool-input-normalization';
import { parseCopilotPermissionRequest } from '@/lib/hooks/sources/copilot/source';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';

/** The adjudicator's only database use is the allow audit row; stub it out. */
const created: Array<Record<string, unknown>> = [];
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => {
    created.push(message);
    return { id: 'msg-1', ...message };
  },
}));

/** Policy lookup is a database read behind a TTL cache; drive it directly. */
let policy: AutoYesPolicy | null = null;
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => policy,
  clearAutoYesPolicyCache: () => {},
}));

/**
 * The payload from the Issue, byte-for-byte, parsed from the JSON it was
 * reported as.
 *
 * Only the two values the Issue elided with `…` are filled in — the tail of the
 * session id and the parent of the cwd — because a `…` is not a string copilot
 * ever sent either. Nothing else is touched, and in particular `tool_input` is
 * the real thing: a string, ending in a newline, whose `\n` escapes are the
 * ones in the report.
 */
const ISSUE_1902_RAW_JSON =
  '{"hook_event_name":"PreToolUse","session_id":"4518a6a0-1b2c-4d3e-8f90-a1b2c3d4e5f6",' +
  '"timestamp":"2026-08-21T11:03:24.604Z","cwd":"/tmp/proj-cp","tool_name":"Edit",' +
  '"tool_input":"*** Begin Patch\\n*** Add File: note4.txt\\n+yo\\n*** End Patch\\n"}';

const issuePayload = (): Record<string, unknown> => JSON.parse(ISSUE_1902_RAW_JSON);

/** `Read` and `Bash` as copilot sends them: `tool_input` is an object. */
const objectPayload = (toolName: string, toolInput: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  session_id: '4518a6a0-1b2c-4d3e-8f90-a1b2c3d4e5f6',
  timestamp: '2026-08-21T11:03:24.604Z',
  cwd: '/tmp/proj-cp',
  tool_name: toolName,
  tool_input: toolInput,
});

/** A copilot payload whose `tool_input` is the given envelope. */
const patchPayload = (patch: string) => ({ ...issuePayload(), tool_input: patch });

const SESSION: PermissionRequestSession = {
  worktreeId: 'wt-1902',
  cliToolId: 'copilot',
  instanceId: 'copilot',
};

/** ALLOWED_DURATIONS[0]; the default Auto-Yes window. */
const ONE_HOUR_MS = 3_600_000;

function makePolicy(overrides: Partial<AutoYesPolicy> = {}): AutoYesPolicy {
  return { mode: null, allowPromptTypes: [], denyPatterns: [], ...overrides };
}

/** Parse as the permission route does, then adjudicate as it does. */
function adjudicate(body: Record<string, unknown>) {
  return resolvePermissionRequest(SESSION, parseCopilotPermissionRequest(body));
}

beforeEach(() => {
  created.length = 0;
  policy = null;
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearToolInputNormalizations();
  clearAgentStopEvents();
  setAutoYesEnabled(SESSION.worktreeId, SESSION.cliToolId, true, ONE_HOUR_MS);
});

describe('the raw payload from Issue #1902', () => {
  it('parses, where it used to answer null', () => {
    const parsed = parseCopilotPermissionRequest(issuePayload());

    expect(parsed).not.toBeNull();
    expect(parsed!.toolName).toBe('Edit');
    expect(parsed!.sessionId).toBe('4518a6a0-1b2c-4d3e-8f90-a1b2c3d4e5f6');
    // The whole envelope, unmodified, under the key the normalisation names.
    expect(parsed!.toolInput).toEqual({
      patch: '*** Begin Patch\n*** Add File: note4.txt\n+yo\n*** End Patch\n',
    });
    expect(parsed!.toolInputNormalization).toEqual({
      reason: 'string-tool-input-as-patch',
      key: 'patch',
      receivedType: 'string',
    });
  });

  it('is reached through the registry, which is what the route uses', () => {
    // Asserting the direct import alone would pass with the registry answering
    // the legacy relay — whose parser is Claude's, which refuses a `PreToolUse`
    // outright and would put every copilot request back on `unknown-payload`.
    const source = getAgentEventSource('copilot');
    expect(source.parsePermissionRequest(issuePayload())?.toolName).toBe('Edit');
  });

  it('is adjudicated `allow`, the Issue’s acceptance criterion', () => {
    const decision = adjudicate(issuePayload());

    expect(decision).toEqual({ behavior: 'allow', reason: 'auto-yes', mode: null });
    // The reason the Issue was filed. Named explicitly so a regression says so.
    expect(decision.reason).not.toBe('unknown-payload');
  });

  it('records the allow in the audit trail, judged on the action header', () => {
    adjudicate(issuePayload());

    expect(created).toHaveLength(1);
    const promptData = created[0].promptData as Record<string, unknown>;
    expect(created[0].content).toBe('Edit: *** Add File: note4.txt');
    expect(promptData.approvalTarget).toBe('*** Add File: note4.txt');
    expect(promptData.answer).toBe('allow');
  });
});

describe('both shapes of tool_input, in one case', () => {
  /**
   * The string row and the object rows together. Restoring the object-only
   * guard takes the first row red and leaves the rest green — which is the
   * whole of Issue #1902 stated as a test.
   */
  const CASES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['Edit (string patch, #1902)', issuePayload()],
    ['Read (object)', objectPayload('Read', { file_path: '/tmp/proj-cp/note4.txt' })],
    ['Bash (object)', objectPayload('Bash', { command: 'ls', description: 'list' })],
  ];

  it.each(CASES)('%s parses and is allowed', (_label, body) => {
    const parsed = parseCopilotPermissionRequest(body);
    expect(parsed, 'payload did not parse').not.toBeNull();
    expect(resolvePermissionRequest(SESSION, parsed)).toMatchObject({
      behavior: 'allow',
      reason: 'auto-yes',
    });
  });

  it('leaves an object tool_input exactly as it arrived', () => {
    // The normalisation is not a rewrite of everything: an object payload has
    // no record at all, which is what makes a non-null record meaningful.
    const parsed = parseCopilotPermissionRequest(
      objectPayload('Bash', { command: 'ls', description: 'list' })
    );
    expect(parsed!.toolInput).toEqual({ command: 'ls', description: 'list' });
    expect(parsed!.toolInputNormalization).toBeNull();
  });

  it('still refuses a tool_input it cannot judge', () => {
    // Strictness is unchanged for everything that is not a usable string: null
    // becomes no-decision, and a dialog is the safe side.
    for (const toolInput of [undefined, '', 42, true, null, ['a']]) {
      const body = { ...issuePayload(), tool_input: toolInput };
      expect(parseCopilotPermissionRequest(body), String(toolInput)).toBeNull();
    }
    expect(decidePermissionRequest(SESSION, null).reason).toBe('unknown-payload');
  });
});

describe('where the deny patterns are applied', () => {
  const PATCH = [
    '*** Begin Patch',
    '*** Add File: scripts/cleanup.sh',
    '+#!/bin/sh',
    '+rm -rf ./build',
    '*** End Patch',
    '',
  ].join('\n');

  it('is the envelope’s action headers, and nothing else', () => {
    const input = readPermissionToolInput(PATCH)!;

    expect(
      collectToolInputMatchTexts('Edit', input.toolInput, input.normalization)
    ).toEqual(['*** Add File: scripts/cleanup.sh']);
  });

  it('suppresses on the path being written', () => {
    policy = makePolicy({ denyPatterns: ['scripts/'] });

    expect(adjudicate(patchPayload(PATCH))).toMatchObject({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
      pattern: 'scripts/',
    });
  });

  it('suppresses on the verb, so a contract can forbid deletions', () => {
    policy = makePolicy({ denyPatterns: ['Delete File'] });
    const patch = '*** Begin Patch\n*** Delete File: .env\n*** End Patch\n';

    expect(adjudicate(patchPayload(patch))).toMatchObject({
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
    });
  });

  it('sees a rename’s destination as well as its source', () => {
    policy = makePolicy({ denyPatterns: ['secrets\\.txt'] });
    const patch =
      '*** Begin Patch\n*** Update File: notes.txt\n*** Move to: secrets.txt\n' +
      '@@\n-a\n+b\n*** End Patch\n';

    expect(adjudicate(patchPayload(patch))).toMatchObject({
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
    });
  });

  it('does NOT escalate on a string that only occurs in the file body', () => {
    // The decision this Issue had to make, and the one that would be easiest to
    // get wrong in the "safe" direction. `rm -rf` is in the patch — as a line of
    // the shell script being written, not as a command being run. Judging it
    // would suppress the edit, the dialog would go unanswered because Auto-Yes
    // is on precisely when nobody is watching, and the run would stall.
    //
    // It is also the rule the product already applies: `Write.content` and
    // `Edit.new_string` are excluded from Claude's matching surface for the same
    // reason. A patch body is those two fields fused into one string.
    policy = makePolicy({ denyPatterns: ['rm -rf'] });

    expect(adjudicate(patchPayload(PATCH))).toMatchObject({
      behavior: 'allow',
      reason: 'auto-yes',
    });
  });

  it('judges Claude’s object-shaped Edit the same way, unchanged', () => {
    // The control for the case above: #1902 did not loosen anything that was
    // already being matched. `new_string` was never on the surface.
    expect(
      collectToolInputMatchTexts('Edit', {
        file_path: 'scripts/cleanup.sh',
        new_string: 'rm -rf ./build',
      })
    ).toEqual(['scripts/cleanup.sh']);
  });
});

describe('the fallbacks, which all over-match', () => {
  it('judges a non-envelope string in full', () => {
    // No headers to summarise and no claim that there are any: the reason code
    // says `as-text`, and the whole string is the surface.
    const input = readPermissionToolInput('please run rm -rf /tmp/x')!;

    expect(input.normalization).toEqual({
      reason: 'string-tool-input-as-text',
      key: 'text',
      receivedType: 'string',
    });
    expect(collectToolInputMatchTexts('Edit', input.toolInput, input.normalization)).toEqual([
      'please run rm -rf /tmp/x',
    ]);

    policy = makePolicy({ denyPatterns: ['rm -rf'] });
    expect(adjudicate(patchPayload('please run rm -rf /tmp/x'))).toMatchObject({
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
    });
  });

  it('judges an envelope with no action header in full', () => {
    const patch = '*** Begin Patch\n*** End Patch\n';
    expect(collectPatchMatchTexts(patch)).toEqual([patch]);
  });

  it('judges an envelope with more headers than it will summarise in full', () => {
    const headers = (n: number) =>
      Array.from({ length: n }, (_, i) => `*** Add File: f${i}.txt`).join('\n');

    const atCap = `*** Begin Patch\n${headers(MAX_PATCH_ACTION_LINES)}\n*** End Patch\n`;
    expect(collectPatchMatchTexts(atCap)).toHaveLength(MAX_PATCH_ACTION_LINES);

    const overCap = `*** Begin Patch\n${headers(MAX_PATCH_ACTION_LINES + 1)}\n*** End Patch\n`;
    expect(collectPatchMatchTexts(overCap)).toEqual([overCap]);
  });

  it('ignores a header-shaped line inside a hunk, because it is prefixed', () => {
    // Content lines carry ` `, `+` or `-`, so a forged header cannot displace a
    // real one. Asserted because the parse is a `startsWith` at column 0.
    const patch =
      '*** Begin Patch\n*** Add File: real.txt\n+*** Add File: forged.txt\n*** End Patch\n';

    expect(collectPatchMatchTexts(patch)).toEqual(['*** Add File: real.txt']);
  });

  it('reads a CRLF envelope', () => {
    const patch = '*** Begin Patch\r\n*** Add File: note4.txt\r\n+yo\r\n*** End Patch\r\n';
    expect(collectPatchMatchTexts(patch)).toEqual(['*** Add File: note4.txt']);
  });

  it('falls back to the whole input when the record and the input disagree', () => {
    // Defence in depth: a normalisation record whose key is not in the object
    // must not empty the matching surface. Over-matching costs a dialog.
    expect(
      collectToolInputMatchTexts(
        'Edit',
        { command: 'rm -rf /' },
        { reason: 'string-tool-input-as-patch', key: 'patch', receivedType: 'string' }
      )
    ).toEqual(['{"command":"rm -rf /"}']);
  });
});

describe('the rewrite is recorded, not done in silence (§7)', () => {
  it('records the reason code for the session that was normalised', () => {
    const before = Date.now();
    adjudicate(issuePayload());

    const record = getLastToolInputNormalization('wt-1902', 'copilot', 'copilot');
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      reason: 'string-tool-input-as-patch',
      key: 'patch',
      receivedType: 'string',
      toolName: 'Edit',
    });
    expect(record!.at).toBeGreaterThanOrEqual(before);
  });

  it('records it on the suppressed path too', () => {
    // The path an operator actually investigates: the edit did not go through,
    // and the question is what the deny pattern was matched against.
    policy = makePolicy({ denyPatterns: ['note4'] });
    expect(adjudicate(issuePayload()).reason).toBe('policy-suppressed');

    expect(getLastToolInputNormalization('wt-1902', 'copilot', 'copilot')).toMatchObject({
      reason: 'string-tool-input-as-patch',
      toolName: 'Edit',
    });
  });

  it('records nothing for a payload that arrived as an object', () => {
    adjudicate(objectPayload('Bash', { command: 'ls', description: 'list' }));

    expect(getLastToolInputNormalization('wt-1902', 'copilot', 'copilot')).toBeNull();
  });

  it('keeps other sessions out of it', () => {
    adjudicate(issuePayload());

    expect(getLastToolInputNormalization('wt-other', 'copilot', 'copilot')).toBeNull();
    expect(getLastToolInputNormalization('wt-1902', 'copilot', 'copilot-2')).toBeNull();
  });
});
