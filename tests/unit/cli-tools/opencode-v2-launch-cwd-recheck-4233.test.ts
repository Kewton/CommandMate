/**
 * Issue #4233 (integration review P2): the launch cwd a relative
 * `XDG_CONFIG_HOME` / `HOME` was resolved against is checked again right before
 * the launch line is typed.
 *
 * The composition checks the pane's cwd, then `launchSession` awaits the
 * executable, the pane's geometry and the server's port; the pane's terminal can
 * `cd` meanwhile (`ws-server.ts` terminal input). The line is not changed (no
 * `cd` added), so the launch is refused instead.
 * docs/design/relative-config-home-4233.md §8.2.
 *
 * tmux and the server runtime are replaced as in `opencode-v2.test.ts`; the "cd"
 * is the pane cwd reader answering another directory once the port is reserved.
 * Only reads, apart from the fixtures made under `os.tmpdir()`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, name.endsWith('_MS') && typeof value === 'number' ? 0 : value])
  );
});

const state = vi.hoisted(() => ({
  calls: [] as string[],
  paneCwd: '' as string,
  cdTo: null as string | null,
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(async () => true),
  createSession: vi.fn(async () => {
    state.calls.push('createSession');
  }),
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_name: string, text: string, enter: boolean) => {
    state.calls.push(`sendKeys:${text}:${enter}`);
  }),
  sendSpecialKeys: vi.fn(async () => undefined),
  killSession: vi.fn(async () => true),
  exactTarget: (name: string) => `=${name}:`,
  getSessionWorkingDirectory: vi.fn(async () => state.paneCwd),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode-v2/runtime', () => ({
  opencodeV2Target: (worktreeId: string, instanceId?: string) => ({ worktreeId, cliToolId: 'opencode-v2', instanceId }),
  reserveOpencodeV2Server: vi.fn(async () => {
    state.calls.push('reserve');
    // The terminal's `cd`, while the launch awaits the port.
    if (state.cdTo !== null) state.paneCwd = state.cdTo;
    return 4321;
  }),
  attachOpencodeV2EventStream: vi.fn(async () => true),
  resumeOpencodeV2EventStream: vi.fn(async () => true),
  releaseOpencodeV2Server: vi.fn(async () => undefined),
}));
vi.mock('@/lib/hooks/sources/opencode-v2/ports', () => ({ getAssignedOpencodeV2Port: vi.fn(() => null) }));
vi.mock('@/lib/session/agent-session-lifecycle', () => ({
  beginAgentSession: vi.fn(() => {
    state.calls.push('begin');
  }),
  buildAgentLaunchCommandLine: vi.fn(() => 'LAUNCH-LINE'),
}));
vi.mock('@/lib/cli-tools/opencode-executable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/opencode-executable')>();
  return {
    ...actual,
    resolveOpencodeV2Executable: vi.fn(async () => ({ executable: { path: '/fake/bin/opencode2' } })),
  };
});
// A test run has no pane reader (`pane-env.ts`); this one reads the modelled pane.
vi.mock('@/lib/agent-roles/pane-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-roles/pane-env')>();
  return { ...actual, roleLaunchCwdReaderForPane: vi.fn(() => async () => state.paneCwd) };
});

import { OpenCodeV2Tool } from '@/lib/cli-tools/opencode-v2';
import { fixedEnvReader, loadRoleComposition } from '@/lib/agent-roles/composition';
import { runWithLaunchRole, type LaunchRoleSnapshot } from '@/lib/session/role-launch';
import { RoleLaunchRefusedError } from '@/lib/agent-roles/launch-errors';

let worktree: string;
let elsewhere: string;
let fakeHome: string;

const LAUNCHED = "sendKeys:clear 2>/dev/null; printf '\\033[3J'; LAUNCH-LINE:true";

function snapshotWith(composition: LaunchRoleSnapshot['composition']): LaunchRoleSnapshot {
  return Object.freeze({
    target: { worktreeId: 'wt-4233', cliToolId: 'opencode-v2' as const },
    db: null as never,
    resolution: null,
    membership: null,
    composition,
    injection: null,
    injectionFingerprint: null,
    refusal: null,
  });
}

/** Compose the way a reused pane's launch does: from the pane's env and cwd. */
function compose(env: Record<string, string>) {
  return loadRoleComposition('opencode-v2', {
    worktreePath: worktree,
    readEnv: fixedEnvReader(env),
    readLaunchCwd: async () => state.paneCwd,
  });
}

