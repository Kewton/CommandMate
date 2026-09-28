/**
 * Issue #2937: the opencode-v2 probe launches the production way — port and
 * password reserved first, then `prepareLaunch`, which must render
 * `scripts/opencode-v2/launch.sh`. A launch line that fell back to
 * `--standalone` fails every check but `version` without starting anything,
 * and v1's opencode keeps its `hook-correlation` skip.
 *
 * `execFile` is replaced (so `--version` answers without a CLI), and so is the
 * server reservation where a test needs it to fail. No tmux runs here.
 *
 * @vitest-environment node
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { evaluateOpencodeV2LaunchLine } from '@/lib/agent-health/server-events';
import { AGENT_HEALTH_TOOLS, PROBE_WORKTREE_ID, probeInstanceId } from '@/lib/agent-health/types';
import { getAgentEventSource, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import { resetOpencodeV2PortAssignments } from '@/lib/hooks/sources/opencode-v2/ports';
import { OPENCODE_V2_DIR_ENV } from '@/lib/hooks/sources/opencode-v2/secrets';

const reserveOverride = vi.hoisted(() => ({ fail: false }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      queueMicrotask(() => callback?.(null, { stdout: 'opencode v2.0.18\n', stderr: '' }));
      return {};
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

vi.mock('../../../../scripts/agent-health/opencode-v2-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../scripts/agent-health/opencode-v2-server')>();
  return {
    ...actual,
    reserveProbeServer: (...args: Parameters<typeof actual.reserveProbeServer>) =>
      reserveOverride.fail ? Promise.resolve(null) : actual.reserveProbeServer(...args),
  };
});

const { buildProbeLaunchCommand, eventCheckMode, probeTool } = await import(
  '../../../../scripts/agent-health/probe-tool'
);
const { TOOL_PROBE_SPECS } = await import('../../../../scripts/agent-health/tool-table');
const { reserveProbeServer, releaseProbeServer } = await import(
  '../../../../scripts/agent-health/opencode-v2-server'
);

let dir: string;

beforeEach(() => {
  dir = makeTempDir('cm-2937-probe-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2-state'));
  resetOpencodeV2PortAssignments();
  reserveOverride.fail = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOpencodeV2PortAssignments();
  removeTempDir(dir);
});

const target = {
  worktreeId: PROBE_WORKTREE_ID,
  cliToolId: 'opencode-v2' as const,
  instanceId: probeInstanceId('opencode-v2'),
};

describe('opencode-v2 in the tool table', () => {
  it('is the sixth tool, with a probe spec in the production geometry', () => {
    expect(AGENT_HEALTH_TOOLS).toHaveLength(6);
    expect(AGENT_HEALTH_TOOLS[5]).toBe('opencode-v2');
    const spec = TOOL_PROBE_SPECS['opencode-v2'];
    expect(spec).toMatchObject({ cliToolId: 'opencode-v2', executable: 'opencode2', width: 80, height: 200 });
    expect(spec.server).toBe('opencode-v2');
    expect(spec.approval.via).toBe('none');
    expect(spec.approval.skipReason).toBeTruthy();
    // v2's word order, not v1's `Allow always`.
    expect(spec.prompts.quoted).toContain('Allow once   Always allow   Reject');
  });

  it('keeps the TUI state out of the user home', () => {
    const env = TOOL_PROBE_SPECS['opencode-v2'].launchEnv?.('/tmp/cm-agent-health-x/opencode-v2');
    expect(env).toEqual({ XDG_STATE_HOME: '/tmp/cm-agent-health-x/opencode-v2-xdg-state' });
    const line = buildProbeLaunchCommand(TOOL_PROBE_SPECS['opencode-v2'], 'bash launch.sh', '/w/opencode-v2');
    expect(line).toBe("XDG_STATE_HOME='/w/opencode-v2-xdg-state' bash launch.sh");
  });
});

describe('eventCheckMode', () => {
  it('checks the SSE for opencode-v2, skips v1 opencode, reads hooks elsewhere', () => {
    const mode = (tool: (typeof AGENT_HEALTH_TOOLS)[number]) =>
      eventCheckMode(TOOL_PROBE_SPECS[tool], getAgentEventSource(TOOL_PROBE_SPECS[tool].cliToolId).capabilities);
    expect(mode('opencode-v2')).toBe('server-sse');
    expect(mode('opencode')).toBe('skip');
    expect(mode('claude')).toBe('hooks');
    expect(mode('codex')).toBe('hooks');
  });
});

describe('the probe launch line', () => {
  it('goes through launch.sh once the port and password are reserved', async () => {
    const port = await reserveProbeServer(target, dir);
    expect(port).not.toBeNull();
    const rendered = renderAgentLaunchCommand(
      getAgentEventSource('opencode-v2').prepareLaunch({ target, executablePath: 'opencode2', worktreePath: dir })
    );
    expect(rendered).toContain('scripts/opencode-v2/launch.sh');
    expect(rendered).toContain(join(dir, 'opencode-v2-state'));
    expect(evaluateOpencodeV2LaunchLine(rendered)).toEqual({ ok: true });
    await releaseProbeServer(target);
  });

  it('is judged a fallback when nothing was reserved (--standalone)', () => {
    const rendered = renderAgentLaunchCommand(
      getAgentEventSource('opencode-v2').prepareLaunch({ target, executablePath: 'opencode2', worktreePath: dir })
    );
    expect(rendered).toContain('--standalone');
    const verdict = evaluateOpencodeV2LaunchLine(rendered);
    expect(verdict.ok).toBe(false);
  });
});

describe('probeTool on a --standalone fallback', () => {
  it('fails every check but version, and starts no session', async () => {
    reserveOverride.fail = true;
    const tmux = { newSession: vi.fn(), killSession: vi.fn() };
    const outcome = await probeTool({
      spec: TOOL_PROBE_SPECS['opencode-v2'],
      tmux: tmux as never,
      listener: { forTool: () => [] } as never,
      childEnv: {} as NodeJS.ProcessEnv,
      workRoot: dir,
      selected: () => true,
      deadline: Date.now() + 60_000,
      log: () => undefined,
    });
    expect(tmux.newSession).not.toHaveBeenCalled();
    const byId = Object.fromEntries(outcome.checks.map((check) => [check.checkId, check]));
    expect(byId.version.status).toBe('pass');
    for (const checkId of ['hook-correlation', 'screen-idle', 'screen-running', 'screen-approval', 'screen-quoted-dialog']) {
      expect(byId[checkId]?.status).toBe('fail');
      expect(byId[checkId]?.summary).toContain('--standalone');
    }
  });
});

describe('probeTool on v1 opencode', () => {
  it('still skips hook-correlation', async () => {
    const outcome = await probeTool({
      spec: TOOL_PROBE_SPECS.opencode,
      tmux: {} as never,
      listener: { forTool: () => [] } as never,
      childEnv: {} as NodeJS.ProcessEnv,
      workRoot: dir,
      selected: (checkId: string) => checkId === 'version' || checkId === 'hook-correlation',
      deadline: Date.now() + 60_000,
      log: () => undefined,
    });
    expect(outcome.checks.map((check) => [check.checkId, check.status])).toEqual([
      ['version', 'pass'],
      ['hook-correlation', 'skip'],
    ]);
  });
});
