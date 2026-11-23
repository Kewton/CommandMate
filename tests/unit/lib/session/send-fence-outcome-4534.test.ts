/**
 * Issue #4534 PR-B s1 (design v2 §3.2, T14 and T15): a refusal keeps what it
 * was, and one function classifies it in the order every entry uses.
 *
 * T14: `InputBoundaryRefusedError` carries the hook's error as its `cause`
 * (constructor argument and message unchanged), so the type of the refusal can
 * be picked off the chain with `instanceof` after the tools' wraps.
 *
 * T15: the classification as a table — pure, on real tickets where the
 * request id matters. Order (v2 §3.2):
 *   1. the request's own ticket refused → target changed
 *   2. a typed refusal on the cause chain whose request id is the request's own
 *      (target changed / reservation lost / fence misuse)
 *   3. a boundary refusal found neither way (`isInputBoundaryRefusal`) →
 *      reservation lost, as today
 *   4. anything else → today's classification (`null` here) — another
 *      request's refusal (a joined launch) included
 * `not-sent` only for the request's own refusal with neither `bodyStarted`
 * nor `dispatchUnknown`; otherwise `indeterminate`.
 *
 * Nothing here starts a process or touches the disk.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { InputBoundaryRefusedError, isInputBoundaryRefusal, observeInputStart, noteInputStart } from '@/lib/session/instance-input-lock';
import {
  FenceMisuseError,
  fenceGate,
  openSendTicket,
  resetFenceForTests,
  SendTargetChangedError,
  type SendTicketInit,
} from '@/lib/session/terminal-fence';
import { RoleConditionUnmetError } from '@/lib/agent-roles/launch-errors';

/** What the request's own ticket says (the entry's handle, or the live ticket). */
interface Own {
  requestId: string;
  refusal: SendTargetChangedError | null;
  bodyStarted: boolean;
  dispatchUnknown: boolean;
}
interface Outcome {
  kind: 'target-changed' | 'reservation-lost' | 'fence-misuse';
  state: 'not-sent' | 'indeterminate';
  order: 1 | 2 | 3;
}
interface OutcomeModule {
  classifySendFenceOutcome: (error: unknown, own: Own | null) => Outcome | null;
  readOwnSendTicket: () => Own | null;
  RelayReservationLostError: new (message: string, requestId?: string | null) => Error & { requestId: string | null };
}

/** Loaded at run time: before the fix there is no such module, and each test says so by an assertion. */
const OUTCOME_MODULE = '@/lib/session/send-fence-outcome';
async function load(): Promise<OutcomeModule> {
  let mod: OutcomeModule | null = null;
  try {
    mod = (await import(/* @vite-ignore */ OUTCOME_MODULE)) as OutcomeModule;
  } catch {
    mod = null;
  }
  expect(mod, 'the classification module (send-fence-outcome) exists').not.toBeNull();
  return mod as OutcomeModule;
}

