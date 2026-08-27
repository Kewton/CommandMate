/**
 * `commandmate init` configures Web Push (Issue #2123).
 *
 * The Issue's acceptance condition — "key generation completes with a means
 * CommandMate provides (no external command typed by hand)" — is exactly this:
 * running `init` leaves an `.env` from which the server can send. Before it, the
 * only route was a `node -e "require('web-push')..."` one-liner nobody was told
 * about.
 *
 * Three properties are pinned, in descending order of how much damage getting
 * them wrong does:
 *
 *  1. **An existing key pair survives `--force`.** The public key is baked into
 *     every `PushSubscription` a browser has already created, so regenerating
 *     orphans every subscribed device — silently, which is #2124's whole
 *     complaint. This is the test to keep if only one can be kept.
 *  2. A fresh install gets a pair, and it is a real one (65/32 bytes base64url),
 *     with a subject that its own classifier accepts — so `init` can never
 *     produce a configuration the startup check will immediately warn about.
 *  3. A generation failure does not fail `init`: push is optional, and the state
 *     it leaves behind is exactly the pre-#2123 state, which the startup check
 *     now names.
 *
 * Driven through the real `runInit` with `fs` mocked, the way the rest of this
 * directory's suites are: the `.env` is read out of the `writeFileSync` call, so
 * the assertions are about the bytes that would land on disk.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');
vi.mock('../../../../src/cli/utils/security-logger');

import { runInit } from '../../../../src/cli/commands/init';
import { VAPID_DEFAULT_SUBJECT, inspectVapidConfig } from '../../../../src/lib/push/vapid';
import { isVapidKeyPair } from '../../../../src/cli/utils/vapid-keygen';

const EXISTING_PUBLIC = Buffer.alloc(65, 3).toString('base64url');
const EXISTING_PRIVATE = Buffer.alloc(32, 5).toString('base64url');

function mockAllDependenciesFound(): void {
  vi.mocked(childProcess.spawnSync).mockReturnValue({
    status: 0,
    stdout: 'v22.0.0',
    stderr: '',
    pid: 1234,
    output: [],
    signal: null,
  });
}

/** The `.env` content `init` handed to writeFileSync. */
function writtenEnv(): string {
  const call = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
  expect(call, 'init wrote no .env').toBeDefined();
  return String(call?.[1]);
}

/** Parse the written `.env` into the environment the server would see. */
function writtenEnvAsRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of writtenEnv().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

describe('runInit and Web Push (Issue #2123)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAllDependenciesFound();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.chmodSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a usable key pair into a fresh .env', async () => {
    const result = await runInit({ defaults: true });

    expect(result.ok).toBe(true);
    expect(
      isVapidKeyPair({
        publicKey: result.config?.CM_VAPID_PUBLIC_KEY,
        privateKey: result.config?.CM_VAPID_PRIVATE_KEY,
      })
    ).toBe(true);

    const env = writtenEnvAsRecord();
    expect(env.CM_VAPID_PUBLIC_KEY).toBe(result.config?.CM_VAPID_PUBLIC_KEY);
    expect(env.CM_VAPID_PRIVATE_KEY).toBe(result.config?.CM_VAPID_PRIVATE_KEY);
  });

  it('leaves the server in a state its own startup check calls healthy', async () => {
    // The closing of the loop: `init` must never produce a configuration that the
    // #2124 self-check immediately warns about.
    await runInit({ defaults: true });
    expect(inspectVapidConfig(writtenEnvAsRecord()).status).toBe('ok');
  });

  it('writes the APNs-safe default subject', async () => {
    const result = await runInit({ defaults: true });
    expect(result.config?.CM_VAPID_SUBJECT).toBe(VAPID_DEFAULT_SUBJECT);
    expect(writtenEnvAsRecord().CM_VAPID_SUBJECT).toBe(VAPID_DEFAULT_SUBJECT);
    expect(writtenEnv()).not.toContain('mailto:commandmate@localhost');
  });

  it('keeps an existing key pair when --force rewrites the file', async () => {
    // Regenerating here would orphan every device that has already subscribed.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        'CM_PORT=3000',
        `CM_VAPID_PUBLIC_KEY=${EXISTING_PUBLIC}`,
        `CM_VAPID_PRIVATE_KEY=${EXISTING_PRIVATE}`,
        'CM_VAPID_SUBJECT=mailto:ops@example.com',
        '',
      ].join('\n') as unknown as never
    );

    const result = await runInit({ defaults: true, force: true });

    expect(result.config?.CM_VAPID_PUBLIC_KEY).toBe(EXISTING_PUBLIC);
    expect(result.config?.CM_VAPID_PRIVATE_KEY).toBe(EXISTING_PRIVATE);
    // …and the operator's own subject survives too, rather than being reset to
    // the project default.
    expect(result.config?.CM_VAPID_SUBJECT).toBe('mailto:ops@example.com');
  });

  it('generates a pair when the existing .env has only half of one', async () => {
    // Half a pair is not a pair: keeping it would leave push permanently off,
    // reported as "partial" forever.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockReturnValue(
      `CM_VAPID_PUBLIC_KEY=${EXISTING_PUBLIC}\n` as unknown as never
    );

    const result = await runInit({ defaults: true, force: true });

    expect(result.config?.CM_VAPID_PUBLIC_KEY).not.toBe(EXISTING_PUBLIC);
    expect(inspectVapidConfig(writtenEnvAsRecord()).status).toBe('ok');
  });

  it('never echoes the private key to the console', async () => {
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });

    const result = await runInit({ defaults: true });

    expect(result.config?.CM_VAPID_PRIVATE_KEY).toBeDefined();
    expect(logged.join('\n')).not.toContain(result.config?.CM_VAPID_PRIVATE_KEY as string);
  });
});
