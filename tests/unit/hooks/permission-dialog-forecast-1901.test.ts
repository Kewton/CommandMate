/**
 * Issue #1901: a permission hook that fires on every tool call is not a dialog
 * forecast.
 *
 * #1725 read "the adjudicator declined to decide" as "a dialog is about to be
 * drawn" and applied Claude's semantics to every tool that reached
 * `permission-decision-service`. copilot fires `PreToolUse` on **every** tool
 * call and executes most of them straight away — measured on copilot 1.0.80:
 * `Read` at t, `PostToolUse` 0–1 s later, no dialog anywhere — so with Auto-Yes
 * off a forecast was filed for every `Read` / `Grep` / `Bash` of a build. Each
 * one published `waiting / hook_permission_request` for up to
 * `STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS`, which is how `commandmate wait`
 * returned exit 10 with
 * `"the agent reported it via PermissionRequest (no decision) for Read"` while
 * the pane showed no dialog at all. antigravity is wired identically.
 *
 * The fix reads the declared
 * {@link AgentSourceCapabilities.permissionHookPredictsDialog} (#1924, §4 D3
 * decision 1; `docs/design/multi-agent-state-architecture.md` §6.2 names this
 * function), in the same shape #1898 reads `permissionReplyReleasesPrompt`.
 *
 * ## What this suite has to prove, in both directions
 *
 * Skipping the forecast is only safe if the *other* layer still sees a real
 * dialog, so the negative case ("a `Read` no longer publishes `waiting`") is
 * worthless on its own — "never report anything" passes it. Every negative here
 * is therefore paired with a positive:
 *
 *  - a real copilot approval, taken from the **live 1.0.80 frame** #1885
 *    recorded, still resolves to `waiting` through `resolvePromptWaiting` — the
 *    single composition `current-output-builder` and the `send` guard both read;
 *  - claude, which declares `true`, still forecasts exactly as #1725 built it;
 *  - flipping copilot's declared capability to `true` brings the forecast back,
 *    and flipping claude's to `false` takes it away. That mutation is what
 *    separates "the capability is read" from "copilot is hard-coded out".
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  parsePermissionRequestPayload,
  type PermissionRequestPayload,
} from '@/lib/hooks/permission-request-payload';
import { resolvePermissionRequest } from '@/lib/hooks/permission-decision-service';
import { getAgentEventSource, listAgentEventSources } from '@/lib/hooks/sources';
import type { AgentEventSource, AgentSourceCapabilities } from '@/lib/hooks/sources';
import { clearAgentStopEvents, getStructuredPromptWaiting } from '@/lib/session/agent-event-state';
import { resolvePromptWaiting } from '@/lib/session/prompt-waiting-composition';

/** The adjudicator's only database use is the allow audit row; stub it out. */
const created: Array<Record<string, unknown>> = [];
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => {
    created.push(message);
    return { id: 'msg-1', ...message };
  },
}));

/** Policy lookup is a database read behind a TTL cache; nothing suppresses here. */
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  clearAutoYesPolicyCache: () => {},
}));

const WORKTREE_ID = 'wt-1901';
/** ALLOWED_DURATIONS[0]; the default Auto-Yes window. */
const ONE_HOUR_MS = 3_600_000;

const CLAUDE_FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');
const COPILOT_FRAME_DIR = resolve(
  __dirname,
  '../lib/detection/fixtures/copilot-live-1885'
);

function session(cliToolId: CLIToolType) {
  return { worktreeId: WORKTREE_ID, cliToolId, instanceId: cliToolId };
}

/**
 * A `PreToolUse` / `PermissionRequest` payload for one tool call.
 *
 * Built from Claude's captured fixture and re-tooled, which is legitimate for
 * every source here: copilot and antigravity speak the same CamelCase dialect
 * (`hook-event-vocabulary`), and what this suite exercises is the adjudicator,
 * which is tool-independent by construction and receives an already-parsed
 * payload.
 */
