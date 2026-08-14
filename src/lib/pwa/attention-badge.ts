/**
 * Carrying "N need your attention" out of the page (Issue #1789).
 *
 * The number itself is not computed here — it comes from
 * `useAttentionCount` (Issue #1788), whose counting rule is the specification:
 * one waiting worktree counts once, however many of its agent instances are
 * waiting. This module is only the three renderings of that one number that
 * survive the tab being in the background:
 *
 *  1. **the tab title** — `(2) CommandMate`, readable in the tab strip;
 *  2. **the favicon** — an amber (or red) badge composited onto the app icon;
 *  3. **the OS/PWA app badge** — `navigator.setAppBadge`.
 *
 * Everything here is a pure function or a narrowly-scoped DOM operation, so the
 * hook that sequences them ({@link module:hooks/useAttentionBadge}) stays small
 * and each piece is testable on its own in jsdom.
 *
 * ## Why the title transform strips before it prepends
 *
 * `document.title` is shared state: Next.js rewrites it on every navigation and
 * any other feature may write to it. So the transform is defined as
 * *strip-then-prepend* rather than *prepend*, which makes re-applying it a
 * no-op. Running the effect twice, or re-applying after a title mutation we did
 * not cause, can never produce `(1) (1) CommandMate`.
 *
 * ## Why the favicon is a data URL
 *
 * The Service Worker caches `/favicon.ico` and `/icons/` cache-first
 * (`cache-policy.ts`). Pointing `<link rel="icon">` at a new *URL* would put the
 * badge behind that cache and behind the browser's own famously idiosyncratic
 * favicon caching. A `data:` URL is neither fetched nor cacheable, so it cannot
 * interact with either. Only `href` is rewritten — `sizes` and `type` are left
 * exactly as Next.js emitted them.
 *
 * @module lib/pwa/attention-badge
 */

/**
 * Matches a badge prefix this module produced, e.g. `"(3) "` or `"(9+) "`.
 *
 * The alternation with end-of-string is what lets `"(3)"` — the whole title of a
 * page that had no title of its own — be stripped as well, without also eating
 * the leading parenthetical of a real title like `"(2024) Report"`.
 */
export const TITLE_BADGE_PATTERN = /^\(\d+\+?\)(?:\s+|$)/;

/** Edge of the square canvas the favicon is composited on, in px. */
export const FAVICON_CANVAS_SIZE = 64;

/** Above this the badge reads `9+` — two glyphs is all that stays legible at 16px. */
export const FAVICON_BADGE_MAX = 9;

/** Normal state. Matches the `warning` token family the in-page badges use. */
export const FAVICON_BADGE_AMBER = '#f59e0b';

/**
 * Overflow state (`9+`). The colour change is tied to the count no longer
 * fitting rather than to an invented threshold: once the exact number is gone,
 * "a lot, and it has been piling up" is the whole message.
 */
export const FAVICON_BADGE_RED = '#ef4444';

/** Remove a badge prefix if one is present. Safe to call on any title. */
export function stripTitleBadge(title: string): string {
  return title.replace(TITLE_BADGE_PATTERN, '').trim();
}

/**
 * The title to display for `count`, given whatever the title currently is.
 *
 * Idempotent by construction: `f(f(t, n), n) === f(t, n)`, and `f(t, 0)` is the
 * undecorated title whether or not `t` carried a badge.
 *
 * The empty-title case is not hypothetical bookkeeping. `document.title`'s
 * getter strips and collapses whitespace, so `"(1) "` written to a page with no
 * title reads back as `"(1)"` — different from what was written, so the caller's
 * "did it change?" check says yes forever, and a title observer re-writing on
 * every change would spin. Hence the trim, and the no-space branch below.
 */
export function formatTitleWithBadge(title: string, count: number): string {
  const base = stripTitleBadge(title);
  if (!Number.isFinite(count) || count <= 0) return base;
  const badge = `(${Math.floor(count)})`;
  return base ? `${badge} ${base}` : badge;
}

/** Badge glyphs for the favicon: `''` at zero, the number, or `9+` past the cap. */
export function formatFaviconBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const n = Math.floor(count);
  return n > FAVICON_BADGE_MAX ? `${FAVICON_BADGE_MAX}+` : String(n);
}

/**
 * The `<link rel="icon">` elements Next.js emitted, in document order.
 *
 * `rel~="icon"` matches `rel="icon"` and `rel="shortcut icon"` but not
 * `rel="apple-touch-icon"` — that one is the home-screen icon, is never shown in
 * a tab strip, and is left alone.
 */
