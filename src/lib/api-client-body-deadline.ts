/**
 * Keep a response's body inside the request's deadline (Issue #4034).
 *
 * `fetch()` resolves when the headers arrive, so the deadline that bounds it says
 * nothing about the body: a server (or a tunnel) that sends headers and then stops
 * leaves `response.json()` pending for the life of the tab.
 *
 * The clock here measures **silence, not duration**: it restarts on every chunk,
 * so a large log still arriving over a slow link is never cut off. It also runs
 * only while someone is waiting on a read. A caller that never reads the body
 * starts no timer, and a caller that reads late is not punished for it.
 *
 * `clone()` keeps that promise, which is why it is implemented here rather than
 * left to the platform: a native clone tees the stream, and the tee reads ahead for
 * a reader nobody has, starting the clock on an unread body. Each side here is a
 * branch of one {@link createBodyFeed}, and the source is read only for a branch
 * that is waiting.
 *
 * Client-side module: no logger, no Node-only imports.
 */

/** What {@link withBodyDeadline} needs from the request that produced the response. */
export interface BodyDeadlineOptions {
  /** How long a pending read may go without a chunk, in ms. */
  stallMs: number;
  /** The caller's own signal, if any. Firing it ends the body as aborted. */
  callerSignal?: AbortSignal;
  /** Close the connection underneath. Called on a stall and on a caller's abort. */
  abortConnection: () => void;
  /** The error for a read that went silent for `stallMs`. */
  stallError: () => Error;
  /** The error for a caller's abort. */
  abortedError: () => Error;
  /** The error for the connection failing mid-body. */
  transportError: (cause: unknown) => Error;
}

const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'] as const;

/**
 * Whether this response has a real body stream that can still be taken over.
 *
 * No body (a 304, a 204, a HEAD) has nothing to bound, and `new Response(stream,
 * { status: 304 })` would throw anyway. A stub without a stream is passed through
 * rather than guessed at.
 */
export function hasWatchableBody(response: Response): boolean {
  return (
    typeof Response === 'function' &&
    response instanceof Response &&
    response.body !== null &&
    !response.bodyUsed &&
    !response.body.locked
  );
}

/** One reader's view of the body: the original response's, or a clone's. */
interface BodyBranch {
  stream: ReadableStream<Uint8Array>;
  /** Chunks another branch's read brought in before this one asked for them. */
  queue: Uint8Array[];
}

interface BodyFeed {
  /** A new branch that starts with these chunks, on top of what is still to come. */
  openBranch: (buffered: readonly Uint8Array[]) => BodyBranch;
  failure: () => Error | null;
}

/**
 * The single reader of the source, handing chunks to every branch.
 *
 * `highWaterMark: 0` is what makes a branch pull only for a waiting reader. The
 * source is read only when a branch with nothing queued pulls, and the clock runs
 * only while such a read is out and some branch is still waiting on it.
 */
