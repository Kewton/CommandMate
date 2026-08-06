/**
 * Auto-Yes v2 adjudication (Issue #1724).
 *
 * The asymmetry that shapes every assertion here: a wrong `allow` runs a shell
 * command, a wrong no-decision costs a dialog. So the suite is not organised
 * around "does it allow the right things" — it is organised around the branches
 * that must *not* allow, and each of them is asserted against a control case in
 * the same describe block that does allow. Without the control, "no decision"
 * passes just as happily when the wiring is dead.
 *
 * Two properties get extra weight:
 *
 *  - **Issue #1699 non-recurrence.** The deny surface is the current request's
 *    `tool_input` and nothing else. The old bug matched deny patterns against a
 *    scrollback window, so one approved `rm -rf` suppressed every later prompt
 *    — including unrelated edits — until the line scrolled off, and a worker
 *    went silent for an hour. Asserted twice: on the collector directly, and as
 *    a sequence where the second request is allowed while the first is still
 *    the most recent recorded suppression.
 *  - **The hook is never more permissive than the poller.** `mode: safe`
 *    suppresses a permission dialog on screen (it is a multiple_choice prompt),
 *    so it must suppress here too.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  clearAllAutoYesStates,
  setAutoYesEnabled,
  disableAutoYes,
} from '@/lib/auto-yes-state';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  collectToolInputMatchTexts,
  parsePermissionRequestPayload,
  type PermissionRequestPayload,
} from '@/lib/hooks/permission-request-payload';
import {
  decidePermissionRequest,
  resolvePermissionRequest,
  PERMISSION_REQUEST_PROMPT_TYPE,
  type PermissionRequestSession,
} from '@/lib/hooks/permission-decision-service';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import {
  clearAgentStopEvents,
  getAskUserQuestion,
  getStructuredPromptWaiting,
} from '@/lib/session/agent-event-state';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

/** The adjudicator's only database use is the allow audit row; stub it out. */
const created: Array<Record<string, unknown>> = [];
let auditFailure: Error | null = null;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => {
    if (auditFailure) throw auditFailure;
    created.push(message);
    return { id: 'msg-1', ...message };
  },
}));

/** Policy lookup is a database read behind a TTL cache; drive it directly. */
let policy: AutoYesPolicy | null = null;
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => policy,
  clearAutoYesPolicyCache: () => {},
}));

/** ALLOWED_DURATIONS[0]; the default Auto-Yes window. */
const ONE_HOUR_MS = 3_600_000;

