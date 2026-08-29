/**
 * Terminal QR renderer (Issue #1937, R8; U-1 decision).
 *
 * Two things are worth stating about what is pinned here.
 *
 * **The M-is-zero trap.** `qr.js`'s package facade does
 * `opt.errorCorrectLevel || ErrorCorrectLevel.H`, and its code for level M is
 * `0`. Asking that facade for M silently returns an H symbol — measurably
 * larger, and wrong about what the caller asked for. `qr-terminal.ts` therefore
 * constructs `qr.js/lib/QRCode` directly, and the tests below compare M against
 * H on a URL where the two differ so the trap cannot come back unnoticed.
 *
 * **Narrow terminals.** A QR code the terminal soft-wraps is unscannable, so
 * "too wide" cannot be allowed to degrade into "printed anyway". The renderer
 * reports `fits: false` and emits nothing, and `formatQrForTerminal` returns
 * `null` so the caller falls back to printing the URL as text.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_TERMINAL_COLUMNS,
  QR_QUIET_ZONE_MODULES,
  formatQrForTerminal,
  renderQrToTerminal,
} from '@/cli/utils/qr-terminal';

/** A Tailscale MagicDNS URL: the short end of what `remote` will show. */
const TAILNET_URL = 'https://commandmate.example.ts.net';

/** A Quick Tunnel URL with a pairing fragment: 115 chars, the realistic worst case. */
const TUNNEL_URL =
  'https://long-random-words-that-cloudflare-picks-here-abcdef.trycloudflare.com/login#code=A1B2C3D4E5F6G7H8J9K0MNPQRS';

const ESC = String.fromCharCode(27);

