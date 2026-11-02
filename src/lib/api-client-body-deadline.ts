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

/**
 * Give a replacement response the parts of the original that a constructor cannot
 * set (`detectAuthRedirect` reads `url` and `redirected`), and make its readers
 * report the error this module recorded.
 *
 * The second half is for WebKit, whose body readers reduce a stream's error to a
 * `TypeError` carrying only its message. That would lose the `kind` and `status`
 * of the `ApiError` on exactly the phones this exists for.
 */
function adoptIdentity(target: Response, source: Response, failure: () => Error | null): Response {
  Object.defineProperties(target, {
    url: { value: source.url },
    redirected: { value: source.redirected },
    type: { value: source.type },
    clone: { value: () => adoptIdentity(Response.prototype.clone.call(target), source, failure) },
  });
  for (const name of BODY_READERS) {
    const read = target[name] as unknown;
    if (typeof read !== 'function') continue;
    Object.defineProperty(target, name, {
      value: (): Promise<unknown> =>
        (read as () => Promise<unknown>).call(target).catch((error: unknown) => {
          throw failure() ?? error;
        }),
    });
  }
  return target;
}

/**
 * The same response, with its body bounded. Only call it when
 * {@link hasWatchableBody} says so.
 *
 * `highWaterMark: 0` is what makes the stream pull only for a waiting reader, and
 * so what keeps an unread body free of timers.
 */
export function withBodyDeadline(response: Response, options: BodyDeadlineOptions): Response {
  const { stallMs, callerSignal, abortConnection, stallError, abortedError, transportError } = options;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();

  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let failure: Error | null = null;

  const disarm = (): void => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const finish = (): void => {
    finished = true;
    disarm();
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };
  // Errors the stream directly rather than waiting for the abort to come back
  // through `reader.read()`: the answer must not depend on the transport noticing.
  const fail = (error: Error): void => {
    if (finished) return;
    finish();
    failure = error;
    streamController.error(error);
    abortConnection();
    reader.cancel(error).catch(() => {});
  };
  function onCallerAbort(): void {
    fail(abortedError());
  }

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        stallTimer = setTimeout(() => fail(stallError()), stallMs);
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          disarm();
          if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          fail(transportError(error));
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  callerSignal?.addEventListener('abort', onCallerAbort);

  return adoptIdentity(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    response,
    () => failure,
  );
}

/** Let go of a response nobody will read, so its connection does not stay open. */
export function discardBody(response: Response): void {
  if (hasWatchableBody(response)) {
    (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {});
  }
}
