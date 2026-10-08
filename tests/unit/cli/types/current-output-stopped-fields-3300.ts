/**
 * The ten `current-output` fields a session that is not running is
 * answered without (Issue #3300, item 11 of #3232).
 *
 * The CLI's copy of the response type declared all of them required. Shared by
 * the two suites that hold the claim from both ends: the type suite
 * (`current-output-mirror-3300.test.ts`: optional on the server type and on the
 * copy) and the response suite (`instances-auto-yes-3300.test.ts`: absent from
 * what the route really answers for a stopped session, present for a running
 * one).
 */
export const FIELDS_ABSENT_WHEN_NOT_RUNNING = [
  'autoYes',
  'isPromptWaiting',
  'thinking',
  'fullOutput',
  'realtimeSnippet',
  'lastCapturedLine',
  'promptData',
  'isSelectionListActive',
  'lastServerResponseTimestamp',
  'serverPollerActive',
] as const;
