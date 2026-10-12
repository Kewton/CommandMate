/**
 * `--instance` (an instance id or a roster alias) resolved to the instance id
 * the server answers, through the same CLI every other call of the script uses
 * (Issue #3633 A).
 *
 * consistency-review.mjs built the resolve-target URL from `process.env` alone
 * and asked it with curl; wait-verify.mjs loaded a fixed `dist/` with the
 * parent's environment. The CLI decides its server from `.env`, `CM_BIND` and
 * HTTPS as well (src/cli/utils/server-url.ts), and `--cli` may be a wrapper
 * that changes all of that — so the resolution could ask one server while
 * capture / ask / wait went to another.
 *
 * The answer comes from `<cli> reply <wt> --instance <selector> --json`: an
 * existing, read-only subcommand that resolves the selector with the CLI's own
 * `resolveCommandTarget` (GET /resolve-target: primary first, exact alias
 * before case-folded, an ambiguous alias exit 2 with the candidates) and
 * prints the resolved `instanceId`. It needs no running session. `--since` in
 * the far future keeps the reply itself empty; only the id is read.
 */

/** Matches `isValidInstanceId` (src/lib/cli-tools/types.ts, src/cli/utils/api-client.ts). */
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_INSTANCE_ID_LENGTH = 64;
/** MAX_AGENT_ALIAS_LENGTH (src/lib/cli-tools/types.ts). */
const MAX_ALIAS_LENGTH = 50;

/** A `--since` no reply can be at or after: the reply is always null, the instance id is still printed. */
export const REPLY_SINCE_NEVER = '9999-12-31T23:59:59Z';

/**
 * Whether `value` is something the server could resolve to an instance — the
 * condition of the CLI's `isInstanceSelector` (src/cli/commands/instances.ts)
 * and of resolve-target's `isPlausibleAlias`: an instance id, or 1..50
 * characters without control characters. `/` and `\` are allowed: an alias is
 * free text, and the lock name is built from the resolved id, not from this.
 */
export function isInstanceSelector(value) {
  if (typeof value !== 'string') return false;
  if (value.length <= MAX_INSTANCE_ID_LENGTH && INSTANCE_ID_PATTERN.test(value)) return true;
  if (value.length === 0 || value.length > MAX_ALIAS_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * @param {(command: string, args: string[], opts?: { cwd?: string, timeoutMs?: number }) => { status: number, stdout: string, stderr: string }} run
 * @param {string} cli the CLI the script was given (`--cli`)
 * @param {string} wt
 * @param {string} selector
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ instanceId: string } | { error: string }} never throws
 */
export function resolveInstanceThroughCli(run, cli, wt, selector, { cwd, timeoutMs } = {}) {
  try {
    const out = run(cli, ['reply', wt, '--instance', selector, '--since', REPLY_SINCE_NEVER, '--json'], {
      cwd,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    if (out.status !== 0) {
      return { error: String(out.stderr || out.stdout || '').trim() || `${cli} reply exit ${out.status}` };
    }
    let answer = null;
    try {
      answer = JSON.parse(out.stdout);
    } catch {
      answer = null;
    }
    if (typeof answer?.instanceId !== 'string' || answer.instanceId === '') {
      return { error: `no instance in the answer: ${String(out.stdout).trim()}` };
    }
    return { instanceId: answer.instanceId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
