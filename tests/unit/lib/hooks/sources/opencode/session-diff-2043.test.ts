/**
 * The opencode turn-diff store (Issue #2043).
 *
 * Every frame here is a **verbatim capture** from opencode 1.18.22 running in an
 * isolated HOME (`tests/fixtures/hooks/opencode/*-2043.json`), not a hand-written
 * shape. That matters more than usual for this feature: Issue #2043's premise was
 * that `session.diff` carries the turn's changed files, and the first test below
 * is the captured frame that disproves it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ensureOpencodeSessionDiff,
  forgetOpencodeSessionDiff,
  getOpencodeSessionDiff,
  opencodeWorkEvidenceFileCount,
  readOpencodeRevertState,
  readOpencodeUserMessageFrame,
  recordOpencodeDiffFrame,
  recordOpencodeRevertResult,
  resetOpencodeSessionDiff,
} from '@/lib/hooks/sources/opencode/diff';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const FIXTURES = join(__dirname, '../../../../../fixtures/hooks/opencode');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

const TARGET: AgentInstanceRef = { worktreeId: 'wt-2043', cliToolId: 'opencode' };

function read() {
  return getOpencodeSessionDiff('wt-2043', 'opencode');
}

beforeEach(() => {
  resetOpencodeSessionDiff();
});

describe('session.diff, as opencode 1.18.22 actually sends it', () => {
  it('carries an EMPTY diff on an ordinary turn — the Issue premise is false', () => {
    // Captured at the same millisecond as `session.idle`, after the turn's two
    // `file.edited` frames. If this ever stops being empty, the panel could read
    // the turn's files straight off the stream and skip the REST call.
    const frame = fixture('session-diff-empty-2043.json');
    const state = readOpencodeRevertState(frame);

    expect(state).toEqual({
      kind: 'files',
      sessionId: 'ses_fc65b58b2ffe0kur0cUkuLmkrr',
      files: [],
    });
  });

  it('carries the held-back files once a revert is active', () => {
    const state = readOpencodeRevertState(fixture('session-diff-reverted-2043.json'));

    expect(state?.kind).toBe('files');
    const files = state?.kind === 'files' ? state.files : [];
    expect(files.map((f) => [f.file, f.status])).toEqual([
      ['.gitignore', 'added'],
      ['added.txt', 'added'],
      ['sample.txt', 'modified'],
    ]);
    // The counts survive verbatim; the panel renders them.
    expect(files[2]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[2].patch).toContain('LINE-TWO-EDITED');
  });
});

describe('session.updated carries the revert state the frame above cannot', () => {
  it('reads Session.revert.messageID', () => {
    const state = readOpencodeRevertState(fixture('session-updated-reverted-2043.json'));

    expect(state).toEqual({
      kind: 'held',
      sessionId: 'ses_fc65b58b2ffe0kur0cUkuLmkrr',
      messageId: 'msg_cmateab46bd45831a705d3141051f',
    });
  });

  it('reads a null revert, which is the ONLY signal an unrevert produces', () => {
    const state = readOpencodeRevertState(fixture('session-updated-unreverted-2043.json'));

    expect(state?.kind).toBe('held');
    expect(state?.kind === 'held' ? state.messageId : 'unset').toBeNull();
  });

  it('refuses a sub-agent session, the same rule #2040 applies', () => {
    const frame = fixture('session-updated-reverted-2043.json');
    const properties = frame.properties as Record<string, unknown>;
    const info = properties.info as Record<string, unknown>;
    info.parentID = 'ses_parent000000000000000000';

    expect(readOpencodeRevertState(frame)).toBeNull();
  });
});

describe('the turn message id comes off message.updated', () => {
  it('reads a user message', () => {
    expect(readOpencodeUserMessageFrame(fixture('message-updated-user-2043.json'))).toEqual({
      sessionId: 'ses_fc65b58b2ffe0kur0cUkuLmkrr',
      messageId: 'msg_cmatee6cc7a4ab0b7aa86d103841a',
    });
  });

  it('ignores an assistant message', () => {
    expect(readOpencodeUserMessageFrame(fixture('message-updated-user.json'))).not.toBeNull();
    const assistant = fixture('message-updated-user-2043.json');
    ((assistant.properties as Record<string, unknown>).info as Record<string, unknown>).role =
      'assistant';

    expect(readOpencodeUserMessageFrame(assistant)).toBeNull();
  });
});

describe('recordOpencodeDiffFrame', () => {
  it('stores the turn message id and the held-back files independently', () => {
    recordOpencodeDiffFrame(TARGET, fixture('message-updated-user-2043.json'), 1000);
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1001);

    const record = read();
    expect(record?.turnMessageId).toBe('msg_cmatee6cc7a4ab0b7aa86d103841a');
    expect(record?.revertedFiles).toHaveLength(3);
    // The turn's own files are still unknown: only the REST call answers those.
    expect(record?.files).toEqual([]);
    expect(record?.filesAt).toBeNull();
  });

  it('drops the previous turn’s files when a new turn starts', () => {
    recordOpencodeDiffFrame(TARGET, fixture('message-updated-user-2043.json'), 1000);
    recordOpencodeRevertResult(TARGET, null, []);
    // Simulate the refresh having answered for turn 1.
    const first = read();
    expect(first).not.toBeNull();

    const next = fixture('message-updated-user-2043.json');
    ((next.properties as Record<string, unknown>).info as Record<string, unknown>).id =
      'msg_second00000000000000000';
    recordOpencodeDiffFrame(TARGET, next, 2000);

    const record = read();
    expect(record?.turnMessageId).toBe('msg_second00000000000000000');
    expect(record?.files).toEqual([]);
    expect(record?.filesAt).toBeNull();
  });

  it('is idempotent across the boundary frame opencode re-sends', () => {
    recordOpencodeDiffFrame(TARGET, fixture('message-updated-user-2043.json'), 1000);
    const first = read();
    recordOpencodeDiffFrame(TARGET, fixture('message-updated-user-2043.json'), 5000);

    // The repeat changed nothing at all, `at` included.
    expect(read()).toEqual(first);
  });

  it('clears the held-back files when session.updated reports no revert', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1000);
    recordOpencodeDiffFrame(TARGET, fixture('session-updated-reverted-2043.json'), 1001);
    expect(read()?.revertedFiles).toHaveLength(3);

    recordOpencodeDiffFrame(TARGET, fixture('session-updated-unreverted-2043.json'), 1002);

    expect(read()?.revertedMessageId).toBeNull();
    expect(read()?.revertedFiles).toEqual([]);
  });

  it('ignores a frame type it does not read', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-idle.json'), 1000);

    expect(read()).toBeNull();
  });
});

describe('scoping', () => {
  it('answers null for every tool but opencode', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1000);

    expect(getOpencodeSessionDiff('wt-2043', 'claude')).toBeNull();
    expect(getOpencodeSessionDiff('wt-2043', 'codex')).toBeNull();
  });

  it('does not refresh for a non-opencode instance', () => {
    expect(ensureOpencodeSessionDiff({ worktreeId: 'wt-2043', cliToolId: 'claude' })).toBeNull();
  });

  it('forgets one instance', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1000);
    forgetOpencodeSessionDiff(TARGET);

    expect(read()).toBeNull();
  });
});

describe('opencodeWorkEvidenceFileCount', () => {
  it('answers null when opencode has said nothing', () => {
    expect(opencodeWorkEvidenceFileCount('wt-2043')).toBeNull();
  });

  it('counts the files a revert is holding back', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1000);

    expect(opencodeWorkEvidenceFileCount('wt-2043')).toBe(3);
  });

  it('counts a file once when it is in both lists', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-reverted-2043.json'), 1000);
    recordOpencodeRevertResult(TARGET, 'msg_x00000000000000000000000', [
      { file: 'sample.txt', patch: null, additions: 1, deletions: 0, status: 'modified' },
    ]);

    expect(opencodeWorkEvidenceFileCount('wt-2043')).toBe(1);
  });

  it('answers 0 rather than null for a session that reported an empty diff', () => {
    recordOpencodeDiffFrame(TARGET, fixture('session-diff-empty-2043.json'), 1000);

    // 0 and null are different instructions to the gate: 0 is "opencode looked
    // and found nothing", null is "opencode was never asked".
    expect(opencodeWorkEvidenceFileCount('wt-2043')).toBe(0);
  });
});
