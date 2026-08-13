/**
 * The generation fence as a shared helper (Issue #1759, seam S8).
 *
 * Before this Issue `beginAgentEventGeneration` had exactly one caller in the
 * whole codebase — `claude-session.ts`, on the creation path. That was correct
 * and also a trap: every other tool starts through its own `startSession` in
 * `src/lib/cli-tools/<tool>.ts`, so the moment Phase 4-2 makes codex emit
 * events, codex inherits the previous codex process's verdict on every restart
 * and nothing warns anyone. The fence had to stop being Claude's private call.
 *
 * What the fence buys, and therefore what these tests are really about: events
 * are keyed by (worktree, tool, instance), a key a recreated session reuses
 * verbatim. Without a fence the *old* process's last `user_prompt_submit` reads
 * as the new one's, and a session nobody has typed into publishes `running`
 * (#1723).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  beginAgentSession,
  prepareAgentLaunch,
} from '@/lib/session/agent-session-lifecycle';
import {
  getAgentEventGenerationStartedAt,
  getStructuredSessionState,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { CLAUDE_CLI_TOOL_ID } from '@/lib/hooks/sources';

const WT = 'wt-fence';
const NOW = 1_700_000_000_000;

beforeEach(() => {
  // The state modules hang off globalThis, so a leftover generation from an
  // earlier file in this worker would make these pass for the wrong reason.
  globalThis.__agentEventGenerationStartedAt?.clear();
  globalThis.__agentEventLast?.clear();
});

describe('beginAgentSession', () => {
  it('opens a generation for the instance it is given', () => {
    expect(getAgentEventGenerationStartedAt(WT, 'claude', 'claude')).toBeNull();

    beginAgentSession({ worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude' }, NOW);

    expect(getAgentEventGenerationStartedAt(WT, 'claude', 'claude')).toBe(NOW);
  });

  it('fences off the previous process’s events for that instance', () => {
    // An event from the process that just died…
    recordAgentEvent(WT, 'claude', 'claude', {
      event: 'user_prompt_submit',
      at: NOW - 5_000,
      detail: null,
      sessionId: 'old-session',
      message: null,
    });
    expect(getStructuredSessionState(WT, 'claude', 'claude', NOW)).not.toBeNull();

    // …is not the new process's, even though the key is identical.
    beginAgentSession({ worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude' }, NOW);

    expect(getStructuredSessionState(WT, 'claude', 'claude', NOW)).toBeNull();
  });

  it('fences instances independently', () => {
    // `claude` and `claude-2` share a worktree and a directory; restarting one
    // must not discard the other's verdict.
    beginAgentSession(
      { worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude-2' },
      NOW
    );

    expect(getAgentEventGenerationStartedAt(WT, 'claude', 'claude-2')).toBe(NOW);
    expect(getAgentEventGenerationStartedAt(WT, 'claude', 'claude')).toBeNull();
  });

  it('works for a tool that has no source of its own yet', () => {
    // The point of the helper: a `startSession` in `src/lib/cli-tools/codex.ts`
    // can call it today, before #1760 gives codex a source, and get a fence.
    beginAgentSession({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, NOW);
    expect(getAgentEventGenerationStartedAt(WT, 'codex', 'codex')).toBe(NOW);
  });

  it('defaults the instance to the primary', () => {
    beginAgentSession({ worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID }, NOW);
    expect(getAgentEventGenerationStartedAt(WT, 'claude')).toBe(NOW);
  });
});

describe('prepareAgentLaunch', () => {
  it('routes through the tool’s source', () => {
    // Claude's writes a settings file and appends `--settings`; the assertion
    // is on the shape rather than the path, which
    // `hook-settings-generator.test.ts` owns byte for byte.
    const plan = prepareAgentLaunch(
      { worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude' },
      '/usr/local/bin/claude'
    );
    expect(plan.command).toMatch(/^'\/usr\/local\/bin\/claude' --settings '.+\.json'$/);
    expect(plan.settingsPath).toMatch(/\.json$/);
  });

  it('returns the bare executable for a tool CommandMate injects nothing into', () => {
    const plan = prepareAgentLaunch(
      { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
      '/usr/local/bin/codex'
    );
    expect(plan.command).toBe('/usr/local/bin/codex');
    expect(plan.settingsPath).toBeNull();
  });

  it('never throws when the config cannot be written', () => {
    // Fail-open: hooks are an enhancement to a session that has to start
    // anyway. An unwritable directory costs the events, not the session.
    //
    // The unwritable path is "a directory whose parent is a regular file".
    // A regular file cannot have children, so `mkdirSync(…, {recursive:true})`
    // throws ENOTDIR immediately on every OS (measured: macOS/node 24 0ms,
    // Linux/node 18 1ms).
    //
    // **Never use a path under /proc, /sys or /dev here.** This case used to say
    // `/proc/definitely-not-writable/cmate`, and it hung PR #1773's CI for
    // 5h31m. On macOS `/proc` does not exist, so the call throws at once and the
    // test is green — the failure is *unreproducible locally by construction*.
    // On Linux `/proc` does exist, and procfs answers a mkdir for a child that
    // cannot exist with **ENOENT rather than EPERM**. Node's recursive mkdir
    // reads ENOENT as "the parent is missing", creates the parent and retries,
    // forever, inside C++: a synchronous spin at 100% CPU with flat memory. The
    // event loop never turns, so vitest's own 5s testTimeout cannot fire and
    // there is no OOM either — the job just goes silent. `tests/unit/guards/
    // no-procfs-env-fixtures.test.ts` now fails if anyone reintroduces it.
    const previous = process.env.CM_AGENT_HOOKS_DIR;
    const blockerDir = mkdtempSync(join(tmpdir(), 'cmate-fence-'));
    const blocker = join(blockerDir, 'not-a-dir');
    writeFileSync(blocker, '');
    process.env.CM_AGENT_HOOKS_DIR = join(blocker, 'cmate');
    try {
      const plan = prepareAgentLaunch(
        { worktreeId: WT, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId: 'claude' },
        '/usr/local/bin/claude'
      );
      expect(plan.command).toBe('/usr/local/bin/claude');
      expect(plan.settingsPath).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CM_AGENT_HOOKS_DIR;
      else process.env.CM_AGENT_HOOKS_DIR = previous;
      removeTempDir(blockerDir);
    }
  });
});
