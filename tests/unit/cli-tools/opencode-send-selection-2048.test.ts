/**
 * The instance's settings riding on the prompt CommandMate posts (Issue #2048).
 *
 * There are two facts here and the second one is a defect this Issue found
 * rather than a feature it added. Both were measured on opencode 1.18.22 in an
 * isolated `HOME` (`docs/design/opencode-server-live-verification.md` §20.5):
 *
 *  1. **`variant` on `prompt_async` works**, and it is the only channel that
 *     applies one — the TUI has no `--variant` flag. `message.updated.info.variant`
 *     came back `high` for a body that carried it.
 *  2. **`agent` on `prompt_async` is not optional in the way it looks.** A body
 *     with no `agent` ran the turn as `build` **on a pane launched
 *     `--agent plan`**, and the pane's own step row printed `Build · …` for that
 *     turn. So CommandMate's send path has, since #2035, been quietly reverting
 *     a `plan` pane to `build` on every message it posted. Sending the
 *     configured agent is what fixes it; omitting the key entirely is what keeps
 *     an *unconfigured* instance on the behaviour it has today.
 *
 * The unconfigured case is therefore the load-bearing test: the body must be
 * byte-identical to the pre-#2048 one, or every operator who never opens the
 * settings pane gets a behaviour change they did not ask for.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: vi.fn((name: string) => `=${name}:`),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>();
  return { ...actual, getAssignedOpencodePort: vi.fn() };
});

vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>();
  return {
    ...actual,
    getOpencodeLiveness: vi.fn(),
    getOpencodePrimarySession: vi.fn(),
  };
});

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import {
  getOpencodeLiveness,
  getOpencodePrimarySession,
} from '@/lib/hooks/sources/opencode/subscription';
import {
  rememberOpencodeLaunchSettings,
  resetOpencodeLaunchSettings,
} from '@/lib/hooks/sources/opencode/launch-settings';
import { hasSession } from '@/lib/tmux/tmux';

const PORT = 4850;
const SESSION = 'ses_fc4662465ffe50IgIV21rnzYjG';
const WORKTREE = 'wt-2048-send';
const BODY = 'Reply with exactly this text and nothing else: hello-2048';

const TARGET = { worktreeId: WORKTREE, cliToolId: 'opencode' as const, instanceId: 'opencode' };

let sandbox: string;
let tool: OpenCodeTool;
const originalFetch = globalThis.fetch;

function stubHappyPath() {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, status: 204, headers: new Headers(), json: async () => undefined };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        info: { id: 'msg', role: 'user' },
        parts: [{ type: 'text', text: BODY }],
      }),
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
  ) as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cm-2048-send-'));
  vi.stubEnv('CM_OPENCODE_LAUNCH_SETTINGS_FILE', join(sandbox, 'opencode-launch-settings.json'));
  resetOpencodeLaunchSettings();
  vi.clearAllMocks();
  vi.mocked(hasSession).mockResolvedValue(true);
  vi.mocked(getAssignedOpencodePort).mockReturnValue(PORT);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 });
  vi.mocked(getOpencodePrimarySession).mockReturnValue(SESSION);
  tool = new OpenCodeTool();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOpencodeLaunchSettings();
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('Issue #2048: prompt_async carries the instance s settings', () => {
  it('sends NOTHING extra for an instance nobody configured', async () => {
    const fetchMock = stubHappyPath();

    await tool.sendMessage(WORKTREE, BODY);

    const body = postedBody(fetchMock);
    expect(Object.keys(body).sort()).toEqual(['messageID', 'parts']);
    expect(body).not.toHaveProperty('agent');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('variant');
  });

  it('sends the persona, the model and the variant when they are configured', async () => {
    rememberOpencodeLaunchSettings(TARGET, {
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    });
    const fetchMock = stubHappyPath();

    await tool.sendMessage(WORKTREE, BODY);

    expect(postedBody(fetchMock)).toMatchObject({
      agent: 'plan',
      model: { providerID: 'github-copilot', modelID: 'claude-sonnet-4.6' },
      variant: 'high',
    });
  });

  it('sends the variant alone — the setting with no other channel', async () => {
    rememberOpencodeLaunchSettings(TARGET, {
      agent: null,
      providerId: null,
      modelId: null,
      variant: 'max',
    });
    const fetchMock = stubHappyPath();

    await tool.sendMessage(WORKTREE, BODY);

    const body = postedBody(fetchMock);
    expect(body.variant).toBe('max');
    expect(body).not.toHaveProperty('agent');
    expect(body).not.toHaveProperty('model');
  });

  it('reads the settings of the instance being sent to, not of the primary one', async () => {
    rememberOpencodeLaunchSettings(TARGET, {
      agent: 'plan',
      providerId: null,
      modelId: null,
      variant: null,
    });
    rememberOpencodeLaunchSettings(
      { ...TARGET, instanceId: 'opencode-2' },
      { agent: 'build', providerId: null, modelId: null, variant: 'low' }
    );
    const fetchMock = stubHappyPath();

    await tool.sendMessage(WORKTREE, BODY, 'opencode-2');

    expect(postedBody(fetchMock)).toMatchObject({ agent: 'build', variant: 'low' });
  });
});