function launch(snapshot: LaunchRoleSnapshot): Promise<void> {
  const tool = new OpenCodeV2Tool() as unknown as {
    launchSession: (worktreeId: string, worktreePath: string) => Promise<void>;
    isToolLive: () => Promise<boolean>;
    reconcileExistingSession: () => Promise<void>;
    waitForReady: () => Promise<boolean>;
  };
  // A reused pane back at its shell (#2070 relaunch path).
  vi.spyOn(tool, 'isToolLive').mockResolvedValue(false);
  vi.spyOn(tool, 'reconcileExistingSession').mockResolvedValue(undefined);
  vi.spyOn(tool, 'waitForReady').mockResolvedValue(true);
  return runWithLaunchRole(snapshot, () => tool.launchSession('wt-4233', worktree));
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'cm-4233-recheck-worktree-'));
  elsewhere = mkdtempSync(join(tmpdir(), 'cm-4233-recheck-cd-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'cm-4233-recheck-home-'));
  for (const base of [worktree, elsewhere]) {
    mkdirSync(join(base, 'rel-xdg', 'opencode'), { recursive: true });
    writeFileSync(join(base, 'rel-xdg', 'opencode', 'opencode.json'), JSON.stringify({ default_agent: 'plan' }));
  }
  state.calls.length = 0;
  state.paneCwd = worktree;
  state.cdTo = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [worktree, elsewhere, fakeHome]) rmSync(dir, { recursive: true, force: true });
});

describe('the composition names the cwd it depended on (Issue #4233)', () => {
  it('a relative XDG_CONFIG_HOME pins the worktree', async () => {
    const composition = await compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome });
    expect(composition.opencodeV2LaunchCwd).toBe(worktree);
  });

  it('an absolute one pins nothing', async () => {
    const composition = await compose({ XDG_CONFIG_HOME: join(worktree, 'rel-xdg'), HOME: fakeHome });
    expect(composition).not.toHaveProperty('opencodeV2LaunchCwd');
  });
});

describe('the launch line is typed only while the pane is still in the worktree (Issue #4233)', () => {
  it('positive: cwd checked, then the terminal cds, then the launch: refused, nothing typed', async () => {
    const composition = await compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome });
    state.cdTo = elsewhere;

    const error = await launch(snapshotWith(composition)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/is not the worktree/);
    expect((error as Error).message).toContain(new RoleLaunchRefusedError('composition-failed', '').message.trim());
    expect(state.calls).toContain('reserve');
    expect(state.calls.filter((call) => call.startsWith('sendKeys'))).toEqual([]);
  });

  it('negative: no cd, the same line as before is typed', async () => {
    const composition = await compose({ XDG_CONFIG_HOME: 'rel-xdg', HOME: fakeHome });

    await launch(snapshotWith(composition));
    expect(state.calls.filter((call) => call.startsWith('sendKeys'))).toEqual([LAUNCHED]);
  });

  it('negative: an absolute XDG_CONFIG_HOME is not checked again, so a cd changes nothing', async () => {
    const composition = await compose({ XDG_CONFIG_HOME: join(worktree, 'rel-xdg'), HOME: fakeHome });
    state.cdTo = elsewhere;

    await launch(snapshotWith(composition));
    expect(state.calls.filter((call) => call.startsWith('sendKeys'))).toEqual([LAUNCHED]);
  });
});