function request(toolName: string, toolInput: Record<string, unknown>): PermissionRequestPayload {
  const base = JSON.parse(
    readFileSync(join(CLAUDE_FIXTURE_DIR, 'permission-request.json'), 'utf8')
  ) as Record<string, unknown>;
  const parsed = parsePermissionRequestPayload({
    ...base,
    tool_name: toolName,
    tool_input: toolInput,
  });
  if (!parsed) throw new Error('fixture-derived payload failed to parse');
  return parsed;
}

/** The tool call at the heart of the Issue: copilot reading a file. */
const readNote = () => request('Read', { file_path: '/tmp/proj-cp/note3.txt' });

function forecastFor(cliToolId: CLIToolType) {
  return getStructuredPromptWaiting(WORKTREE_ID, cliToolId, cliToolId);
}

/** Swap one source's declared capabilities for the body of a test. */
function withCapabilities<T>(
  source: AgentEventSource,
  overrides: Partial<AgentSourceCapabilities>,
  body: () => T
): T {
  const declared = source.capabilities;
  Object.defineProperty(source, 'capabilities', {
    value: { ...declared, ...overrides },
    configurable: true,
  });
  try {
    return body();
  } finally {
    Object.defineProperty(source, 'capabilities', { value: declared, configurable: true });
  }
}

/** A live copilot frame, raw with escapes, exactly as #1885 captured it. */
function copilotFrame(name: string): string {
  return readFileSync(join(COPILOT_FRAME_DIR, `${name}.txt`), 'utf-8');
}

/**
 * `resolvePromptWaiting` as `buildCurrentOutput` and the `send` guard call it,
 * with the scraper half derived from a real frame rather than asserted.
 */
function waitingFor(cliToolId: CLIToolType, frame: string) {
  const status = detectSessionStatus(frame, cliToolId);
  return resolvePromptWaiting({
    worktreeId: WORKTREE_ID,
    cliToolId,
    instanceId: cliToolId,
    scraper: {
      status: status.status,
      reason: status.reason,
      hasActivePrompt: status.hasActivePrompt === true,
    },
  });
}

beforeEach(() => {
  created.length = 0;
  clearAllAutoYesStates();
  clearAgentStopEvents();
});

afterEach(() => {
  clearAllAutoYesStates();
  clearAgentStopEvents();
});

describe('a `PreToolUse` that is not a dialog forecast (Issue #1901)', () => {
  it('files nothing for copilot `Read`, so `resolvePromptWaiting` stays clear', () => {
    // The exact reproduction: Auto-Yes off, so the adjudicator abstains with
    // `auto-yes-disabled` — which is what #1725 read as "a dialog is coming".
    const decision = resolvePermissionRequest(session('copilot'), readNote());
    expect(decision.behavior).toBeNull();
    expect(decision.reason).toBe('auto-yes-disabled');

    expect(forecastFor('copilot')).toBeNull();

    // And the composed verdict, which is what `wait --on-prompt agent`,
    // `send`'s guard and the sidebar all read. The frame is copilot mid-turn:
    // the agent is reading a file, nobody is blocked.
    const resolution = waitingFor('copilot', copilotFrame('turn-running-thinking'));
    expect(resolution.waiting).toBe(false);
    expect(resolution.structured).toBeNull();
    expect(resolution.blocksSend).toBe(false);
    expect(resolution.blockedBy).toBeNull();
  });

  it('still resolves to waiting on a real copilot approval dialog', () => {
    // The other half, and the one that makes the first assertion mean
    // something. The forecast is gone, so this can only come from the scraper —
    // which reads it because copilot draws the approval as a box over the
    // bottom of the pane, taking the status bar and the composer away (#1885 /
    // #1886). A live 1.0.80 frame, not a hand-written one.
    const resolution = waitingFor('copilot', copilotFrame('permission-dialog'));

    expect(resolution.waiting).toBe(true);
    expect(resolution.scraperWaiting).toBe(true);
    expect(resolution.blocksSend).toBe(true);
    expect(resolution.blockedBy).toBe('scraper');
  });

  it('files nothing for antigravity, wired the same way', () => {
    resolvePermissionRequest(session('antigravity'), readNote());

    expect(forecastFor('antigravity')).toBeNull();
  });

  it('keeps filing for claude, where a no-decision does mean a dialog', () => {
    // The control. Without it "never report anything" passes this whole file,
    // and #1725's detection — a dialog ~6 s before
    // `Notification(permission_prompt)` announces it — would be gone.
    resolvePermissionRequest(session('claude'), readNote());

    expect(forecastFor('claude')).toMatchObject({
      source: 'permission-request',
      toolName: 'Read',
      confirmedAt: null,
    });
  });
});

