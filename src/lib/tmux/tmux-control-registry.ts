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
  /**
   * The name this entry is currently filed under.
   *
   * Duplicates the map key on purpose. Every callback the entry owns (the
   * client event handler, the idle-cleanup timer) has to look the entry back up
   * by name, and a tmux session can be renamed under a live attach
   * (Issue #1621 Phase 3). Capturing the name in those closures would leave
   * them addressing a key that no longer exists, so output would stop reaching
   * subscribers and the idle timer would fail to clean up. Reading it off the
   * entry means a rename only has to update this one field.
   */
  sessionName: string;
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

  /**
   * Re-file a live control-mode attach under a session's new name
   * (Issue #1621 Phase 3).
   *
   * `rename-session` does not disturb an attached control client, so the child
   * process, its pipe and its scrollback all survive — what breaks is this
   * registry, which is keyed by name. Without re-keying, `sendInput(newName)`
   * throws "No control client registered" while a perfectly healthy attach sits
   * under the old key: the session is alive but input no longer reaches it.
   * Re-keying is therefore strictly better than tearing the attach down and
   * re-establishing it, and it keeps every subscriber connected.
   *
   * @returns true when an entry was moved; false when nothing was registered
   *          under `oldName`, or when `newName` is already registered (the
   *          existing attach wins — clobbering it would strand a live child
   *          process with no way to stop it)
   */
  renameSession(oldName: string, newName: string): boolean {
    if (oldName === newName) return false;

    const entry = this.entries.get(oldName);
    if (!entry) return false;
    if (this.entries.has(newName)) {
      logger.warn('rename:destination-occupied', { oldName, newName });
      return false;
    }

    this.entries.delete(oldName);
    entry.sessionName = newName;
    this.entries.set(newName, entry);
    entry.client.setSessionName(newName);

    const handlers = this.handlers.get(oldName);
    if (handlers) {
      this.handlers.delete(oldName);
      this.handlers.set(newName, handlers);
    }

    logger.debug('rename', { oldName, newName });
    return true;
  }

  private ensureEntry(sessionName: string): RegistryEntry {
    const existing = this.entries.get(sessionName);
    if (existing) {
      return existing;
    }

    const client = this.createClient(sessionName);
    client.start(sessionName);

    const entry: RegistryEntry = {
      client,
      subscribers: new Set(),
      // Replaced immediately below; the entry has to exist first so the event
      // handler can read its current name rather than capture the old one.
      unsubscribeClientEvent: () => {},
      idleTimer: null,
      sessionName,
    };

    entry.unsubscribeClientEvent = client.onEvent((event) => {
      const handlers = this.handlers.get(entry.sessionName);
      if (handlers) {
        for (const handler of handlers) {
          handler(event);
        }
      }
      if (event.type === 'exit' || event.type === 'error') {
        this.deleteEntry(entry.sessionName);
      }
    });

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
      // entry.sessionName, not the captured `sessionName`: the session may have
      // been renamed while this timer was pending (see renameSession).
      logger.debug('idle-cleanup', { sessionName: entry.sessionName });
      this.deleteEntry(entry.sessionName);
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
