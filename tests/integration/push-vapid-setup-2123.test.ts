/**
 * The whole #2123 / #2124 path, end to end, over real files (integration).
 *
 * The unit suites each pin one link. This one pins that the links FIT: the keys
 * `commandmate init` writes are keys the server's own self-check calls healthy,
 * the API route serves the public key it wrote, and a subject that reaches APNs
 * is the one that comes out when the operator sets nothing.
 *
 * That fit is the acceptance condition neither Issue can state on its own — #2123
 * asks "can a new reader get to a subscription", #2124 asks "is the default
 * accepted" — and it is where a real regression would live: a keygen that emits
 * standard base64, an `.env` writer whose escaping the loader disagrees with, a
 * self-check reading a variable name nobody writes. Every one of those passes its
 * own unit test.
 *
 * Real temp directories and the real `web-push` are used; nothing is stubbed. No
 * server is started and no port is bound — the loop closed here is
 * configuration, not transport.
 *
 * NOT measured here (and not measurable in CI): what APNs or FCM actually do with
 * a given subject. Those are the orchestrator's device measurements from the Epic
 * #2002 UAT (2026-08-27, two devices); this file asserts only what CommandMate
 * produces and reports.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { generateVapidKeyPair } from '../../src/cli/utils/vapid-keygen';
import { EnvSetup, readExistingVapidKeys } from '../../src/cli/utils/env-setup';
import {
  VAPID_DEFAULT_SUBJECT,
  formatVapidReportLines,
  inspectVapidConfig,
} from '../../src/lib/push/vapid';
import type { EnvConfig } from '../../src/cli/types';

const VAPID_VARS = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

const BASE: EnvConfig = {
  CM_ROOT_DIR: '/tmp/repos',
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  CM_DB_PATH: '/tmp/cm.db',
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
};

/** What `commandmate init` does, minus the preflight and the console output. */
async function writeInitEnv(
  overrides: Partial<EnvConfig> = {}
): Promise<{ config: EnvConfig; parsed: Record<string, string> }> {
  const existing = readExistingVapidKeys(envPath);
  const generated =
    existing.CM_VAPID_PUBLIC_KEY && existing.CM_VAPID_PRIVATE_KEY
      ? { publicKey: existing.CM_VAPID_PUBLIC_KEY, privateKey: existing.CM_VAPID_PRIVATE_KEY }
      : await (async () => {
          const result = await generateVapidKeyPair();
          if (!result.ok) throw new Error(result.error);
          return result.keys;
        })();

  const config: EnvConfig = {
    ...BASE,
    CM_VAPID_PUBLIC_KEY: generated.publicKey,
    CM_VAPID_PRIVATE_KEY: generated.privateKey,
    CM_VAPID_SUBJECT: existing.CM_VAPID_SUBJECT || VAPID_DEFAULT_SUBJECT,
    ...overrides,
  };

  await new EnvSetup(envPath).createEnvFile(config, { force: true });
  return { config, parsed: dotenvConfig({ path: envPath, processEnv: {} }).parsed ?? {} };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-2123-int-'));
  envPath = join(dir, '.env');
  saved = {};
  for (const key of VAPID_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of VAPID_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('init -> .env -> self-check (Issues #2123 / #2124)', () => {
  it('produces a configuration the startup check calls healthy and says nothing about', async () => {
    const { parsed } = await writeInitEnv();

    const inspection = inspectVapidConfig(parsed);
    expect(inspection.status).toBe('ok');
    expect(inspection.configured).toBe(true);
    // The negative control, at the end of the whole chain: a reader who runs
    // `commandmate init` and starts the server sees no push line at all.
    expect(formatVapidReportLines(inspection)).toEqual([]);
  });

  it('the written keys survive dotenv, byte for byte', async () => {
    // base64url contains `-` and `_`; a writer that quoted or escaped them, or a
    // loader that unescaped differently, would produce keys the push service
    // rejects — and that failure is invisible until a real device is involved.
    const { config, parsed } = await writeInitEnv();
    expect(parsed.CM_VAPID_PUBLIC_KEY).toBe(config.CM_VAPID_PUBLIC_KEY);
    expect(parsed.CM_VAPID_PRIVATE_KEY).toBe(config.CM_VAPID_PRIVATE_KEY);
  });

  it('the public key is the 65-byte uncompressed point PushManager needs', async () => {
    const { parsed } = await writeInitEnv();
    const point = Buffer.from(parsed.CM_VAPID_PUBLIC_KEY, 'base64url');
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
    expect(Buffer.from(parsed.CM_VAPID_PRIVATE_KEY, 'base64url').length).toBe(32);
  });

  it('serves that public key through getVapidPublicKey', async () => {
    // The route (`GET /api/push/vapid`) is a one-line wrapper over this, and it is
    // the check the guide tells the reader to run.
    const { parsed } = await writeInitEnv();
    for (const key of VAPID_VARS) process.env[key] = parsed[key];

    const { getVapidPublicKey, isPushConfigured } = await import('../../src/lib/push/vapid');
    expect(isPushConfigured()).toBe(true);
    expect(getVapidPublicKey()).toBe(parsed.CM_VAPID_PUBLIC_KEY);
  });

  it('writes the .env with owner-only permissions', async () => {
    await writeInitEnv();
    // The private key is in this file.
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('a second init keeps the key pair, so subscribed devices are not orphaned', async () => {
    const first = await writeInitEnv();
    const second = await writeInitEnv();

    expect(second.parsed.CM_VAPID_PUBLIC_KEY).toBe(first.parsed.CM_VAPID_PUBLIC_KEY);
    expect(second.parsed.CM_VAPID_PRIVATE_KEY).toBe(first.parsed.CM_VAPID_PRIVATE_KEY);
  });

  it('an operator subject survives a second init', async () => {
    await writeInitEnv({ CM_VAPID_SUBJECT: 'mailto:ops@example.com' });
    const { parsed } = await writeInitEnv();
    expect(parsed.CM_VAPID_SUBJECT).toBe('mailto:ops@example.com');
  });
});

describe('the subject the operator ends up with (Issue #2124)', () => {
  it('defaults to a subject its own classifier accepts', async () => {
    const { parsed } = await writeInitEnv();
    expect(parsed.CM_VAPID_SUBJECT).toBe(VAPID_DEFAULT_SUBJECT);
    expect(inspectVapidConfig(parsed).subjectIssue).toBeNull();
  });

  it('never writes the localhost mailto that was measured as a 403', async () => {
    await writeInitEnv();
    expect(readFileSync(envPath, 'utf-8')).not.toContain('mailto:commandmate@localhost');
  });

  it('reports, without disabling push, when the operator sets an unusable subject', async () => {
    const { parsed } = await writeInitEnv({ CM_VAPID_SUBJECT: 'mailto:cm@localhost' });

    const inspection = inspectVapidConfig(parsed);
    expect(inspection.status).toBe('invalid-subject');
    // Fail-open: the keys are fine, so push stays on and only Apple refuses it.
    expect(inspection.configured).toBe(true);
    // And the value is reported verbatim rather than silently replaced, so the
    // warning describes what the server will actually send.
    expect(inspection.subject).toBe('mailto:cm@localhost');
    expect(formatVapidReportLines(inspection).join('\n')).toContain('APNs');
  });
});
