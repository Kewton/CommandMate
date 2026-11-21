/**
 * Issue #4466 PR0: the test-side vessel of the send-operation hooks (design
 * `docs/design/send-atomic-4466.md` §4.3, §6.1).
 *
 * The hooks belong to the new route `POST /api/worktrees/:id/send-operation`, which does
 * not exist yet (PR1b). PR0 puts only the test side here — the points, the hook type and
 * a registry — and nothing in `src/`. PR1b wires the points into the route's stages
 * (how — a seam of its stage module that the table mocks, or another way — is PR1b's
 * call); until then nothing calls {@link runSendOperationHook}, and the rows that register
 * a hook are `it.fails` rows of the new route.
 *
 *  - `h-S1`  : right after S1 (the reads). A hook that throws {@link SendOperationStop}
 *              stops the operation there, so the table can show S1 wrote nothing.
 *  - `h-S2`  : right before S2 (the IMMEDIATE transaction) is entered. The policy inputs
 *              (roster tool, default, reply-to roster, declaration) are changed here; any
 *              await of S1 after which they change looks the same from S2 (I3c).
 *  - `h-S3`  : after the launch, before the keys (I2: S3 types into S2's target).
 *  - `h-S3b` : after the keys (the delivery stage, outside I1).
 */

export const SEND_OPERATION_HOOK_POINTS = ['h-S1', 'h-S2', 'h-S3', 'h-S3b'] as const;
export type SendOperationHookPoint = (typeof SEND_OPERATION_HOOK_POINTS)[number];

/** What a hook is told: where it runs, for which worktree. */
export interface SendOperationHookContext {
  point: SendOperationHookPoint;
  worktreeId: string;
}

/** A hook. `h-S2` must not leave work pending past its return (S2 has no await, I3). */
export type SendOperationHook = (context: SendOperationHookContext) => void | Promise<void>;

/** Thrown by an `h-S1` hook to stop the operation after S1 (the "S1 writes nothing" rows). */
export class SendOperationStop extends Error {
  constructor(point: SendOperationHookPoint) {
    super(`send-operation stopped at ${point} (test hook)`);
    this.name = 'SendOperationStop';
  }
}

const hooks = new Map<SendOperationHookPoint, SendOperationHook>();
const fired: SendOperationHookPoint[] = [];
const stopped: SendOperationHookPoint[] = [];

/** Register the hook of one point (replaces an earlier one). */
export function setSendOperationHook(point: SendOperationHookPoint, hook: SendOperationHook): void {
  hooks.set(point, hook);
}

/** Forget every hook and the record of what fired (each test's afterEach). */
export function clearSendOperationHooks(): void {
  hooks.clear();
  fired.length = 0;
  stopped.length = 0;
}

/** The insertion point: the route (PR1b) calls this at each point. No hook → nothing. */
export async function runSendOperationHook(point: SendOperationHookPoint, worktreeId: string): Promise<void> {
  fired.push(point);
  const hook = hooks.get(point);
  if (!hook) return;
  try {
    await hook({ point, worktreeId });
  } catch (error) {
    // Recorded here, so a route that turns every exception into a 5xx still shows where it stopped.
    if (error instanceof SendOperationStop) stopped.push(point);
    throw error;
  }
}

/** The points where a hook stopped the operation ({@link SendOperationStop}). */
export function stoppedSendOperationHooks(): readonly SendOperationHookPoint[] {
  return [...stopped];
}

/** The points reached, in order (a row with a hook expects its point among them). */
export function firedSendOperationHooks(): readonly SendOperationHookPoint[] {
  return [...fired];
}