const SESSION: PermissionRequestSession = {
  worktreeId: 'wt-1724',
  cliToolId: 'claude',
  instanceId: 'claude',
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

/** A payload with the fixture's shape and a caller-chosen tool call. */
function request(toolName: string, toolInput: Record<string, unknown>): PermissionRequestPayload {
  const base = fixture('permission-request.json') as Record<string, unknown>;
  const parsed = parsePermissionRequestPayload({
    ...base,
    tool_name: toolName,
    tool_input: toolInput,
  });
  if (!parsed) throw new Error('fixture-derived payload failed to parse');
  return parsed;
}

const bash = (command: string) => request('Bash', { command, description: 'run a command' });

function makePolicy(overrides: Partial<AutoYesPolicy> = {}): AutoYesPolicy {
  return { mode: null, allowPromptTypes: [], denyPatterns: [], ...overrides };
}

function enableAutoYes(): void {
  setAutoYesEnabled(SESSION.worktreeId, SESSION.cliToolId, true, ONE_HOUR_MS);
}

beforeEach(() => {
  created.length = 0;
  auditFailure = null;
  policy = null;
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('the adjudication table', () => {
  it('allows when Auto-Yes is on and nothing suppresses it', () => {
    enableAutoYes();

    expect(decidePermissionRequest(SESSION, bash('git status'))).toMatchObject({
      behavior: 'allow',
      reason: 'auto-yes',
    });
  });

  it('makes no decision when Auto-Yes was never enabled', () => {
    expect(decidePermissionRequest(SESSION, bash('git status'))).toEqual({
      behavior: null,
      reason: 'auto-yes-disabled',
    });
  });

  it('makes no decision when Auto-Yes has been switched off mid-window', () => {
    enableAutoYes();
    disableAutoYes(SESSION.worktreeId, SESSION.cliToolId, 'stop_pattern_matched');

    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();
  });

  it('makes no decision for another instance of the same worktree', () => {
    // Auto-Yes is per (worktree, tool, instance). An approval leaking across
    // instances would approve for a session nobody armed.
    enableAutoYes();

    expect(decidePermissionRequest({ ...SESSION, instanceId: 'claude-2' }, bash('git status')))
      .toMatchObject({ behavior: null, reason: 'auto-yes-disabled' });
  });

  it('makes no decision for a payload it cannot read', () => {
    enableAutoYes();

    for (const body of [
      null,
      undefined,
      'not an object',
      {},
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'PermissionRequest', tool_input: { command: 'ls' } },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: 'ls' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: ['ls'] },
    ]) {
      const parsed = parsePermissionRequestPayload(body);
      expect(parsed, `should not have parsed: ${JSON.stringify(body)}`).toBeNull();
      expect(decidePermissionRequest(SESSION, parsed)).toEqual({
        behavior: null,
        reason: 'unknown-payload',
      });
    }
  });
});

describe('the Auto-Yes expiry boundary', () => {
  it('allows one millisecond before expiry and not at it', () => {
    // isAutoYesExpired uses >=, so the state dies exactly when the countdown
    // reads 00:00 (#959). The hook must not outlive the poller by a tick.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const state = setAutoYesEnabled(SESSION.worktreeId, SESSION.cliToolId, true, ONE_HOUR_MS);

    vi.setSystemTime(state.expiresAt - 1);
    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBe('allow');

    vi.setSystemTime(state.expiresAt);
    expect(decidePermissionRequest(SESSION, bash('git status'))).toEqual({
      behavior: null,
      reason: 'auto-yes-disabled',
    });
  });
});

describe('AskUserQuestion is never adjudicated (Issue #1726)', () => {
  it('makes no decision even with Auto-Yes on and no policy', () => {
    enableAutoYes();
    const parsed = parsePermissionRequestPayload(
      fixture('permission-request-ask-user-question.json')
    );

    expect(parsed?.toolName).toBe('AskUserQuestion');
    // The real payload has no permission_suggestions, unlike Bash's (#1721).
    expect(parsed?.permissionSuggestions).toBeNull();
    expect(decidePermissionRequest(SESSION, parsed)).toEqual({
      behavior: null,
      reason: 'ask-user-question',
    });
  });

  it('is decided before Auto-Yes is even consulted', () => {
    // Control: with Auto-Yes off the reason would be auto-yes-disabled for any
    // other tool, so this pins the ordering rather than the outcome.
    const parsed = parsePermissionRequestPayload(
      fixture('permission-request-ask-user-question.json')
    );

    expect(decidePermissionRequest(SESSION, parsed).reason).toBe('ask-user-question');
    expect(decidePermissionRequest(SESSION, bash('git status')).reason).toBe('auto-yes-disabled');
  });

  it('keeps the questions it carries without adjudicating them (Issue #1726)', () => {
    // `AskUserQuestion` raises a `PermissionRequest` with a `tool_input`
    // byte-identical to its `PreToolUse` one, so this is a second, independent
    // source for the same questions — and the only one on a session started
    // before PreToolUse injection existed.
    clearAgentStopEvents();
    enableAutoYes();
    const parsed = parsePermissionRequestPayload(
      fixture('permission-request-ask-user-question.json')
    );

    const decision = resolvePermissionRequest(SESSION, parsed);

    expect(decision).toEqual({ behavior: null, reason: 'ask-user-question' });
    const episode = getAskUserQuestion(SESSION.worktreeId, SESSION.cliToolId, SESSION.instanceId);
    expect(episode?.spec.questions.map((q) => q.question)).toEqual([
      'What is your favorite color?',
      'Which editor do you prefer?',
    ]);
  });

  it('keeps no questions for any other tool (Issue #1726)', () => {
    clearAgentStopEvents();

    resolvePermissionRequest(SESSION, bash('git status'));

    expect(getAskUserQuestion(SESSION.worktreeId, SESSION.cliToolId, SESSION.instanceId)).toBeNull();
  });
});

describe('contract policy suppression', () => {
  beforeEach(enableAutoYes);

  it('suppresses under mode: off', () => {
    policy = makePolicy({ mode: 'off' });

    expect(decidePermissionRequest(SESSION, bash('git status'))).toMatchObject({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'mode-off',
    });
  });

  it('suppresses under mode: safe, because the dialog is a multiple_choice', () => {
    // The hook must never be more permissive than the poller it front-runs:
    // safe allows yes_no only, and "Do you want to proceed? / 1. Yes / 2. Yes,
    // and … / 3. No" is detected as multiple_choice on screen.
    policy = makePolicy({ mode: 'safe' });
    expect(PERMISSION_REQUEST_PROMPT_TYPE).toBe('multiple_choice');

    expect(decidePermissionRequest(SESSION, bash('git status'))).toMatchObject({
      behavior: null,
      suppressedBy: 'type-not-allowed',
    });
  });

  it('honours allow-listed both ways', () => {
    policy = makePolicy({ mode: 'allow-listed', allowPromptTypes: ['yes_no'] });
    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();

    policy = makePolicy({ mode: 'allow-listed', allowPromptTypes: ['multiple_choice'] });
    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBe('allow');
  });

  it('suppresses on a deny pattern, and reports which one', () => {
    policy = makePolicy({ denyPatterns: ['rm\\s+-rf'] });

    expect(decidePermissionRequest(SESSION, bash('rm -rf ./build'))).toMatchObject({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern',
      pattern: 'rm\\s+-rf',
    });
  });

  it('suppresses on a deny pattern that cannot be evaluated', () => {
    // Fail-closed: a pattern the contract author asked for that silently did
    // nothing is the worst outcome a contract can have.
    policy = makePolicy({ denyPatterns: ['('] });

    expect(decidePermissionRequest(SESSION, bash('git status'))).toMatchObject({
      suppressedBy: 'deny-pattern-unusable',
    });
  });

  it('honours deny patterns even when the contract states no mode', () => {
    policy = makePolicy({ mode: null, denyPatterns: ['curl'] });

    expect(decidePermissionRequest(SESSION, bash('curl http://x')).behavior).toBeNull();
    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBe('allow');
  });

  it('never denies — suppression means "do not answer", not "refuse"', () => {
    // A deny would surface in the agent as `Denied by PermissionRequest hook`
    // and would change what every contract in the field already means.
    policy = makePolicy({ mode: 'off', denyPatterns: ['rm\\s+-rf'] });

    for (const command of ['rm -rf /', 'git status']) {
      expect(decidePermissionRequest(SESSION, bash(command)).behavior).not.toBe('deny');
    }
  });
});

describe('Issue #1699 must not recur: the deny surface is one request', () => {
  beforeEach(enableAutoYes);

  it('judges a Bash request on its own command line and nothing else', () => {
    // Direct assertion on the matching surface. There is no pane, no
    // scrollback and no history parameter for anything else to arrive through.
    expect(collectToolInputMatchTexts('Bash', { command: 'git status', description: 'status' }))
      .toEqual(['git status', 'status']);
  });

  it('allows an unrelated edit right after an rm -rf was suppressed', () => {
    // The exact sequence that silenced a worker for an hour: approve an
    // rm -rf, then ask for something ordinary. Under the old scrollback
    // matching, every later request stayed suppressed.
    policy = makePolicy({ denyPatterns: ['rm\\s+-rf'] });

    expect(resolvePermissionRequest(SESSION, bash('rm -rf ./node_modules')).behavior).toBeNull();
    const suppression = getLastPolicySuppression(SESSION.worktreeId, SESSION.cliToolId);
    expect(suppression).toMatchObject({ reason: 'deny-pattern', pattern: 'rm\\s+-rf' });

    for (const later of [
      request('Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }),
      bash('git add -A'),
      request('Read', { file_path: '/repo/README.md' }),
      bash('npm run lint'),
    ]) {
      expect(
        resolvePermissionRequest(SESSION, later),
        `${later.toolName} should not inherit the earlier suppression`
      ).toMatchObject({ behavior: 'allow' });
    }

    // The record is still the old one — it is exposure, not state that gates
    // anything (#1684). If a later request had been suppressed, `at` would have
    // moved and `pattern` would be re-stamped.
    expect(getLastPolicySuppression(SESSION.worktreeId, SESSION.cliToolId)).toBe(suppression);
  });

  it('does not carry a suppressed request into the next one on any tool', () => {
    policy = makePolicy({ denyPatterns: ['secrets\\.env'] });

    expect(resolvePermissionRequest(SESSION, request('Read', { file_path: '/repo/secrets.env' }))
      .behavior).toBeNull();
    expect(resolvePermissionRequest(SESSION, request('Read', { file_path: '/repo/other.env' }))
      .behavior).toBe('allow');
  });

  it('re-suppresses when the dangerous request comes back', () => {
    // The mirror of the test above: proves the pattern is still live rather
    // than having been consumed by the first match.
    policy = makePolicy({ denyPatterns: ['rm\\s+-rf'] });

    expect(resolvePermissionRequest(SESSION, bash('rm -rf ./a')).behavior).toBeNull();
    expect(resolvePermissionRequest(SESSION, bash('ls')).behavior).toBe('allow');
    expect(resolvePermissionRequest(SESSION, bash('rm -rf ./b')).behavior).toBeNull();
  });
});

describe('the deny surface for tools other than Bash', () => {
  it('uses the primary arguments, not bulk file content', () => {
    // A deny pattern is a statement about the action. Matching it against a
    // file body would block an edit for quoting the string it guards against.
    expect(
      collectToolInputMatchTexts('Write', {
        file_path: '/repo/docs/runbook.md',
        content: 'never run rm -rf /',
      })
    ).toEqual(['/repo/docs/runbook.md']);
  });

  it('falls back to the whole input for a tool it does not know', () => {
    // Over-matching costs a dialog; under-matching costs the protection the
    // contract asked for.
    const texts = collectToolInputMatchTexts('SomeFutureTool', { target: 'rm -rf /' });

    expect(texts.join(' ')).toContain('rm -rf /');
  });

  it('falls back when a known tool arrives with an unexpected shape', () => {
    // Claude renaming `command` must not silently empty the deny surface.
    const texts = collectToolInputMatchTexts('Bash', { cmd: 'rm -rf /' });

    expect(texts.join(' ')).toContain('rm -rf /');
  });

  it('suppresses through the fallback end to end', () => {
    enableAutoYes();
    policy = makePolicy({ denyPatterns: ['rm\\s+-rf'] });

    expect(decidePermissionRequest(SESSION, request('SomeFutureTool', { target: 'rm -rf /' }))
      .behavior).toBeNull();
  });
});

describe('recording the verdict', () => {
  beforeEach(enableAutoYes);

  it('writes an allow to prompt history, since no dialog ever renders it', () => {
    resolvePermissionRequest(SESSION, bash('touch /tmp/marker'));

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      worktreeId: SESSION.worktreeId,
      cliToolId: 'claude',
      instanceId: 'claude',
      messageType: 'prompt',
    });
    expect(created[0].promptData).toMatchObject({
      status: 'answered',
      answer: 'allow',
      answeredBy: 'auto',
      approvalTarget: expect.stringContaining('touch /tmp/marker'),
    });
    // D2: no tool_use_id exists, so correlation is prompt_id + tool_name.
    expect(created[0].summary).toContain('tool=Bash');
    expect(created[0].summary).toContain('prompt_id=11111111-1111-4111-8111-111111111111');
  });

  it('records no options, because none were ever shown', () => {
    resolvePermissionRequest(SESSION, bash('touch /tmp/marker'));

    expect((created[0].promptData as { options: unknown[] }).options).toEqual([]);
  });

  it('writes nothing to prompt history when it makes no decision', () => {
    // The dialog will be drawn, and the existing response poller records it
    // exactly as it does today. A second row would double-count the trail, and
    // a `pending` one would be stamped with the human's answer by
    // recordAnsweredPrompt.
    policy = makePolicy({ denyPatterns: ['touch'] });
    resolvePermissionRequest(SESSION, bash('touch /tmp/marker'));

    expect(created).toEqual([]);
    expect(getLastPolicySuppression(SESSION.worktreeId, SESSION.cliToolId)).toMatchObject({
      reason: 'deny-pattern',
      promptType: 'multiple_choice',
    });
  });

  it('records no suppression when Auto-Yes is simply off', () => {
    // Auto-Yes being off is not a policy withholding anything; reporting it as
    // one would make `capture --json` blame a contract that does not exist.
    clearAllAutoYesStates();
    resolvePermissionRequest(SESSION, bash('touch /tmp/marker'));

    expect(getLastPolicySuppression(SESSION.worktreeId, SESSION.cliToolId)).toBeNull();
    expect(created).toEqual([]);
  });

  it('still allows when the audit write throws', () => {
    // The verdict is already decided and the agent is blocked on the response;
    // losing the audit row must not turn into a hung dialog or a changed answer.
    auditFailure = new Error('database is locked');

    expect(resolvePermissionRequest(SESSION, bash('ls')).behavior).toBe('allow');
    expect(created).toEqual([]);
  });
});

