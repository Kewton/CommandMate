import type {
  CaptureOptions,
  SessionTransport,
  TransportCapabilities,
  TransportHandlers,
  TransportSubscription,
} from './session-transport';
import { createSession, hasSession, killSession, sendKeys, sendSpecialKey, capturePane } from './tmux';
import { incrementTmuxControlCapturePaneCalls } from './tmux-control-mode-metrics';
import { getTmuxControlRegistry, type TmuxControlRegistry } from './tmux-control-registry';

const CONTROL_MODE_CAPABILITIES: TransportCapabilities = {
  streamingOutput: true,
  explicitResize: true,
  snapshotFallback: true,
};

export interface ControlModeTmuxTransportOptions {
  registry?: TmuxControlRegistry;
}

export class ControlModeTmuxTransport implements SessionTransport {
  private readonly registry: TmuxControlRegistry;

  constructor(options: ControlModeTmuxTransportOptions = {}) {
    this.registry = options.registry ?? getTmuxControlRegistry();
  }

  async ensureSession(sessionName: string, cwd: string): Promise<void> {
    const exists = await hasSession(sessionName);
    if (!exists) {
      await createSession(sessionName, cwd);
    }
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    return hasSession(sessionName);
  }

  async sendInput(sessionName: string, input: string): Promise<void> {
    if (this.registry.hasSession(sessionName)) {
      this.registry.sendInput(sessionName, input);
      return;
    }
    await sendKeys(sessionName, input);
  }

  async sendSpecialKey(sessionName: string, key: string): Promise<void> {
    if (key !== 'Escape' && key !== 'C-c' && key !== 'C-d' && key !== 'C-m' && key !== 'Enter') {
      throw new Error(`Unsupported special key for ControlModeTmuxTransport: ${key}`);
    }
    await sendSpecialKey(sessionName, key);
  }

  async resize(sessionName: string, cols: number, rows: number): Promise<void> {
    this.registry.resize(sessionName, cols, rows);
  }

  async captureSnapshot(sessionName: string, opts?: CaptureOptions): Promise<string> {
    incrementTmuxControlCapturePaneCalls();
    return capturePane(sessionName, opts);
  }

  async subscribe(
    sessionName: string,
    handlers: TransportHandlers
  ): Promise<TransportSubscription> {
    const subscriberId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const unsubscribe = this.registry.subscribe(sessionName, subscriberId, (event) => {
      if (event.type === 'output') {
        handlers.onOutput(event.data);
      } else if (event.type === 'exit') {
        handlers.onExit?.({ exitCode: event.exitCode });
      } else {
        handlers.onError(event.error);
      }
    });

    return {
      async unsubscribe(): Promise<void> {
        unsubscribe();
      },
    };
  }

  getCapabilities(): TransportCapabilities {
    return CONTROL_MODE_CAPABILITIES;
  }

  getSubscriberCount(sessionName: string): number {
    return this.registry.getSubscriberCount(sessionName);
  }

  async killSession(sessionName: string): Promise<boolean> {
    return killSession(sessionName);
  }
}

let controlModeTransportSingleton: ControlModeTmuxTransport | null = null;

export function getControlModeTmuxTransport(): ControlModeTmuxTransport {
  if (!controlModeTransportSingleton) {
    controlModeTransportSingleton = new ControlModeTmuxTransport();
  }
  return controlModeTransportSingleton;
}
