/**
 * Reading the `PermissionRequest` payload (Issue #1724).
 *
 * Written against `tests/fixtures/hooks/claude/permission-request*.json` —
 * bytes from a real Claude v2.1.223 session (Issue #1721), not from the hooks
 * documentation, which is wrong about this event in two ways that matter (D2).
 * Asserting the *absence* of the documented fields is deliberate: if a future
 * Claude adds `tool_use_id`, this suite fails and somebody re-reads the spike
 * before building correlation on it.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ASK_USER_QUESTION_TOOL,
  collectToolInputMatchTexts,
  MAX_TOOL_NAME_LENGTH,
  parsePermissionRequestPayload,
  PERMISSION_REQUEST_EVENT_NAME,
} from '@/lib/hooks/permission-request-payload';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('the captured Bash permission request', () => {
  const captured = fixture('permission-request.json');

  it('has the shape the spike measured, not the documented one', () => {
    expect(captured.hook_event_name).toBe(PERMISSION_REQUEST_EVENT_NAME);
    // D2: both documented fields are absent from the real payload.
    expect(captured).not.toHaveProperty('tool_use_id');
    expect(captured).not.toHaveProperty('permission_requirements');
    expect(captured).toHaveProperty('permission_suggestions');
    // The correlation keys that do exist.
    expect(typeof captured.prompt_id).toBe('string');
    expect(typeof captured.tool_name).toBe('string');
    expect(typeof captured.tool_input).toBe('object');
  });

  it('parses into the correlation keys that exist', () => {
    const parsed = parsePermissionRequestPayload(captured);

    expect(parsed).toMatchObject({
      toolName: 'Bash',
      promptId: captured.prompt_id,
      sessionId: captured.session_id,
      permissionMode: 'default',
    });
    expect(parsed?.toolInput).toEqual(captured.tool_input);
    expect(parsed?.permissionSuggestions).toEqual(captured.permission_suggestions);
  });

  it('judges the request on the command line Claude actually sent', () => {
    const parsed = parsePermissionRequestPayload(captured)!;

    expect(collectToolInputMatchTexts(parsed.toolName, parsed.toolInput)).toEqual([
      'touch /tmp/example-marker.txt && ls -l /tmp/example-marker.txt',
      'Create marker file in /tmp',
    ]);
  });
});

describe('the captured AskUserQuestion permission request', () => {
  const captured = fixture('permission-request-ask-user-question.json');

  it('is a PermissionRequest with no permission_suggestions', () => {
    // §5.6: AskUserQuestion raises the event like any tool, but Claude offers
    // no rule candidates for it — and returning `allow` still shows the picker.
    expect(captured.hook_event_name).toBe(PERMISSION_REQUEST_EVENT_NAME);
    expect(captured.tool_name).toBe(ASK_USER_QUESTION_TOOL);
    expect(captured).not.toHaveProperty('permission_suggestions');
  });

  it('parses, so the refusal to adjudicate it is a decision and not a parse failure', () => {
    const parsed = parsePermissionRequestPayload(captured);

    expect(parsed?.toolName).toBe(ASK_USER_QUESTION_TOOL);
    expect(parsed?.permissionSuggestions).toBeNull();
  });
});

describe('what is refused', () => {
  it('refuses anything that is not a PermissionRequest object', () => {
    const base = fixture('permission-request.json');

    expect(parsePermissionRequestPayload(null)).toBeNull();
    expect(parsePermissionRequestPayload([base])).toBeNull();
    expect(parsePermissionRequestPayload('{}')).toBeNull();
    expect(parsePermissionRequestPayload({ ...base, hook_event_name: 'PreToolUse' })).toBeNull();
    expect(parsePermissionRequestPayload({ ...base, tool_name: '' })).toBeNull();
    expect(parsePermissionRequestPayload({ ...base, tool_name: 42 })).toBeNull();
    expect(
      parsePermissionRequestPayload({ ...base, tool_name: 'x'.repeat(MAX_TOOL_NAME_LENGTH + 1) })
    ).toBeNull();
    expect(parsePermissionRequestPayload({ ...base, tool_input: null })).toBeNull();
    expect(parsePermissionRequestPayload({ ...base, tool_input: [] })).toBeNull();
  });

  it('accepts a payload missing the optional correlation fields', () => {
    // A refusal here would be a no-decision, i.e. Auto-Yes silently off, for a
    // Claude build that simply stopped sending prompt_id.
    const base = fixture('permission-request.json');
    delete base.prompt_id;
    delete base.permission_mode;
    delete base.permission_suggestions;

    expect(parsePermissionRequestPayload(base)).toMatchObject({
      toolName: 'Bash',
      promptId: null,
      permissionMode: null,
      permissionSuggestions: null,
    });
  });

  it('never returns an empty match surface for a non-empty input', () => {
    // An empty surface would mean every deny pattern silently passes.
    for (const [tool, input] of [
      ['Bash', { command: 'ls' }],
      ['Bash', { unexpected: 'rm -rf /' }],
      ['Write', { file_path: '/a' }],
      ['Mystery', { a: 1, b: [2, 3] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const texts = collectToolInputMatchTexts(tool, input);
      expect(texts.length, `${tool} produced no texts`).toBeGreaterThan(0);
      expect(texts.join('').length).toBeGreaterThan(0);
    }
  });
});