export function findFaviconLinks(doc: Document): HTMLLinkElement[] {
  return Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

export interface FaviconRenderOptions {
  /** The app icon to composite the badge onto. Omitted/not-yet-loaded is fine. */
  base?: CanvasImageSource | null;
  /** Canvas edge in px. Defaults to {@link FAVICON_CANVAS_SIZE}. */
  size?: number;
  /** Document to create the canvas in. Defaults to the ambient one. */
  document?: Document;
}

/**
 * Draw the badged favicon and return it as a `data:` URL, or `null`.
 *
 * `null` — not an exception — is returned for every environment that cannot
 * draw: no document, no 2D context (jsdom without the `canvas` package), a
 * tainted canvas. The caller simply leaves the existing favicon in place; a
 * missing badge is a missing nicety, never an error the user should see.
 *
 * The base icon is optional on purpose. The image loads asynchronously, and the
 * first paint after a wait starts should not be delayed by a network round trip
 * for an icon that is very likely already in the memory cache — so a plate is
 * drawn under the badge when the image is not ready, and the caller redraws
 * once it is.
 */
export function renderFaviconBadgeDataUrl(
  count: number,
  options: FaviconRenderOptions = {},
): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;

  const doc = options.document ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const size = options.size ?? FAVICON_CANVAS_SIZE;

  try {
    const canvas = doc.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);

    if (options.base) {
      ctx.drawImage(options.base, 0, 0, size, size);
    } else {
      // No icon yet: a neutral slate plate keeps the badge from floating on
      // transparency, which reads as a rendering glitch in a light tab strip.
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, size, size);
    }

    const overflow = Math.floor(count) > FAVICON_BADGE_MAX;
    const radius = size * 0.34;
    const centre = size - radius - size * 0.03;

    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.fillStyle = overflow ? FAVICON_BADGE_RED : FAVICON_BADGE_AMBER;
    ctx.fill();
    // A dark rim so the disc keeps its edge against a pale icon.
    ctx.lineWidth = size * 0.05;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();

    const text = formatFaviconBadgeText(count);
    ctx.fillStyle = overflow ? '#ffffff' : '#1c1300';
    ctx.font = `bold ${Math.round(size * (text.length > 1 ? 0.38 : 0.48))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, centre, centre + size * 0.02);

    return canvas.toDataURL('image/png');
  } catch {
    // Tainted canvas, a stubbed-out context, an exotic browser — no badge.
    return null;
  }
}

/** One `<link rel="icon">` we changed, and how to put it back. */
export interface FaviconSwapRecord {
  link: HTMLLinkElement;
  /** The `href` before we touched it; `null` when the attribute was absent. */
  originalHref: string | null;
  /** True when we added the element ourselves and must remove it on restore. */
  created: boolean;
}

/**
 * Point every icon link at `dataUrl`, recording what to restore.
 *
 * Records are only taken the first time a link is touched, so repeated calls
 * (one per count change) never overwrite the pristine href with a data URL.
 * When the document has no icon link at all — a bare test harness, or a future
 * metadata change — one is created and marked for removal.
 */
export function applyFaviconDataUrl(
  doc: Document,
  dataUrl: string,
  records: FaviconSwapRecord[],
): FaviconSwapRecord[] {
  let links = findFaviconLinks(doc);

  if (links.length === 0) {
    const created = doc.createElement('link');
    created.setAttribute('rel', 'icon');
    created.setAttribute('type', 'image/png');
    doc.head.appendChild(created);
    records.push({ link: created, originalHref: null, created: true });
    links = [created];
  }

  for (const link of links) {
    if (!records.some((record) => record.link === link)) {
      records.push({ link, originalHref: link.getAttribute('href'), created: false });
    }
    // Only `href`: `sizes` and `type` stay as Next.js emitted them, so the
    // browser keeps picking the right icon for the surface it is drawing.
    link.setAttribute('href', dataUrl);
  }

  return records;
}

/** Undo {@link applyFaviconDataUrl}, emptying `records` in place. */
export function restoreFavicons(records: FaviconSwapRecord[]): void {
  for (const record of records) {
    if (record.created) {
      record.link.remove();
      continue;
    }
    if (record.originalHref === null) record.link.removeAttribute('href');
    else record.link.setAttribute('href', record.originalHref);
  }
  records.length = 0;
}

/** The href of the app icon as authored, before any badge swap. */
export function originalFaviconHref(doc: Document, records: FaviconSwapRecord[]): string | null {
  for (const record of records) {
    if (!record.created && record.originalHref) return record.originalHref;
  }
  const link = findFaviconLinks(doc).find((el) => el.getAttribute('href'));
  return link?.getAttribute('href') ?? null;
}

/** The slice of `Navigator` the Badging API adds. Absent on most browsers. */
interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void> | void;
  clearAppBadge?: () => Promise<void> | void;
}

/**
 * Mirror the count onto the OS/PWA app icon, or do nothing at all.
 *
 * The Badging API exists on installed PWAs in Chromium and on macOS Safari, and
 * nowhere else — so *every* failure mode here is expected, not exceptional:
 * the methods may be missing, may reject because the app is not installed, or
 * may throw outright. All three are swallowed. Nothing is logged: a warning per
 * status change on an unsupported browser is a console the user stops reading.
 *
 * @returns whether a call was actually made (for tests, not for callers to act on)
 */
export function applyAppBadge(count: number, nav?: Navigator | null): boolean {
  const target = (nav ?? (typeof navigator !== 'undefined' ? navigator : null)) as
    | (Navigator & BadgingNavigator)
    | null;
  if (!target) return false;

  const silence = (result: Promise<void> | void): void => {
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {});
    }
  };

  try {
    if (Number.isFinite(count) && count > 0) {
      if (typeof target.setAppBadge !== 'function') return false;
      silence(target.setAppBadge(Math.floor(count)));
      return true;
    }
    if (typeof target.clearAppBadge !== 'function') return false;
    silence(target.clearAppBadge());
    return true;
  } catch {
    return false;
  }
}
