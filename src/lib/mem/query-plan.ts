/**
 * The queries of one evaluation (Issue #4222, design §1.1・§7): their keys, the merge
 * of the same query, the budget per evaluation, the concurrency and the sharing of
 * a query in flight with another evaluation.
 *
 * - Inside one evaluation, a key is asked once; every item reads the same answer.
 * - Between evaluations running at once, only a query **in flight** is shared, by key
 *   (P1-1: a key names everything its answer covers). Nothing is kept after it ends:
 *   no cache, so no timer and no sweep.
 * - The child's lifetime is its own timeout (`execFile`'s option) and `abort` (P2-5).
 *   A caller stops waiting at its own deadline; the last caller to leave aborts the
 *   child and removes the entry.
 *
 * @module lib/mem/query-plan
 */

import { execFile } from 'child_process';
import { withDeadline } from './eval-deadline';

export type QueryClass = 'external' | 'local';

export interface ExecResult {
  /** The exit code; null when the child did not exit by itself. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** `gh` / `git` is not installed. */
  missing: boolean;
  /** Over `maxBuffer`. */
  overflow: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  maxBuffer: number;
  signal: AbortSignal;
}

export type MemExec = (file: 'gh' | 'git', args: string[], options: ExecOptions) => Promise<ExecResult>;

/** `execFile`, no shell, no prompt waits (§1.1). */
export const defaultMemExec: MemExec = (file, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false, aborted: false, missing: false, overflow: false });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        const aborted = options.signal.aborted || e.name === 'AbortError';
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout: out,
          stderr: err,
          timedOut: !aborted && e.killed === true,
          aborted,
          missing: e.code === 'ENOENT',
          overflow: e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      }
    );
  });

export type QueryOutcome =
  | { ok: true; result: ExecResult }
  | { ok: false; reason: 'query_budget_exhausted' | 'deadline_exceeded' };

export interface QuerySpec {
  class: QueryClass;
  /** Names everything the answer covers (P1-1). */
  key: string;
  file: 'gh' | 'git';
  args: string[];
  cwd?: string;
  maxBuffer?: number;
}

export interface QueryLimits {
  externalPerEvaluation: number;
  localPerEvaluation: number;
  externalTimeoutMs: number;
  localTimeoutMs: number;
  concurrency: number;
}

/** §1.1 (U1: the numbers are estimates). */
export const DEFAULT_QUERY_LIMITS: QueryLimits = {
  externalPerEvaluation: 8,
  localPerEvaluation: 24,
  externalTimeoutMs: 5_000,
  localTimeoutMs: 3_000,
  concurrency: 4,
};

const DEFAULT_MAX_BUFFER = 1024 * 1024;

interface SharedQuery {
  promise: Promise<ExecResult>;
  abort: AbortController;
  waiters: number;
}

/** Queries in flight, shared by key between evaluations running at once. */
const inFlight = new Map<string, SharedQuery>();

/** Test seam (G4): how many shared queries are in flight. */
export function sharedQueryCount(): number {
  return inFlight.size;
}

class Semaphore {
  private free: number;
  private readonly queue: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free += 1;
  }
}

export class QueryPlan {
  private readonly memo = new Map<string, Promise<QueryOutcome>>();
  private readonly used: Record<QueryClass, number> = { external: 0, local: 0 };
  private readonly gates: Record<QueryClass, Semaphore>;
  /** Every query this evaluation asked (counted once per key), for tests and logs. */
  readonly asked: string[] = [];

  constructor(
    private readonly exec: MemExec,
    private readonly now: () => number,
    private readonly deadlineAt: number,
    private readonly limits: QueryLimits = DEFAULT_QUERY_LIMITS
  ) {
    this.gates = { external: new Semaphore(limits.concurrency), local: new Semaphore(limits.concurrency) };
  }

  /** Whether the evaluation's deadline has passed. */
  expired(): boolean {
    return this.now() >= this.deadlineAt;
  }

  run(spec: QuerySpec): Promise<QueryOutcome> {
    const known = this.memo.get(spec.key);
    if (known) return known;
    const limit = spec.class === 'external' ? this.limits.externalPerEvaluation : this.limits.localPerEvaluation;
    let outcome: Promise<QueryOutcome>;
    if (this.used[spec.class] >= limit) {
      outcome = Promise.resolve({ ok: false, reason: 'query_budget_exhausted' });
    } else if (this.expired()) {
      outcome = Promise.resolve({ ok: false, reason: 'deadline_exceeded' });
    } else {
      this.used[spec.class] += 1;
      this.asked.push(spec.key);
      outcome = this.start(spec);
    }
    this.memo.set(spec.key, outcome);
    return outcome;
  }

  private async start(spec: QuerySpec): Promise<QueryOutcome> {
    const gate = this.gates[spec.class];
    await gate.acquire();
    try {
      if (this.expired()) return { ok: false, reason: 'deadline_exceeded' };
      const sharedKey = `${spec.file}\u0000${spec.cwd ?? ''}\u0000${spec.key}`;
      let shared = inFlight.get(sharedKey);
      if (!shared) {
        const abort = new AbortController();
        const timeoutMs = spec.class === 'external' ? this.limits.externalTimeoutMs : this.limits.localTimeoutMs;
        const entry: SharedQuery = {
          abort,
          waiters: 0,
          promise: this.exec(spec.file, spec.args, {
            cwd: spec.cwd,
            timeoutMs,
            maxBuffer: spec.maxBuffer ?? DEFAULT_MAX_BUFFER,
            signal: abort.signal,
          }),
        };
        const forget = () => {
          if (inFlight.get(sharedKey) === entry) inFlight.delete(sharedKey);
        };
        entry.promise.then(forget, forget);
        inFlight.set(sharedKey, entry);
        shared = entry;
      }
      shared.waiters += 1;
      const waited = await withDeadline(shared.promise, this.deadlineAt - this.now());
      shared.waiters -= 1;
      if (!waited.ok) {
        // The last caller to leave takes the child with it (P2-5).
        if (shared.waiters === 0) {
          shared.abort.abort();
          if (inFlight.get(sharedKey) === shared) inFlight.delete(sharedKey);
        }
        return { ok: false, reason: 'deadline_exceeded' };
      }
      return { ok: true, result: waited.value };
    } finally {
      gate.release();
    }
  }
}