/** Printable width in terminal cells: SGR sequences occupy no columns. */
function cellWidth(line: string): number {
  // eslint-disable-next-line no-control-regex
  return [...line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')].length;
}

describe('encoding', () => {
  it('produces a square symbol with the mandatory 4-module quiet zone', () => {
    const render = renderQrToTerminal(TAILNET_URL, { color: false });
    expect(render.columns).toBe(render.moduleCount + QR_QUIET_ZONE_MODULES * 2);
    // Two module rows per terminal row, so the block is half as tall as wide.
    expect(render.rows).toBe(Math.ceil(render.columns / 2));
    expect(render.lines).toHaveLength(render.rows);
    for (const line of render.lines) {
      expect(cellWidth(line)).toBe(render.columns);
    }
  });

  it('surrounds the symbol with a light border on every side', () => {
    // A scanner needs the quiet zone. Uncoloured, a light module is a full
    // block, so the first and last rows must be nothing but full blocks.
    const render = renderQrToTerminal(TAILNET_URL, { color: false });
    const blank = '█'.repeat(render.columns);
    expect(render.lines[0]).toBe(blank);
    expect(render.lines[1]).toBe(blank);
    expect(render.lines[render.rows - 1]).toBe(blank);
    for (const line of render.lines) {
      expect(line.startsWith('████')).toBe(true);
      expect(line.endsWith('████')).toBe(true);
    }
  });

  it('honours the requested error correction level instead of silently using H', () => {
    // The regression this pins: `qr.js`'s facade maps M (numeric 0) onto H via
    // `||`. On this URL M is a version 7 / 45-module symbol and H is version 10
    // / 57 — so if M ever starts producing H's size again, this fails.
    const m = renderQrToTerminal(TUNNEL_URL, { errorCorrectionLevel: 'M', color: false });
    const h = renderQrToTerminal(TUNNEL_URL, { errorCorrectionLevel: 'H', color: false });
    expect(m.errorCorrectionLevel).toBe('M');
    expect(m.version).toBe(7);
    expect(m.moduleCount).toBe(45);
    expect(h.version).toBe(10);
    expect(h.moduleCount).toBe(57);
    expect(m.moduleCount).toBeLessThan(h.moduleCount);
  });

  it('defaults to level M', () => {
    expect(renderQrToTerminal(TUNNEL_URL, { color: false }).errorCorrectionLevel).toBe('M');
  });

  it('encodes non-ASCII as UTF-8 bytes rather than truncating them', () => {
    // `qr.js` writes `charCodeAt(i)` into an 8-bit slot, so a raw multibyte
    // string would be silently corrupted. The renderer re-expresses the input
    // as UTF-8 bytes first, which shows up as a larger symbol for the same
    // character count.
    const ascii = renderQrToTerminal('https://a.example.com/x/aaaaaa', { color: false });
    const multibyte = renderQrToTerminal('https://a.example.com/x/あああ', { color: false });
    expect(multibyte.moduleCount).toBeGreaterThanOrEqual(ascii.moduleCount);
    expect(() => renderQrToTerminal('https://例.example.com/login')).not.toThrow();
  });

  it('rejects empty input rather than emitting an empty symbol', () => {
    expect(() => renderQrToTerminal('')).toThrow(/non-empty/);
  });
});

describe('fitting a narrow terminal', () => {
  it('fits an 80-column terminal for a realistic tunnel URL', () => {
    // The acceptance measurement: 115-char URL, level M, 45 modules + 8 quiet
    // = 53 columns. 80 columns is the assumed default.
    const render = renderQrToTerminal(TUNNEL_URL, { columns: 80, color: false });
    expect(render.columns).toBe(53);
    expect(render.fits).toBe(true);
    expect(DEFAULT_TERMINAL_COLUMNS).toBe(80);
    expect(renderQrToTerminal(TUNNEL_URL, { color: false }).fits).toBe(true);
  });

  it('stays under 80 columns even for an over-long URL', () => {
    const long = `https://${'x'.repeat(140)}.trycloudflare.com/login#code=A1B2C3D4E5F6G7H8J9K0MNPQRS`;
    const render = renderQrToTerminal(long, { columns: 80, color: false });
    expect(long.length).toBeGreaterThan(180);
    expect(render.fits).toBe(true);
    expect(render.columns).toBeLessThanOrEqual(80);
  });

  it('emits nothing when the symbol cannot fit', () => {
    // Wrapping is the failure mode being designed out: half a QR code on each
    // of two lines scans as nothing at all, and looks like it should work.
    const render = renderQrToTerminal(TUNNEL_URL, { columns: 40 });
    expect(render.fits).toBe(false);
    expect(render.lines).toEqual([]);
    // The width it would have needed is still reported, so the caller can say
    // why it is showing a URL instead of a QR code.
    expect(render.columns).toBeGreaterThan(40);
    expect(formatQrForTerminal(TUNNEL_URL, { columns: 40 })).toBeNull();
  });

  it('never wraps: every emitted line fits the given width', () => {
    for (const columns of [53, 60, 80, 120, 200]) {
      const render = renderQrToTerminal(TUNNEL_URL, { columns, color: false });
      if (!render.fits) continue;
      for (const line of render.lines) {
        expect(cellWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('drops to a lower redundancy level to fit, and says so', () => {
    // H needs 65 columns for this URL; M needs 53. Trading redundancy is
    // allowed because the symbol stays spec-valid.
    const render = renderQrToTerminal(TUNNEL_URL, {
      errorCorrectionLevel: 'H',
      columns: 60,
      color: false,
    });
    expect(render.fits).toBe(true);
    expect(render.downgraded).toBe(true);
    expect(render.errorCorrectionLevel).toBe('M');
    expect(render.columns).toBe(53);
  });

  it('never trades away the quiet zone to fit', () => {
    // Shrinking the border is the other obvious way to save columns, and it
    // breaks scanning outright. The border stays 4 modules at every width.
    for (const columns of [53, 80, 200]) {
      const render = renderQrToTerminal(TUNNEL_URL, { columns, color: false });
      expect(render.columns - render.moduleCount).toBe(QR_QUIET_ZONE_MODULES * 2);
    }
  });

  it('keeps the requested level when downgrading is disabled', () => {
    const render = renderQrToTerminal(TUNNEL_URL, {
      errorCorrectionLevel: 'H',
      columns: 60,
      color: false,
      allowLevelDowngrade: false,
    });
    expect(render.errorCorrectionLevel).toBe('H');
    expect(render.downgraded).toBe(false);
    expect(render.fits).toBe(false);
  });

  it('reports the smallest attempt when nothing in the ladder fits', () => {
    // Falling through the whole ladder must still produce the L-level width,
    // not the width of whatever was tried first.
    const render = renderQrToTerminal(TUNNEL_URL, { errorCorrectionLevel: 'H', columns: 20 });
    expect(render.fits).toBe(false);
    expect(render.errorCorrectionLevel).toBe('L');
    expect(render.columns).toBe(49);
  });
});

describe('output form', () => {
  it('uses half-block glyphs so one row carries two module rows', () => {
    const render = renderQrToTerminal(TAILNET_URL, { color: false });
    const glyphs = new Set(render.lines.join('').split(''));
    expect([...glyphs].sort()).toEqual([' ', '▀', '▄', '█'].filter((g) => glyphs.has(g)).sort());
    expect(render.rows * 2).toBeGreaterThanOrEqual(render.columns);
  });

  it('colours both halves of each cell so it reads on light and dark themes', () => {
    // Without explicit colours the symbol is inverted on a light background.
    // Each cell sets a foreground (top module) and a background (bottom).
    const render = renderQrToTerminal(TAILNET_URL, { color: true });
    const line = render.lines[Math.floor(render.rows / 2)];
    expect(line).toContain(`${ESC}[97;107m`); // light over light
    expect(line).toMatch(new RegExp(`${ESC}\\[(30|97);(40|107)m`));
    expect(line.endsWith(`${ESC}[0m`)).toBe(true);
    expect(cellWidth(line)).toBe(render.columns);
  });

  it('emits no escape sequences when colour is off', () => {
    const render = renderQrToTerminal(TAILNET_URL, { color: false });
    expect(render.lines.join('')).not.toContain(ESC);
  });

  it('joins the lines for printing when it fits', () => {
    const render = renderQrToTerminal(TAILNET_URL, { columns: 80, color: false });
    expect(formatQrForTerminal(TAILNET_URL, { columns: 80, color: false })).toBe(
      render.lines.join('\n'),
    );
  });
});
