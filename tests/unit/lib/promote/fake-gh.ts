/**
 * A fake `gh` for the promote tests (Issue #4225). Nothing reaches GitHub.
 *
 * It reads a token from the environment the way gh does (re-review R3): `github.com`,
 * `*.ghe.com` and `github.localhost` read `GH_TOKEN` then `GITHUB_TOKEN`; any other host
 * (an Enterprise Server) reads `GH_ENTERPRISE_TOKEN` then `GITHUB_ENTERPRISE_TOKEN`. A
 * token found there names its account; with none, the host's active account answers.
 */
import type { ExecResult } from '@/lib/mem/query-plan';
import type { GhCall, GhRun } from '@/lib/promote/github-write';

export interface FakeAccount {
  id: number;
  login: string;
  token: string;
}

export interface FakeComment {
  id: number;
  html_url: string;
  node_id: string;
  body: string;
  user: { id: number };
  issue: string;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, missing: false, overflow: false });
export const failed = (stderr: string, extra: Partial<ExecResult> = {}): ExecResult => ({
  code: 1,
  stdout: '',
  stderr,
  timedOut: false,
  aborted: false,
  missing: false,
  overflow: false,
  ...extra,
});

export function ghTokenVariablesFor(host: string): [string, string] {
  const lower = host.toLowerCase();
  return lower === 'github.com' || lower.endsWith('.ghe.com') || lower === 'github.localhost'
    ? ['GH_TOKEN', 'GITHUB_TOKEN']
    : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
}

export class FakeGh {
  accounts: FakeAccount[] = [
    { id: 101, login: 'alice', token: 'tok-alice-0000' },
    { id: 202, login: 'bob', token: 'tok-bob-0000' },
  ];
  active = 101;
  comments: FakeComment[] = [];
  calls: GhCall[] = [];
  issue = { node_id: 'I_1', repository_url: 'https://api.github.com/repos/o/r', state: 'open', locked: false, body: 'issue body' };
  /** The POST's answer after GitHub took the comment: undefined = the normal answer. */
  postAnswer?: (comment: FakeComment) => ExecResult;
  /** Replaces any answer (a failing gh). */
  override?: (call: GhCall) => ExecResult | undefined;
  /** Waits before answering a call that matches (to let a test act during the await). */
  hold?: { match: (call: GhCall) => boolean; wait: Promise<void> };
  private next = 1;

  hostOf(call: GhCall): string {
    const index = call.args.indexOf('--hostname');
    return index >= 0 ? call.args[index + 1] : 'github.com';
  }

  /** Who a call runs as. */
  whoami(call: GhCall): FakeAccount {
    const [first, second] = ghTokenVariablesFor(this.hostOf(call));
    const token = call.env?.[first] || call.env?.[second];
    const byToken = token ? this.accounts.find((account) => account.token === token) : undefined;
    return byToken ?? this.accounts.find((account) => account.id === this.active)!;
  }

  posts(): GhCall[] {
    return this.calls.filter((call) => call.args.includes('--method'));
  }

  run: GhRun = async (call) => {
    this.calls.push(call);
    if (this.hold && this.hold.match(call)) {
      const { wait } = this.hold;
      this.hold = undefined;
      await wait;
    }
    const overridden = this.override?.(call);
    if (overridden) return overridden;
    const args = call.args;
    if (args[0] === 'auth' && args[1] === 'token') {
      return ok(`${this.accounts.find((account) => account.id === this.active)!.token}\n`);
    }
    if (args[0] !== 'api') return failed('unknown command');
    const path = args.find((arg, i) => i > 0 && !arg.startsWith('-') && args[i - 1] !== '--hostname' && args[i - 1] !== '--method' && args[i - 1] !== '--jq' && args[i - 1] !== '--input');
    const me = this.whoami(call);
    if (path === 'user') return ok(JSON.stringify({ id: me.id, login: me.login }));
    if (args.includes('--method') && path?.endsWith('/comments')) {
      const input = JSON.parse(call.input ?? '{}') as { body: string };
      const id = this.next++;
      const comment: FakeComment = {
        id,
        html_url: `https://${this.hostOf(call)}/o/r/issues/1#issuecomment-${id}`,
        node_id: `IC_${id}`,
        body: input.body,
        user: { id: me.id },
        issue: path,
      };
      this.comments.push(comment);
      return this.postAnswer ? this.postAnswer(comment) : ok(JSON.stringify(comment));
    }
    if (path?.includes('/comments')) {
      return ok(this.comments.map((c) => JSON.stringify({ id: c.id, html_url: c.html_url, body: c.body, user: { id: c.user.id } })).join('\n'));
    }
    if (path && /\/issues\/\d+$/.test(path)) return ok(JSON.stringify(this.issue));
    return failed('HTTP 404: Not Found');
  };
}
