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

/**
 * Parse the request body as JSON and require it to be a plain object (Issue #3333).
 *
 * Routes that destructure the body would otherwise throw a TypeError on `null`
 * and land in their outer catch as a 500. A syntax error, an empty body, or a
 * body that is `null`, an array, or a primitive all return `{ ok: false, response }`
 * with 400 `{ error: 'Invalid request body' }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers validate the fields themselves
export async function readJsonObjectBody<T = any>(req: { json(): Promise<unknown> }): Promise<ReadJsonBodyResult<T>> {
  const parsed = await readJsonBody<unknown>(req);
  if (!parsed.ok) return parsed;
  const body = parsed.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    };
  }
  return { ok: true, body: body as T };
}

/**
 * Like `readJsonObjectBody`, but the body is optional (Issue #3333).
 *
 * A missing, empty, or syntactically broken body is treated as `{}` so the route
 * goes on with its defaults, as the routes' own `.catch(() => ({}))` did. Only a
 * body that parses to something other than an object (`null`, an array, a
 * number, a string) answers 400 `{ error: 'Invalid request body' }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers validate the fields themselves
export async function readOptionalJsonObjectBody<T = any>(req: { json(): Promise<unknown> }): Promise<ReadJsonBodyResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: true, body: {} as T };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    };
  }
  return { ok: true, body: raw as T };
}
