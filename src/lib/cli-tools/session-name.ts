/**
 * tmux session naming for CLI tool instances.
 *
 * ## Issue #1984: なぜ独立したモジュールなのか
 *
 * セッション名の決め方は `BaseCLITool.getSessionName()` の中にあり、7 つの具象ツールは
 * どれもこれを override していない（実装は base の 1 本きり）。にもかかわらず
 * 「名前が欲しいだけ」の呼び出し側は `CLIToolManager.getInstance().getTool(id)` を
 * 経由するしかなく、そのために 7 ツールの実装（と、そこから伸びる tmux / child_process
 * / composer spec のグラフ）を**モジュールロード時に**引かされていた。
 *
 * `ws-server.ts` がまさにそれで、`getTool()` を呼ぶのは
 * ハンドラの中（terminal subscribe / `migrateWorktreeRooms`）だけなのに、
 * `@/lib/cli-tools/manager` を静的 import していた。実測でこの 1 辺が
 * `import('@/lib/ws-server')` の 458ms のうち 234ms を占めていた。
 *
 * 規則そのものは 1 箇所に保つ — `BaseCLITool.getSessionName()` はこの関数へ委譲する。
 *
 * ## Issue #2866: 名前空間（ns）
 *
 * worktree ID はディレクトリ名から作られるので、DB が別の 2 台のサーバでも
 * `mcbd-{cli}-{worktreeId}` が重なる。サーバ起動時に `initSessionNamespace()`
 * （`session-namespace.ts`）が ns（16 進 8 桁）を決めると、以後の名前は
 * `mcbd-{ns}-{cli}-{worktreeId}[-{suffix}]` になる。ns 未設定（CLI・テスト・
 * 初期化失敗時）は従来形式のまま。ns はどの CLI ツール ID とも一致しないので、
 * `mcbd-` の直後の区切りで新旧を見分けられる（{@link parseSessionName}）。
 *
 * このモジュールは CLI バンドル（`tsconfig.cli.json` は paths なし）にも入るので、
 * `@/` を使わず、DB にも触らない。ns の保持だけをここで行い、DB からの読み書きは
 * `session-namespace.ts` が受け持つ。
 */

import { CLI_TOOL_IDS, deriveSessionSuffix, type CLIToolType } from './types';
import { validateSessionName } from './validation';
import { lookupLegacyAlias } from '../tmux/legacy-session-alias';

const SESSION_NAME_PREFIX = 'mcbd-';

/** Shape of a session-name namespace: 8 lowercase hex digits (Issue #2866). */
export const SESSION_NAMESPACE_PATTERN = /^[0-9a-f]{8}$/;

/** CLI tool ids, longest first, so a longer id is never read as a shorter one. */
const CLI_TOOL_IDS_LONGEST_FIRST: readonly CLIToolType[] = [...CLI_TOOL_IDS].sort(
  (a, b) => b.length - a.length
);

declare global {
  // eslint-disable-next-line no-var
  var __cmTmuxSessionNamespace: string | null | undefined;
}

/**
 * The namespace this process names its sessions with, or null (legacy names).
 *
 * @internal Read through `getSessionNamespace()` in `session-namespace.ts`.
 * Kept on `globalThis` because the custom server sets it at startup while the
 * Next route bundles — a separate module graph (Issue #2223) — read it.
 */
export function getActiveSessionNamespace(): string | null {
  return globalThis.__cmTmuxSessionNamespace ?? null;
}

/**
 * @internal Set by `initSessionNamespace()` / reset by tests only.
 */
export function setActiveSessionNamespace(namespace: string | null): void {
  if (namespace !== null && !SESSION_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`Invalid session namespace: ${namespace}`);
  }
  globalThis.__cmTmuxSessionNamespace = namespace;
}

function buildSessionName(
  head: string,
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId?: string
): string {
  const base = `${head}${cliToolId}-${worktreeId}`;
  if (!instanceId || instanceId === cliToolId) {
    validateSessionName(base);
    return base;
  }
  const suffix = deriveSessionSuffix(instanceId, cliToolId);
  const sessionName = suffix ? `${base}-${suffix}` : base;
  validateSessionName(sessionName);
  return sessionName;
}

