/**
 * Unit tests for VAPID config resolution (Issue #1125).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVapidConfig, isPushConfigured, getVapidPublicKey } from '@/lib/push/vapid';

const KEYS = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

describe('vapid config', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns null when keys are absent', () => {
    expect(getVapidConfig()).toBeNull();
    expect(isPushConfigured()).toBe(false);
    expect(getVapidPublicKey()).toBeNull();
  });

  it('returns null when only one key is present', () => {
    process.env.CM_VAPID_PUBLIC_KEY = 'pub';
    expect(getVapidConfig()).toBeNull();
  });

  it('resolves config with a default subject when keys are present', () => {
    process.env.CM_VAPID_PUBLIC_KEY = 'pub';
    process.env.CM_VAPID_PRIVATE_KEY = 'priv';
    const config = getVapidConfig();
    expect(config).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:commandmate@localhost' });
    expect(isPushConfigured()).toBe(true);
    expect(getVapidPublicKey()).toBe('pub');
  });

  it('uses a custom subject when provided', () => {
    process.env.CM_VAPID_PUBLIC_KEY = 'pub';
    process.env.CM_VAPID_PRIVATE_KEY = 'priv';
    process.env.CM_VAPID_SUBJECT = 'mailto:ops@example.com';
    expect(getVapidConfig()?.subject).toBe('mailto:ops@example.com');
  });
});
