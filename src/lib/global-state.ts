/**
 * Process-wide state helper for the `globalThis.__*` cache pattern.
 *
 * Returns the value already stored on `globalThis[key]`, or runs `init` once and
 * stores its result. `init` runs only when the slot is `null`/`undefined`, at the
 * moment this function is called (so callers keep their own init timing).
 *
 * `key` and the initial value are typed from each file's `declare global`
 * declaration. This module imports nothing so any layer (server, CLI) can use it.
 */
export function getOrInitGlobal<K extends keyof typeof globalThis>(
  key: K,
  init: () => NonNullable<(typeof globalThis)[K]>
): NonNullable<(typeof globalThis)[K]> {
  return (globalThis[key] ??= init() as (typeof globalThis)[K]) as NonNullable<(typeof globalThis)[K]>;
}
