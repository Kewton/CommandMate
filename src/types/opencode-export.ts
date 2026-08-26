/**
 * `opencode export --sanitize` — what it actually removes (Issue #2051)
 *
 * The Issue asks for the sanitized export to become an attachment candidate for
 * the daily report and for `/create-pr`. The name `--sanitize` is not evidence
 * that it is safe to attach, so 1.18.22 was measured against a session built to
 * be maximally leaky — a prompt carrying an inline password, and a `read` tool
 * call over a file of key-shaped strings. Both exports were taken and diffed;
 * the full record is `docs/design/opencode-server-live-verification.md` §23.
 *
 * ## What it removes
 *
 * Every field that can carry free text or file content:
 *
 * | Field | Sanitized value |
 * |---|---|
 * | `info.directory` | `[redacted:session-directory:<sessionID>]` |
 * | `info.title` | `[redacted:session-title:<sessionID>]` |
 * | `messages[].info.path.cwd` / `.root` | `[redacted:cwd:<messageID>]` / `[redacted:root:…]` |
 * | `messages[].parts[].text` | `[redacted:text:<partID>]` — **user and assistant alike** |
 * | `messages[].parts[].snapshot` | `[redacted:snapshot:<partID>]` |
 * | `messages[].parts[].state.output` | `[redacted:tool-output:<partID>]` |
 * | `messages[].parts[].state.title` | `[redacted:tool-title:<partID>]` |
 * | `messages[].parts[].state.input` | replaced by `{ redacted: "tool-input:<partID>" }` |
 * | `messages[].parts[].state.metadata` | replaced by `{ redacted: "tool-state-metadata:<partID>" }` |
 * | `messages[].parts[].metadata` | replaced by `{ redacted: "tool-metadata:<partID>" }` |
 *
 * Verified by counting needles: the inline password, the four key-shaped
 * strings, the read file's name, the operator's username and every path segment
 * appeared 3–8 times each in the plain export and **zero** times in the
 * sanitized one.
 *
 * ## What it keeps — and why that is the interesting half
 *
 * Ids (session / message / part / `callID`), `slug`, `projectID`, `path`,
 * `agent`, `model.id`, `model.providerID`, `model.variant`, `version`, every
 * timestamp, every token count, every cost, `finish` reasons, `state.status`,
 * each part's `type`, the diff `summary` counts — and **the tool names**
 * (`"read"`), which are not redacted.
 *
 * The consequence worth stating plainly: **a sanitized export contains no
 * conversation at all.** It is not a redacted transcript, it is a metrics and
 * shape document — how many turns, which tools ran, what it cost, how long it
 * took. That is a genuinely useful thing to hang off a daily report or a PR, but
 * it is not the thing "attach the transcript" suggests, so
 * {@link summarizeOpencodeExport} reduces it to exactly those facts rather than
 * pretending the JSON is readable.
 *
 * Two kept fields needed a judgement call, since the Issue asks for one:
 *
 * - **`projectID`** is a hash derived from the session's absolute directory
 *   (`44b7340824bf…` for the measured path). It is not reversible, but it is a
 *   stable fingerprint of a path, so two exports from the same checkout can be
 *   linked. For a daily report and a PR body — both of which already name the
 *   repository — that is not a disclosure, and it is kept.
 * - **Tool names** reveal the shape of the work (`read`, `bash`, `edit`). Same
 *   judgement, same reason, and they are most of the value in the summary.
 *
 * ## Why {@link auditOpencodeExportRedaction} exists
 *
 * "It is called sanitize" is not a guarantee that `--sanitize` was passed, that
 * this opencode release still redacts the same fields, or that the bytes on
 * hand came from that command at all. Every path measured above is checked
 * before anything is attached, and an export that fails the audit is dropped
 * rather than published. A later release that stops redacting a field turns
 * into a missing section, which is the failure worth having.
 */

/** The prefix every scalar redaction token measured on 1.18.22 begins with. */
export const OPENCODE_REDACTION_PREFIX = '[redacted:';

/**
 * Keys whose value must be redacted in a `--sanitize` export.
 *
 * Every one was observed carrying either free text or a filesystem path in the
 * plain export of the same session. `input` and `metadata` are here because
 * `--sanitize` replaces the whole object rather than its leaves.
 */
export const OPENCODE_EXPORT_SENSITIVE_KEYS = [
  'directory',
  'title',
  'cwd',
  'root',
  'text',
  'snapshot',
  'output',
  'input',
  'metadata',
] as const;

