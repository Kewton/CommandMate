/**
 * Which {@link AgentEventSource} speaks for which CLI tool (Issue #1759).
 *
 * The lookup that replaces "assume Claude". A receiver holds a
 * {@link CLIToolType} — it came off the hook URL or the request body — and asks
 * here; it never imports a tool's module and never compares against a tool id.
 *
 * ## Held on `globalThis`
 *
 * Not decoration. `agent-event-state` documents what happened the last time a
 * shared map lived in module scope (#1736): under `next dev` every route
 * handler is bundled separately, so `/api/hooks/agent-event` and
 * `/api/hooks/permission-request` each got their own copy of the module, one
 * wrote and the other read, and every field came back null — with no error, no
 * warning and a perfectly well-formed response. A registry has the same shape
 * of failure available to it: a source registered in one bundle would be absent
 * in another, and the fallback below would silently take over. So the map is
 * process-wide, and the registration is idempotent.
 *
 * ## Unregistered tools
 *
 * {@link getAgentEventSource} always answers. A tool with no source gets the
 * compatibility source from `./legacy-relay`, which preserves the pre-#1759
 * receiver behaviour for the hand-configured hooks of #1549. Ask
 * {@link hasAgentEventSource} when the distinction matters.
 *
 * @module lib/hooks/sources/registry
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLegacyRelaySource } from './legacy-relay';
import type { AgentEventSource } from './types';
import { claudeAgentEventSource } from './claude/source';

declare global {
  // eslint-disable-next-line no-var
  var __agentEventSources: Map<CLIToolType, AgentEventSource> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventLegacySources: Map<CLIToolType, AgentEventSource> | undefined;
}

const registered = (globalThis.__agentEventSources ??= new Map<CLIToolType, AgentEventSource>());

/** Memoised compatibility sources, so repeated lookups return one object. */
const legacy = (globalThis.__agentEventLegacySources ??= new Map<CLIToolType, AgentEventSource>());

/**
 * Add or replace a tool's source.
 *
 * @param source - The implementation; its own `cliToolId` is the key
 */
export function registerAgentEventSource(source: AgentEventSource): void {
  registered.set(source.cliToolId, source);
  // A tool that has a real source must not keep answering from the
  // compatibility one anywhere — including from a memo taken before it was
  // registered, which is reachable in `next dev` where registration order
  // across bundles is not fixed.
  legacy.delete(source.cliToolId);
}

/** Whether this tool has a real implementation, as opposed to the fallback. */
export function hasAgentEventSource(cliToolId: CLIToolType): boolean {
  return registered.has(cliToolId);
}

/**
 * The source for one tool. Never null.
 *
 * @returns The registered implementation, or the compatibility source that
 *   keeps a hand-configured #1549 hook working until this tool has one
 */
export function getAgentEventSource(cliToolId: CLIToolType): AgentEventSource {
  const source = registered.get(cliToolId);
  if (source) return source;

  const existing = legacy.get(cliToolId);
  if (existing) return existing;

  const fallback = createLegacyRelaySource(cliToolId);
  legacy.set(cliToolId, fallback);
  return fallback;
}

/** Every tool with a real implementation. Ordered by registration. */
export function listAgentEventSources(): AgentEventSource[] {
  return [...registered.values()];
}

/**
 * Undo a registration. For tests — production only ever adds.
 *
 * The mutation "take Claude out of the registry" that Issue #1759 asks to be
 * proved lethal is spelled with this.
 */
export function unregisterAgentEventSource(cliToolId: CLIToolType): void {
  registered.delete(cliToolId);
  legacy.delete(cliToolId);
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------
//
// Statically imported and registered on load, rather than through a
// side-effecting `import './claude'` somewhere else: an import a bundler is
// free to consider unused is a registration that disappears in a production
// build, and "the source is silently absent" is the exact failure this module's
// globalThis comment is about.
//
// Phase 4-2…4-5 adds one line here per tool. That, plus the tool's own file, is
// the whole of "adding a tool" — see docs/design/agent-event-source-interface.md.
registerAgentEventSource(claudeAgentEventSource);
