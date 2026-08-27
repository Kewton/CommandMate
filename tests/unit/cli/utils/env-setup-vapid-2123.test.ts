/**
 * `.env` carries the Web Push trio, and `--force` never destroys it (#2123 / #2124).
 *
 * ## The part that is a data-loss guard, not a formatting test
 *
 * `commandmate init --force` rewrites `.env` from scratch. Regenerating the VAPID
 * key pair there would be a silent data-loss bug: the public key is baked into
 * every `PushSubscription` a browser has already created, so a new pair orphans
 * every subscribed device — the rows stay in `push_subscriptions`, every send
 * fails, and (before #2124) nothing told anyone. `readExistingVapidKeys` is what
 * stops that, and the round-trip test below is the one that goes red if the
 * escaping and the parser ever stop agreeing.
 *
 * `readExistingVapidKeys` deliberately does NOT use `dotenv`: it reads a file that
 * is about to be overwritten, and `dotenv.config()` would populate `process.env`
 * as a side effect, leaking the old keys into the running CLI. The env-isolation
 * test below pins that.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EnvSetup,
  escapeEnvValue,
  readExistingVapidKeys,
} from '../../../../src/cli/utils/env-setup';
import type { EnvConfig } from '../../../../src/cli/types';

let dir: string;
let envPath: string;

const BASE: EnvConfig = {
  CM_ROOT_DIR: '/tmp/repos',
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  CM_DB_PATH: '/tmp/cm.db',
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
};

const PUBLIC = Buffer.alloc(65, 3).toString('base64url');
const PRIVATE = Buffer.alloc(32, 5).toString('base64url');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-vapid-env-'));
  envPath = join(dir, '.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT']) {
    delete process.env[key];
  }
});

describe('readExistingVapidKeys (Issue #2123)', () => {
  it('returns nothing for a file that does not exist', () => {
    expect(readExistingVapidKeys(join(dir, 'absent.env'))).toEqual({});
  });

  it('returns nothing for a file with no VAPID variables', () => {
    writeFileSync(envPath, 'CM_PORT=3000\nCM_BIND=127.0.0.1\n');
    expect(readExistingVapidKeys(envPath)).toEqual({});
  });

  it('reads the three variables', () => {
    writeFileSync(
      envPath,
      [
        'CM_PORT=3000',
        `CM_VAPID_PUBLIC_KEY=${PUBLIC}`,
        `CM_VAPID_PRIVATE_KEY=${PRIVATE}`,
        'CM_VAPID_SUBJECT=mailto:ops@example.com',
        '',
      ].join('\n')
    );
    expect(readExistingVapidKeys(envPath)).toEqual({
      CM_VAPID_PUBLIC_KEY: PUBLIC,
      CM_VAPID_PRIVATE_KEY: PRIVATE,
      CM_VAPID_SUBJECT: 'mailto:ops@example.com',
    });
  });

  it('ignores comments, blank lines and empty values', () => {
    writeFileSync(
      envPath,
      [
        '# CM_VAPID_PUBLIC_KEY=commented-out',
        '',
        'CM_VAPID_PRIVATE_KEY=',
        `CM_VAPID_PUBLIC_KEY=${PUBLIC}`,
        '',
      ].join('\n')
    );
    expect(readExistingVapidKeys(envPath)).toEqual({ CM_VAPID_PUBLIC_KEY: PUBLIC });
  });

  it('does not match a variable whose name merely ends with a VAPID name', () => {
    writeFileSync(envPath, `OLD_CM_VAPID_PUBLIC_KEY=${PUBLIC}\n`);
    expect(readExistingVapidKeys(envPath)).toEqual({});
  });

  it('does not leak the keys into process.env', () => {
    // The reason this is hand-rolled rather than `dotenv`: it reads a file that is
    // about to be overwritten, and populating the environment from it would make
    // the running CLI carry the values it is replacing.
    writeFileSync(envPath, `CM_VAPID_PUBLIC_KEY=${PUBLIC}\nCM_VAPID_PRIVATE_KEY=${PRIVATE}\n`);
    readExistingVapidKeys(envPath);
    expect(process.env.CM_VAPID_PUBLIC_KEY).toBeUndefined();
    expect(process.env.CM_VAPID_PRIVATE_KEY).toBeUndefined();
  });

  it('reads back a value that needed quoting when written', () => {
    // The round trip through escapeEnvValue is the property that matters: a
    // subject with a space would otherwise be written quoted and read back with
    // the quotes still attached, silently changing the `sub` claim.
    const subject = 'mailto:ops team@example.com';
    writeFileSync(envPath, `CM_VAPID_SUBJECT=${escapeEnvValue(subject)}\n`);
    expect(readExistingVapidKeys(envPath).CM_VAPID_SUBJECT).toBe(subject);
  });
});

describe('createEnvFile writes the trio (Issues #2123 / #2124)', () => {
  it('emits all three variables when the pair is present', async () => {
    await new EnvSetup(envPath).createEnvFile({
      ...BASE,
      CM_VAPID_PUBLIC_KEY: PUBLIC,
      CM_VAPID_PRIVATE_KEY: PRIVATE,
      CM_VAPID_SUBJECT: 'https://github.com/Kewton/CommandMate',
    });

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain(`CM_VAPID_PUBLIC_KEY=${PUBLIC}`);
    expect(content).toContain(`CM_VAPID_PRIVATE_KEY=${PRIVATE}`);
    expect(content).toContain('CM_VAPID_SUBJECT=https://github.com/Kewton/CommandMate');
    // The reader has to learn from the file itself that one of these is a secret.
    expect(content).toContain('secret');
  });

  it('emits none of them when the pair is absent', () => {
    // A half-written trio would make `commandmate status` report a "partial"
    // configuration nobody asked for.
    return new EnvSetup(envPath).createEnvFile(BASE).then(() => {
      expect(readFileSync(envPath, 'utf-8')).not.toContain('CM_VAPID');
    });
  });

  it('emits none of them when only the public key is present', async () => {
    await new EnvSetup(envPath).createEnvFile({ ...BASE, CM_VAPID_PUBLIC_KEY: PUBLIC });
    expect(readFileSync(envPath, 'utf-8')).not.toContain('CM_VAPID');
  });

  it('round-trips through readExistingVapidKeys', async () => {
    const subject = 'mailto:ops@example.com';
    await new EnvSetup(envPath).createEnvFile({
      ...BASE,
      CM_VAPID_PUBLIC_KEY: PUBLIC,
      CM_VAPID_PRIVATE_KEY: PRIVATE,
      CM_VAPID_SUBJECT: subject,
    });
    expect(readExistingVapidKeys(envPath)).toEqual({
      CM_VAPID_PUBLIC_KEY: PUBLIC,
      CM_VAPID_PRIVATE_KEY: PRIVATE,
      CM_VAPID_SUBJECT: subject,
    });
  });
});
