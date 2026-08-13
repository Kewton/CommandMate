/**
 * antigravity's approval adjudication (Issue #1779, the last gap in Epic #1720
 * Phase 4).
 *
 * ## Why most of this file runs a real shell
 *
 * The thing under test is a string that a *different program* executes. agy runs
 * a `PreToolUse` handler through `sh -c`, reads its stdout, and treats an empty
 * object as a **denial** — so the failure this suite exists to prevent is not
 * "the command is spelled wrong", it is "the command is spelled plausibly and
 * emits nothing when the server is down, and every tool call on the developer's
 * machine stops". Asserting on substrings of the command cannot see that:
 * `curl … || true` and `curl …; printf '{"decision":"ask"}'` differ by one
 * clause and by the entire behaviour.
 *
 * So {@link runHook} really does `spawn('sh', ['-c', command])` with a real
 * payload on its stdin, against a real HTTP server on a real port, and asserts
 * on the bytes that come back out. Every one of the five failure paths Issue
 * #1779 enumerates is a server (or the absence of one) rather than a mock.
 *
 * ## What "fail-open" means here, and why it is not `allow`
 *
 * Issue #1779 asked for `{"decision":"allow"}` on every failure path. Measured
 * live on agy 1.1.12 in an isolated `HOME`, that would be strictly worse than
 * what is implemented:
 *
 *  - `~/.gemini/config/hooks.json` is **one file for the whole machine**, so an
 *    `allow` fallback means that stopping CommandMate silently auto-approves
 *    every tool call in every agy session on the machine — including sessions
 *    CommandMate never started, which is failure path 5 and which is the common
 *    case for a user who also runs agy in their own terminal.
 *  - `{"decision":"ask"}` is agy's own documented word for *"prompt the user for
 *    permission"*, and a hook answering it draws exactly the
 *    `Do you want to proceed? / 1. Yes …` dialog a hooks-free control run draws.
 *    That is the real fail-open: agy behaves as though CommandMate were not
 *    installed, which is what the Issue's stated worry ("do not brick agy") asks
 *    for, without opening the hole.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import {
  ANTIGRAVITY_ABSTAIN_BODY,
  ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS,
  ANTIGRAVITY_PERMISSION_HOOK_EVENT,
  ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS,
  ANTIGRAVITY_PERMISSION_URL_ENV_VAR,
  ANTIGRAVITY_TOOL_MATCHER,
  buildAntigravityHookConfig,
  buildAntigravityPermissionHookCommand,
  type AntigravityHookMatcherGroup,
} from '@/lib/hooks/sources/antigravity/hooks-config';
import {
  antigravityAgentEventSource,
  encodeAntigravityVerdict,
  parseAntigravityPermissionRequest,
} from '@/lib/hooks/sources/antigravity/source';
import { describeAbstain, isAbstainSafe } from '@/lib/hooks/sources';

const execFileAsync = promisify(execFile);

const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/hooks/antigravity/pre-tool-use.json'), 'utf8')
) as Record<string, unknown>;

/** What agy must never receive from this hook, in the form it would receive it. */
const DENIAL = '{}';

/** The abstention every failure path has to produce, as agy would read it. */
const ABSTAIN = ANTIGRAVITY_ABSTAIN_BODY;

const servers: Server[] = [];

/**
 * Start a throwaway HTTP server on an ephemeral port.
 *
 * Port 0 rather than a fixed number: this suite runs beside whatever else the
 * developer has listening, and a hard-coded port is how a test suite comes to
 * depend on a production server being down (#1779's own contract forbids
 * touching port 3000).
 *
 * @param handler - Called with the request body; returns status and body
 */
