export interface CaptureOptions {
  startLine?: number;
  endLine?: number;
}

export interface TransportCapabilities {
  streamingOutput: boolean;
  explicitResize: boolean;
  snapshotFallback: boolean;
}

export interface TransportHandlers {
  onOutput(data: string): void;
  onExit?(info: { exitCode?: number | null }): void;
  onError(error: Error): void;
}

export interface TransportSubscription {
  unsubscribe(): Promise<void>;
}

export interface SessionTransport {
  ensureSession(sessionName: string, cwd: string): Promise<void>;
  sessionExists(sessionName: string): Promise<boolean>;
  sendInput(sessionName: string, input: string): Promise<void>;
  sendSpecialKey(sessionName: string, key: string): Promise<void>;
  resize(sessionName: string, cols: number, rows: number): Promise<void>;
  captureSnapshot(sessionName: string, opts?: CaptureOptions): Promise<string>;
  subscribe(
    sessionName: string,
    handlers: TransportHandlers
  ): Promise<TransportSubscription>;
  getCapabilities(): TransportCapabilities;
  killSession(sessionName: string): Promise<boolean>;
}