/**
 * Issue #1725: a no-decision is a prediction that a dialog is about to appear.
 *
 * D5 measured `{}` landing back in the ordinary TUI approval flow, which is the
 * same statement read forwards: whenever this service declines to decide, a
 * human is about to be asked. That is ~6 seconds before
 * `Notification(permission_prompt)` announces the same dialog, and it is the
 * earliest anything here can know.
 *
 * The control cases matter more than the positive one. "Always reports a
 * dialog" would pass a suite that only checks the no-decision branches, and the
 * cost of a false report is a `wait --on-prompt agent` that exits 10 on a
 * session nobody is blocking.
 */
describe('reporting the dialog a no-decision produces (Issue #1725)', () => {
  beforeEach(() => {
    clearAgentStopEvents();
  });

  function reported() {
    return getStructuredPromptWaiting(SESSION.worktreeId, SESSION.cliToolId, SESSION.instanceId);
  }

  it('reports one when Auto-Yes is off', async () => {
    resolvePermissionRequest(SESSION, bash('npm test'));

    expect(reported()).toMatchObject({
      source: 'permission-request',
      toolName: 'Bash',
      // A prediction, not an observation: it expires unless something
      // corroborates it.
      confirmedAt: null,
    });
  });

  it('reports one when a contract policy withheld the approval', async () => {
    enableAutoYes();
    policy = makePolicy({ denyPatterns: ['rm -rf'] });

    resolvePermissionRequest(SESSION, bash('rm -rf /tmp/x'));

    expect(reported()).not.toBeNull();
  });

  it('reports one for an unreadable payload', async () => {
    resolvePermissionRequest(SESSION, null);

    expect(reported()).toMatchObject({ source: 'permission-request', toolName: null });
  });

  it('reports one for AskUserQuestion, which also draws a screen', async () => {
    // Allowing it does not dismiss the picker (§5.6), so a no-decision here is
    // followed by a screen a human must act on just the same. What is not
    // claimed is that it survives: nothing about that screen emits events, so
    // unless the scraper corroborates it the record expires.
    enableAutoYes();

    resolvePermissionRequest(SESSION, request('AskUserQuestion', { questions: [] }));

    expect(reported()).not.toBeNull();
  });

  it('reports nothing when it answered `allow`', async () => {
    // No dialog is drawn at all, so there is nothing for a human to answer.
    enableAutoYes();

    const decision = resolvePermissionRequest(SESSION, bash('npm test'));

    expect(decision.behavior).toBe('allow');
    expect(reported()).toBeNull();
  });

  it('reports nothing in bypassPermissions mode', async () => {
    // Claude's "do not ask me" mode: if the hook fires there at all, the agent
    // answers its own question and no human is ever blocked. Whether it fires
    // was not measured by the #1721 spike, so the mode is checked rather than
    // assumed.
    const payload = parsePermissionRequestPayload({
      ...(fixture('permission-request.json') as Record<string, unknown>),
      permission_mode: 'bypassPermissions',
    });

    resolvePermissionRequest(SESSION, payload);

    expect(reported()).toBeNull();
  });

  it('still reports one in the modes that do draw dialogs', async () => {
    const payload = parsePermissionRequestPayload({
      ...(fixture('permission-request.json') as Record<string, unknown>),
      permission_mode: 'acceptEdits',
    });

    resolvePermissionRequest(SESSION, payload);

    expect(reported()).not.toBeNull();
  });
});