async function startServer(
  handler: (body: string) => { status: number; body: string; delayMs?: number }
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const { status, body, delayMs } = handler(Buffer.concat(chunks).toString('utf8'));
      const send = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      };
      if (delayMs) setTimeout(send, delayMs).unref();
      else send();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/api/hooks/permission-request?tool=antigravity`;
}

/**
 * The hook's environment, and *only* what is listed.
 *
 * Not `{ ...process.env }`: the guard that makes the machine-global hook inert
 * for sessions CommandMate did not start is "`CM_PERMISSION_HOOK_URL` is unset",
 * and a suite that inherited the developer's environment could not tell a
 * working guard from a variable that happened to be absent.
 */
function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // `next-env.d.ts` declares `NODE_ENV` as required on `ProcessEnv`, which is
  // true of *this* process and not of the one being spawned. The double cast is
  // the honest way to say "an environment with these variables and no others".
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extra } as unknown as NodeJS.ProcessEnv;
}

/**
 * Run the generated hook exactly as agy runs it.
 *
 * `sh -c`, the payload written to the child's **stdin**, and a working directory
 * that is not the worktree — agy runs hooks from the directory holding
 * `hooks.json`, so a command that quietly depended on `cwd` would pass here and
 * fail in the field.
 *
 * The payload deliberately does *not* travel through the environment or through
 * `argv`, and that is not a stylistic choice. Linux caps a single argv entry or
 * environment string at `MAX_ARG_STRLEN` (32 × PAGE_SIZE = 128 KiB) and fails
 * the whole `execve` with `E2BIG` past it; macOS has no such per-string limit.
 * A `PAYLOAD=…` environment variable therefore passed locally and failed only on
 * CI — the same "green on macOS, red on Linux" shape as the `/proc` fixture that
 * hung CI for five hours. Writing to stdin has no such ceiling, and it is what
 * the agent itself does.
 *
 * @param payload - Bytes to write to the hook's stdin
 * @param env - Extra environment on top of {@link hookEnv}
 */
async function runHook(
  payload: string,
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn('sh', ['-c', buildAntigravityPermissionHookCommand()], {
    env: hookEnv(env),
    cwd: '/',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdin.on('error', () => {
    // A hook that exits without reading its stdin turns this write into EPIPE.
    // Swallowed here so the assertion below reports *what the agent saw* rather
    // than this suite dying with an unhandled 'error' event.
    stderr += 'EPIPE writing to hook stdin\n';
  });
  child.stdin.end(payload);
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return { stdout, stderr };
}

/** The captured `PreToolUse` payload, with no receiver configured. */
async function runPermissionHook(): Promise<string> {
  return (await runHook(JSON.stringify(FIXTURE))).stdout;
}

/** Same, with the receiver URL pointed somewhere. */
async function runAgainst(url: string, extra: Record<string, string> = {}): Promise<string> {
  return (
    await runHook(JSON.stringify(FIXTURE), {
      [ANTIGRAVITY_PERMISSION_URL_ENV_VAR]: url,
      ...extra,
    })
  ).stdout;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

// ===========================================================================
// The five failure paths. This is the centre of the Issue.
// ===========================================================================

describe('the adjudication hook never leaves agy without a verdict', () => {
  it('path 5: prints an abstention when CommandMate did not start this agy', async () => {
    // The machine-global file fires for the operator's own `agy` too. Without a
    // receiver URL the only correct behaviour is to look like no hook at all.
    const stdout = await runPermissionHook();

    expect(stdout).toBe(ABSTAIN);
    expect(stdout).not.toBe(DENIAL);
  });

  it('path 5: consumes stdin before exiting, so the agent does not see an EPIPE', async () => {
    // agy writes the payload to the hook's stdin. A hook that exits without
    // reading turns that write into a broken pipe on the agent's side — the
    // lesson `copilot/hook-settings` learned the same way.
    expect(buildAntigravityPermissionHookCommand()).toContain('cat >/dev/null');

    // Comfortably past Linux's 64 KiB pipe buffer, which is the whole point: a
    // payload that fits in the buffer is written and forgotten whether or not
    // anything reads it, so a smaller one would pass against a hook that never
    // consumed stdin at all. It must NOT be shrunk to dodge a spawn limit — see
    // {@link runHook} for why it travels on stdin rather than in the environment.
    const big = JSON.stringify({ ...FIXTURE, padding: 'x'.repeat(200_000) });
    expect(big.length).toBeGreaterThan(128 * 1024);

    const { stdout, stderr } = await runHook(big);

    expect(stdout).toBe(ABSTAIN);
    expect(stderr).toBe('');
  });

  it('path 1: prints an abstention when the server is unreachable', async () => {
    // A port that was listening and is not any more — the state of the machine
    // for the whole of a `commandmate stop`.
    const url = await startServer(() => ({ status: 200, body: '{"decision":"allow"}' }));
    servers.pop()?.close();

    expect(await runAgainst(url)).toBe(ABSTAIN);
  });

  it('path 2: prints an abstention when the server is too slow', async () => {
    const url = await startServer(() => ({
      status: 200,
      body: '{"decision":"allow"}',
      delayMs: (ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS + 3) * 1000,
    }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
  }, 20_000);

  it('path 3: prints an abstention for a 4xx', async () => {
    // What `badRequest()` answers. It is deliberately left as a 4xx in the route
    // — this is the measurement that makes that safe.
    const url = await startServer(() => ({
      status: 400,
      body: '{"error":"tool must be a known CLI tool id"}',
    }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
  });

  it('path 3: prints an abstention for a 5xx', async () => {
    const url = await startServer(() => ({ status: 500, body: '{"decision":"allow"}' }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
  });

  it('path 4: prints an abstention for a body that is not JSON', async () => {
    // A proxy's HTML error page, or a captive portal. Anything but a verdict.
    const url = await startServer(() => ({
      status: 200,
      body: '<html><body>502 Bad Gateway</body></html>',
    }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
  });

  it('path 4: prints an abstention for JSON with no decision in it', async () => {
    // The exact body every other tool reads as "no opinion", arriving here from
    // a receiver that has not been taught about agy.
    const url = await startServer(() => ({ status: 200, body: '{}' }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
    expect(await runAgainst(url)).not.toBe(DENIAL);
  });

  it('path 4: prints an abstention for an empty 200', async () => {
    const url = await startServer(() => ({ status: 200, body: '' }));

    expect(await runAgainst(url)).toBe(ABSTAIN);
  });

  it('passes a real verdict through untouched', async () => {
    // The other half of the contract: the fallback must not swallow the answer.
    const allow = await startServer(() => ({ status: 200, body: '{"decision":"allow"}' }));
    expect(await runAgainst(allow)).toBe('{"decision":"allow"}');

    const deny = await startServer(() => ({
      status: 200,
      body: '{"decision":"deny","reason":"blocked by policy"}',
    }));
    expect(await runAgainst(deny)).toBe('{"decision":"deny","reason":"blocked by policy"}');
  });

  it('posts the payload agy handed it, to the URL it was given', async () => {
    let seen = '';
    const url = await startServer((body) => {
      seen = body;
      return { status: 200, body: '{"decision":"allow"}' };
    });

    await runAgainst(url);

    expect(JSON.parse(seen)).toEqual(FIXTURE);
  });

  it('sends the bearer token as one header when the environment carries one', async () => {
    // `${VAR:+-H "…"}` word-splits into four arguments and sends `Authorization:`
    // alone; the `set --` form below is why this is asserted rather than assumed.
    let auth: string | undefined;
    const server = createServer((req, res) => {
      auth = req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"decision":"allow"}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    await runAgainst(`http://127.0.0.1:${address.port}/`, { CM_AUTH_TOKEN: 'tok en' });

    expect(auth).toBe('Bearer tok en');
  });

  it('sends no Authorization header when there is no token', async () => {
    let auth: string | undefined = 'unset';
    const server = createServer((req, res) => {
      auth = req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"decision":"allow"}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    await runAgainst(`http://127.0.0.1:${address.port}/`);

    expect(auth).toBeUndefined();
  });

  it('is valid POSIX shell', async () => {
    // agy runs it through `sh -c`, not bash. A bashism here fails at the worst
    // possible moment — inside a hook whose empty output is a denial.
    await expect(
      execFileAsync('sh', ['-n', '-c', buildAntigravityPermissionHookCommand()])
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// The registration itself
// ===========================================================================

describe('PreToolUse is registered, against its own receiver', () => {
  const RELAY = '/opt/commandmate/scripts/hooks/cmate-agent-event.sh';

  it('is in the config, in agy’s grouped shape', () => {
    const config = buildAntigravityHookConfig(RELAY);
    const groups = config[ANTIGRAVITY_PERMISSION_HOOK_EVENT] as AntigravityHookMatcherGroup[];

    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe(ANTIGRAVITY_TOOL_MATCHER);
    expect(groups[0].hooks[0].type).toBe('command');
  });

  it('leaves the three observation events on the relay, unchanged', () => {
    // The regression this guards: routing an observation through the
    // adjudication command would answer `{"decision":"ask"}` to a `Stop`, and
    // agy reads a `Stop` reply as a control instruction.
    const config = buildAntigravityHookConfig(RELAY);

    expect(Object.keys(config)).toEqual([
      'SessionStart',
      'PostToolUse',
      'Stop',
      ANTIGRAVITY_PERMISSION_HOOK_EVENT,
    ]);
    for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
      expect(JSON.stringify(config[event])).toContain(RELAY);
    }
  });

  it('never puts the relay on the adjudication hook', () => {
    // `cmate-agent-event.sh` ends in `curl … >/dev/null`. Pointing this event at
    // it is the exact mistake #1762 refused to make, and the reason there is a
    // second command at all.
    const config = buildAntigravityHookConfig(RELAY);
    const groups = config[ANTIGRAVITY_PERMISSION_HOOK_EVENT] as AntigravityHookMatcherGroup[];

    expect(groups[0].hooks[0].command).not.toContain(RELAY);
    expect(groups[0].hooks[0].command).not.toContain('cmate-agent-event.sh');
  });

  it('bounds curl strictly inside the handler’s own timeout', () => {
    // If curl could outlive the handler, agy would kill the hook mid-write and
    // the reply would be a partial body — on this tool, the one output that must
    // never happen by accident.
    const config = buildAntigravityHookConfig(RELAY);
    const groups = config[ANTIGRAVITY_PERMISSION_HOOK_EVENT] as AntigravityHookMatcherGroup[];

    expect(groups[0].hooks[0].timeout).toBe(ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS);
    expect(ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS).toBeLessThan(
      ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS
    );
    expect(groups[0].hooks[0].command).toContain(
      `-m ${ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS}`
    );
  });

  it('carries no worktree or instance, because one file serves the whole machine', () => {
    const serialised = JSON.stringify(buildAntigravityHookConfig(RELAY));

    expect(serialised).toContain(ANTIGRAVITY_PERMISSION_URL_ENV_VAR);
    expect(serialised).not.toContain('worktreeId=');
    expect(serialised).not.toContain('instanceId=');
  });
});

// ===========================================================================
// The source
// ===========================================================================

describe('the verdict agy is given', () => {
  it('spells abstention as `ask`, never as an empty object', () => {
    expect(encodeAntigravityVerdict({ kind: 'abstain' })).toEqual({ decision: 'ask' });
    expect(antigravityAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'responseBody',
      body: { decision: 'ask' },
    });
  });

  it('spells the shell fallback and the HTTP abstention the same way', () => {
    // Two representations of one decision, in two languages, in two files. They
    // are asserted equal because nothing else would notice them drifting: agy
    // accepts both, and the wrong one is only visibly wrong in a session where
    // the server is down.
    expect(JSON.parse(ANTIGRAVITY_ABSTAIN_BODY)).toEqual(
      encodeAntigravityVerdict({ kind: 'abstain' })
    );
  });

  it('encodes an approval and a denial in agy’s top-level form', () => {
    expect(encodeAntigravityVerdict({ kind: 'allowOnce' })).toEqual({ decision: 'allow' });
    expect(encodeAntigravityVerdict({ kind: 'deny', message: 'blocked by policy' })).toEqual({
      decision: 'deny',
      reason: 'blocked by policy',
    });
  });

  it('collapses the verdicts agy has no spelling for into an abstention', () => {
    // Not into `allow`: a standing grant is a different promise from approving
    // one call, and `{}` is not available to mean "no opinion" here.
    expect(encodeAntigravityVerdict({ kind: 'allowAlways' })).toEqual({ decision: 'ask' });
    expect(encodeAntigravityVerdict({ kind: 'answer', answers: [['yes']] })).toEqual({
      decision: 'ask',
    });
  });

  it('declares that abstaining is now safe, because of how it is spelled', () => {
    // #1762 declared `blocks`, correctly, for a source that had no `PreToolUse`
    // hook and would have answered `{}` if it had one. Measured on 1.1.12 for
    // #1779: an `ask` reply draws the ordinary approval dialog, which is
    // `proceeds`. Read this with the two assertions above — flipping the
    // encoding back to `{}` makes this declaration a lie.
    expect(antigravityAgentEventSource.noDecision).toEqual({ kind: 'proceeds' });
    expect(isAbstainSafe(antigravityAgentEventSource)).toBe(true);
    expect(describeAbstain(antigravityAgentEventSource).blocksForMs).toBe(0);
  });
});

describe('reading agy’s PreToolUse payload', () => {
  it('reads the captured fixture', () => {
    expect(parseAntigravityPermissionRequest(FIXTURE)).toEqual({
      toolName: 'run_command',
      toolInput: { CommandLine: 'echo hello', Cwd: '.', WaitMsBeforeAsync: 1000 },
      promptId: null,
      sessionId: '22222222-2222-4222-8222-222222222222',
      permissionMode: null,
      permissionSuggestions: null,
    });
  });

  it('feeds the deny patterns the command line, which is the whole point', () => {
    // `collectToolInputMatchTexts` judges deny patterns against the tool input.
    // A parser that returned the tool name and an empty input would adjudicate
    // every request as if it were harmless.
    const parsed = parseAntigravityPermissionRequest(FIXTURE);
    expect(JSON.stringify(parsed?.toolInput)).toContain('echo hello');
  });

  it('refuses anything it cannot vouch for', () => {
    // Null becomes no-decision at the call site, which on this tool is now a
    // dialog. Being strict costs a dialog; being lax approves a command.
    expect(parseAntigravityPermissionRequest(null)).toBeNull();
    expect(parseAntigravityPermissionRequest('{}')).toBeNull();
    expect(parseAntigravityPermissionRequest({})).toBeNull();
    expect(parseAntigravityPermissionRequest({ toolCall: {} })).toBeNull();
    expect(parseAntigravityPermissionRequest({ toolCall: { name: 'run_command' } })).toBeNull();
    expect(
      parseAntigravityPermissionRequest({ toolCall: { name: '', args: {} } })
    ).toBeNull();
    expect(
      parseAntigravityPermissionRequest({ toolCall: { name: 'x'.repeat(200), args: {} } })
    ).toBeNull();
  });

  it('does not read Claude’s spelling, because agy never sends it', () => {
    // A cross-wired parser would file some other tool's payload as agy's.
    expect(
      parseAntigravityPermissionRequest({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      })
    ).toBeNull();
  });
});
