/**
 * Issue #3981, PR review P3-4: `clearSessionStarting` without a token (the
 * kill-session route) also forgets the session's launch in progress, which
 * needs the tmux session name. A name that does not resolve must not take the
 * "starting" record's removal down with it.
 *
 * Positive control: with the forget and the removal in one `try`, a throwing
 * `resolveSessionName` skipped `records.delete` and the instance stayed
 * "starting". Negative control: a name that resolves forgets the launch too.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => ({ throws: false }));

vi.mock('@/lib/cli-tools/session-name', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/session-name')>();
  return {
    ...original,
    resolveSessionName: (...args: Parameters<typeof original.resolveSessionName>) => {
      if (resolver.throws) throw new Error('session name does not resolve');
      return original.resolveSessionName(...args);
    },
  };
});

import { clearSessionStarting, getSessionStartingSince, markSessionStarting } from '@/lib/session/session-starting-state';
import {
  isSessionLaunchInFlight,
  resetSessionLaunchFlightsForTest,
  runSessionLaunch,
} from '@/lib/session/session-launch-flight';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

const WT = 'wt3981clear';

beforeEach(() => {
  resolver.throws = false;
  resetSessionLaunchFlightsForTest();
  clearSessionStarting(WT, 'codex');
});

afterEach(() => {
  resolver.throws = false;
  resetSessionLaunchFlightsForTest();
});

describe('[#3981 P3-4] kill-session clear: the starting record goes even when the name does not resolve', () => {
  it('positive: resolveSessionName throws → the record is still dropped, and nothing is thrown', () => {
    markSessionStarting(WT, 'codex');
    expect(getSessionStartingSince(WT, 'codex')).not.toBeNull();
    resolver.throws = true;
    expect(() => clearSessionStarting(WT, 'codex')).not.toThrow();
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();
  });

  it('negative: a name that resolves drops the record and forgets the launch in progress', () => {
    const session = resolveSessionName('codex', WT);
    void runSessionLaunch(session, 'Codex CLI', () => new Promise<void>(() => undefined));
    markSessionStarting(WT, 'codex');
    clearSessionStarting(WT, 'codex');
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();
    expect(isSessionLaunchInFlight(session)).toBe(false);
  });

  it('negative: with a token, another launch’s record is left alone (Issue #3195) and no launch is forgotten', () => {
    const session = resolveSessionName('codex', WT);
    void runSessionLaunch(session, 'Codex CLI', () => new Promise<void>(() => undefined));
    const token = markSessionStarting(WT, 'codex') as number;
    clearSessionStarting(WT, 'codex', undefined, token + 1);
    expect(getSessionStartingSince(WT, 'codex')).not.toBeNull();
    expect(isSessionLaunchInFlight(session)).toBe(true);
  });
});
