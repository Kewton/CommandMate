/**
 * OpenCodeV2Tool (Issue #2934, Epic #2370 Phase 1).
 *
 * tmux, the runtime around the server and the submit path are replaced; what is
 * asserted is the order of the lifecycle and what each step hands the next.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.endsWith('_MS') && typeof value === 'number' ? 0 : value,
    ])
  );
});

const calls: string[] = [];

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(async () => {
    calls.push('createSession');
  }),
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_name: string, text: string, enter: boolean) => {
    calls.push(`sendKeys:${text}:${enter}`);
  }),
  sendSpecialKeys: vi.fn(async (_name: string, keys: string[]) => {
    calls.push(`keys:${keys.join(',')}`);
  }),
  killSession: vi.fn(async () => {
    calls.push('killSession');
    return true;
  }),
  exactTarget: (name: string) => `=${name}:`,
  getSessionWorkingDirectory: vi.fn(async () => '/wt'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/hooks/sources/opencode-v2/runtime', () => ({
  opencodeV2Target: (worktreeId: string, instanceId?: string) => ({
    worktreeId,
    cliToolId: 'opencode-v2',
    instanceId,
  }),
  reserveOpencodeV2Server: vi.fn(async () => {
    calls.push('reserve');
    return 4321;
  }),
  attachOpencodeV2EventStream: vi.fn(async () => {
    calls.push('attach');
    return true;
  }),
  resumeOpencodeV2EventStream: vi.fn(async () => {
    calls.push('resume');
    return true;
  }),
  releaseOpencodeV2Server: vi.fn(async () => {
    calls.push('release');
  }),
}));

vi.mock('@/lib/hooks/sources/opencode-v2/ports', () => ({
  getAssignedOpencodeV2Port: vi.fn(() => null),
}));

vi.mock('@/lib/session/agent-session-lifecycle', () => ({
  beginAgentSession: vi.fn(() => {
    calls.push('begin');
  }),
  buildAgentLaunchCommandLine: vi.fn(() => 'LAUNCH-LINE'),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn(async (params: { message: string; cliToolId: string }) => {
    calls.push(`submit:${params.cliToolId}:${params.message}`);
  }),
}));

// Issue #2939: the executable is found on PATH and then asked its version, and
// the path that answered is the path launched. Only `opencode2` is "on PATH"
// here, at a fixed fake location.
const FAKE_OPENCODE2 = '/fake/bin/opencode2';
vi.mock('@/lib/cli-tools/copilot-executable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/copilot-executable')>();
  return {
    ...actual,
    findExecutablesOnPath: vi.fn((name: string) => (name === 'opencode2' ? [FAKE_OPENCODE2] : [])),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.find((arg) => typeof arg === 'function') as
        | ((error: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      const stdout = file === FAKE_OPENCODE2 && args[0] === '--version' ? versionOutput : '';
      queueMicrotask(() => callback?.(null, stdout, ''));
      return {};
    }),
  };
});

import { capturePane, hasSession } from '@/lib/tmux/tmux';
import {
  OpenCodeV2Tool,
  parseOpencodeV2Version,
} from '@/lib/cli-tools/opencode-v2';
import { buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import { clearOpencodeExecutableCache } from '@/lib/cli-tools/opencode-executable';

let versionOutput = 'opencode v2.0.18\n';
const FIXTURES = resolve(__dirname, '../../fixtures/opencode-v2-live-2934');
const BOOT_IDLE = readFileSync(resolve(FIXTURES, 'boot-idle.txt'), 'utf8');

beforeEach(() => {
  calls.length = 0;
  versionOutput = 'opencode v2.0.18\n';
  clearOpencodeExecutableCache();
  vi.mocked(hasSession).mockReset();
  vi.mocked(capturePane).mockReset();
  vi.mocked(capturePane).mockResolvedValue(BOOT_IDLE);
});

describe('identity (D1)', () => {
  it('is opencode-v2 / OpenCode V2 / opencode2', () => {
    const tool = new OpenCodeV2Tool();
    expect([tool.id, tool.name, tool.command]).toEqual(['opencode-v2', 'OpenCode V2', 'opencode2']);
    expect(tool.getSessionName('wt')).toBe('mcbd-opencode-v2-wt');
  });

  it('reads the version `opencode2 --version` prints, and nothing else', () => {
    expect(parseOpencodeV2Version('opencode v2.0.18\n')).toBe('2.0.18');
    expect(parseOpencodeV2Version('1.18.31')).toBeNull();
    expect(parseOpencodeV2Version('something v2.0.18')).toBeNull();
  });

  it('is installed only when the binary answers as OpenCode', async () => {
    expect(await new OpenCodeV2Tool().isInstalled()).toBe(true);
    versionOutput = 'not opencode\n';
    clearOpencodeExecutableCache();
    expect(await new OpenCodeV2Tool().isInstalled()).toBe(false);
  });
});

describe('launch (D2)', () => {
  it('reserves the server, types the wrapper line, waits for the composer, then subscribes', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    await new OpenCodeV2Tool().startSession('wt', '/wt');

    expect(calls).toEqual([
      'begin',
      'createSession',
      'reserve',
      'sendKeys:LAUNCH-LINE:true',
      'attach',
    ]);
    expect(buildAgentLaunchCommandLine).toHaveBeenCalledWith({
      target: { worktreeId: 'wt', cliToolId: 'opencode-v2', instanceId: undefined },
      executablePath: FAKE_OPENCODE2,
      worktreePath: '/wt',
    });
  });

  it('re-subscribes to a live pane instead of launching again', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);

    await new OpenCodeV2Tool().startSession('wt', '/wt');

    expect(calls).toEqual(['resume']);
  });
});

describe('reattach through isRunning (D5)', () => {
  it('re-subscribes a live pane it holds no stream for, once per retry window', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    const tool = new OpenCodeV2Tool();

    expect(await tool.isRunning('wt')).toBe(true);
    expect(await tool.isRunning('wt')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.filter((c) => c === 'resume')).toHaveLength(1);
  });

  it('does nothing for a pane that is not there', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    expect(await new OpenCodeV2Tool().isRunning('wt')).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });
});

describe('send (D6)', () => {
  it('waits for the composer and types into it', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);

    await new OpenCodeV2Tool().sendMessage('wt', 'hello');

    expect(calls).toContain('submit:opencode-v2:hello');
  });

  it('refuses when the composer never shows up', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    // A frame the liveness check accepts (the footer is on it) but with no
    // composer: the wait is what must refuse. Liveness reads the same capture,
    // so the footer stays; only the send's own readiness check is exercised by
    // the empty frame that follows.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(BOOT_IDLE)
      .mockResolvedValue('$ ');

    await expect(new OpenCodeV2Tool().sendMessage('wt', 'hello')).rejects.toThrow(
      /composer not ready/
    );
    expect(calls.some((c) => c.startsWith('submit:'))).toBe(false);
  });

  it('refuses when there is no session', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    await expect(new OpenCodeV2Tool().sendMessage('wt', 'hello')).rejects.toThrow(/does not exist/);
  });
});

describe('kill', () => {
  it('types /exit, then Enter, force-kills a pane that stayed, and releases the server', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);

    await new OpenCodeV2Tool().killSession('wt');

    expect(calls).toEqual(['sendKeys:/exit:false', 'keys:Enter', 'killSession', 'release']);
  });

  it('releases the server even when there was no session', async () => {
    vi.mocked(hasSession).mockResolvedValue(false);

    await new OpenCodeV2Tool().killSession('wt');

    expect(calls).toEqual(['killSession', 'release']);
  });

  it('declares the keystrokes it sends', () => {
    expect(new OpenCodeV2Tool().gracefulExitSequence().keys.map((k) => k.kind === 'literal' ? k.text : k.name)).toEqual([
      '/exit',
      'Enter',
    ]);
  });
});
