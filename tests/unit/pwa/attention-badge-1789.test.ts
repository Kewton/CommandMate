/**
 * @vitest-environment jsdom
 *
 * The out-of-page renderings of the attention count (Issue #1789).
 *
 * The three surfaces are pinned separately from the hook that drives them
 * because each has its own way of going wrong quietly: a title transform that is
 * not idempotent stacks prefixes, a favicon swap that forgets the original href
 * can never restore it, and a Badging API call on a browser without one throws
 * inside an effect and takes the app shell down with it.
 *
 * jsdom has no 2D canvas, so the context and `toDataURL` are stubbed — and
 * restored after every case, because CI runs the whole suite in one process
 * (`fileParallelism: false`) and a leaked prototype patch would surface as an
 * unrelated file failing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyAppBadge,
  applyFaviconDataUrl,
  FAVICON_BADGE_AMBER,
  FAVICON_BADGE_RED,
  findFaviconLinks,
  formatFaviconBadgeText,
  formatTitleWithBadge,
  originalFaviconHref,
  renderFaviconBadgeDataUrl,
  restoreFavicons,
  stripTitleBadge,
  type FaviconSwapRecord,
} from '@/lib/pwa/attention-badge';

const STUB_DATA_URL = 'data:image/png;base64,STUB';

interface RecordingContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  discFills: string[];
  texts: Array<{ text: string; color: string }>;
}

function makeContext(): RecordingContext {
  const ctx: RecordingContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(() => {
      ctx.discFills.push(ctx.fillStyle);
    }),
    stroke: vi.fn(),
    fillText: vi.fn((text: string) => {
      ctx.texts.push({ text, color: ctx.fillStyle });
    }),
    discFills: [],
    texts: [],
  };
  return ctx;
}

let context: RecordingContext | null = null;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

function stubCanvas(ctx: RecordingContext | null): void {
  context = ctx;
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = (() =>
    STUB_DATA_URL) as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
}

beforeEach(() => {
  document.head.innerHTML = '';
  stubCanvas(makeContext());
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  document.head.innerHTML = '';
  context = null;
});

describe('title transform (Issue #1789)', () => {
  it('leaves the title alone at zero', () => {
    expect(formatTitleWithBadge('CommandMate', 0)).toBe('CommandMate');
  });

  it('prefixes one, several, and more than nine', () => {
    expect(formatTitleWithBadge('CommandMate', 1)).toBe('(1) CommandMate');
    expect(formatTitleWithBadge('Review | CommandMate', 3)).toBe('(3) Review | CommandMate');
    // Unlike the favicon, the title has room for the exact number — `9+` there
    // is a legibility cap at 16 px, not a rule about the count.
    expect(formatTitleWithBadge('CommandMate', 12)).toBe('(12) CommandMate');
  });

  it('is idempotent: applying it twice cannot produce "(1) (1) Foo"', () => {
    const once = formatTitleWithBadge('CommandMate', 1);
    expect(formatTitleWithBadge(once, 1)).toBe('(1) CommandMate');
    expect(formatTitleWithBadge(formatTitleWithBadge(once, 1), 1)).toBe('(1) CommandMate');
  });

  it('replaces a stale badge rather than stacking on it', () => {
    expect(formatTitleWithBadge('(1) CommandMate', 4)).toBe('(4) CommandMate');
    expect(formatTitleWithBadge('(9+) CommandMate', 2)).toBe('(2) CommandMate');
  });

  it('emits no trailing space when there is no title to prefix', () => {
    // `document.title`'s getter strips whitespace, so `"(2) "` would read back
    // as `"(2)"` — a permanent mismatch for any caller that re-applies on a
    // title change, i.e. an endless write loop.
    expect(formatTitleWithBadge('', 2)).toBe('(2)');
    expect(formatTitleWithBadge(formatTitleWithBadge('', 2), 2)).toBe('(2)');
    expect(formatTitleWithBadge('(2)', 0)).toBe('');
  });

  it('restores the undecorated title at zero, whatever it was decorated with', () => {
    expect(formatTitleWithBadge('(7) Review | CommandMate', 0)).toBe('Review | CommandMate');
    expect(stripTitleBadge('(9+) CommandMate')).toBe('CommandMate');
    expect(stripTitleBadge('CommandMate')).toBe('CommandMate');
  });
});

describe('favicon badge text (Issue #1789)', () => {
  it('caps at 9+, so at most two glyphs have to survive being drawn at 16px', () => {
    expect(formatFaviconBadgeText(0)).toBe('');
    expect(formatFaviconBadgeText(1)).toBe('1');
    expect(formatFaviconBadgeText(9)).toBe('9');
    expect(formatFaviconBadgeText(10)).toBe('9+');
    expect(formatFaviconBadgeText(150)).toBe('9+');
  });
});

describe('favicon rendering (Issue #1789)', () => {
  it('returns a data URL — never a fetchable URL, which the SW cache would own', () => {
    const url = renderFaviconBadgeDataUrl(2);
    expect(url).toBe(STUB_DATA_URL);
    expect(url?.startsWith('data:')).toBe(true);
  });

  it('draws nothing at zero', () => {
    expect(renderFaviconBadgeDataUrl(0)).toBeNull();
  });

  it('returns null instead of throwing when there is no 2D context', () => {
    stubCanvas(null);
    expect(() => renderFaviconBadgeDataUrl(3)).not.toThrow();
    expect(renderFaviconBadgeDataUrl(3)).toBeNull();
  });

  it('paints the count amber, and the overflow state red', () => {
    renderFaviconBadgeDataUrl(2);
    expect(context?.discFills).toContain(FAVICON_BADGE_AMBER);
    expect(context?.texts.at(-1)?.text).toBe('2');

    stubCanvas(makeContext());
    renderFaviconBadgeDataUrl(42);
    expect(context?.discFills).toContain(FAVICON_BADGE_RED);
    expect(context?.texts.at(-1)?.text).toBe('9+');
  });

  it('composites onto the app icon when it is loaded, and onto a plate when it is not', () => {
    const image = { width: 64, height: 64 } as unknown as CanvasImageSource;
    renderFaviconBadgeDataUrl(1, { base: image });
    expect(context?.drawImage).toHaveBeenCalledTimes(1);
    expect(context?.fillRect).not.toHaveBeenCalled();

    stubCanvas(makeContext());
    renderFaviconBadgeDataUrl(1);
    expect(context?.drawImage).not.toHaveBeenCalled();
    expect(context?.fillRect).toHaveBeenCalledTimes(1);
  });
});

describe('favicon link swapping (Issue #1789)', () => {
  function seedLinks(): void {
    document.head.innerHTML = `
      <link rel="icon" href="/icon.png?v=1" type="image/png" sizes="32x32">
      <link rel="icon" href="/icon1.png?v=1" type="image/png" sizes="192x192">
      <link rel="apple-touch-icon" href="/apple-icon.png" sizes="180x180">
    `;
  }

  it('finds the tab icons and leaves the apple-touch-icon alone', () => {
    seedLinks();
    const links = findFaviconLinks(document);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/icon.png?v=1', '/icon1.png?v=1']);
  });

  it('rewrites only href, keeping sizes and type as Next.js emitted them', () => {
    seedLinks();
    const records: FaviconSwapRecord[] = [];
    applyFaviconDataUrl(document, STUB_DATA_URL, records);

    const [first] = findFaviconLinks(document);
    expect(first.getAttribute('href')).toBe(STUB_DATA_URL);
    expect(first.getAttribute('sizes')).toBe('32x32');
    expect(first.getAttribute('type')).toBe('image/png');
  });

  it('restores every original href', () => {
    seedLinks();
    const records: FaviconSwapRecord[] = [];
    applyFaviconDataUrl(document, STUB_DATA_URL, records);
    restoreFavicons(records);

    expect(findFaviconLinks(document).map((l) => l.getAttribute('href'))).toEqual([
      '/icon.png?v=1',
      '/icon1.png?v=1',
    ]);
    expect(records).toHaveLength(0);
  });

  it('never records a data URL as the original, however many times it re-applies', () => {
    // The failure this guards: swapping twice before restoring, and "restoring"
    // to the badge — a favicon that can never go back.
    seedLinks();
    const records: FaviconSwapRecord[] = [];
    applyFaviconDataUrl(document, STUB_DATA_URL, records);
    applyFaviconDataUrl(document, 'data:image/png;base64,SECOND', records);
    expect(records.map((r) => r.originalHref)).toEqual(['/icon.png?v=1', '/icon1.png?v=1']);

    restoreFavicons(records);
    expect(findFaviconLinks(document)[0].getAttribute('href')).toBe('/icon.png?v=1');
  });

  it('creates a link when the document has none, and removes it again', () => {
    const records: FaviconSwapRecord[] = [];
    applyFaviconDataUrl(document, STUB_DATA_URL, records);
    expect(findFaviconLinks(document)).toHaveLength(1);

    restoreFavicons(records);
    expect(findFaviconLinks(document)).toHaveLength(0);
  });

  it('reports the authored icon href even after the swap', () => {
    seedLinks();
    const records: FaviconSwapRecord[] = [];
    applyFaviconDataUrl(document, STUB_DATA_URL, records);
    expect(originalFaviconHref(document, records)).toBe('/icon.png?v=1');
  });
});

describe('app badge (Issue #1789)', () => {
  it('does nothing, and throws nothing, on a browser without the Badging API', () => {
    const bare = {} as Navigator;
    expect(() => applyAppBadge(3, bare)).not.toThrow();
    expect(applyAppBadge(3, bare)).toBe(false);
    expect(applyAppBadge(0, bare)).toBe(false);
  });

  it('sets the count and clears at zero', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    const nav = { setAppBadge, clearAppBadge } as unknown as Navigator;

    expect(applyAppBadge(4, nav)).toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(4);

    expect(applyAppBadge(0, nav)).toBe(true);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejection (installed-only APIs reject on a plain tab)', async () => {
    const nav = {
      setAppBadge: vi.fn(() => Promise.reject(new Error('not installed'))),
    } as unknown as Navigator;

    expect(() => applyAppBadge(1, nav)).not.toThrow();
    // If the rejection escaped, this turn of the microtask queue is where an
    // unhandled rejection would be reported.
    await Promise.resolve();
  });

  it('swallows a synchronous throw', () => {
    const nav = {
      setAppBadge: vi.fn(() => {
        throw new Error('boom');
      }),
    } as unknown as Navigator;
    expect(applyAppBadge(1, nav)).toBe(false);
  });

  it('accepts a non-promise return (older implementations return void)', () => {
    const nav = { setAppBadge: vi.fn(() => undefined) } as unknown as Navigator;
    expect(applyAppBadge(2, nav)).toBe(true);
  });
});