/** One field the audit found still carrying readable content. */
export interface OpencodeExportLeak {
  /** Dotted path from the document root, e.g. `messages[3].parts[0].text`. */
  path: string;
  /** How the value failed: a readable scalar, or an object left intact. */
  kind: 'plaintext' | 'unredacted-object';
}

function isRedactedScalar(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(OPENCODE_REDACTION_PREFIX);
}

/**
 * Whether a value is the `{ redacted: "…" }` stand-in `--sanitize` substitutes
 * for `state.input`, `state.metadata` and `parts[].metadata`.
 */
function isRedactedObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'redacted';
}

/**
 * Check every measured-sensitive field of a parsed export.
 *
 * Absent, `null` and empty-string values pass: a part with no text simply has
 * none, and `--sanitize` leaves those alone rather than inventing a token for
 * them. Numbers and booleans pass for the same reason — `truncated: false` is
 * not a disclosure. What fails is a non-empty string that is not a redaction
 * token, and an object standing where `--sanitize` would have put its
 * `{ redacted }` stand-in.
 *
 * @param document - A parsed `opencode export` body (either variety)
 * @returns Every field still readable. Empty means the document is redacted to
 *   the extent 1.18.22 was measured to redact it
 */
export function auditOpencodeExportRedaction(document: unknown): OpencodeExportLeak[] {
  const leaks: OpencodeExportLeak[] = [];
  const sensitive = new Set<string>(OPENCODE_EXPORT_SENSITIVE_KEYS);

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (sensitive.has(key)) {
        if (value === null || value === undefined || value === '') continue;
        if (isRedactedScalar(value) || isRedactedObject(value)) continue;
        if (typeof value === 'number' || typeof value === 'boolean') continue;
        leaks.push({
          path: childPath,
          kind: typeof value === 'string' ? 'plaintext' : 'unredacted-object',
        });
        // Not descending: the whole subtree is suspect, and one entry per
        // offending field reads better than one per leaf beneath it.
        continue;
      }
      walk(value, childPath);
    }
  };

  walk(document, '');
  return leaks;
}

/** Everything a sanitized export can still say about a session. */
export interface OpencodeExportSummary {
  sessionId: string | null;
  /** `info.agent`, e.g. `build`. */
  agent: string | null;
  /** `provider/model`, e.g. `github-copilot/claude-sonnet-4.6`. */
  model: string | null;
  /** The opencode release that wrote the session. */
  version: string | null;
  /** USD, the session's own cumulative figure. */
  cost: number | null;
  /** Message counts by role, in the order the export lists them. */
  userMessages: number;
  assistantMessages: number;
  /** Distinct tool names, sorted. Survives `--sanitize`; see the module note. */
  tools: string[];
  /** Total tool invocations, including repeats of the same tool. */
  toolCalls: number;
  /** `info.time.created` / `.updated`, epoch ms. */
  createdAt: number | null;
  updatedAt: number | null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reduce a sanitized export to the facts it still carries.
 *
 * Reads defensively throughout: this parses the output of another program's
 * `--sanitize` path, and a release that renames a field should cost the report
 * that field rather than throw inside a summary generator.
 *
 * @param document - A parsed `opencode export --sanitize` body
 * @returns The summary, or null when the document has no `info` object at all
 */
export function summarizeOpencodeExport(document: unknown): OpencodeExportSummary | null {
  const root = asRecord(document);
  if (root === null) return null;
  const info = asRecord(root.info);
  if (info === null) return null;

  const model = asRecord(info.model);
  const providerId = model === null ? null : readString(model, 'providerID');
  const modelId = model === null ? null : readString(model, 'id');
  const time = asRecord(info.time);

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const tools = new Set<string>();

  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (const entry of messages) {
    const message = asRecord(entry);
    if (message === null) continue;
    const messageInfo = asRecord(message.info);
    const role = messageInfo === null ? null : readString(messageInfo, 'role');
    if (role === 'user') userMessages += 1;
    else if (role === 'assistant') assistantMessages += 1;

    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (part === null) continue;
      if (readString(part, 'type') !== 'tool') continue;
      toolCalls += 1;
      const tool = readString(part, 'tool');
      if (tool !== null) tools.add(tool);
    }
  }

  return {
    sessionId: readString(info, 'id'),
    agent: readString(info, 'agent'),
    model: providerId !== null && modelId !== null ? `${providerId}/${modelId}` : modelId,
    version: readString(info, 'version'),
    cost: readNumber(info, 'cost'),
    userMessages,
    assistantMessages,
    tools: [...tools].sort(),
    toolCalls,
    createdAt: time === null ? null : readNumber(time, 'created'),
    updatedAt: time === null ? null : readNumber(time, 'updated'),
  };
}
