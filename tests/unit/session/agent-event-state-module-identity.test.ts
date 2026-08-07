/**
 * Issue #1736: the structured state must survive a second module instance.
 *
 * The bug this pins is not a wrong value, it is a *missing* one, and it was
 * invisible: `agent-event-state` held six bare module-scoped `Map`s, `next dev`
 * bundles every route handler separately, and so `/api/hooks/agent-event` wrote
 * events into one set of maps while `/api/worktrees/:id/current-output` read a
 * different, permanently empty set. No error, no warning — `structuredEvents`
 * simply always answered null, which is the exact "I configured hooks and
 * nothing happened" failure Epic #1720 exists to remove. Measured on
 * 2026-08-07: the POST logged `agent-event-received` and the GET that followed
 * reported `lastEventType: null`. Production builds share the module and were
 * never affected, so nothing in CI or in a release ever saw it.
 *
 * `vi.resetModules()` + `await import()` reproduces exactly that shape: a second
 * evaluation of the module, in the same process, whose top-level bindings are
 * fresh. State the first instance wrote must still be readable through the
 * second, which is only true when the maps live on `globalThis`.
 *
 * Every assertion below therefore reads through `second` what was written
 * through `first`. `expectsDistinctInstances` is the non-vacuity guard: if
 * `vi.resetModules()` ever stopped producing a new instance, every other
 * assertion here would pass for the wrong reason.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';

type AgentEventStateModule = typeof import('@/lib/session/agent-event-state');
type SuppressionModule = typeof import('@/lib/polling/auto-yes-suppression-state');

/**
 * Load a module twice, with a registry reset in between, and hand back both
 * instances — the in-process stand-in for two route bundles.
 */
async function loadTwice<T>(loader: () => Promise<T>): Promise<{ first: T; second: T }> {
  vi.resetModules();
  const first = await loader();
  vi.resetModules();
  const second = await loader();
  return { first, second };
}

/**
 * Assert the two handles really are separate evaluations. Module namespace
 * objects are re-created per evaluation, so identical function identity would
 * mean the reset did nothing and this whole file proves nothing.
 */
function expectsDistinctInstances<T extends object>(a: T, b: T, probe: keyof T): void {
  expect(a).not.toBe(b);
  expect(a[probe]).not.toBe(b[probe]);
}

const WT = 'wt-1736';
const TOOL = 'claude' as const;

describe('agent-event-state is shared across module instances (#1736)', () => {
  it('reports a stop event recorded by another instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    expectsDistinctInstances(first, second, 'recordAgentStopEvent');
    first.clearAgentStopEvents();

    first.recordAgentStopEvent(WT, TOOL, undefined, 1_700_000_000_000);

    expect(second.getLastStopEventAt(WT, TOOL)).toBe(1_700_000_000_000);
    second.clearAgentStopEvents();
  });

  it('reports the last agent event, and the generation, recorded by another instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    expectsDistinctInstances(first, second, 'recordAgentEvent');
    first.clearAgentStopEvents();

    const at = 1_700_000_100_000;
    first.beginAgentEventGeneration(WT, TOOL, undefined, at - 1_000);
    first.recordAgentEvent(WT, TOOL, undefined, {
      event: 'user_prompt_submit',
      at,
      detail: null,
      sessionId: 'session-a',
    });

    expect(second.getLastAgentEvent(WT, TOOL)).toMatchObject({
      event: 'user_prompt_submit',
      at,
    });
    expect(second.getAgentEventGenerationStartedAt(WT, TOOL)).toBe(at - 1_000);
    // The structured verdict — the value #1723 promoted to decide sessionStatus
    // — must cross the boundary too, not just the raw record.
    expect(second.getStructuredSessionState(WT, TOOL, undefined, at + 1_000)).toMatchObject({
      status: 'running',
      event: 'user_prompt_submit',
    });
    second.clearAgentStopEvents();
  });

  it('reports the open dialog recorded by another instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    expectsDistinctInstances(first, second, 'reportPermissionRequestPending');
    first.clearAgentStopEvents();

    const at = 1_700_000_200_000;
    first.reportPermissionRequestPending(WT, TOOL, undefined, 'Bash', at);

    const waiting = second.getStructuredPromptWaiting(WT, TOOL, undefined, at + 1_000);
    expect(waiting).toMatchObject({ at, source: 'permission-request', toolName: 'Bash' });

    // The record must be the *same object*, not a structural twin: the builder
    // mutates it in place to mark corroboration and the history write, and a
    // per-instance copy would drop both.
    second.corroborateStructuredPromptWaiting(WT, TOOL, undefined, at + 2_000);
    expect(first.getStructuredPromptWaiting(WT, TOOL, undefined, at + 3_000)).toMatchObject({
      scraperCorroborated: true,
      confirmedAt: at + 2_000,
    });
    second.clearAgentStopEvents();
  });

  it('reports the in-flight AskUserQuestion recorded by another instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    expectsDistinctInstances(first, second, 'recordAskUserQuestion');
    first.clearAgentStopEvents();

    const at = 1_700_000_300_000;
    const spec: AskUserQuestionSpec = {
      promptId: 'prompt-1',
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          choices: [{ label: 'A', description: null }],
        },
      ],
    };
    first.recordAskUserQuestion(WT, TOOL, undefined, spec, at);

    expect(second.getAskUserQuestion(WT, TOOL, undefined, at + 1_000)?.spec).toEqual(spec);
    second.clearAgentStopEvents();
  });

  it('deduplicates against a key claimed by another instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    expectsDistinctInstances(first, second, 'isDuplicateAgentEvent');
    first.clearAgentStopEvents();

    const at = 1_700_000_400_000;
    expect(first.isDuplicateAgentEvent(WT, TOOL, undefined, 'stop', 'session-x', at)).toBe(false);
    expect(second.getRecentEventKeyCount()).toBe(1);
    // Injection ships two Stop hooks per turn (#1722); the second delivery can
    // land on either bundle, so the window has to be shared to mean anything.
    expect(second.isDuplicateAgentEvent(WT, TOOL, undefined, 'stop', 'session-x', at + 100)).toBe(true);
    second.clearAgentStopEvents();
  });

  it('clears through either instance', async () => {
    const { first, second } = await loadTwice<AgentEventStateModule>(
      () => import('@/lib/session/agent-event-state')
    );
    first.clearAgentStopEvents();

    first.recordAgentStopEvent(WT, TOOL, undefined, 1_700_000_500_000);
    second.clearAgentStopEvents();

    expect(first.getLastStopEventAt(WT, TOOL)).toBeNull();
  });
});

describe('auto-yes-suppression-state is shared across module instances (#1736)', () => {
  it('reports a suppression recorded by another instance', async () => {
    const { first, second } = await loadTwice<SuppressionModule>(
      () => import('@/lib/polling/auto-yes-suppression-state')
    );
    expectsDistinctInstances(first, second, 'recordPolicySuppression');
    first.clearPolicySuppressions();

    // The producers (`/api/hooks/permission-request` via
    // permission-decision-service, and the Auto-Yes poller) are never the same
    // route bundle as the sole consumer (`buildCurrentOutput`).
    first.recordPolicySuppression(
      WT,
      TOOL,
      undefined,
      { reason: 'type-not-allowed', mode: 'safe', promptType: 'multiple_choice' },
      1_700_000_600_000
    );

    expect(second.getLastPolicySuppression(WT, TOOL)).toMatchObject({
      reason: 'type-not-allowed',
      mode: 'safe',
      at: 1_700_000_600_000,
    });
    second.clearPolicySuppressions();
  });
});