describe('the capability is read, not the tool id (Issue #1901)', () => {
  it('forecasts for exactly the sources that declare `permissionHookPredictsDialog`', () => {
    // The registry's own answer, so this cannot drift from #1924's 6x5 table
    // without one of the two suites going red.
    const declared = new Map(
      listAgentEventSources().map((source) => [
        source.cliToolId,
        source.capabilities.permissionHookPredictsDialog,
      ])
    );
    expect(declared.size).toBeGreaterThanOrEqual(6);

    for (const [cliToolId, predicts] of declared) {
      clearAgentStopEvents();
      resolvePermissionRequest(session(cliToolId), readNote());
      expect({ cliToolId, forecast: forecastFor(cliToolId) !== null }).toEqual({
        cliToolId,
        forecast: predicts,
      });
    }
  });

  it('brings the forecast back when copilot declares `true`', () => {
    // The mutation §4 D3 asks for. If this stays green with the value flipped,
    // the gate is a hard-coded tool check and the next tool to grow a
    // fires-on-every-call permission hook re-creates #1901.
    withCapabilities(getAgentEventSource('copilot'), { permissionHookPredictsDialog: true }, () => {
      resolvePermissionRequest(session('copilot'), readNote());
      expect(forecastFor('copilot')).toMatchObject({ source: 'permission-request' });
    });
  });

  it('takes the forecast away when claude declares `false`', () => {
    // The same mutation from the other side: claude is not special-cased in.
    withCapabilities(getAgentEventSource('claude'), { permissionHookPredictsDialog: false }, () => {
      resolvePermissionRequest(session('claude'), readNote());
      expect(forecastFor('claude')).toBeNull();
    });
  });
});

describe('what a skipped forecast does NOT change (Issue #1901)', () => {
  it('still records the allow audit row on a non-forecasting source', () => {
    // Deliberate deviation from the Issue body, which proposed dropping this
    // row for copilot / antigravity too. An allowed request never draws a
    // dialog, so the row is the only record that CommandMate approved a command
    // unattended — the capability is a statement about dialog *prediction*, and
    // the design policy's discoverability rule (§7) is what makes deleting the
    // audit trail the wrong trade. Noise is the cost; invisibility is not.
    setAutoYesEnabled(WORKTREE_ID, 'copilot', true, ONE_HOUR_MS);

    const decision = resolvePermissionRequest(
      session('copilot'),
      request('Bash', { command: 'npm test', description: 'run the suite' })
    );

    expect(decision.behavior).toBe('allow');
    expect(forecastFor('copilot')).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ worktreeId: WORKTREE_ID, cliToolId: 'copilot' });
  });

  it('still returns the same verdict a non-forecasting source would have had', () => {
    // The gate is on the reporting side only. A source that stops forecasting
    // must not start (or stop) allowing anything: the response body the agent
    // is blocked on is unchanged.
    const before = resolvePermissionRequest(session('copilot'), readNote());
    const claude = resolvePermissionRequest(session('claude'), readNote());

    expect(before).toEqual(claude);
  });
});
