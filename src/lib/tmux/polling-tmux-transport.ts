import type {
  CaptureOptions,
  SessionTransport,
  TransportCapabilities,
  TransportSubscription,
} from './session-transport';
import {
  capturePane,
  createSession,
  hasSession,
  killSession,
  sendKeys,
  sendSpecialKey,
} from './tmux';

const POLLING_TMUX_CAPABILITIES: TransportCapabilities = {
  streamingOutput: false,
  explicitResize: false,
  snapshotFallback: true,
};

class NoopSubscription implements TransportSubscription {
  async unsubscribe(): Promise<void> {
    return;
  }
}

export class PollingTmuxTransport implements SessionTransport {
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
    await sendKeys(sessionName, input);
  }

  async sendSpecialKey(sessionName: string, key: string): Promise<void> {
    if (key !== 'Escape' && key !== 'C-c' && key !== 'C-d' && key !== 'C-m' && key !== 'Enter') {
      throw new Error(`Unsupported special key for PollingTmuxTransport: ${key}`);
    }
    await sendSpecialKey(sessionName, key);
  }

  async resize(): Promise<void> {
    throw new Error('PollingTmuxTransport does not support explicit resize');
  }

  async captureSnapshot(sessionName: string, opts?: CaptureOptions): Promise<string> {
    return capturePane(sessionName, opts);
  }

  async subscribe(): Promise<TransportSubscription> {
    return new NoopSubscription();
  }

  getCapabilities(): TransportCapabilities {
    return POLLING_TMUX_CAPABILITIES;
  }

  async killSession(sessionName: string): Promise<boolean> {
    return killSession(sessionName);
  }
}

let pollingTmuxTransportSingleton: PollingTmuxTransport | null = null;

export function getPollingTmuxTransport(): PollingTmuxTransport {
  if (!pollingTmuxTransportSingleton) {
    pollingTmuxTransportSingleton = new PollingTmuxTransport();
  }
  return pollingTmuxTransportSingleton;
}
