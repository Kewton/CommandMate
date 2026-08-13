/**
 * `AgentEventSource` — the public surface (Issue #1759).
 *
 * Import from here rather than from the files underneath. Importing `./registry`
 * is what registers the built-in sources, so this barrel is also the guarantee
 * that a caller who reached for the types got the implementations too.
 *
 * The spec this implements is `docs/design/agent-event-source-interface.md`,
 * which also carries the checklist for adding a tool.
 *
 * @module lib/hooks/sources
 */

export type {
  AgentEventSource,
  AgentEventTransport,
  AgentInstanceRef,
  AgentLaunchPlan,
  AgentSourceCapabilities,
  NoDecisionBehavior,
  NormalizedAgentEvent,
  PendingDecision,
  PermissionSubject,
  QuestionSubject,
  RawAgentEvent,
  SourceLiveness,
  Subscription,
  Verdict,
  VerdictEncoding,
} from './types';

export {
  getAgentEventSource,
  hasAgentEventSource,
  listAgentEventSources,
  registerAgentEventSource,
  unregisterAgentEventSource,
} from './registry';

export { definePullEventSource, definePushHookSource } from './define-source';
export type { PullEventSourceSpec, PushHookSourceSpec } from './define-source';

export {
  boundDetail,
  fromNameTable,
  getUnknownEventTally,
  isPlainObject,
  readFirstStringField,
  readNestedString,
  readStringField,
  resetUnknownEventTallies,
  runEventMappers,
  whenNamed,
} from './event-mapper';
export type { EventMapper, EventMapping, UnknownEventTally } from './event-mapper';

export {
  CAMEL_CASE_HOOK_EVENT_NAMES,
  extractSnakeCaseEventDetail,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
} from './hook-event-vocabulary';

export {
  answerPendingDecision,
  closeDecisionSlot,
  listOpenDecisions,
  openDecisionSlot,
  resetPendingDecisions,
} from './pending-decisions';
export type { DecisionSlot } from './pending-decisions';

export { describeAbstain, describeNoDecision, isAbstainSafe } from './abstain';
export type { AbstainOutcome } from './abstain';

export { CLAUDE_CLI_TOOL_ID } from './claude/tool-id';
export { GEMINI_CLI_TOOL_ID } from './gemini/tool-id';
export { ANTIGRAVITY_CLI_TOOL_ID } from './antigravity/tool-id';
