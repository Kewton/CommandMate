/**
 * Issue #2979: an OpenCode V2 schedule runs in the worktree it was placed in.
 *
 * `opencode2` takes its project directory from `PWD`, not from the process's
 * cwd (tests/fixtures/opencode-v2-schedule-2979/README.md), and `execFile`'s
 * `cwd` does not rewrite `PWD`. So the executor hands the v2 child a `PWD`
 * equal to `cwd`; every other tool keeps the environment it had.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const { mockResolveOpencodeV2 } = vi.hoisted(() => ({ mockResolveOpencodeV2: vi.fn() }));
vi.mock('@/lib/cli-tools/opencode-executable', () => ({
  OPENCODE_V2_BINARY_NAME: 'opencode2',
  resolveOpencodeV2Executable: mockResolveOpencodeV2,
}));

import { execFile } from 'child_process';
import { executeClaudeCommand } from '../../../src/lib/session/claude-executor';

const mockedExecFile = vi.mocked(execFile);

interface ExecCall {
  command: string;
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
}

/** Record the call and finish the run with an empty stdout. */
function captureExecFile(): ExecCall[] {
  const calls: ExecCall[] = [];
  mockedExecFile.mockImplementation(((
    command: string,
    _args: readonly string[],
    options: ExecCall['options'],
    cb: (err: Error | null, out: string, err2: string) => void
  ) => {
    calls.push({ command, options });
    queueMicrotask(() => cb(null, '', ''));
    return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
  }) as unknown as typeof execFile);
  return calls;
}

describe('executeClaudeCommand: the child PWD (Issue #2979)', () => {
  let serverDir: string;
  let worktreeDir: string;
  let originalPwd: string | undefined;
  let originalAuthToken: string | undefined;

  beforeEach(() => {
    serverDir = mkdtempSync(join(tmpdir(), 'cm-2979-server-'));
    worktreeDir = mkdtempSync(join(tmpdir(), 'cm-2979-worktree-'));
    originalPwd = process.env.PWD;
    originalAuthToken = process.env.CM_AUTH_TOKEN;
    // The server was started from its own checkout, not the schedule's worktree.
    process.env.PWD = serverDir;
    process.env.CM_AUTH_TOKEN = 'secret-2979';
    mockedExecFile.mockReset();
    mockResolveOpencodeV2.mockReset();
    mockResolveOpencodeV2.mockResolvedValue({
      executable: { path: '/opt/homebrew/bin/opencode2', version: '2.0.18', generation: 'v2' },
      probed: [],
    });
  });

  afterEach(() => {
    if (originalPwd === undefined) delete process.env.PWD;
    else process.env.PWD = originalPwd;
    if (originalAuthToken === undefined) delete process.env.CM_AUTH_TOKEN;
    else process.env.CM_AUTH_TOKEN = originalAuthToken;
    rmSync(serverDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('opencode-v2: PWD is the worktree, not the server PWD', async () => {
    const calls = captureExecFile();
    await executeClaudeCommand('create a file', worktreeDir, 'opencode-v2', 'default');

    expect(calls).toHaveLength(1);
    expect(calls[0].options.cwd).toBe(worktreeDir);
    expect(calls[0].options.env?.PWD).toBe(worktreeDir);
    expect(calls[0].options.env?.PWD).not.toBe(serverDir);
  });

  it('opencode-v2: the rest of the environment is still sanitized', async () => {
    const calls = captureExecFile();
    await executeClaudeCommand('create a file', worktreeDir, 'opencode-v2', 'auto');

    expect(calls[0].options.env).not.toHaveProperty('CM_AUTH_TOKEN');
    expect(calls[0].options.env?.PATH).toBe(process.env.PATH);
  });

  it.each(['claude', 'codex', 'opencode'])('%s: the inherited PWD is left as it was', async (tool) => {
    const calls = captureExecFile();
    await executeClaudeCommand('hello', worktreeDir, tool, undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.cwd).toBe(worktreeDir);
    expect(calls[0].options.env?.PWD).toBe(serverDir);
  });
});
