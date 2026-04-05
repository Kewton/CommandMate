/**
 * Simple CLI Spinner
 * Issue #638: Report generation status visibility - CLI progress
 *
 * Lightweight spinner for stderr output without external dependencies.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '���', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  start(): void;
  stop(): void;
  succeed(message: string): void;
  fail(message: string): void;
}

type WriteFn = (text: string) => void;

/**
 * Create a simple spinner that writes to stderr.
 * @param message - The message to display alongside the spinner
 * @param writeFn - Optional custom write function (defaults to process.stderr.write)
 */
export function createSpinner(
  message: string,
  writeFn?: WriteFn,
): Spinner {
  const write: WriteFn = writeFn ?? ((text: string) => process.stderr.write(text));
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;

  function clearLine() {
    write('\r\x1b[K');
  }

  return {
    start() {
      frameIndex = 0;
      timer = setInterval(() => {
        clearLine();
        write(`${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]} ${message}`);
        frameIndex++;
      }, FRAME_INTERVAL_MS);
      // Show first frame immediately
      write(`${SPINNER_FRAMES[0]} ${message}`);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    },

    succeed(msg: string) {
      this.stop();
      write(`✓ ${msg}\n`);
    },

    fail(msg: string) {
      this.stop();
      write(`✗ ${msg}\n`);
    },
  };
}
