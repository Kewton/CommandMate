/**
 * The variant travelling from the stream to the launch line (Issue #2048).
 *
 * Two wirings, and each one exists because a measurement said the obvious
 * alternative does not work (`docs/design/opencode-server-live-verification.md`
 * §20):
 *
 *  - **stream -> effort latch.** The variant rides on `session.updated` and on
 *    `message.updated`, neither of which maps to any of the seven event words,
 *    so it has to be read in `deliver` beside #2040's session record. The pane
 *    never prints it, so this is the only way any surface can show it.
 *  - **settings -> launch line.** `--agent` and `--model` go on the command
 *    line; `--variant` must not, because the TUI has no such flag and exits when
 *    given one.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    probeOpencodeHealth: vi.fn(),
    openOpencodeEventStream: vi.fn(),
  };
});

import {
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource, prepareOpencodeLaunch } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  discardAgentEventState,
  getLastReportedAgentEffort,
} from '@/lib/session/agent-event-state';
import {
  rememberOpencodeLaunchSettings,
  resetOpencodeLaunchSettings,
} from '@/lib/hooks/sources/opencode/launch-settings';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetAgentSessionTelemetry } from '@/lib/hooks/agent-session-telemetry';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const SESSION_UPDATED = JSON.parse(
  readFileSync(join(FIXTURES, 'session-updated-variant-2048.json'), 'utf8')
) as { withVariant: OpencodeFrame; withoutVariant: OpencodeFrame };
const MESSAGE_UPDATED = JSON.parse(
  readFileSync(join(FIXTURES, 'message-updated-variant-2048.json'), 'utf8')
) as OpencodeFrame;

const TARGET = { worktreeId: 'wt-2048-wire', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4849;

let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];
/**
 * A sandbox for the two files this test writes.
 *
 * `rememberOpencodePort` and `rememberOpencodeLaunchSettings` both persist under
 * `~/.commandmate`, which is the operator's own running server's state. A test
 * that writes there leaves entries for a worktree that does not exist, in files
 * a real CommandMate reads — so the env overrides are not tidiness, they are the
 * difference between a unit test and a side effect.
 */
let sandbox: string;

function streamOf(...frames: OpencodeFrame[]) {
  return () =>
    (async function* (): AsyncGenerator<OpencodeFrame> {
      for (const each of frames) yield each;
    })();
}

function silentStream(signal: AbortSignal) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

function subscribe() {
  return openOpencodeSubscription(
    TARGET,
    (event) => received.push(event),
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT }
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cm-2048-ports-'));
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv(
    'CM_OPENCODE_LAUNCH_SETTINGS_FILE',
    join(sandbox, 'opencode-launch-settings.json')
  );
  vi.clearAllMocks();
  resetOpencodeSubscriptions();
  resetOpencodeToolCalls();
  resetUnknownEventTallies();
  resetAgentSessionTelemetry();
  resetOpencodeLaunchSettings();
  resetOpencodePortAssignments();
  discardAgentEventState(TARGET.worktreeId, 'opencode', 'opencode');
  queued = [];
  received = [];
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: '1.18.22' },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => (queued.shift() ?? silentStream(signal))(signal)
  );
});

afterEach(() => {
  resetOpencodeSubscriptions();
  resetAgentSessionTelemetry();
  resetOpencodeLaunchSettings();
  resetOpencodePortAssignments();
  discardAgentEventState(TARGET.worktreeId, 'opencode', 'opencode');
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('the stream fills the effort latch (Issue #2048)', () => {
  it('reads `Session.model.variant` off a live session.updated frame', async () => {
    queued.push(streamOf(SESSION_UPDATED.withVariant));
    await subscribe();

    await vi.waitFor(() =>
      expect(getLastReportedAgentEffort(TARGET.worktreeId, 'opencode', 'opencode')).toBe('high')
    );
  });

  it('reads the flat `info.variant` off a live message.updated frame', async () => {
    queued.push(streamOf(MESSAGE_UPDATED));
    await subscribe();

    await vi.waitFor(() =>
      expect(getLastReportedAgentEffort(TARGET.worktreeId, 'opencode', 'opencode')).toBe('high')
    );
  });

  it('does not clear the latch on the frames that carry no variant', async () => {
    queued.push(streamOf(SESSION_UPDATED.withVariant, SESSION_UPDATED.withoutVariant));
    await subscribe();

    await vi.waitFor(() =>
      expect(getLastReportedAgentEffort(TARGET.worktreeId, 'opencode', 'opencode')).toBe('high')
    );
  });
});

describe('prepareOpencodeLaunch with instance settings (Issue #2048)', () => {
  const context = {
    target: TARGET,
    executablePath: 'opencode',
    worktreePath: '/tmp/wt-2048-wire',
  };

  it('is byte-identical to pre-#2048 for an instance nobody configured', () => {
    rememberOpencodePort(TARGET, PORT, '/tmp/wt-2048-wire');
    expect(prepareOpencodeLaunch(context).command).toBe(
      `'opencode' --port ${PORT} --hostname 127.0.0.1`
    );
  });

  it('appends the two flags the TUI declares', () => {
    rememberOpencodePort(TARGET, PORT, '/tmp/wt-2048-wire');
    rememberOpencodeLaunchSettings(TARGET, {
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    });
    expect(prepareOpencodeLaunch(context).command).toBe(
      `'opencode' --port ${PORT} --hostname 127.0.0.1 --agent 'plan' --model 'github-copilot/claude-sonnet-4.6'`
    );
  });

  it('NEVER puts --variant on the line, even when that is the only setting', () => {
    rememberOpencodePort(TARGET, PORT, '/tmp/wt-2048-wire');
    rememberOpencodeLaunchSettings(TARGET, {
      agent: null,
      providerId: null,
      modelId: null,
      variant: 'high',
    });
    const command = prepareOpencodeLaunch(context).command;
    expect(command).not.toContain('variant');
    expect(command).toBe(`'opencode' --port ${PORT} --hostname 127.0.0.1`);
  });

  it('stays bare when there is no port — a launch with no server gains no flags', () => {
    rememberOpencodeLaunchSettings(TARGET, {
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: null,
    });
    expect(prepareOpencodeLaunch(context)).toEqual({
      command: 'opencode',
      settingsPath: null,
      env: {},
    });
  });
});
