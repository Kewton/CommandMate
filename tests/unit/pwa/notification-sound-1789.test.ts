/**
 * @vitest-environment jsdom
 *
 * The synthesised waiting chime (Issue #1789).
 *
 * Two properties matter more than the waveform:
 *
 *  - **it never throws and never logs.** Autoplay policy differs by browser and
 *    by how the user reached the page; "no sound" is a normal outcome, not an
 *    error, and a console warning per waiting edge is a console nobody reads.
 *  - **it reuses one AudioContext.** One per chime would exhaust the hardware
 *    contexts a document is allowed, and would throw away the unlocked state
 *    that makes the chime audible at all.
 *
 * `window.AudioContext` is stubbed here and deleted afterwards — CI runs every
 * file in one process (`fileParallelism: false`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  disposeWaitingSound,
  playWaitingSound,
  unlockWaitingSound,
  WAITING_SOUND_TONES,
} from '@/lib/pwa/notification-sound';

class FakeOscillator {
  type = '';
  frequency = { value: 0 };
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connected = 0;
  connect(): void {
    this.connected += 1;
  }
  start(at: number): void {
    this.startedAt = at;
  }
  stop(at: number): void {
    this.stoppedAt = at;
  }
}

class FakeGainNode {
  ramps: Array<{ value: number; at: number }> = [];
  connected = 0;
  gain = {
    value: 0,
    setValueAtTime: (_value: number, _at: number): void => {},
    linearRampToValueAtTime: (value: number, at: number): void => {
      this.ramps.push({ value, at });
    },
  };
  connect(): void {
    this.connected += 1;
  }
}

class FakeAudioContext {
  currentTime = 10;
  destination = {};
  resumeCalls = 0;
  resumeImpl: () => Promise<void> = async () => {};
  failOscillator = false;
  oscillators: FakeOscillator[] = [];
  gains: FakeGainNode[] = [];
  closed = false;

  constructor(public state: string) {}

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return this.resumeImpl();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  createOscillator(): FakeOscillator {
    if (this.failOscillator) throw new Error('context closed');
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }
}

interface FakeConfig {
  state?: string;
  resumeImpl?: () => Promise<void>;
  failOscillator?: boolean;
}

let config: FakeConfig = {};
let created = 0;
let latest: FakeAudioContext | null = null;

function installAudioContext(key: 'AudioContext' | 'webkitAudioContext' = 'AudioContext'): void {
  const Stub = function AudioContextStub() {
    created += 1;
    const ctx = new FakeAudioContext(config.state ?? 'running');
    if (config.resumeImpl) ctx.resumeImpl = config.resumeImpl;
    ctx.failOscillator = config.failOscillator ?? false;
    latest = ctx;
    return ctx;
  };
  (window as unknown as Record<string, unknown>)[key] = Stub as unknown as typeof AudioContext;
}

beforeEach(() => {
  config = {};
  created = 0;
  latest = null;
  disposeWaitingSound();
});

afterEach(() => {
  disposeWaitingSound();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  vi.restoreAllMocks();
});

describe('playWaitingSound (Issue #1789)', () => {
  it('schedules one oscillator per tone of the chime', () => {
    installAudioContext();

    expect(playWaitingSound()).toBe(true);
    expect(latest?.oscillators).toHaveLength(WAITING_SOUND_TONES.length);
    expect(latest?.oscillators.map((o) => o.frequency.value)).toEqual(
      WAITING_SOUND_TONES.map((t) => t.frequency),
    );
    expect(latest?.oscillators.map((o) => o.startedAt)).toEqual(
      WAITING_SOUND_TONES.map((t) => 10 + t.offset),
    );
  });

  it('ramps the gain down instead of cutting the tone off (a hard stop clicks)', () => {
    installAudioContext();
    playWaitingSound();

    for (const gain of latest?.gains ?? []) {
      expect(gain.ramps.at(-1)?.value).toBeLessThan(0.001);
      expect(gain.connected).toBe(1);
    }
  });

  it('reuses a single AudioContext across chimes', () => {
    installAudioContext();
    playWaitingSound();
    playWaitingSound();
    playWaitingSound();
    expect(created).toBe(1);
  });

  it('is a silent no-op on a browser with no Web Audio at all', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => playWaitingSound()).not.toThrow();
    expect(playWaitingSound()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the webkit-prefixed constructor', () => {
    installAudioContext('webkitAudioContext');

    expect(playWaitingSound()).toBe(true);
    expect(created).toBe(1);
  });

  it('tries to resume a suspended context, and gives up quietly if it cannot', async () => {
    config = { state: 'suspended', resumeImpl: () => Promise.reject(new Error('gesture required')) };
    installAudioContext();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => playWaitingSound()).not.toThrow();
    expect(latest?.resumeCalls).toBe(1);
    // No retry loop: one attempt per chime, never a scheduled second try.
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false rather than throwing when the graph cannot be built', () => {
    config = { failOscillator: true };
    installAudioContext();

    expect(playWaitingSound()).toBe(false);
  });
});

describe('unlockWaitingSound (Issue #1789)', () => {
  it('creates and resumes the context from a user gesture', () => {
    config = { state: 'suspended' };
    installAudioContext();

    unlockWaitingSound();
    expect(created).toBe(1);
    expect(latest?.resumeCalls).toBe(1);
  });

  it('does not resume again once the context is running', () => {
    installAudioContext();
    unlockWaitingSound();
    unlockWaitingSound();
    expect(latest?.resumeCalls).toBe(0);
  });

  it('is a no-op without Web Audio', () => {
    expect(() => unlockWaitingSound()).not.toThrow();
  });
});
