/**
 * Controllable WebSocket mock for hook tests (Issue #1120).
 *
 * Install with `installMockWebSocket()` in beforeEach and drive lifecycle
 * transitions manually (mockOpen / mockMessage / mockServerClose / mockError).
 * Mirrors the browser WebSocket surface the app hooks rely on.
 */

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.closed = true;
    this.onclose?.({ code, reason });
  }

  // --- test controls ---
  mockOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  mockMessage(data: string): void {
    this.onmessage?.({ data });
  }

  /** Simulate the server dropping the connection (unexpected close). */
  mockServerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  mockError(): void {
    this.onerror?.({});
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

export function installMockWebSocket(): () => void {
  const previous = (globalThis as { WebSocket?: unknown }).WebSocket;
  MockWebSocket.reset();
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket as unknown;
  return () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = previous;
    MockWebSocket.reset();
  };
}
