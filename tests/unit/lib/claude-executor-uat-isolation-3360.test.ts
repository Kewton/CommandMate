/**
 * Issue #3360: under `CM_UAT_ISOLATION=1` a headless `codex exec` / `agy -p`
 * (Schedules, daily summary) is refused before anything is spawned. Both read the
 * user's shared hook config whatever the server passes, and with no receiver URL
 * in their environment the hooks fall back to `CM_PORT` / 3000 — production.
 *
 * Positive: refused under isolation, `execFile` never called (failed before the
 * fix — the run was spawned). Negative: unset, both are spawned as before, and
 * under isolation the other tools still run.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import * as executor from '../../../src/lib/session/claude-executor';
import { UAT_ISOLATION_ENV_VAR } from '../../../src/config/uat-isolation';

const { executeClaudeCommand } = executor;
// Read off the namespace so the suite still loads against the pre-#3360 module
// (the negative controls must pass there; only the refusals may fail).
const uatIsolationHeadlessRefusal = (tool: string): string | null =>
  (executor as unknown as { uatIsolationHeadlessRefusal: (t: string) => string | null })
    .uatIsolationHeadlessRefusal(tool);

const mockedExecFile = vi.mocked(execFile);

function succeedOnce(): void {
  mockedExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: readonly string[],
    _options: unknown,
    cb: (err: Error | null, out: string, err2: string) => void
  ) => {
    queueMicrotask(() => cb(null, 'ok', ''));
    return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
  }) as unknown as typeof execFile);
}

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[UAT_ISOLATION_ENV_VAR];
  delete process.env[UAT_ISOLATION_ENV_VAR];
  mockedExecFile.mockReset();
});

afterEach(() => {
  if (saved === undefined) delete process.env[UAT_ISOLATION_ENV_VAR];
  else process.env[UAT_ISOLATION_ENV_VAR] = saved;
});

describe('headless codex / antigravity under CM_UAT_ISOLATION=1', () => {
  it.each([
    ['codex', '$CODEX_HOME/hooks.json'],
    ['antigravity', '~/.gemini/config/hooks.json'],
  ])('refuses %s before spawning, naming the shared file', async (tool, shared) => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';

    const result = await executeClaudeCommand('hello', '/tmp', tool);

    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain(`${UAT_ISOLATION_ENV_VAR}=1: refusing to start a headless ${tool} run`);
    expect(result.error).toContain(shared);
    expect(result.error).toContain('skip those scenarios');
  });

  it('still runs claude (restricted by --setting-sources instead)', async () => {
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    succeedOnce();

    const result = await executeClaudeCommand('hello', '/tmp', 'claude');

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][1]).toContain('--setting-sources');
    expect(result.status).toBe('completed');
  });

  it.each(['codex', 'antigravity'])('negative control: unset, %s is spawned as before', async (tool) => {
    succeedOnce();

    const result = await executeClaudeCommand('hello', '/tmp', tool);

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('uatIsolationHeadlessRefusal answers null when unset, and for claude when set', () => {
    expect(uatIsolationHeadlessRefusal('codex')).toBeNull();
    expect(uatIsolationHeadlessRefusal('antigravity')).toBeNull();
    process.env[UAT_ISOLATION_ENV_VAR] = '1';
    expect(uatIsolationHeadlessRefusal('claude')).toBeNull();
    expect(uatIsolationHeadlessRefusal('codex')).not.toBeNull();
  });
});