/**
 * The session name in the given namespace, ignoring legacy adoptions
 * (Issue #2866). `namespace === null` is the legacy form.
 *
 * @throws Error if the resulting session name is invalid
 */
export function resolveNamespacedSessionName(
  namespace: string | null,
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId?: string
): string {
  const head = namespace === null ? SESSION_NAME_PREFIX : `${SESSION_NAME_PREFIX}${namespace}-`;
  return buildSessionName(head, cliToolId, worktreeId, instanceId);
}

/**
 * Resolve the tmux session name for a (worktree, CLI tool, instance) triple.
 *
 * Format (Issue #868, #2866):
 * - namespace set: `mcbd-{ns}-{cli_tool_id}-{worktree_id}[-{suffix}]` — unless a
 *   legacy session was adopted for that name (`adoptLegacySessions`), in which
 *   case the adopted legacy name is returned
 * - namespace unset: `mcbd-{cli_tool_id}-{worktree_id}[-{suffix}]`
 *
 * The primary instance (`instanceId` omitted or `=== cliToolId`) carries no
 * suffix.
 *
 * T2.3 (MF4-001): the result is validated to keep shell metacharacters out of
 * the tmux command line.
 *
 * @param cliToolId - CLI tool ID
 * @param worktreeId - Worktree ID
 * @param instanceId - Agent instance ID (defaults to the primary instance)
 * @returns Session name
 * @throws Error if the resulting session name is invalid
 *
 * @example
 * ```typescript
 * // namespace unset
 * resolveSessionName('claude', 'wt-1');            // 'mcbd-claude-wt-1'
 * resolveSessionName('claude', 'wt-1', 'claude-2'); // 'mcbd-claude-wt-1-2'
 * // namespace '0a1b2c3d'
 * resolveSessionName('claude', 'wt-1');            // 'mcbd-0a1b2c3d-claude-wt-1'
 * ```
 */
export function resolveSessionName(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId?: string
): string {
  const namespace = getActiveSessionNamespace();
  const name = resolveNamespacedSessionName(namespace, cliToolId, worktreeId, instanceId);
  if (namespace === null) return name;
  return lookupLegacyAlias(name) ?? name;
}

/**
 * The legacy (pre-#2866) session name, whatever the namespace:
 * `mcbd-{cli_tool_id}-{worktree_id}[-{suffix}]`.
 *
 * @throws Error if the resulting session name is invalid
 */
export function resolveLegacySessionName(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId?: string
): string {
  return resolveNamespacedSessionName(null, cliToolId, worktreeId, instanceId);
}

/** A session name split into its parts (Issue #2866). */
export interface ParsedSessionName {
  /** The server namespace, or null for the legacy form */
  namespace: string | null;
  cliToolId: CLIToolType;
  /** What follows `mcbd-[{ns}-]{cli}-`: the worktree ID and an optional suffix */
  rest: string;
}

/**
 * Split a session name of either form. The worktree ID and the instance suffix
 * are NOT separated — worktree IDs may contain `-`, so only the caller (who
 * knows the set of worktree IDs) can tell them apart.
 *
 * @returns null when the name does not start with `mcbd-`, names no known CLI
 *   tool, or has nothing after the tool
 */
export function parseSessionName(name: string): ParsedSessionName | null {
  if (!name.startsWith(SESSION_NAME_PREFIX)) return null;
  let body = name.slice(SESSION_NAME_PREFIX.length);

  let namespace: string | null = null;
  const dash = body.indexOf('-');
  if (dash > 0 && SESSION_NAMESPACE_PATTERN.test(body.slice(0, dash))) {
    namespace = body.slice(0, dash);
    body = body.slice(dash + 1);
  }

  const cliToolId = CLI_TOOL_IDS_LONGEST_FIRST.find((id) => body.startsWith(`${id}-`));
  if (!cliToolId) return null;
  const rest = body.slice(cliToolId.length + 1);
  if (rest === '') return null;
  return { namespace, cliToolId, rest };
}
