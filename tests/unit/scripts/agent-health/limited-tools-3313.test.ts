/**
 * Issue #3313: gemini, vibe-local and copilot are rows of the daily report.
 * Their `version` is read without starting a session, and every other check
 * is a skip whose kind is given where the skip is made. The probe's own skips
 * (no picker, no hook, version failed) carry their kind too.
 *
 * `execFile` is replaced, so no CLI runs here.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  AGENT_HEALTH_CHECK_IDS,
  AGENT_HEALTH_LIMITED_TOOLS,
  type AgentHealthCheckId,
} from '@/lib/agent-health/types';

const exec = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[] }>,
  fail: false,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn(
    (
      file: string,
      args: string[],
      _options: unknown,
      callback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      exec.calls.push({ file, args });
      queueMicrotask(() =>
        exec.fail ? callback?.(new Error(`spawn ${file} ENOENT`)) : callback?.(null, { stdout: `${file} 9.9.9\n`, stderr: '' })
      );
      return {};
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const { probeLimitedTool, probeTool } = await import('../../../../scripts/agent-health/probe-tool');
const { LIMITED_TOOL_SPECS, TOOL_PROBE_SPECS } = await import('../../../../scripts/agent-health/tool-table');

const all = () => true;
const env = {} as NodeJS.ProcessEnv;

let dir: string;

beforeEach(() => {
  exec.calls = [];
  exec.fail = false;
  dir = makeTempDir('cm-3313-limited-');
});

afterEach(() => {
  removeTempDir(dir);
});

describe('the version-only tools', () => {
  it('has a spec for gemini, vibe-local and copilot', () => {
    expect(Object.keys(LIMITED_TOOL_SPECS)).toEqual([...AGENT_HEALTH_LIMITED_TOOLS]);
  });

  it.each([...AGENT_HEALTH_LIMITED_TOOLS])('%s: version is read, every other check is a skip with a kind and a reason', async (tool) => {
    const outcome = await probeLimitedTool(LIMITED_TOOL_SPECS[tool], env, all);
    expect(outcome.checks.map((check) => check.checkId)).toEqual([...AGENT_HEALTH_CHECK_IDS]);
    expect(outcome.checks[0]).toMatchObject({ checkId: 'version', status: 'pass' });
    expect(outcome.version).not.toBeNull();
    for (const check of outcome.checks.slice(1)) {
      expect(check.status).toBe('skip');
      expect(check.skipKind).toBe(LIMITED_TOOL_SPECS[tool].skip.kind);
      expect(check.skipReason).toBe(LIMITED_TOOL_SPECS[tool].skip.reason);
    }
    // Only `--version`: nothing is launched.
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args.at(-1)).toBe('--version');
  });

  it('gemini reports that it cannot sign in', async () => {
    const outcome = await probeLimitedTool(LIMITED_TOOL_SPECS.gemini, env, all);
    expect(outcome.checks[1].skipKind).toBe('signed-out');
    expect(outcome.checks[1].summary).toContain('This client is no longer supported');
  });

  it('vibe-local reads the engine\'s version, never the launcher (which starts Ollama and a session)', async () => {
    await probeLimitedTool(LIMITED_TOOL_SPECS['vibe-local'], env, all);
    expect(exec.calls[0].file).toBe('python3');
    expect(exec.calls[0].args[0]).toMatch(/vibe-coder\.py$/);
    expect(exec.calls.some((call) => call.file === 'vibe-local')).toBe(false);
  });

  it('a missing CLI fails version and skips the rest as prerequisite-failed', async () => {
    exec.fail = true;
    const outcome = await probeLimitedTool(LIMITED_TOOL_SPECS.copilot, env, all);
    expect(outcome.version).toBeNull();
    expect(outcome.checks[0]).toMatchObject({ checkId: 'version', status: 'fail' });
    expect(outcome.checks.slice(1).every((check) => check.skipKind === 'prerequisite-failed')).toBe(true);
  });

  it('honours --only', async () => {
    const outcome = await probeLimitedTool(
      LIMITED_TOOL_SPECS.gemini,
      env,
      (checkId: AgentHealthCheckId) => checkId === 'version' || checkId === 'screen-idle'
    );
    expect(outcome.checks.map((check) => check.checkId)).toEqual(['version', 'screen-idle']);
  });
});

describe('the probe passes the kind where it skips', () => {
  const ctx = (selected: (checkId: string) => boolean) => ({
    spec: TOOL_PROBE_SPECS.opencode,
    tmux: {} as never,
    listener: { forTool: () => [] } as never,
    childEnv: env,
    workRoot: dir,
    selected,
    deadline: Date.now() + 60_000,
    log: () => undefined,
  });

  it('opencode: hook-correlation and screen-picker are no-definition', async () => {
    const outcome = await probeTool(
      ctx((checkId) => ['version', 'hook-correlation', 'screen-picker'].includes(checkId))
    );
    const kinds = Object.fromEntries(outcome.checks.map((check) => [check.checkId, check.skipKind ?? null]));
    expect(kinds).toEqual({ version: null, 'hook-correlation': 'no-definition', 'screen-picker': 'no-definition' });
  });

  it('a failed version makes every other check prerequisite-failed', async () => {
    exec.fail = true;
    const outcome = await probeTool(ctx(() => true));
    expect(outcome.checks[0]).toMatchObject({ checkId: 'version', status: 'fail' });
    const rest = outcome.checks.slice(1);
    expect(rest).toHaveLength(AGENT_HEALTH_CHECK_IDS.length - 1);
    expect(rest.every((check) => check.status === 'skip' && check.skipKind === 'prerequisite-failed')).toBe(true);
  });

  it('no skip object is written by hand in the runner (each goes through skipCheck)', () => {
    for (const file of ['probe-tool.ts', 'main.ts']) {
      const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'agent-health', file), 'utf8');
      expect(source, file).not.toMatch(/status:\s*'skip'/);
    }
  });
});
