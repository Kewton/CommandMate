/**
 * Issue #3046: the dispatch record (#3045 writes it, the release report reads
 * it). A missing or malformed file is "nothing dispatched", never an error.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { dispatchRecordPath, parseDispatchRecord } from '@/lib/agent-health/dispatch-record';

describe('dispatchRecordPath', () => {
  it('is <base>/dispatch/<date>.json', () => {
    expect(dispatchRecordPath('/base', '2026-10-01')).toBe(path.join('/base', 'dispatch', '2026-10-01.json'));
  });
});

describe('parseDispatchRecord', () => {
  const valid = {
    schemaVersion: 1,
    date: '2026-10-01',
    status: 'sent',
    sentAt: '2026-10-01T00:30:00.000Z',
    issues: [
      { number: 3050, kind: 'bug', title: 'codex screen-idle' },
      { number: 3051, kind: 'metrics', title: 'file-size' },
    ],
    deferred: [3052],
  };

  it('reads a valid record', () => {
    expect(parseDispatchRecord(JSON.stringify(valid))).toEqual(valid);
  });

  it('treats a missing file, broken JSON and other schema versions as none', () => {
    expect(parseDispatchRecord(null)).toBeNull();
    expect(parseDispatchRecord('{')).toBeNull();
    expect(parseDispatchRecord('[]')).toBeNull();
    expect(parseDispatchRecord(JSON.stringify({ ...valid, schemaVersion: 2 }))).toBeNull();
    expect(parseDispatchRecord(JSON.stringify({ ...valid, status: 'weird' }))).toBeNull();
  });

  it('drops malformed issues and deferred entries but keeps the record', () => {
    const record = parseDispatchRecord(
      JSON.stringify({
        ...valid,
        sentAt: undefined,
        issues: [{ number: 1, kind: 'feature', title: 'x' }, { number: 'x' }, { number: 7, kind: 'bug' }],
        deferred: [3, 'x', -1, 4.5],
      })
    );
    expect(record).toEqual({
      schemaVersion: 1,
      date: '2026-10-01',
      status: 'sent',
      issues: [{ number: 7, kind: 'bug', title: '' }],
      deferred: [3],
    });
  });

  it('defaults missing arrays to empty (a no-target day)', () => {
    expect(parseDispatchRecord(JSON.stringify({ schemaVersion: 1, date: '2026-10-01', status: 'no-target' }))).toEqual({
      schemaVersion: 1,
      date: '2026-10-01',
      status: 'no-target',
      issues: [],
      deferred: [],
    });
  });
});
