/**
 * Request-body JSON parsing for API route handlers (Issue #3295).
 *
 * A body that is not valid JSON is a client mistake, so it answers 400 rather
 * than falling into the route's outer catch (500 + error-level log).
 */

import { NextResponse } from 'next/server';

export type ReadJsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

/**
 * Parse the request body as JSON.
 *
 * On a malformed body returns `{ ok: false, response }` with 400
 * `{ error: 'Invalid request body' }`. Only syntax is checked; whether the
 * parsed value is an object stays the caller's concern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers validate the shape themselves
export async function readJsonBody<T = any>(req: { json(): Promise<unknown> }): Promise<ReadJsonBodyResult<T>> {
  try {
    return { ok: true, body: (await req.json()) as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    };
  }
}
