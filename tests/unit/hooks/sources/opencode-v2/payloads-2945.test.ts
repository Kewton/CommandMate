/**
 * Reading OpenCode V2's approvals and forms (Issue #2945).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  buildOpencodeV2FormAnswer,
  describeOpencodeV2Permission,
  parseOpencodeV2Form,
  parseOpencodeV2PermissionRequest,
  toOpencodeV2PendingQuestion,
} from '@/lib/hooks/sources/opencode-v2/payloads';
import { toOpencodeV2PermissionReply } from '@/lib/hooks/sources/opencode-v2/source';

const approval = (data: Record<string, unknown>) => ({
  type: 'permission.asked',
  data: { id: 'per_1', sessionID: 'ses_1', ...data },
});

describe('approvals', () => {
  it('reads the action as the tool name, metadata as the input, and `save` as the suggestion', () => {
    const parsed = parseOpencodeV2PermissionRequest(
      approval({ action: 'shell', resources: ['ls'], save: ['ls *'], metadata: { command: 'ls -la' } })
    );
    expect(parsed).toEqual({
      toolName: 'shell',
      toolInput: { action: 'shell', resources: ['ls'], command: 'ls -la' },
      promptId: 'per_1',
      sessionId: 'ses_1',
      permissionMode: null,
      permissionSuggestions: ['ls *'],
    });
  });

  it('refuses an approval it could not address', () => {
    expect(parseOpencodeV2PermissionRequest({ type: 'permission.asked', data: { id: 'per_1' } })).toBeNull();
    expect(parseOpencodeV2PermissionRequest({ sessionID: 'ses_1', action: 'edit' })).toBeNull();
  });

  it('describes a shell approval by its command, and names each file of a multi-file edit', () => {
    expect(describeOpencodeV2Permission(approval({ action: 'shell', metadata: { command: 'rm -rf x' } }))).toBe(
      'shell rm -rf x'
    );
    expect(
      describeOpencodeV2Permission(
        approval({
          action: 'edit',
          resources: ['a.txt', 'b.txt'],
          metadata: {
            files: [
              { file: 'a.txt', patch: '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n' },
              { file: 'b.txt', patch: '@@ -0,0 +1 @@\n+z\n' },
            ],
          },
        })
      )
    ).toBe('edit a.txt, b.txt\na.txt\n@@ -1 +1 @@\n-x\n+y\nb.txt\n@@ -0,0 +1 @@\n+z');
  });

  it('maps verdicts onto the three wire replies, and has none for an abstain or an answer', () => {
    expect(toOpencodeV2PermissionReply({ kind: 'allowOnce' })).toBe('once');
    expect(toOpencodeV2PermissionReply({ kind: 'allowAlways' })).toBe('always');
    expect(toOpencodeV2PermissionReply({ kind: 'deny' })).toBe('reject');
    expect(toOpencodeV2PermissionReply({ kind: 'abstain' })).toBeNull();
    expect(toOpencodeV2PermissionReply({ kind: 'answer', answers: [['x']] })).toBeNull();
  });
});

const form = (fields: unknown[]) => ({ id: 'frm_1', sessionID: 'ses_1', title: 'Questions', fields });

describe('forms', () => {
  it('reads a multiselect, a boolean, and skips a hidden field', () => {
    const spec = parseOpencodeV2Form(
      form([
        { key: 'h', type: 'string', hidden: true, default: 'x' },
        {
          key: 'm',
          title: 'Which?',
          type: 'multiselect',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
        { key: 'ok', title: 'Proceed?', type: 'boolean' },
      ])
    );
    expect(spec?.promptId).toBe('frm_1');
    expect(spec?.questions.map((q) => [q.question, q.multiSelect, q.choices.map((c) => c.label)])).toEqual([
      ['Which?', true, ['A', 'B']],
      ['Proceed?', false, ['Yes', 'No']],
    ]);
  });

  it('refuses a form with a field no surface can offer choices for', () => {
    expect(parseOpencodeV2Form(form([{ key: 'n', title: 'How many?', type: 'number' }]))).toBeNull();
    expect(parseOpencodeV2Form(form([{ key: 's', title: 'Name?', type: 'string' }]))).toBeNull();
    expect(toOpencodeV2PendingQuestion(form([{ key: 's', title: 'Name?', type: 'string' }]), 0)).toBeNull();
  });

  it('builds the answer from values: an array for a multiselect, a boolean for a boolean', () => {
    const payload = form([
      {
        key: 'm',
        title: 'Which?',
        type: 'multiselect',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      { key: 'ok', title: 'Proceed?', type: 'boolean' },
    ]);
    expect(buildOpencodeV2FormAnswer(payload, [['A', 'B'], ['No']])).toEqual({ m: ['a', 'b'], ok: false });
  });

  it('refuses free text where the field is not `custom`, and a count that does not match the fields', () => {
    const payload = form([{ key: 'q', title: 'Q?', type: 'string', options: [{ value: 'v', label: 'V' }] }]);
    expect(buildOpencodeV2FormAnswer(payload, [['V']])).toEqual({ q: 'v' });
    expect(buildOpencodeV2FormAnswer(payload, [['something else']])).toBeNull();
    expect(buildOpencodeV2FormAnswer(payload, [['V'], ['V']])).toBeNull();
    expect(buildOpencodeV2FormAnswer(payload, [['V', 'V']])).toBeNull();
  });
});