const MINE = 'send-1-mine';
const THEIRS = 'send-1-theirs';
const own = (over: Partial<Own> = {}): Own => ({ requestId: MINE, refusal: null, bodyStarted: false, dispatchUnknown: false, ...over });
const wrap = (cause: unknown): Error => new Error(`Failed to send message to Codex: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
const shape = (o: Outcome | null): Pick<Outcome, 'kind' | 'state' | 'order'> | null => (o === null ? null : { kind: o.kind, state: o.state, order: o.order });

afterEach(() => {
  resetFenceForTests();
});

// ---------------------------------------------------------------------------
// T14
// ---------------------------------------------------------------------------

describe('T14: InputBoundaryRefusedError keeps the hook’s error as its cause', () => {
  it('[T14] new InputBoundaryRefusedError(x).cause === x; the message and the boundary test are as before', () => {
    const hookError = new Error('reservation gone');
    const refused = new InputBoundaryRefusedError(hookError);
    expect(refused.cause).toBe(hookError);
    expect(refused.message).toBe('Input boundary could not be recorded (reservation gone); nothing was typed (Issue #3957)');
    expect(isInputBoundaryRefusal(refused)).toBe(true);
  });

  it('[T14] a TypeError from the hook is kept too (codex reproduced an empty cause with one)', () => {
    const hookError = new TypeError('cannot read properties of undefined');
    expect(new InputBoundaryRefusedError(hookError).cause).toBe(hookError);
  });

  it('[T14] through runBoundaryHook (noteInputStart): the refusal thrown carries the hook’s error', async () => {
    const hookError = new TypeError('boundary write failed');
    const thrown = await observeInputStart(
      async () => {
        noteInputStart();
      },
      undefined,
      {
        beforeInput: () => {
          throw hookError;
        },
      }
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(InputBoundaryRefusedError);
    expect((thrown as Error).cause).toBe(hookError);
  });

  it('[T14] a SendTargetChangedError is picked off the cause chain by instanceof, after a tool’s wrap', () => {
    const refusal = new SendTargetChangedError('tool-changed', MINE);
    const outer = wrap(new InputBoundaryRefusedError(refusal));
    const chain: unknown[] = [];
    for (let e: unknown = outer, d = 0; e instanceof Error && d < 10; e = e.cause, d++) chain.push(e);
    expect(chain.find((e) => e instanceof SendTargetChangedError)).toBe(refusal);
  });
});

// ---------------------------------------------------------------------------
// T15: the table
// ---------------------------------------------------------------------------

describe('T15: the classification order, as a table', () => {
  type Row = [name: string, make: (m: OutcomeModule) => { error: unknown; own: Own | null }, expected: Pick<Outcome, 'kind' | 'state' | 'order'> | null];
  const ownRefusal = (over: Partial<Own> = {}): Own => own({ refusal: new SendTargetChangedError('tool-changed', MINE), ...over });

  const ROWS: Row[] = [
    // Order 1: the own ticket refused — whatever the error says after the wraps.
    ['1: own refusal, an unrelated wrapped error', () => ({ error: new Error('Failed to send message to Codex: timed out'), own: ownRefusal() }), { kind: 'target-changed', state: 'not-sent', order: 1 }],
    ['1: own refusal, body started', () => ({ error: new Error('x'), own: ownRefusal({ bodyStarted: true }) }), { kind: 'target-changed', state: 'indeterminate', order: 1 }],
    ['1: own refusal, a dispatch not settled', () => ({ error: new Error('x'), own: ownRefusal({ dispatchUnknown: true }) }), { kind: 'target-changed', state: 'indeterminate', order: 1 }],
    ['1 before 3: own refusal, the error a boundary refusal', () => ({ error: new InputBoundaryRefusedError(new Error('reservation gone')), own: ownRefusal() }), { kind: 'target-changed', state: 'not-sent', order: 1 }],
    // Order 2: a typed refusal of this request on the chain.
    ['2: own SendTargetChangedError under a wrap', () => ({ error: wrap(new SendTargetChangedError('target-gone', MINE)), own: own() }), { kind: 'target-changed', state: 'not-sent', order: 2 }],
    ['2: own SendTargetChangedError, body started', () => ({ error: wrap(new SendTargetChangedError('target-gone', MINE)), own: own({ bodyStarted: true }) }), { kind: 'target-changed', state: 'indeterminate', order: 2 }],
    ['2: own RelayReservationLostError inside the boundary refusal', (m) => ({ error: wrap(new InputBoundaryRefusedError(new m.RelayReservationLostError('relay r1 is no longer reserved for this send', MINE))), own: own() }), { kind: 'reservation-lost', state: 'not-sent', order: 2 }],
    ['2: own FenceMisuseError under a wrap', () => ({ error: wrap(new FenceMisuseError('batch-ended', 'a step after its creation ended', MINE)), own: own() }), { kind: 'fence-misuse', state: 'not-sent', order: 2 }],
    ['2: own FenceMisuseError, a dispatch not settled', () => ({ error: new FenceMisuseError('batch-of-another-send', 'x', MINE), own: own({ dispatchUnknown: true }) }), { kind: 'fence-misuse', state: 'indeterminate', order: 2 }],
    // Order 3: a boundary refusal found neither way — reservation lost, as today.
    ['3: new Error(\'reservation gone\') from the hook (3957)', () => ({ error: new InputBoundaryRefusedError(new Error('reservation gone')), own: null }), { kind: 'reservation-lost', state: 'not-sent', order: 3 }],
    ['3: the boundary refusal’s message copied by a wrap (no cause)', () => ({ error: new Error(`Failed to send message to Codex: ${new InputBoundaryRefusedError(new Error('reservation gone')).message}`), own: own() }), { kind: 'reservation-lost', state: 'not-sent', order: 3 }],
    ['3: another request’s RelayReservationLostError — still the boundary refusal it is today', (m) => ({ error: new InputBoundaryRefusedError(new m.RelayReservationLostError('relay r1 is no longer reserved for this send', THEIRS)), own: own() }), { kind: 'reservation-lost', state: 'not-sent', order: 3 }],
    ['3: with the own body started — never not-sent', () => ({ error: new InputBoundaryRefusedError(new Error('reservation gone')), own: own({ bodyStarted: true }) }), { kind: 'reservation-lost', state: 'indeterminate', order: 3 }],
    // Order 4: today's classification.
    ['4: another request’s SendTargetChangedError (a joined launch)', () => ({ error: new SendTargetChangedError('tool-changed', THEIRS), own: own() }), null],
    ['4: another request’s SendTargetChangedError under a wrap', () => ({ error: wrap(new SendTargetChangedError('tool-changed', THEIRS)), own: own() }), null],
    ['4: a SendTargetChangedError with no own ticket at all', () => ({ error: new SendTargetChangedError('tool-changed', MINE), own: null }), null],
    ['4: a FenceMisuseError of no request (unticketed)', () => ({ error: new FenceMisuseError('unticketed', 'layer x on y'), own: own() }), null],
    ['4: another request’s FenceMisuseError', () => ({ error: new FenceMisuseError('batch-ended', 'x', THEIRS), own: own() }), null],
    ['4: the role’s condition refused through the boundary (#4115 is today’s)', () => ({ error: new InputBoundaryRefusedError(new RoleConditionUnmetError('the role changed')), own: own() }), null],
    ['4: an ordinary failure', () => ({ error: new Error('submit could not be confirmed'), own: own() }), null],
    ['4: not an error', () => ({ error: 'boom', own: own() }), null],
  ];

  it.each(ROWS)('[T15] %s', async (_name, make, expected) => {
    const m = await load();
    const { error, own: view } = make(m);
    expect(shape(m.classifySendFenceOutcome(error, view))).toEqual(expected);
  });

  it('[T15] a cause chain that loops ends (no hang), as order 4', async () => {
    const m = await load();
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(m.classifySendFenceOutcome(a, own())).toBeNull();
  });

  it('[T15] the classification never swallows: it returns data and leaves the error as it was', async () => {
    const m = await load();
    const refusal = new SendTargetChangedError('tool-changed', MINE);
    const error = wrap(refusal);
    const before = { message: error.message, cause: error.cause };
    const outcome = m.classifySendFenceOutcome(error, own({ refusal }));
    expect(outcome).not.toBeNull();
    expect({ message: error.message, cause: error.cause }).toEqual(before);
  });
});

describe('T15 on real tickets: whose refusal it is', () => {
  const init = (confirm: SendTicketInit['confirm']): SendTicketInit => ({
    target: { worktreeId: 'wt', instanceId: 'codex', cliToolId: 'codex' },
    resolvedBy: 'roster',
    kind: 'resolved',
    confirm,
    names: ['mcbd-codex-wt'],
  });

  it('[T15] a joined launch: B’s refusal classified in A’s context is order 4; in B’s it is B’s own (order 1)', async () => {
    const m = await load();
    const a = openSendTicket(init(() => null));
    const b = openSendTicket(init(() => 'tool-changed'));
    try {
      const refusalOfB = b.run(() => {
        try {
          fenceGate('key');
        } catch (error) {
          return error;
        }
        return null;
      });
      expect(refusalOfB).toBeInstanceOf(SendTargetChangedError);
      expect(a.run(() => m.classifySendFenceOutcome(refusalOfB, m.readOwnSendTicket()))).toBeNull();
      expect(m.classifySendFenceOutcome(refusalOfB, a)).toBeNull();
      expect(shape(b.run(() => m.classifySendFenceOutcome(refusalOfB, m.readOwnSendTicket())))).toEqual({ kind: 'target-changed', state: 'not-sent', order: 1 });
      expect(shape(m.classifySendFenceOutcome(wrap(refusalOfB), b))).toEqual({ kind: 'target-changed', state: 'not-sent', order: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it('[T15] the handle carries its request id, and the live ticket reads the same; none outside a run', async () => {
    const m = await load();
    const a = openSendTicket(init(() => null));
    try {
      expect(typeof (a as unknown as { requestId?: unknown }).requestId).toBe('string');
      expect(a.run(() => m.readOwnSendTicket()?.requestId)).toBe((a as unknown as { requestId: string }).requestId);
      expect(m.readOwnSendTicket()).toBeNull();
    } finally {
      a.close();
    }
  });

  it('[T15] a RelayReservationLostError made under a ticket names that request (order 2); with none it names nobody', async () => {
    const m = await load();
    const a = openSendTicket(init(() => null));
    try {
      const lost = a.run(() => new m.RelayReservationLostError('relay r1 is no longer reserved for this send'));
      expect(lost.requestId).toBe((a as unknown as { requestId: string }).requestId);
      expect(lost.message).toBe('relay r1 is no longer reserved for this send');
      expect(shape(m.classifySendFenceOutcome(new InputBoundaryRefusedError(lost), a))).toEqual({ kind: 'reservation-lost', state: 'not-sent', order: 2 });
      expect(new m.RelayReservationLostError('m').requestId).toBeNull();
    } finally {
      a.close();
    }
  });
});
