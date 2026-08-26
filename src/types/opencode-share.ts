/**
 * opencode session sharing — the config gate and the URL shape (Issue #2051)
 *
 * `POST /session/:id/share` publishes a conversation to opencode's own hosting
 * under the operator's credentials, and the page it produces is readable by
 * anyone who has the link. This module holds the two facts the rest of the app
 * needs in order to decide whether that button may be offered at all, and both
 * were measured against opencode 1.18.22 rather than read off the Issue —
 * `docs/design/opencode-server-live-verification.md` §23.
 *
 * ## The gate is `share === 'disabled'`, and nothing else
 *
 * `GET /config` echoes a `share` key **only when the operator set one**. The
 * OpenAPI `Config.share` schema is `enum: ["manual", "auto", "disabled"]`, and a
 * server whose config file has no `share` key answers with the key **absent** —
 * measured, not inferred. So `undefined` is *unset*, which is not the same
 * answer as `"disabled"`, and treating the two alike would hide the button on
 * every default installation.
 *
 * The reason this gate has to exist client-side at all is that the server does
 * not offer a usable one. With `share: "disabled"` configured, `POST /share`
 * answers **HTTP 500** with `{"name":"UnknownError","data":{"message":
 * "Unexpected server error. Check server logs for details.","ref":"err_…"}}`.
 * The real reason (`Error: Sharing is disabled in configuration`) appears only
 * in the server's own log, and the response carries no code that tells it apart
 * from any other 500. A caller cannot ask forgiveness here, only permission.
 *
 * ## What the returned URL looks like
 *
 * Measured: `https://opncd.ai/share/<last 8 characters of the session id>` —
 * for `ses_fc35f3dadffe2uirJpjJBtxFhy`, `https://opncd.ai/share/jJBtxFhy`. The
 * Issue body says `opncd.ai/s/<id>`; that spelling does not exist on 1.18.22.
 * Nothing here hard-codes the host, because the server is the authority on the
 * URL it minted and a later release may move it; the only requirement enforced
 * is that it be an absolute `https:` URL, so that a malformed body cannot turn
 * into a link the UI would render.
 *
 * ## Why `session.share` is not "is it shared right now"
 *
 * `DELETE /session/:id/share` really does take the page down (the public URL
 * then renders opencode's own "Not Found" view), but the session record
 * **keeps** its `share: { url }` afterwards — measured, and it survives a server
 * restart, so it is persisted rather than cached. `session.share` therefore
 * means *this session was published at some point*, and a UI that reads it as
 * current state will report a revoked session as still shared for ever.
 */

/** The values opencode's `Config.share` accepts, from its own OpenAPI. */
export const OPENCODE_SHARE_MODES = ['manual', 'auto', 'disabled'] as const;

/** One of {@link OPENCODE_SHARE_MODES}. */
export type OpencodeShareMode = (typeof OPENCODE_SHARE_MODES)[number];

/**
 * The `share` setting a `GET /config` body declares.
 *
 * @param config - A parsed `GET /config` body
 * @returns The configured mode, or `null` when the key is absent or is a word
 *   this opencode release added and this build does not know. `null` is *not*
 *   `'disabled'`; see the module comment
 */
export function readOpencodeShareMode(config: unknown): OpencodeShareMode | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).share;
  if (typeof value !== 'string') return null;
  return (OPENCODE_SHARE_MODES as readonly string[]).includes(value)
    ? (value as OpencodeShareMode)
    : null;
}

/**
 * Whether this server would refuse to publish.
 *
 * Deliberately positive only for the one measured refusal. An unreadable
 * config, an unreachable server and an unset key all answer `false` here, which
 * lets the operator try; the failure they get back is a plain error, whereas a
 * button that silently never appears is a feature that looks broken.
 *
 * @param mode - From {@link readOpencodeShareMode}
 */
export function isOpencodeSharingDisabled(mode: OpencodeShareMode | null): boolean {
  return mode === 'disabled';
}

/**
 * The share URL a `Session` body carries, if it carries a usable one.
 *
 * @param session - A parsed `Session` body, e.g. from `POST /session/:id/share`
 * @returns An absolute `https:` URL, or null
 */
export function readOpencodeShareUrl(session: unknown): string | null {
  if (typeof session !== 'object' || session === null || Array.isArray(session)) return null;
  const share = (session as Record<string, unknown>).share;
  if (typeof share !== 'object' || share === null || Array.isArray(share)) return null;
  const url = (share as Record<string, unknown>).url;
  if (typeof url !== 'string' || url === '') return null;
  // An absolute https URL or nothing: a relative or `javascript:` value reaching
  // an anchor's href is the one way a malformed body becomes a UI defect.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' ? url : null;
}

/** What `GET /api/worktrees/:id/opencode/share` answers. */
export interface OpencodeShareState {
  /** The instance this describes. */
  instanceId: string;
  /** `GET /config`'s `share`, or null when unset/unreadable. */
  shareMode: OpencodeShareMode | null;
  /**
   * Whether the share control may be offered: a live server, a session to
   * publish, and a `share` setting that is not `'disabled'`.
   */
  canShare: boolean;
  /** The session the button would publish, or null when there is none yet. */
  sessionId: string | null;
  /**
   * The URL opencode last minted for this session, or null.
   *
   * Named for what it is: this survives `DELETE`, so it is a record of a past
   * publication and not proof the page is up. See the module comment.
   */
  lastShareUrl: string | null;
}
