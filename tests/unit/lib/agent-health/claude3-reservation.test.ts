/**
 * Issue #4243: the Claude 3 reservation (src/lib/agent-health/claude3-reservation.ts).
 * Pairs with docs/design/claude3-dispatch-exclusion-4243.md §6 (R2–R4, R6).
 * Every reservation lives in a directory under os.tmpdir(), removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireReservation,
  beginSend,
  defaultReservationDir,
  dispatchRunFinishedMark,
  finishDispatchRun,
  endSend,
  forceReleaseReservation,
  isSending,
  markSendChild,
  readReservation,
  releaseReservation,
  renewReservation,
  SENDING_STALE_MS,
  sendUnderReservation,
  takeoverReservation,
  type ReservationEnv,
  type ReservationGeneration,
} from '@/lib/agent-health/claude3-reservation';

let dir: string;
let clock: number;
const alive = new Set<number>();

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude3-res-')), 'claude3.reservation');
  clock = Date.parse('2026-11-08T00:00:00Z');
  alive.clear();
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

function env(pid = 100, extra: Partial<ReservationEnv> = {}): ReservationEnv {
  return { dir, now: () => new Date(clock), pid, isAlive: (p) => alive.has(p), ...extra };
}

function current(): ReservationGeneration {
  const read = readReservation(dir);
  if (!read.ok) throw new Error(read.message);
  return read.current;
}

function hold(holder: 'pm' | 'dispatch' = 'pm', pid = 100): string {
  const result = acquireReservation(env(pid), { holder, label: '#1', date: holder === 'dispatch' ? '2026-11-08' : null });
  if (!result.ok) throw new Error(result.message);
  return result.generation.token as string;
}

const genFiles = () => fs.readdirSync(dir).filter((name) => /^gen-\d+\.json$/.test(name));

describe('claude3 reservation: generations (R4)', () => {
  it('no directory reads as released at generation 0 and writes nothing', () => {
    expect(current()).toMatchObject({ state: 'released', generation: 0 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('positive: two callers that read the same N — only one publishes N+1, the other sees held and fails 3', () => {
    let raced = false;
    const a = acquireReservation(
      env(1, {
        beforePublish: () => {
          if (raced) return;
          raced = true;
          // B reads the same N (0) and publishes N+1 before A links.
          const b = acquireReservation(env(2), { holder: 'dispatch', label: 'b', date: '2026-11-08' });
          expect(b.ok).toBe(true);
        },
      }),
      { holder: 'pm', label: 'a' }
    );
    expect(a).toMatchObject({ ok: false, code: 3 });
    expect(genFiles()).toEqual(['gen-1.json']);
    expect(current()).toMatchObject({ holder: 'dispatch', label: 'b' });
  });

  it('positive: a tmp file left before link is ignored; the current generation stays N', () => {
    const token = hold();
    fs.writeFileSync(path.join(dir, 'tmp-999-abc.json'), JSON.stringify({ ...current(), generation: 2, state: 'released' }));
    expect(current()).toMatchObject({ generation: 1, state: 'held', token });
  });

  it('positive: the old rename interleaving cannot leave two holders (A judged, B took, A resumes)', () => {
    const a = hold('pm', 1);
    expect(releaseReservation(env(1), a).ok).toBe(true);
    // A decides on generation 2 (released) and is paused; B takes generation 3.
    let b: string | null = null;
    const late = acquireReservation(
      env(1, {
        beforePublish: () => {
          if (b) return;
          b = hold('dispatch', 2);
        },
      }),
      { holder: 'pm', label: 'late' }
    );
    expect(late.ok).toBe(false);
    expect(current()).toMatchObject({ state: 'held', token: b });
    expect(genFiles()).toHaveLength(3);
  });

  it('negative: after a force release, PM and dispatch racing for it — exactly one gets it', () => {
    const t = hold('pm');
    expect(forceReleaseReservation(env(), t).ok).toBe(true);
    let inner: boolean | null = null;
    const outer = acquireReservation(
      env(1, {
        beforePublish: () => {
          if (inner !== null) return;
          inner = acquireReservation(env(2), { holder: 'dispatch', label: 'd', date: '2026-11-08' }).ok;
        },
      }),
      { holder: 'pm', label: 'p' }
    );
    expect([outer.ok, inner].filter(Boolean)).toHaveLength(1);
  });

  it('negative: cleaning keeps the current generation and removes only gen-<N-10> and below', () => {
    const t = hold();
    for (let i = 0; i < 14; i++) expect(renewReservation(env(), t).ok).toBe(true);
    const numbers = genFiles().map((name) => Number(/\d+/.exec(name)?.[0])).sort((x, y) => x - y);
    expect(numbers[numbers.length - 1]).toBe(15);
    expect(numbers[0]).toBe(5);
    expect(current().generation).toBe(15);
  });
});

describe('claude3 reservation: a late publish onto a cleaned generation name (P1-1)', () => {
  it('positive: a paused beginSend resumes after its N+1 was cleaned — the link is refused and nothing is sent', async () => {
    const a = hold('pm', 1);
    let resumed = false;
    let ran = false;
    const sent = await sendUnderReservation(
      env(1, {
        beforePublish: () => {
          if (resumed) return;
          resumed = true;
          // While A is paused: a person takes over and B renews until A's N+1 (gen-2) is cleaned.
          const taken = takeoverReservation(env(2), { fromToken: a, reason: 'restart' });
          if (!taken.ok) throw new Error(taken.message);
          const b = taken.generation.token as string;
          for (let i = 0; i < 12; i++) expect(renewReservation(env(2), b).ok).toBe(true);
          expect(fs.existsSync(path.join(dir, 'gen-2.json'))).toBe(false);
        },
      }),
      a,
      async () => {
        ran = true;
        return { status: 0, stdout: '' };
      }
    );
    expect(sent).toMatchObject({ sent: false, code: 3 });
    expect(ran).toBe(false);
    expect(fs.existsSync(path.join(dir, 'gen-2.json'))).toBe(false);
    expect(current()).toMatchObject({ holder: 'pm', previousToken: a, sending: null });
  });

  it('negative: an ordinary send under a long history still goes through and chains the generations', async () => {
    const t = hold('pm', 1);
    for (let i = 0; i < 12; i++) expect(renewReservation(env(1), t).ok).toBe(true);
    const sent = await sendUnderReservation(env(1), t, async () => ({ status: 0, stdout: '' }));
    expect(sent).toMatchObject({ sent: true, status: 0 });
    const last = current();
    const prev = JSON.parse(fs.readFileSync(path.join(dir, `gen-${last.generation - 1}.json`), 'utf8'));
    expect(last.parentPublishId).toBe(prev.publishId);
    expect(last.sending).toBeNull();
  });
});

describe('claude3 reservation: tokens (R2)', () => {
  it('positive: A held → A released → B held → A’s renew / release / send all fail 3 and B stays', async () => {
    const a = hold('pm', 1);
    expect(releaseReservation(env(1), a).ok).toBe(true);
    const b = hold('pm', 2);
    const before = current();
    expect(renewReservation(env(1), a)).toMatchObject({ ok: false, code: 3 });
    expect(releaseReservation(env(1), a)).toMatchObject({ ok: false, code: 3 });
    let ran = false;
    const sent = await sendUnderReservation(env(1), a, async () => {
      ran = true;
      return { status: 0, stdout: '' };
    });
    expect(sent).toMatchObject({ sent: false, code: 3 });
    expect(ran).toBe(false);
    expect(current()).toEqual(before);
    expect(current().token).toBe(b);
  });

  it('negative: the right token renews only reviewAfter and releases', () => {
    const t = hold();
    const before = current();
    clock += 3_600_000;
    expect(renewReservation(env(), t, 2).ok).toBe(true);
    const after = current();
    expect(after.token).toBe(t);
    expect(after.heldSince).toBe(before.heldSince);
    expect(after.reviewAfter).toBe(new Date(clock + 2 * 3_600_000).toISOString());
    expect(releaseReservation(env(), t).ok).toBe(true);
    expect(current().state).toBe('released');
  });

  it('negative: takeover --reason restart gives a new token with previousToken; the old token then fails', () => {
    const a = hold('pm');
    const taken = takeoverReservation(env(), { fromToken: a, reason: 'restart' });
    expect(taken.ok).toBe(true);
    const now = current();
    expect(now).toMatchObject({ state: 'held', holder: 'pm', previousToken: a });
    expect(now.token).not.toBe(a);
    expect(releaseReservation(env(), a)).toMatchObject({ ok: false, code: 3 });
  });

  it('positive: restart cannot take a dispatch reservation; dispatch-finished needs the evidence', () => {
    const d = hold('dispatch');
    expect(takeoverReservation(env(), { fromToken: d, reason: 'restart' })).toMatchObject({ ok: false, code: 3 });
    expect(takeoverReservation(env(), { fromToken: d, reason: 'dispatch-finished', finished: () => false })).toMatchObject({ ok: false, code: 3 });
    expect(takeoverReservation(env(), { fromToken: d, reason: 'dispatch-finished', finished: () => true }).ok).toBe(true);
    expect(current()).toMatchObject({ holder: 'pm', previousToken: d });
  });
});

describe('claude3 reservation: sending (R3)', () => {
  it('positive: while a send is in progress (parent alive) renew / release / takeover / force release all fail 3', () => {
    const t = hold('pm', 100);
    alive.add(100);
    expect(beginSend(env(100), t).ok).toBe(true);
    expect(renewReservation(env(5), t)).toMatchObject({ ok: false, code: 3 });
    expect(releaseReservation(env(5), t)).toMatchObject({ ok: false, code: 3 });
    expect(takeoverReservation(env(5), { fromToken: t, reason: 'restart' })).toMatchObject({ ok: false, code: 3 });
    expect(forceReleaseReservation(env(5), t)).toMatchObject({ ok: false, code: 3 });
    expect(endSend(env(100), t).ok).toBe(true);
    expect(releaseReservation(env(5), t).ok).toBe(true);
  });

  it('positive: parent and child dead but under 15 minutes — still sending', () => {
    const t = hold('pm', 100);
    expect(beginSend(env(100), t).ok).toBe(true);
    expect(markSendChild(env(100), t, 200).ok).toBe(true);
    clock += SENDING_STALE_MS - 1;
    expect(isSending(current(), new Date(clock), () => false)).toBe(true);
    expect(takeoverReservation(env(5), { fromToken: t, reason: 'restart' })).toMatchObject({ ok: false, code: 3 });
  });

  it('negative: parent and child dead over 15 minutes — takeover goes through', () => {
    const t = hold('pm', 100);
    expect(beginSend(env(100), t).ok).toBe(true);
    clock += SENDING_STALE_MS + 1;
    expect(takeoverReservation(env(5), { fromToken: t, reason: 'restart' }).ok).toBe(true);
  });

  it('positive: a live child keeps it sending even after 15 minutes', () => {
    const t = hold('pm', 100);
    expect(beginSend(env(100), t).ok).toBe(true);
    expect(markSendChild(env(100), t, 200).ok).toBe(true);
    alive.add(200);
    clock += SENDING_STALE_MS * 2;
    expect(isSending(current(), new Date(clock), (p) => alive.has(p))).toBe(true);
  });

  it('records the child pid during the send and clears the mark afterwards', async () => {
    const t = hold('pm', 100);
    let during: ReservationGeneration | null = null;
    const sent = await sendUnderReservation(env(100), t, async (onChild) => {
      onChild(4242);
      during = current();
      return { status: 0, stdout: 'ok' };
    });
    expect(sent).toMatchObject({ sent: true, status: 0 });
    expect(during).toMatchObject({ sending: { parentPid: 100, childPid: 4242 } });
    expect(current().sending).toBeNull();
  });

  it('positive: reviewAfter in the past does not end the reservation', () => {
    hold('pm');
    clock += 30 * 3_600_000;
    expect(acquireReservation(env(2), { holder: 'dispatch', label: 'd', date: '2026-11-09' })).toMatchObject({ ok: false, code: 3 });
    expect(current().state).toBe('held');
  });
});

describe('claude3 reservation: location and target (R6)', () => {
  it('positive: the default location ignores AGENT_HEALTH_DIR and is one absolute path under the home directory', () => {
    const saved = process.env.AGENT_HEALTH_DIR;
    try {
      process.env.AGENT_HEALTH_DIR = path.join(os.tmpdir(), 'elsewhere');
      const a = defaultReservationDir();
      delete process.env.AGENT_HEALTH_DIR;
      const b = defaultReservationDir();
      expect(a).toBe(b);
      expect(path.isAbsolute(a)).toBe(true);
      expect(a).toBe(path.join(os.homedir(), '.commandmate', 'agent-health', 'claude3.reservation'));
    } finally {
      if (saved === undefined) delete process.env.AGENT_HEALTH_DIR;
      else process.env.AGENT_HEALTH_DIR = saved;
    }
  });

  it('positive: a generation whose target is not claude-3 refuses every change with 2', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'gen-1.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        target: { worktreeId: 'mycodebranchdesk', instanceId: 'claude-2', cliTool: 'claude' },
        state: 'released',
        holder: null,
        token: null,
        label: null,
        date: null,
        heldSince: null,
        reviewAfter: null,
        sending: null,
        previousToken: null,
      })
    );
    expect(acquireReservation(env(), { holder: 'pm', label: 'x' })).toMatchObject({ ok: false, code: 2 });
    expect(genFiles()).toEqual(['gen-1.json']);
  });
});

describe('claude3 reservation: finished marks survive a late cleaning (#4243 review b)', () => {
  const markOf = (token: string) => path.join(dir, `finished-${token}.json`);

  it('positive: an old release whose cleaning resumes late leaves the current dispatch’s finished mark', () => {
    const d1 = hold('dispatch', 1);
    alive.add(2);
    let d2: string | null = null;
    const released = releaseReservation(
      env(1, {
        beforeClean: () => {
          if (d2) return;
          // While d1's release is paused before cleaning: d2 reserves, its run finishes, but its own send is in progress.
          d2 = hold('dispatch', 2);
          expect(beginSend(env(2), d2).ok).toBe(true);
          expect(finishDispatchRun(env(2), d2)).toMatchObject({ ok: false, code: 3 });
          expect(fs.existsSync(markOf(d2))).toBe(true);
        },
      }),
      d1
    );
    expect(released.ok).toBe(true);
    const token = d2 as unknown as string;
    expect(fs.existsSync(markOf(token))).toBe(true);
    expect(endSend(env(2), token).ok).toBe(true);
    expect(fs.existsSync(markOf(token))).toBe(true);
    expect(dispatchRunFinishedMark(dir, current())).toBe(true);
  });

  it('negative: a token’s own mark goes when the reservation leaves it (finish, or a later force release)', () => {
    const a = hold('dispatch', 1);
    expect(finishDispatchRun(env(1), a).ok).toBe(true);
    expect(fs.existsSync(markOf(a))).toBe(false);

    const b = hold('dispatch', 1);
    alive.add(1);
    expect(beginSend(env(1), b).ok).toBe(true);
    expect(finishDispatchRun(env(1), b).ok).toBe(false);
    expect(fs.existsSync(markOf(b))).toBe(true);
    expect(endSend(env(1), b).ok).toBe(true);
    expect(forceReleaseReservation(env(5), b).ok).toBe(true);
    expect(fs.existsSync(markOf(b))).toBe(false);
  });
});
