/**
 * What an opencode approval is ABOUT, carried to the surfaces that show it
 * (Issue #2031).
 *
 * `permission.asked` does not name the tool it is asking about (#1758 §5.4).
 * The name lives in the `message.part.updated` frame for the same `callID`,
 * which the subscription correlates as it goes — and until this Issue the
 * notification path threw that correlation away (`toolName: null`, hard-coded),
 * so a browser was told a dialog was open and never what it was for.
 *
 * `patterns` is the other half and the more consequential one: it is the rule
 * answering `Allow always` would SAVE. That verdict is the only one on the
 * panel whose effect outlives the dialog, so a button offering it without
 * showing its scope asks for a decision whose size the user cannot see.
 *
 * The retained list is bounded on both axes. Not because the captured frames
 * are large — they carry one entry — but because this record is held for up to
 * 30 minutes and served back over HTTP, and a stored footprint that depends on
 * what an agent chose to send is the property #1930/S3 exists to refuse.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    probeOpencodeHealth: vi
      .fn()
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: '1.18.3' } }),
    openOpencodeEventStream: vi.fn(),
  };
});
vi.mock('@/lib/hooks/permission-decision-service', () => ({
  resolvePermissionRequest: vi.fn(),
  PERMISSION_DECISION_SLOW_MS: 500,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({}) as never) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-2031', path: '/tmp/wt' })) }));
vi.mock('@/lib/hooks/agent-event-service', () => ({
  applyAgentStopEvent: vi
    .fn()
    .mockResolvedValue({ taskId: null, taskEventApplied: false, verificationRunId: null }),
}));

import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  readOpencodePermissionSubject,
  rememberOpencodeToolCall,
  resetOpencodeToolCalls,
  toOpencodePendingPermission,
} from '@/lib/hooks/sources/opencode/payloads';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
} from '@/lib/session/agent-event-state';
import {
  MAX_DECISION_PATTERNS,
  MAX_DECISION_PATTERN_LENGTH,
} from '@/lib/session/provisional-turn';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const TARGET = { worktreeId: 'wt-2031', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const CALL_ID = 'toolu_0000000000000000000000000';

describe('reading the subject off a captured approval', () => {
  beforeEach(() => {
    resetOpencodeToolCalls();
  });

  it('names the tool from the `message.part.updated` correlation', () => {
    rememberOpencodeToolCall(CALL_ID, 'bash');
    const subject = readOpencodePermissionSubject(fixture('permission-asked'), 1_000);

    expect(subject).toEqual({ toolName: 'bash', patterns: ['/tmp/*'] });
  });

  it('falls back to the approval kind when nothing correlated the call', () => {
    // Not an error state: the correlation table is bounded and a long session
    // drops its oldest entries. A less specific name, never a wrong one.
    const subject = readOpencodePermissionSubject(fixture('permission-asked'), 1_000);

    expect(subject?.toolName).toBe('external_directory');
    expect(subject?.patterns).toEqual(['/tmp/*']);
  });

  it('reads nothing out of a frame that is not an approval', () => {
    expect(readOpencodePermissionSubject(fixture('question-asked'), 1_000)).toBeNull();
    expect(readOpencodePermissionSubject(fixture('session-idle'), 1_000)).toBeNull();
  });

  it('is exactly the list the adjudicator judged, metadata`s copy included', () => {
    // Measured, and worth pinning because it is not what the top-level
    // `properties.patterns` alone would give: `parseOpencodePermissionRequest`
    // spreads `metadata` LAST, so an approval whose metadata carries its own
    // `patterns` shadows the outer one. The captured frame has both and they
    // agree; this asserts the shadowing rather than the agreement, because the
    // panel must show what `Allow always` will actually be judged against.
    const frame = fixture('permission-asked');
    const properties = frame.properties as Record<string, unknown>;
    properties.patterns = ['/outer/*'];
    (properties.metadata as Record<string, unknown>).patterns = ['/from-metadata/*'];

    const subject = readOpencodePermissionSubject(frame, 1_000);
    const pending = toOpencodePendingPermission(frame, 1_000)!;

    expect(subject?.patterns).toEqual(['/from-metadata/*']);
    expect(pending.subject.kind).toBe('permission');
    expect(subject?.patterns).toEqual(
      (pending.subject as unknown as { toolInput: { patterns: unknown } }).toolInput.patterns,
    );
  });
});

describe('what the retained record keeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpencodeToolCalls();
    resetPendingDecisions();
    clearAgentStopEvents();
    // Abstain, so the dialog stays open and a record survives to inspect. A
    // delivered verdict releases it before it is ever published (#1898).
    vi.mocked(resolvePermissionRequest).mockResolvedValue({
      behavior: null,
      reason: 'auto-yes-disabled',
    } as never);
  });

  /** Feed one frame through the real normaliser and the real ingest. */
  async function ingest(raw: Record<string, unknown>): Promise<void> {
    const event = opencodeAgentEventSource.normalizeEvent({ payload: raw, receivedAt: Date.now() });
    expect(event).not.toBeNull();
    await ingestOpencodeEvent(TARGET, event!);
  }

  function waiting() {
    return getStructuredPromptWaiting('wt-2031', 'opencode', 'opencode');
  }

  it('carries the tool name and the `Allow always` rules onto the dialog record', async () => {
    rememberOpencodeToolCall(CALL_ID, 'bash');
    await ingest(fixture('permission-asked'));

    expect(waiting()).toMatchObject({
      source: 'notification',
      decisionId: 'per_0000000000000000000000000',
      toolName: 'bash',
      patterns: ['/tmp/*'],
    });
  });

  it('bounds the rule list on both axes', async () => {
    const frame = fixture('permission-asked');
    const properties = frame.properties as Record<string, unknown>;
    const oversized = [
      ...Array.from({ length: MAX_DECISION_PATTERNS + 20 }, (_, i) => `/tmp/${i}/*`),
      'x'.repeat(MAX_DECISION_PATTERN_LENGTH + 500),
    ];
    // Both copies: `metadata.patterns` shadows the outer one — see the
    // shadowing pin above.
    properties.patterns = oversized;
    (properties.metadata as Record<string, unknown>).patterns = oversized;
    await ingest(frame);

    const patterns = waiting()!.patterns!;
    // A thousand short globs and one enormous glob are the same failure, so
    // both bounds have to hold at once.
    expect(patterns).toHaveLength(MAX_DECISION_PATTERNS);
    for (const pattern of patterns) {
      expect(pattern.length).toBeLessThanOrEqual(MAX_DECISION_PATTERN_LENGTH);
    }
  });

  it('drops entries that are not rules rather than rendering them', async () => {
    const frame = fixture('permission-asked');
    const properties = frame.properties as Record<string, unknown>;
    properties.patterns = [null, '', 42, '/tmp/*', { a: 1 }];
    (properties.metadata as Record<string, unknown>).patterns = properties.patterns;
    await ingest(frame);

    // `"undefined"` or `"[object Object]"` next to an `Allow always` button
    // would be a rule the user believes they are granting.
    expect(waiting()!.patterns).toEqual(['/tmp/*']);
  });

  it('says null when the approval named no rules at all', async () => {
    const frame = fixture('permission-asked');
    const properties = frame.properties as Record<string, unknown>;
    properties.patterns = [];
    (properties.metadata as Record<string, unknown>).patterns = [];
    await ingest(frame);

    expect(waiting()!.patterns).toBeNull();
  });
});
