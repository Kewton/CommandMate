/**
 * Reading opencode's log for the shared-data conflict (Issue #2939, D2).
 *
 * Every log here is a fake in a temporary directory; the operator's
 * `~/.local/share/opencode` is never read.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  OPENCODE_LOG_TAIL_BYTES,
  buildOpencodeSharedDataConflictMessage,
  findOpencodeSharedDataConflict,
  resolveOpencodeLogPath,
} from '@/lib/hooks/sources/opencode/log-diagnosis';

let sandbox: string;
let logPath: string;

const LAUNCH = Date.parse('2026-09-28T08:28:20.000Z');
const line = (iso: string, rest: string): string =>
  `timestamp=${iso} level=ERROR run=906e1cd3 ${rest}\n`;
const NO_SUCH_COLUMN =
  'message=failed ref=err_22b448ab error="SQLiteError: no such column: project_id" cause="…"';

beforeEach(() => {
  sandbox = makeTempDir('opencode-log-2939-');
  logPath = join(sandbox, 'opencode.log');
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDir(sandbox);
});

describe('findOpencodeSharedDataConflict', () => {
  it('finds `no such column` logged after the launch', async () => {
    writeFileSync(
      logPath,
      line('2026-09-28T08:28:19.500Z', 'message="cli starting" version=1.18.33') +
        line('2026-09-28T08:28:21.911Z', NO_SUCH_COLUMN)
    );
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBe('no such column: project_id');
  });

  it('ignores the same error from before the launch', async () => {
    writeFileSync(logPath, line('2026-09-28T07:00:00.000Z', NO_SUCH_COLUMN));
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBeNull();
  });

  it('answers null when there is no such line, no file, or lines without a stamp', async () => {
    writeFileSync(logPath, line('2026-09-28T08:28:21.000Z', 'message="server listening"'));
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBeNull();
    expect(await findOpencodeSharedDataConflict(LAUNCH, join(sandbox, 'missing.log'))).toBeNull();
    writeFileSync(logPath, 'SQLiteError: no such column: project_id\n');
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBeNull();
  });

  it('reads only the tail of a large log', async () => {
    const filler = line('2026-09-28T08:28:21.000Z', 'message=' + 'x'.repeat(200));
    const head = line('2026-09-28T08:28:21.000Z', NO_SUCH_COLUMN);
    const count = Math.ceil((OPENCODE_LOG_TAIL_BYTES * 2) / filler.length);
    writeFileSync(logPath, head + filler.repeat(count));
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBeNull();

    writeFileSync(logPath, filler.repeat(count) + head);
    expect(await findOpencodeSharedDataConflict(LAUNCH, logPath)).toBe('no such column: project_id');
  });
});

describe('resolveOpencodeLogPath', () => {
  it('follows XDG_DATA_HOME', () => {
    vi.stubEnv('XDG_DATA_HOME', join(sandbox, 'xdg'));
    expect(resolveOpencodeLogPath()).toBe(join(sandbox, 'xdg', 'opencode', 'log', 'opencode.log'));
  });

  it('is read through the default path too', async () => {
    vi.stubEnv('XDG_DATA_HOME', join(sandbox, 'xdg'));
    mkdirSync(join(sandbox, 'xdg', 'opencode', 'log'), { recursive: true });
    writeFileSync(resolveOpencodeLogPath(), line('2026-09-28T08:28:21.911Z', NO_SUCH_COLUMN));
    expect(await findOpencodeSharedDataConflict(LAUNCH)).toBe('no such column: project_id');
  });
});

describe('buildOpencodeSharedDataConflictMessage', () => {
  it('names the finding and both ways out', () => {
    const message = buildOpencodeSharedDataConflictMessage('no such column: project_id');
    expect(message).toContain('no such column: project_id');
    expect(message).toContain('OpenCode V2');
    expect(message).toContain('opencode.db');
  });
});