function createBodyFeed(source: ReadableStream<Uint8Array>, options: BodyDeadlineOptions): BodyFeed {
  const { stallMs, callerSignal, abortConnection, stallError, abortedError, transportError } = options;
  const reader = source.getReader();

  interface LiveBranch {
    queue: Uint8Array[];
    controller: ReadableStreamDefaultController<Uint8Array>;
    /** Set while this branch's reader is waiting; resolves its `pull`. */
    release: (() => void) | null;
  }
  const branches = new Set<LiveBranch>();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let ended = false;
  /** The source has nothing more to say: ended, failed, or everyone let go. */
  let settled = false;
  let failure: Error | null = null;

  const syncClock = (): void => {
    const someoneWaits = [...branches].some((branch) => branch.release !== null);
    if (reading && !settled && someoneWaits) {
      stallTimer ??= setTimeout(() => fail(stallError()), stallMs);
    } else {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };
  const settle = (): void => {
    settled = true;
    syncClock();
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };
  // Errors the branches directly rather than waiting for the abort to come back
  // through `reader.read()`: the answer must not depend on the transport noticing.
  const fail = (error: Error): void => {
    if (settled) return;
    settle();
    failure = error;
    for (const branch of branches) {
      branch.controller.error(error);
      branch.release?.();
    }
    abortConnection();
    reader.cancel(error).catch(() => {});
  };
  function onCallerAbort(): void {
    fail(abortedError());
  }

  const deliver = (chunk: Uint8Array): void => {
    for (const branch of branches) {
      if (branch.release) {
        branch.controller.enqueue(chunk);
        branch.release();
      } else {
        branch.queue.push(chunk);
      }
    }
  };
  const readSource = async (): Promise<void> => {
    if (reading || settled) return;
    reading = true;
    syncClock();
    try {
      const { done, value } = await reader.read();
      reading = false;
      if (settled) return;
      if (done) {
        ended = true;
        settle();
        for (const branch of branches) {
          if (!branch.release) continue;
          branch.controller.close();
          branch.release();
        }
        return;
      }
      deliver(value);
      syncClock();
    } catch (error) {
      reading = false;
      fail(transportError(error));
    }
  };

  const openBranch = (buffered: readonly Uint8Array[]): BodyBranch => {
    const queue = [...buffered];
    let branch!: LiveBranch;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          branch = { queue, controller, release: null };
          if (failure) controller.error(failure);
          else branches.add(branch);
        },
        pull(controller) {
          const next = branch.queue.shift();
          if (next) {
            controller.enqueue(next);
            return;
          }
          if (ended) {
            controller.close();
            return;
          }
          return new Promise<void>((resolve) => {
            branch.release = () => {
              branch.release = null;
              resolve();
            };
            syncClock();
            void readSource();
          });
        },
        cancel(reason) {
          branch.release?.();
          branches.delete(branch);
          syncClock();
          if (branches.size > 0 || settled) return;
          settle();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, queue };
  };

  callerSignal?.addEventListener('abort', onCallerAbort);

  return { openBranch, failure: () => failure };
}

/**
 * A response over one branch of the feed, with the parts of the original that a
 * constructor cannot set (`detectAuthRedirect` reads `url` and `redirected`), and
 * readers that report the error this module recorded.
 *
 * The readers are for WebKit, whose body readers reduce a stream's error to a
 * `TypeError` carrying only its message. That would lose the `kind` and `status`
 * of the `ApiError` on exactly the phones this exists for.
 */
function responseOverBranch(
  source: Response,
  feed: BodyFeed,
  branch: BodyBranch,
  headers: Headers,
): Response {
  const target = new Response(branch.stream, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
  Object.defineProperties(target, {
    url: { value: source.url },
    redirected: { value: source.redirected },
    type: { value: source.type },
    clone: {
      value: (): Response => {
        if (target.bodyUsed || branch.stream.locked) {
          throw new TypeError('Failed to clone: the response body is already used');
        }
        // The headers as they are now, as a native clone copies them.
        return responseOverBranch(source, feed, feed.openBranch(branch.queue), target.headers);
      },
    },
  });
  for (const name of BODY_READERS) {
    const read = target[name] as unknown;
    if (typeof read !== 'function') continue;
    Object.defineProperty(target, name, {
      value: (): Promise<unknown> =>
        (read as () => Promise<unknown>).call(target).catch((error: unknown) => {
          throw feed.failure() ?? error;
        }),
    });
  }
  return target;
}

/**
 * The same response, with its body bounded. Only call it when
 * {@link hasWatchableBody} says so.
 */
export function withBodyDeadline(response: Response, options: BodyDeadlineOptions): Response {
  const feed = createBodyFeed(response.body as ReadableStream<Uint8Array>, options);
  return responseOverBranch(response, feed, feed.openBranch([]), response.headers);
}

/** Let go of a response nobody will read, so its connection does not stay open. */
export function discardBody(response: Response): void {
  if (hasWatchableBody(response)) {
    (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {});
  }
}
