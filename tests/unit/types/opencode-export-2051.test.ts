/**
 * `opencode export --sanitize`: the redaction audit and the summary (Issue #2051).
 *
 * The fixture in `tests/fixtures/opencode-share-2051/export-sanitized.json` is
 * not hand-written. It is the real output of
 * `opencode export --sanitize <sessionID>` on opencode 1.18.22, taken in an
 * isolated `HOME` against a session built to be maximally leaky: a prompt
 * carrying an inline password, and a `read` tool call over a file of key-shaped
 * strings. The plain export of the same session was diffed against it, and the
 * full field-by-field record is in
 * `docs/design/opencode-server-live-verification.md` §23.
 *
 * The suite therefore does two different jobs:
 *
 *  - It pins the **measured redaction** of 1.18.22, so a release that stops
 *    redacting a field is caught here rather than in a published report.
 *  - It checks the audit **fails** on the shapes the plain export actually had,
 *    because an audit that passes everything is worse than no audit — it would
 *    launder an unsanitized export into an attachment.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  OPENCODE_EXPORT_SENSITIVE_KEYS,
  OPENCODE_REDACTION_PREFIX,
  auditOpencodeExportRedaction,
  summarizeOpencodeExport,
} from '@/types/opencode-export';

const FIXTURE = join(
  process.cwd(),
  'tests/fixtures/opencode-share-2051/export-sanitized.json'
);

function sanitizedExport(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
}

describe('the measured fixture', () => {
  it('carries none of the material that was in the plain export', () => {
    // Each needle appeared 3-8 times in the plain export of the same session.
    const raw = readFileSync(FIXTURE, 'utf8');
    for (const needle of [
      'AKIAIOSFODNN7EXAMPLE',
      'hunter2',
      'ghp_EXAMPLE',
      'secrets.env',
      '/private/tmp/',
    ]) {
      expect(raw).not.toContain(needle);
    }
  });

  it('redacts the operator\'s prompt and the agent\'s reply alike', () => {
    const document = sanitizedExport() as {
      messages: { info: { role: string }; parts: { type: string; text?: string }[] }[];
    };
    const texts = document.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === 'text').map((part) => part.text)
    );
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text).toContain(OPENCODE_REDACTION_PREFIX);
    }
  });

  it('keeps the tool name, which is the half that is not redacted', () => {
    // Deliberate, and documented as a judgement call: tool names are most of
    // the value in the summary and are not a disclosure.
    const document = sanitizedExport() as {
      messages: { parts: { type: string; tool?: string }[] }[];
    };
    const tools = document.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
    expect(tools).toContain('read');
  });
});

describe('auditOpencodeExportRedaction', () => {
  it('passes the real sanitized export', () => {
    expect(auditOpencodeExportRedaction(sanitizedExport())).toEqual([]);
  });

  it('catches a session directory left in place', () => {
    // Verbatim shape from the plain export: `--sanitize` turns this into
    // `[redacted:session-directory:<sessionID>]`.
    const leaks = auditOpencodeExportRedaction({
      info: { id: 'ses_x', directory: '/Users/someone/work/repo' },
      messages: [],
    });
    expect(leaks).toEqual([{ path: 'info.directory', kind: 'plaintext' }]);
  });

  it('catches a tool output left in place', () => {
    const leaks = auditOpencodeExportRedaction({
      info: { id: 'ses_x' },
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              tool: 'read',
              state: {
                status: 'completed',
                output: '<content>\n1: AWS_SECRET_ACCESS_KEY=…\n</content>',
              },
            },
          ],
        },
      ],
    });
    expect(leaks).toEqual([
      { path: 'messages[0].parts[0].state.output', kind: 'plaintext' },
    ]);
  });

  it('catches the tool input and metadata objects the plain export leaves intact', () => {
    // `--sanitize` replaces each of these whole objects with `{ redacted: … }`,
    // so an object standing here means the flag did not apply.
    const leaks = auditOpencodeExportRedaction({
      info: { id: 'ses_x' },
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              state: {
                input: { filePath: '/Users/someone/work/repo/secrets.env' },
                metadata: { preview: 'AWS_ACCESS_KEY_ID=…' },
              },
              metadata: { anthropic: { caller: { type: 'direct' } } },
            },
          ],
        },
      ],
    });
    expect(leaks.map((leak) => leak.path).sort()).toEqual([
      'messages[0].parts[0].metadata',
      'messages[0].parts[0].state.input',
      'messages[0].parts[0].state.metadata',
    ]);
    expect(leaks.every((leak) => leak.kind === 'unredacted-object')).toBe(true);
  });

  it('does not descend into an offending field, so one leak is one entry', () => {
    const leaks = auditOpencodeExportRedaction({
      info: { id: 'ses_x' },
      messages: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'tool', state: { metadata: { display: { text: 'a', path: 'b' } } } }],
        },
      ],
    });
    expect(leaks).toHaveLength(1);
  });

  it('accepts absent, null and empty values rather than demanding a token', () => {
    // A part with no text simply has none; `--sanitize` invents nothing for it.
    expect(
      auditOpencodeExportRedaction({
        info: { id: 'ses_x', title: null, directory: '' },
        messages: [{ info: { role: 'user' }, parts: [{ type: 'step-start' }] }],
      })
    ).toEqual([]);
  });

  it('accepts numbers and booleans, which are not disclosures', () => {
    expect(
      auditOpencodeExportRedaction({ info: { id: 'ses_x' }, messages: [], input: 0, output: false })
    ).toEqual([]);
  });

  it('checks every key the measurement found carrying content', () => {
    // A guard on the guard: if the list shrinks, this says so.
    expect([...OPENCODE_EXPORT_SENSITIVE_KEYS]).toEqual([
      'directory',
      'title',
      'cwd',
      'root',
      'text',
      'snapshot',
      'output',
      'input',
      'metadata',
    ]);
  });
});

describe('summarizeOpencodeExport', () => {
  it('reduces the measured export to the facts that survived', () => {
    const summary = summarizeOpencodeExport(sanitizedExport());
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      agent: 'build',
      model: 'github-copilot/claude-sonnet-4.6',
      version: '1.18.22',
      userMessages: 1,
      assistantMessages: 2,
      tools: ['read'],
      toolCalls: 1,
    });
    expect(summary?.sessionId).toMatch(/^ses_/);
    expect(summary?.cost).toBeGreaterThan(0);
    expect(summary?.createdAt).toBeGreaterThan(0);
  });

  it('carries no readable text out of the document', () => {
    // The point of the summary: it is built only from fields `--sanitize` keeps,
    // so nothing it returns can be a transcript fragment.
    const summary = summarizeOpencodeExport(sanitizedExport());
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(OPENCODE_REDACTION_PREFIX);
    expect(serialized).not.toContain('/private/tmp/');
  });

  it('answers null for a document with no info object', () => {
    expect(summarizeOpencodeExport({ messages: [] })).toBeNull();
    expect(summarizeOpencodeExport(null)).toBeNull();
    expect(summarizeOpencodeExport('{}')).toBeNull();
  });

  it('loses a renamed field rather than throwing', () => {
    // This parses another program's output; a release that renames a key should
    // cost the report that key, not the report.
    const summary = summarizeOpencodeExport({
      info: { id: 'ses_x', model: 'github-copilot/claude-sonnet-4.6' },
      messages: 'not an array',
    });
    expect(summary).toMatchObject({
      sessionId: 'ses_x',
      model: null,
      agent: null,
      userMessages: 0,
      assistantMessages: 0,
      tools: [],
      toolCalls: 0,
    });
  });

  it('falls back to the bare model id when the provider is missing', () => {
    expect(
      summarizeOpencodeExport({ info: { id: 'ses_x', model: { id: 'claude-sonnet-4.6' } } })
    ).toMatchObject({ model: 'claude-sonnet-4.6' });
  });

  it('counts repeated calls to one tool once in the name list', () => {
    const summary = summarizeOpencodeExport({
      info: { id: 'ses_x' },
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'tool', tool: 'read' },
            { type: 'tool', tool: 'read' },
            { type: 'tool', tool: 'bash' },
          ],
        },
      ],
    });
    expect(summary).toMatchObject({ tools: ['bash', 'read'], toolCalls: 3 });
  });
});
