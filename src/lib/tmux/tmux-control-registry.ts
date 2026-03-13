import { createLogger } from '@/lib/logger';
import {
  incrementTmuxControlCleanupCount,
  setTmuxControlActiveSessions,
  setTmuxControlSubscriberCount,
} from './tmux-control-mode-metrics';
import { TmuxControlClient, type TmuxControlClientOptions } from './tmux-control-client';
import type { TmuxControlEvent } from './tmux-control-parser';

const logger = createLogger('tmux-control-registry');
const DEFAULT_REGISTRY_IDLE_TIMEOUT_MS = 15_000;

export interface TmuxControlRegistryOptions extends TmuxControlClientOptions {
  idleTimeoutMs?: number;
  createClient?: (sessionName: string) => TmuxControlClient;
}

interface RegistryEntry {
  client: TmuxControlClient;
  subscribers: Set<string>;
  unsubscribeClientEvent: () => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

type EventHandler = (event: TmuxControlEvent) => void;

export class TmuxControlRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly idleTimeoutMs: number;
  private readonly createClient: (sessionName: string) => TmuxControlClient;

  constructor(options: TmuxControlRegistryOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_REGISTRY_IDLE_TIMEOUT_MS;
    this.createClient = options.createClient ?? (() => new TmuxControlClient(options));
  }

  subscribe(sessionName: string, subscriberId: string, handler: EventHandler): () => void {
    const entry = this.ensureEntry(sessionName);
    entry.subscribers.add(subscriberId);
    this.cancelIdleCleanup(entry);
    this.updateMetrics();

    let handlerSet = this.handlers.get(sessionName);
    if (!handlerSet) {
      handlerSet = new Set<EventHandler>();
      this.handlers.set(sessionName, handlerSet);
    }
    handlerSet.add(handler);

    return () => {
      handlerSet?.delete(handler);
      this.unsubscribe(sessionName, subscriberId);
    };
  }

  sendInput(sessionName: string, input: string): void {
    const entry = this.entries.get(sessionName);
    if (!entry) {
      throw new Error(`No control client registered for ${sessionName}`);
    }
    entry.client.sendInput(input);
  }

  resize(sessionName: string, cols: number, rows: number): void {
    const entry = this.entries.get(sessionName);
    if (!entry) {
      throw new Error(`No control client registered for ${sessionName}`);
    }
    entry.client.resize(cols, rows);
  }

  hasSession(sessionName: string): boolean {
    return this.entries.has(sessionName);
  }

  getSubscriberCount(sessionName: string): number {
    return this.entries.get(sessionName)?.subscribers.size ?? 0;
  }

  getTotalSubscriberCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.subscribers.size;
    }
    return count;
  }

  getSessionCount(): number {
    return this.entries.size;
  }

  shutdown(): void {
    for (const [sessionName, entry] of this.entries) {
      this.teardownEntry(sessionName, entry);
    }
    this.entries.clear();
    this.handlers.clear();
    this.updateMetrics();
  }

  private ensureEntry(sessionName: string): RegistryEntry {
    const existing = this.entries.get(sessionName);
    if (existing) {
      return existing;
    }

    const client = this.createClient(sessionName);
    client.start(sessionName);
    const unsubscribeClientEvent = client.onEvent((event) => {
      const handlers = this.handlers.get(sessionName);
      if (handlers) {
        for (const handler of handlers) {
          handler(event);
        }
      }
      if (event.type === 'exit' || event.type === 'error') {
        this.deleteEntry(sessionName);
      }
    });

    const entry: RegistryEntry = {
      client,
      subscribers: new Set(),
      unsubscribeClientEvent,
      idleTimer: null,
    };
    this.entries.set(sessionName, entry);
    this.updateMetrics();
    return entry;
  }

  private unsubscribe(sessionName: string, subscriberId: string): void {
    const entry = this.entries.get(sessionName);
    if (!entry) {
      return;
    }

    entry.subscribers.delete(subscriberId);
    this.updateMetrics();
    if (entry.subscribers.size === 0) {
      this.scheduleIdleCleanup(sessionName, entry);
    }
  }

  private scheduleIdleCleanup(sessionName: string, entry: RegistryEntry): void {
    if (this.idleTimeoutMs <= 0) {
      this.deleteEntry(sessionName);
      return;
    }

    this.cancelIdleCleanup(entry);
    entry.idleTimer = setTimeout(() => {
      logger.debug('idle-cleanup', { sessionName });
      this.deleteEntry(sessionName);
    }, this.idleTimeoutMs);
  }

  private cancelIdleCleanup(entry: RegistryEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private deleteEntry(sessionName: string): void {
    const entry = this.entries.get(sessionName);
    if (!entry) {
      return;
    }
    this.teardownEntry(sessionName, entry);
    this.entries.delete(sessionName);
    this.handlers.delete(sessionName);
    this.updateMetrics();
  }

  private teardownEntry(_sessionName: string, entry: RegistryEntry): void {
    this.cancelIdleCleanup(entry);
    entry.unsubscribeClientEvent();
    entry.client.stop();
    incrementTmuxControlCleanupCount();
  }

  private updateMetrics(): void {
    setTmuxControlActiveSessions(this.getSessionCount());
    setTmuxControlSubscriberCount(this.getTotalSubscriberCount());
  }
}

let tmuxControlRegistrySingleton: TmuxControlRegistry | null = null;

export function getTmuxControlRegistry(): TmuxControlRegistry {
  if (!tmuxControlRegistrySingleton) {
    tmuxControlRegistrySingleton = new TmuxControlRegistry();
  }
  return tmuxControlRegistrySingleton;
}
