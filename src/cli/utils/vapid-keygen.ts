/**
 * VAPID key-pair generation for `commandmate init` (Issue #2123).
 *
 * ## Why the CLI generates keys at all
 *
 * Web Push sends nothing without `CM_VAPID_PUBLIC_KEY` / `CM_VAPID_PRIVATE_KEY`,
 * and before this Issue CommandMate offered no way to produce them: `init` never
 * mentioned VAPID, `env-setup`'s defaults did not carry them, and `scripts/` had
 * no helper. The documented workaround was to know that the bundled `web-push`
 * package exposes `generateVAPIDKeys()` and to type a `node -e` one-liner — which
 * is not a setup step, it is a piece of folklore. `init` now writes a pair, so a
 * fresh install has push available and the reader never sees a raw `node -e`.
 *
 * ## Why the import is lazy
 *
 * `web-push` is a runtime dependency (it is what `push-sender` sends with), but
 * it is a heavy one — it pulls in `https-proxy-agent`, `jws` and their trees. This
 * module is reached from `src/cli/commands/init.ts`, which `program.ts` imports at
 * module scope, so a top-level `import` here would load that graph on EVERY CLI
 * invocation, `commandmate --version` included. The dynamic import keeps the cost
 * on the one command that needs it.
 *
 * ## Why a failure here is not a failure of `init`
 *
 * Push is optional. If `web-push` cannot be loaded (a partial install, a bundler
 * that dropped an optional dependency), `init` must still produce a working `.env`
 * — so this returns a result object rather than throwing, and the caller reports
 * the miss and carries on. Same fail-open direction as every other diagnostic
 * added by #2113 / #2123.
 *
 * @module cli/utils/vapid-keygen
 */

/** A generated application-server key pair, base64url-encoded as VAPID requires. */
export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

/** Outcome of {@link generateVapidKeyPair}: keys, or the reason there are none. */
export type VapidKeygenResult =
  | { ok: true; keys: VapidKeyPair }
  | { ok: false; error: string };

/**
 * Shape of the one function this module needs from `web-push`.
 *
 * Declared structurally so the lazy import can be type-checked without pulling
 * `web-push`'s types into `tsconfig.cli.json`'s program at build time.
 */
interface VapidKeyGenerator {
  generateVAPIDKeys(): VapidKeyPair;
}

/**
 * A base64url string of exactly `bytes` decoded bytes.
 *
 * VAPID keys are a P-256 point: 65 bytes uncompressed for the public key, 32 for
 * the private scalar. Checking the shape here means a `web-push` that ever
 * returned something else is caught at generation rather than at the first push.
 */
export function isBase64UrlOfLength(value: unknown, bytes: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, 'base64url').length === bytes;
}

/** True when both halves look like a usable VAPID application-server key pair. */
export function isVapidKeyPair(value: unknown): value is VapidKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const pair = value as Partial<VapidKeyPair>;
  return isBase64UrlOfLength(pair.publicKey, 65) && isBase64UrlOfLength(pair.privateKey, 32);
}

/**
 * Generate a VAPID application-server key pair using the bundled `web-push`.
 *
 * @param load - Loader override, injected by tests so the unit suite does not
 *   depend on `web-push` being resolvable.
 * @returns The pair, or the reason none could be produced. Never throws.
 */
export async function generateVapidKeyPair(
  load: () => Promise<VapidKeyGenerator> = () =>
    import('web-push').then((mod) => (mod.default ?? mod) as unknown as VapidKeyGenerator)
): Promise<VapidKeygenResult> {
  try {
    const webpush = await load();
    const keys: unknown = webpush.generateVAPIDKeys();
    if (!isVapidKeyPair(keys)) {
      return { ok: false, error: 'web-push returned a key pair of an unexpected shape' };
    }
    return { ok: true, keys };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
