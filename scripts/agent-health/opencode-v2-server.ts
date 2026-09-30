/**
 * The OpenCode V2 server around a probe session (Issue #2937).
 *
 * Production launches OpenCode V2 through `scripts/opencode-v2/launch.sh`,
 * which runs `opencode2 serve` on a reserved port with a per-launch password
 * and the TUI against it. The probe goes the same way: it reserves the port
 * and password with the runtime's own `reserveOpencodeV2Server` (under
 * `$CM_OPENCODE_V2_DIR`, which `main.ts` points inside the run's temp dir),
 * reads the server's SSE with the client the subscription uses, and after the
 * session is killed checks that the wrapper stopped the server.
 *
 * The verdicts are in `src/lib/agent-health/server-events.ts`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ReceivedServerEvent, ServerLeftovers } from '@/lib/agent-health/server-events';
import { isPortFree } from '@/lib/hooks/sources/opencode/ports';
import { openOpencodeV2EventStream, probeOpencodeV2Server } from '@/lib/hooks/sources/opencode-v2/client';
import { frameType } from '@/lib/hooks/sources/opencode-v2/mappers';
import { releaseOpencodeV2Server, reserveOpencodeV2Server } from '@/lib/hooks/sources/opencode-v2/runtime';
import { readOpencodeV2Password } from '@/lib/hooks/sources/opencode-v2/secrets';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const execFileAsync = promisify(execFile);

/** How long the server may take to answer once the TUI is on screen. */
const SERVER_READY_MS = 15_000;
/** launch.sh gives serve 3 s after SIGTERM before SIGKILL; this covers it. */
const LEFTOVER_WAIT_MS = 8_000;
/** Longest wait for an aborted stream to wind down. */
const STOP_WAIT_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { reserveOpencodeV2Server as reserveProbeServer, releaseOpencodeV2Server as releaseProbeServer };

/**
 * Records every frame of one server's `/api/event` — not only the types
 * Phase 1 maps, since a renamed event shows up as a type nobody reads.
 */
export class ServerEventRecorder {
  readonly events: ReceivedServerEvent[] = [];
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  /** Set when the stream could not be opened or broke before `stop()`. */
  error: string | null = null;

  /**
   * Open the stream. Resolves once the server accepted the subscription, or
   * with {@link error} set when it never did.
   */
  async start(port: number, password: string, readyMs: number = SERVER_READY_MS): Promise<boolean> {
    const deadline = Date.now() + readyMs;
    let probe = await probeOpencodeV2Server(port, password);
    while (probe.kind !== 'healthy' && Date.now() < deadline) {
      await sleep(250);
      probe = await probeOpencodeV2Server(port, password);
    }
    if (probe.kind !== 'healthy') {
      this.error =
        probe.kind === 'rejected'
          ? `127.0.0.1:${port} が認証を拒否した（HTTP ${probe.status}）`
          : `127.0.0.1:${port} の serve が ${readyMs / 1000} 秒以内に応答しなかった`;
      return false;
    }
    try {
      const items = await openOpencodeV2EventStream(port, password, this.controller.signal);
      this.loop = (async () => {
        try {
          for await (const item of items) {
            if (item.kind === 'frame') this.events.push({ type: frameType(item.frame), receivedAt: Date.now() });
          }
        } catch (error) {
          if (!this.controller.signal.aborted) this.error = describe(error);
        }
      })();
      return true;
    } catch (error) {
      this.error = describe(error);
      return false;
    }
  }

  /** Close the stream. Never waits more than {@link STOP_WAIT_MS} for it to wind down. */
  async stop(): Promise<void> {
    this.controller.abort();
    if (!this.loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.loop.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open a recorder on the instance's server with its password file. */
export async function recordServerEvents(target: AgentInstanceRef, port: number): Promise<ServerEventRecorder> {
  const recorder = new ServerEventRecorder();
  const password = readOpencodeV2Password(target);
  if (password === null) {
    recorder.error = 'パスワードファイルが読めない';
    return recorder;
  }
  await recorder.start(port, password);
  return recorder;
}

/** `opencode2 serve` processes started for `port` (launch.sh's exact argv). */
async function servePids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', `opencode2 serve --hostname 127.0.0.1 --port ${port}$`]);
    return stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

/**
 * What of the server outlived the session, after giving launch.sh's trap its
 * grace period. Anything left is stopped here so the run itself leaves no
 * process behind — but it is still reported.
 */
export async function collectServerLeftovers(port: number, waitMs: number = LEFTOVER_WAIT_MS): Promise<ServerLeftovers> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pids = await servePids(port);
    const portBound = !(await isPortFree(port));
    if ((pids.length === 0 && !portBound) || Date.now() >= deadline) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
      return { port, portBound, pids };
    }
    await sleep(500);
  }
}
