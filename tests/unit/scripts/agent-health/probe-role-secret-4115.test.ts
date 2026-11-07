/**
 * Issue #4115: a probe logs the line it launches, and a pane shows it. With a test
 * role and an env of the user's, neither may hold what the user set.
 *
 * `execFile` is replaced so `--version` answers without a CLI. No tmux runs here.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      queueMicrotask(() => callback?.(null, { stdout: 'opencode 1.18.35\n', stderr: '' }));
      return {};
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const { probeTool } = await import('../../../../scripts/agent-health/probe-tool');
const { TOOL_PROBE_SPECS } = await import('../../../../scripts/agent-health/tool-table');

const SECRET = 'SECRET_KEY_4115';

let dir: string;
beforeEach(() => {
  dir = makeTempDir('cm-4115-probe-role-');
});
afterEach(() => {
  removeTempDir(dir);
});

async function run(childEnv: Record<string, string>) {
  const logged: string[] = [];
  let command = '';
  let fileDuring: boolean | null = null;
  const tmux = {
    newSession: vi.fn(async (options: { command: string }) => {
      command = options.command;
      const file = /\$\(cat '([^']+)'\)/.exec(command)?.[1];
      fileDuring = file ? fs.existsSync(file) : null;
      throw new Error('stop here: the launch line is what is under test');
    }),
    killSession: vi.fn(async () => undefined),
  };
  await probeTool({
    spec: TOOL_PROBE_SPECS.opencode,
    tmux: tmux as never,
    listener: { forTool: () => [] } as never,
    childEnv: childEnv as unknown as NodeJS.ProcessEnv,
    workRoot: dir,
    selected: (checkId: string) => checkId === 'version' || checkId === 'screen-idle',
    deadline: Date.now() + 60_000,
    log: (message: string) => logged.push(message),
    role: { id: 'probe-role', body: 'ROLE_BODY_4115' },
  }).catch(() => undefined);
  return { logged, command, fileDuring };
}

describe('a probe with a test role', () => {
  it('with the user\'s env: their values are on neither the line nor the log, and the file is removed', async () => {
    const { logged, command, fileDuring } = await run({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { p: { options: { apiKey: SECRET } } } }),
    });
    expect(command).toContain('OPENCODE_CONFIG_CONTENT="$(cat ');
    expect(command).not.toContain(SECRET);
    expect(logged.join('\n')).toContain('launching');
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(fileDuring).toBe(true);
    const file = /\$\(cat '([^']+)'\)/.exec(command)?.[1] as string;
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(join(dir, 'role-artifacts', 'launch-env'))).toEqual([]);
  });

  it('never has the body on the line, with or without an env of the user\'s', async () => {
    const { logged, command } = await run({});
    expect(command).toContain('OPENCODE_CONFIG_CONTENT=');
    expect(command).not.toContain('$(cat');
    expect(command).not.toContain('ROLE_BODY_4115');
    expect(logged.join('\n')).not.toContain('ROLE_BODY_4115');
  });
});
