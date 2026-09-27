/**
 * Issue #2878: every tmux process the agent-health driver starts is pinned to
 * `-L cm-agent-health` and runs without `TMUX` in its environment. The real
 * `execFile` is replaced, so no tmux runs here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

const calls: Call[] = [];
/** What the fake `display-message -p '#{socket_path}'` answers: a path inside the test's temp dir. */
let fakeSocketPath = '';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn(
    (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ file, args, env: options?.env });
      const stdout = args.includes('display-message') ? `${fakeSocketPath}\n` : '';
      queueMicrotask(() => callback?.(null, { stdout, stderr: '' }));
      return { stdin: { end: () => undefined } };
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

let dir: string;

beforeEach(() => {
  calls.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-driver-'));
  fakeSocketPath = path.join(dir, 'cm-agent-health');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AgentHealthTmux', () => {
  it('pins every tmux invocation to -L cm-agent-health and strips TMUX', async () => {
    const { AgentHealthTmux } = await import('../../../../scripts/agent-health/tmux-driver');
    const { buildChildEnv } = await import('@/lib/agent-health/tmux-command');
    const env = buildChildEnv({ PATH: '/usr/bin', TMUX: '/private/tmp/tmux-501/default,1,2' });
    const tmux = new AgentHealthTmux(env, dir);

    await tmux.isServerRunning();
    await tmux.newSession({ sessionName: 'agent-health-claude', workingDirectory: dir, width: 200, height: 1000, command: 'claude' });
    await tmux.newSession({ sessionName: 'agent-health-codex', workingDirectory: dir, width: 200, height: 1000, command: 'codex' });
    await tmux.capture('agent-health-claude', 1000);
    await tmux.sendKey('agent-health-claude', 'Enter');
    await tmux.typeText('agent-health-claude', 'Run the shell command: sleep 20');
    await tmux.pasteText('agent-health-claude', 'line 1\nline 2');
    await tmux.killSession('agent-health-claude');
    fs.writeFileSync(fakeSocketPath, '');
    await tmux.teardown();
    // The (fake) socket file of the private server is removed with it.
    expect(fs.existsSync(fakeSocketPath)).toBe(false);

    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call.file).toBe('tmux');
      expect(call.args.slice(0, 2)).toEqual(['-L', 'cm-agent-health']);
      expect(call.env).toBeDefined();
      expect(call.env).not.toHaveProperty('TMUX');
    }
    // The config file is applied exactly once — to the call that starts the server.
    const withConfig = calls.filter((call) => call.args.includes('-f'));
    expect(withConfig).toHaveLength(1);
    expect(withConfig[0].args).toContain('new-session');
    // Keys and text target one session exactly.
    const sends = calls.filter((call) => call.args.includes('send-keys'));
    for (const call of sends) expect(call.args).toContain('=agent-health-claude:');
    // Literal text goes through `-l --`.
    const literal = sends.find((call) => call.args.includes('-l'))!;
    expect(literal.args.slice(-3)).toEqual(['-l', '--', 'Run the shell command: sleep 20']);
  });
});
