/**
 * The comment's outcome and the fixed poster (Issue #4225, design §3.2, T8・T11c).
 * A fake gh only (`fake-gh.ts`); nothing reaches GitHub.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyCommentPost,
  fixedTokenEnv,
  GH_TOKEN_VARIABLES,
  postGhComment,
  readGhToken,
  readGhUser,
} from '@/lib/promote/github-write';
import type { IssueCommentDestination } from '@/lib/promote/model';
import { FakeGh, failed, ghTokenVariablesFor } from './fake-gh';

const dest = (host: string): IssueCommentDestination => ({ kind: 'issue_comment', ref: 'issue', host, owner: 'o', repo: 'r', number: 1 });
const exec = (code: number | null, stdout: string, stderr = '', extra = {}) => ({
  code,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
  missing: false,
  overflow: false,
  ...extra,
});

/** The rule of the 2nd re-review (R2): `GH_TOKEN` for github.com, `GH_ENTERPRISE_TOKEN` for every other host. */
const legacyEnv = (host: string, token: string): Record<string, string> =>
  host === 'github.com' ? { GH_TOKEN: token } : { GH_ENTERPRISE_TOKEN: token };

const HOSTS = ['github.com', 'acme.ghe.com', 'ghe.example.com'];

describe('the poster is fixed by the token, on every class of host (T11c, R3)', () => {
  it.each(HOSTS)('%s: the check and the POST run as the account of the token, even after a switch in between', async (host) => {
    const gh = new FakeGh();
    const token = await readGhToken(gh.run, host);
    expect(token).toBe('tok-alice-0000');
    const env = fixedTokenEnv(token!);
    expect((await readGhUser(gh.run, host, env))?.id).toBe(101);
    gh.active = 202; // `gh auth switch` between the check and the POST
    const posted = await postGhComment(gh.run, dest(host), 'body', env);
    expect(posted).toMatchObject({ outcome: 'success', userId: 101 });
    expect(gh.comments[0].user.id).toBe(101);
    // The token is in the child's environment only, never in an argument or the input.
    for (const call of gh.calls) {
      expect(call.args.join(' ')).not.toContain('tok-alice');
      expect(call.input ?? '').not.toContain('tok-alice');
    }
    // Every call named the host.
    expect(gh.calls.filter((call) => call.args[0] === 'api').every((call) => call.args.includes('--hostname') && call.args.includes(host))).toBe(true);
  });

  it('all four variables carry the one token (E holds no classification of hosts)', () => {
    expect(Object.keys(fixedTokenEnv('t')).sort()).toEqual([...GH_TOKEN_VARIABLES].sort());
    for (const host of HOSTS) for (const name of ghTokenVariablesFor(host)) expect(fixedTokenEnv('t')[name]).toBe('t');
  });

  it('(positive control) the R2 rule (GH_ENTERPRISE_TOKEN for every non-github.com host) posts as the switched account on *.ghe.com', async () => {
    const gh = new FakeGh();
    const env = legacyEnv('acme.ghe.com', (await readGhToken(gh.run, 'acme.ghe.com'))!);
    gh.active = 202;
    await postGhComment(gh.run, dest('acme.ghe.com'), 'body', env);
    expect(gh.comments[0].user.id).toBe(202);
    // …while it holds on the two other classes.
    for (const host of ['github.com', 'ghe.example.com']) {
      const other = new FakeGh();
      const fixed = legacyEnv(host, (await readGhToken(other.run, host))!);
      other.active = 202;
      await postGhComment(other.run, dest(host), 'body', fixed);
      expect(other.comments[0].user.id).toBe(101);
    }
  });

  it('(positive control) with no token fixed, the POST runs as whoever is active then', async () => {
    const gh = new FakeGh();
    expect((await readGhUser(gh.run, 'github.com'))?.id).toBe(101);
    gh.active = 202;
    await postGhComment(gh.run, dest('github.com'), 'body', {});
    expect(gh.comments[0].user.id).toBe(202);
  });

  it('(control) no token → null, and nothing else is asked', async () => {
    const gh = new FakeGh();
    gh.override = (call) => (call.args[0] === 'auth' ? failed('not logged in') : undefined);
    expect(await readGhToken(gh.run, 'github.com')).toBeNull();
    expect(gh.posts()).toHaveLength(0);
  });
});

describe('the outcome of a POST (design §3.2)', () => {
  const answer = JSON.stringify({ id: 9, html_url: 'https://github.com/o/r/issues/1#c', node_id: 'IC_9', user: { id: 101 } });
  it.each([
    ['created', exec(0, answer), 'success'],
    ['422', exec(1, '', 'HTTP 422: Validation Failed'), 'failure'],
    ['404', exec(1, '', 'gh: Not Found (HTTP 404)'), 'failure'],
    ['403', exec(1, '', 'HTTP 403: Forbidden'), 'failure'],
    ['gh missing', exec(null, '', '', { missing: true }), 'failure'],
    ['500', exec(1, '', 'HTTP 502: Bad Gateway'), 'unknown'],
    ['408', exec(1, '', 'HTTP 408'), 'unknown'],
    ['429', exec(1, '', 'HTTP 429: rate limit'), 'unknown'],
    ['timeout', exec(null, '', '', { timedOut: true }), 'unknown'],
    ['offline (no status)', exec(1, '', 'error connecting to api.github.com'), 'unknown'],
    ['exit 0, unreadable', exec(0, 'not json'), 'unknown'],
    ['overflow', exec(null, '', '', { overflow: true }), 'unknown'],
  ])('%s → %s', (_name, result, outcome) => {
    expect(classifyCommentPost(result).outcome).toBe(outcome);
  });

  it('the body goes on stdin as JSON, never as an argument', async () => {
    const gh = new FakeGh();
    await postGhComment(gh.run, dest('github.com'), 'secret-free body text', fixedTokenEnv('tok-alice-0000'));
    const post = gh.posts()[0];
    expect(post.args).toEqual(['api', '--method', 'POST', '--hostname', 'github.com', 'repos/o/r/issues/1/comments', '--input', '-']);
    expect(JSON.parse(post.input!)).toEqual({ body: 'secret-free body text' });
  });
});
