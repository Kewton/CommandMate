/**
 * Renders a URL as a QR code the terminal can display (Issue #1937, R8).
 *
 * ## Why `qr.js`, and why through `lib/` (U-1)
 *
 * `react-qr-code` is React-only, so the CLI cannot reuse it. The three
 * candidates in the design note were measured; see
 * `dev-reports/issue/1937/u1-qr-dependency.md` for the numbers. In short:
 * `qr.js` is already resolved in this tree as `react-qr-code`'s pinned
 * dependency, so promoting it to a direct dependency adds **zero** install
 * bytes, against +5.3 MB / +31 packages for `qrcode` (which drags in `yargs`).
 *
 * Two consequences of that choice are load-bearing:
 *
 * 1. **We load `qr.js/lib/QRCode`, not the package facade.** The facade does
 *    `opt.errorCorrectLevel || ErrorCorrectLevel.H`, and `ErrorCorrectLevel.M`
 *    is `0` - so asking the facade for M silently gets you H. Measured on
 *    qr.js@0.0.0: `qrcode('abc', {errorCorrectLevel: 0}).errorCorrectLevel === 2`.
 *    A test pins that M really produces an M-sized symbol here.
 * 2. **`qr.js` ships no type declarations**, and `tsconfig.cli.json` has no
 *    `allowJs`, so a plain `import` fails `build:cli` with TS7016. The module is
 *    loaded through `createRequire` and given the narrow local interface below.
 *
 * ## Rendering
 *
 * One character cell carries two module rows (an upper half block), which is
 * what keeps modules roughly square in a terminal and halves the line count. A
 * 115-character tunnel URL at level M is a 45x45 symbol: **53 columns** with the
 * mandatory 4-module quiet zone, so it fits an 80-column terminal.
 *
 * A QR code that the terminal soft-wraps is unscannable, so this module never
 * emits one it knows to be too wide: it reports `fits: false` and lets the
 * caller print the URL as text instead.
 */
import { createRequire } from 'node:module';

/** The slice of `qr.js/lib/QRCode` this module uses. */
interface QrJsCode {
  typeNumber: number;
  moduleCount: number;
  addData(data: string): void;
  make(): void;
  isDark(row: number, col: number): boolean;
}
type QrJsCodeConstructor = new (typeNumber: number, errorCorrectLevel: number) => QrJsCode;

const requireCjs = createRequire(__filename);

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * qr.js's numeric codes. These are the QR spec's format-info values, not an
 * ordering - note that M is 0, which is the whole reason for the note above.
 */
const ERROR_CORRECT_LEVEL: Record<QrErrorCorrectionLevel, number> = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2,
};

/** Most redundancy first. The fallback ladder walks this list rightwards. */
const LEVELS_BY_REDUNDANCY: readonly QrErrorCorrectionLevel[] = ['H', 'Q', 'M', 'L'];

/** The QR spec's mandatory light border. Shrinking it breaks scanners. */
export const QR_QUIET_ZONE_MODULES = 4;

/** Assumed terminal width when the caller has none to offer. */
export const DEFAULT_TERMINAL_COLUMNS = 80;

const UPPER_HALF = '▀';
const LOWER_HALF = '▄';
const FULL_BLOCK = '█';
const SPACE = ' ';

/**
 * Written as a char code rather than a literal escape byte: raw C0 bytes in
 * `src/` are a CI failure (`scripts/check-control-chars.mjs`, Issue #1432).
 */
const ESC = String.fromCharCode(27);
const SGR_RESET = `${ESC}[0m`;
const FG_DARK = 30; // black
const FG_LIGHT = 97; // bright white
const BG_DARK = 40;
const BG_LIGHT = 107;

export interface QrTerminalOptions {
  /** Requested redundancy. Defaults to `'M'`, the usual QR default. */
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  /** Terminal width to fit into. Defaults to {@link DEFAULT_TERMINAL_COLUMNS}. */
  columns?: number;
  /**
   * Emit SGR colours so the symbol reads correctly on light *and* dark themes.
   * With `false` the light modules are drawn as block glyphs, which only scans
   * on a dark background. Callers should pass `false` when stdout is not a TTY.
   * Defaults to `true`.
   */
  color?: boolean;
  /**
   * Drop to a lower redundancy level when the requested one is too wide.
   * The quiet zone is never traded away - that would break scanning outright.
   * Defaults to `true`.
   */
  allowLevelDowngrade?: boolean;
}

