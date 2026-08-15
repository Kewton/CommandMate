/**
 * The opt-in "a branch is waiting for you" chime (Issue #1789).
 *
 * Synthesised with the Web Audio API rather than shipped as a file: two
 * oscillators cost nothing to download, cannot be blocked by a cache or a CSP
 * rule about media, and — the actual requirement — involve **no external
 * resource of any kind**. A CDN reference here would be a third party learning
 * every time one of your agents stops for input.
 *
 * ## Everything here fails silently, on purpose
 *
 * Browsers refuse to start audio before the user has interacted with the page,
 * and they disagree about what counts. So there is no error path: no throw, no
 * `console.error`, no toast, no retry. If the chime cannot play, the tab title
 * and the favicon badge (the other two surfaces of this Issue) still say the
 * same thing, and a browser that has decided to stay silent is not going to be
 * argued out of it by a retry loop.
 *
 * {@link unlockWaitingSound} is the counter-move: called from the first real
 * user gesture, it creates and resumes the context while the browser is still
 * willing, so the chime works from then on.
 *
 * @module lib/pwa/notification-sound
 */

/** Peak gain per tone. Quiet: this fires while you are working elsewhere. */
export const WAITING_SOUND_GAIN = 0.12;

/**
 * A rising two-note chime — an "attention" shape rather than an "error" shape,
 * because a branch waiting for you is a request, not a fault.
 */
export const WAITING_SOUND_TONES: ReadonlyArray<{
  /** Hz. */
  frequency: number;
  /** Seconds after the start of the chime. */
  offset: number;
  /** Seconds. */
  duration: number;
}> = [
  { frequency: 880, offset: 0, duration: 0.12 },
  { frequency: 1318.5, offset: 0.13, duration: 0.18 },
];

type AudioContextConstructor = new () => AudioContext;

/**
 * One context for the page. Creating one per chime leaks hardware audio
 * resources — Chrome caps a document at a few dozen and then refuses — and
 * would throw away the "already unlocked" state that makes the chime audible.
 */
let cachedContext: AudioContext | null = null;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function acquireContext(): AudioContext | null {
  if (cachedContext) return cachedContext;
  const Ctor = getAudioContextConstructor();
  if (!Ctor) return null;
  try {
    cachedContext = new Ctor();
  } catch {
    return null;
  }
  return cachedContext;
}

function silence(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).catch === 'function') {
    (result as Promise<unknown>).catch(() => {});
  }
}

/**
 * Bring the audio context to life from inside a user gesture.
 *
 * Safe to call repeatedly — after the first call it is a resume on an already
 * running context, which browsers treat as a no-op.
 */
export function unlockWaitingSound(): void {
  const ctx = acquireContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') silence(ctx.resume?.());
  } catch {
    // Nothing to do and nothing to say.
  }
}

/**
 * Play the chime once.
 *
 * @returns whether the tones were scheduled. `false` means the environment has
 * no Web Audio at all or refused to build the graph; it does **not** promise
 * that the user heard anything (a suspended context accepts the schedule and
 * plays nothing). Callers must not branch on it beyond tests.
 */
export function playWaitingSound(): boolean {
  const ctx = acquireContext();
  if (!ctx) return false;

  try {
    // Best effort: if the page has had a gesture, this makes the difference
    // between audible and not. If it has not, the schedule below is simply
    // never heard — which is the documented, accepted outcome.
    if (ctx.state === 'suspended') silence(ctx.resume?.());

    const start = ctx.currentTime ?? 0;

    for (const tone of WAITING_SOUND_TONES) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = tone.frequency;

      const at = start + tone.offset;
      const end = at + tone.duration;
      // A short attack and a ramp to (near) zero: a hard stop on a sine is a
      // click, which is exactly the sound nobody wants in the background.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(WAITING_SOUND_GAIN, at + 0.015);
      gain.gain.linearRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(end + 0.02);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the cached context.
 *
 * Used by tests between cases (the constructor is stubbed per test, and a
 * context cached from the previous one would be handed back) and available as a
 * teardown for anything that tears the page down without unloading it.
 */
export function disposeWaitingSound(): void {
  const ctx = cachedContext;
  cachedContext = null;
  try {
    silence(ctx?.close?.());
  } catch {
    // Already closed, or a stub without `close`.
  }
}
