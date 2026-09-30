/**
 * OpenCode V2's SSE table → CommandMate's state (Issue #2934, decision D5).
 *
 * Frames are the fixtures in `tests/fixtures/opencode-v2-live-2934/`:
 * `sse-measured-turn.json` is what `GET /api/event` sent for a real turn on
 * 2.0.18 (no `location` — `durable` instead), and `sse-reconstructed.json`
 * carries the approval / question / failure envelopes from the Phase 0
 * measurement in Epic #2370.
 *
 * Every frame goes through the path the stream uses
 * (`deliverOpencodeV2Frame` → the source's normalizer → `ingestOpencodeV2Event`)
 * and the assertion is on the published state, not on the intermediate words.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import { deliverOpencodeV2Frame } from '@/lib/hooks/sources/opencode-v2/subscription';
import { ingestOpencodeV2Event } from '@/lib/hooks/sources/opencode-v2/ingest';
import {
  OPENCODE_V2_HANDLED_EVENT_TYPES,
  frameDecisionId,
  frameSessionId,
} from '@/lib/hooks/sources/opencode-v2/mappers';
import {
  discardAgentEventState,
  getLastAgentEvent,
  getPendingDecisions,
  getStructuredSessionState,
} from '@/lib/session/agent-event-state';
import type { AgentInstanceRef, NormalizedAgentEvent } from '@/lib/hooks/sources/types';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-live-2934');

type Frame = Record<string, unknown>;

function load(name: string): Frame[] {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Frame[];
}

const measured = load('sse-measured-turn.json');
const reconstructed = load('sse-reconstructed.json');

function frameOf(type: string): Frame {
  const frame = [...measured, ...reconstructed].find((candidate) => candidate.type === type);
  if (!frame) throw new Error(`no fixture frame of type ${type}`);
  return frame;
}

let counter = 0;
const targets: AgentInstanceRef[] = [];

function freshTarget(): AgentInstanceRef {
  counter += 1;
  const target: AgentInstanceRef = {
    worktreeId: `wt-2934-${counter}`,
    cliToolId: 'opencode-v2',
    instanceId: 'opencode-v2',
  };
  targets.push(target);
  return target;
}

const stopEffect = vi.fn(async () => {});

/** Push frames through the stream's own path, awaiting each ingest. */
async function feed(target: AgentInstanceRef, frames: Frame[]): Promise<boolean[]> {
  const delivered: boolean[] = [];
  let at = Date.now();
  for (const frame of frames) {
    const events: NormalizedAgentEvent[] = [];
    delivered.push(
      deliverOpencodeV2Frame(
        frame,
        (raw) => opencodeV2AgentEventSource.normalizeEvent(raw),
        (event) => events.push(event),
        at
      )
    );
    for (const event of events) await ingestOpencodeV2Event(target, event, stopEffect);
    at += 10;
  }
  return delivered;
}

function status(target: AgentInstanceRef): string | null {
  return (
    getStructuredSessionState(target.worktreeId, target.cliToolId, target.instanceId)?.status ??
    null
  );
}

afterEach(() => {
  for (const target of targets.splice(0)) {
    discardAgentEventState(target.worktreeId, target.cliToolId, target.instanceId);
  }
  stopEffect.mockClear();
});

describe('the fixtures are what the table claims', () => {
  it('the measured turn has no location on either frame', () => {
    expect(measured.map((frame) => frame.type)).toEqual([
      'session.execution.started',
      'session.execution.succeeded',
    ]);
    for (const frame of measured) {
      expect(frame.location).toBeUndefined();
      expect(frame.durable).toBeDefined();
    }
  });

  it('reads the session and decision ids off the envelopes', () => {
    expect(frameSessionId(frameOf('session.execution.succeeded'))).toBe(
      'ses_f194e1bf3ffeD8Ak2TrW5f3pwe'
    );
    expect(frameDecisionId(frameOf('permission.asked'))).toBe('per_0e6b1f20d003ExamplePermission');
    expect(frameDecisionId(frameOf('permission.replied'))).toBe(
      'per_0e6b1f20d003ExamplePermission'
    );
    expect(frameDecisionId(frameOf('form.created'))).toBe('frm_0e6b1f20d008ExampleForm');
    expect(frameDecisionId(frameOf('form.replied'))).toBe('frm_0e6b1f20d008ExampleForm');
    expect(frameDecisionId(frameOf('form.cancelled'))).toBe('frm_0e6b1f20d008ExampleForm');
  });
});