export interface QrTerminalRender {
  /** Rows of the symbol. Empty when `fits` is false. */
  lines: string[];
  /** Width of each line in terminal cells, including the quiet zone. */
  columns: number;
  /** Number of terminal rows the symbol occupies. */
  rows: number;
  /** Modules per side, excluding the quiet zone. */
  moduleCount: number;
  /** QR version (1-40) that `qr.js` selected. */
  version: number;
  /** Redundancy actually used, which may be below the requested level. */
  errorCorrectionLevel: QrErrorCorrectionLevel;
  /** True when the requested level had to be lowered to fit. */
  downgraded: boolean;
  /** False when even the smallest allowed symbol is wider than `columns`. */
  fits: boolean;
}

/**
 * Encodes `text` and lays it out for a terminal of `columns` cells.
 *
 * Returns `fits: false` with no lines rather than something that would wrap.
 */
export function renderQrToTerminal(
  text: string,
  options: QrTerminalOptions = {},
): QrTerminalRender {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('renderQrToTerminal: text must be a non-empty string');
  }

  const requested = options.errorCorrectionLevel ?? 'M';
  const columns = options.columns ?? DEFAULT_TERMINAL_COLUMNS;
  const color = options.color ?? true;
  const allowDowngrade = options.allowLevelDowngrade ?? true;

  const ladder = allowDowngrade
    ? LEVELS_BY_REDUNDANCY.slice(LEVELS_BY_REDUNDANCY.indexOf(requested))
    : [requested];

  let smallest: QrTerminalRender | null = null;
  for (const level of ladder) {
    const symbol = encode(text, level);
    const width = symbol.moduleCount + QR_QUIET_ZONE_MODULES * 2;
    const candidate: QrTerminalRender = {
      lines: [],
      columns: width,
      rows: Math.ceil(width / 2),
      moduleCount: symbol.moduleCount,
      version: symbol.typeNumber,
      errorCorrectionLevel: level,
      downgraded: level !== requested,
      fits: width <= columns,
    };
    if (candidate.fits) {
      candidate.lines = layout(symbol, color);
      return candidate;
    }
    // Keep the last (smallest) attempt so the caller can report how wide the
    // symbol would have had to be.
    smallest = candidate;
  }

  // `ladder` always has at least one entry, so `smallest` is set here.
  return smallest as QrTerminalRender;
}

/**
 * Convenience wrapper for printing: the symbol when it fits, `null` when it
 * does not. A `null` return is the caller's cue to show the URL as text.
 */
export function formatQrForTerminal(
  text: string,
  options: QrTerminalOptions = {},
): string | null {
  const render = renderQrToTerminal(text, options);
  return render.fits ? render.lines.join('\n') : null;
}

function encode(text: string, level: QrErrorCorrectionLevel): QrJsCode {
  const QRCode = requireCjs('qr.js/lib/QRCode') as QrJsCodeConstructor;
  const code = new QRCode(-1, ERROR_CORRECT_LEVEL[level]);
  // qr.js's byte-mode writer does `charCodeAt(i)` into an 8-bit slot, so any
  // code point above U+00FF would be truncated. Re-expressing the string as its
  // UTF-8 bytes (one byte per latin1 char) is what makes a non-ASCII URL encode
  // to the bytes a scanner will decode back as UTF-8.
  code.addData(Buffer.from(text, 'utf8').toString('latin1'));
  code.make();
  return code;
}

/** Two module rows per terminal row, with the quiet zone drawn in. */
function layout(code: QrJsCode, color: boolean): string[] {
  const quiet = QR_QUIET_ZONE_MODULES;
  const width = code.moduleCount + quiet * 2;
  const isDark = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= code.moduleCount || c >= code.moduleCount) return false;
    return code.isDark(r, c) === true;
  };

  const lines: string[] = [];
  for (let row = 0; row < width; row += 2) {
    const cells: string[] = [];
    let pending = '';
    for (let col = 0; col < width; col++) {
      const top = isDark(row, col);
      // An odd height leaves the final row with no bottom half; treat the
      // missing module as light so the quiet zone stays intact.
      const bottom = row + 1 < width ? isDark(row + 1, col) : false;
      if (color) {
        const sgr = `${ESC}[${top ? FG_DARK : FG_LIGHT};${bottom ? BG_DARK : BG_LIGHT}m`;
        if (sgr !== pending) {
          cells.push(sgr);
          pending = sgr;
        }
        cells.push(UPPER_HALF);
      } else {
        cells.push(glyph(top, bottom));
      }
    }
    lines.push(color ? cells.join('') + SGR_RESET : cells.join(''));
  }
  return lines;
}

/**
 * Uncoloured mapping: light modules are drawn, dark modules are left as the
 * terminal background. Correct on a dark background, inverted on a light one -
 * which is why colour is the default.
 */
function glyph(topDark: boolean, bottomDark: boolean): string {
  if (topDark && bottomDark) return SPACE;
  if (topDark) return LOWER_HALF;
  if (bottomDark) return UPPER_HALF;
  return FULL_BLOCK;
}