describe('D5: each event → the state CommandMate publishes', () => {
  it('session.execution.started → running', async () => {
    const target = freshTarget();
    await feed(target, [frameOf('session.execution.started')]);
    expect(status(target)).toBe('running');
    expect(getLastAgentEvent(target.worktreeId, 'opencode-v2', 'opencode-v2')?.sessionId).toBe(
      'ses_f194e1bf3ffeD8Ak2TrW5f3pwe'
    );
  });

  it.each(['session.execution.succeeded', 'session.execution.interrupted'])(
    '%s → ready, and the stop side effects run',
    async (type) => {
      const target = freshTarget();
      await feed(target, [frameOf('session.execution.started'), frameOf(type)]);
      expect(status(target)).toBe('ready');
      expect(stopEffect).toHaveBeenCalledWith(target, 'opencode-v2');
    }
  );

  it('session.execution.failed → ready, recorded as an error', async () => {
    const target = freshTarget();
    await feed(target, [
      frameOf('session.execution.started'),
      frameOf('session.execution.failed'),
    ]);
    expect(status(target)).toBe('ready');
    const last = getLastAgentEvent(target.worktreeId, 'opencode-v2', 'opencode-v2');
    expect(last?.event).toBe('stop');
    expect(last?.detail).toBe('error');
    expect(last?.message).toBe('model provider returned 529');
  });

  it('permission.asked → waiting; permission.replied releases it and the turn goes on', async () => {
    const target = freshTarget();
    await feed(target, [frameOf('session.execution.started'), frameOf('permission.asked')]);
    expect(status(target)).toBe('waiting');
    const pending = getPendingDecisions(target.worktreeId, 'opencode-v2', 'opencode-v2');
    expect(pending).toHaveLength(1);
    expect(pending[0].decisionId).toBe('per_0e6b1f20d003ExamplePermission');
    expect(pending[0].toolName).toBe('edit');

    await feed(target, [frameOf('permission.replied')]);
    expect(getPendingDecisions(target.worktreeId, 'opencode-v2', 'opencode-v2')).toEqual([]);
    expect(status(target)).toBe('running');
  });

  it.each(['form.replied', 'form.cancelled'])(
    'form.created → waiting; %s releases it',
    async (settle) => {
      const target = freshTarget();
      await feed(target, [frameOf('session.execution.started'), frameOf('form.created')]);
      expect(status(target)).toBe('waiting');
      expect(getPendingDecisions(target.worktreeId, 'opencode-v2', 'opencode-v2')[0].decisionId).toBe(
        'frm_0e6b1f20d008ExampleForm'
      );

      await feed(target, [frameOf(settle)]);
      expect(getPendingDecisions(target.worktreeId, 'opencode-v2', 'opencode-v2')).toEqual([]);
      expect(status(target)).toBe('running');
    }
  );

  it('ignores every other type, and records nothing for it', async () => {
    const target = freshTarget();
    const delivered = await feed(target, [frameOf('session.reasoning.delta')]);
    expect(delivered).toEqual([false]);
    expect(getLastAgentEvent(target.worktreeId, 'opencode-v2', 'opencode-v2')).toBeNull();
    expect(OPENCODE_V2_HANDLED_EVENT_TYPES).not.toContain('session.reasoning.delta');
  });

  it('routes a frame by the stream it came on, whether or not it names a directory', async () => {
    // One instance, one server: the measured frames carry no `location` and the
    // reconstructed approval carries a directory that is not the instance's
    // worktree. Both land on the instance whose stream delivered them.
    const target = freshTarget();
    const other = freshTarget();
    const delivered = await feed(target, [
      frameOf('session.execution.started'),
      frameOf('permission.asked'),
    ]);
    expect(delivered).toEqual([true, true]);
    expect(status(target)).toBe('waiting');
    expect(status(other)).toBeNull();
  });
});
