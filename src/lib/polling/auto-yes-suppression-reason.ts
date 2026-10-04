/**
 * Why an auto-answer was withheld.
 *
 * `deny-pattern-unusable` is the fail-closed case: a deny pattern that cannot be
 * evaluated (unsafe, unparseable, or over-long) suppresses instead of being
 * skipped. Ignoring it would silently drop the protection the contract author
 * asked for, which is the more dangerous of the two directions.
 */
export type AutoYesSuppressionReason =
  | 'mode-off'
  | 'deny-pattern'
  | 'deny-pattern-unusable'
  | 'type-not-allowed'
  /**
   * Issue #1829: not a policy verdict at all, but the same outcome recorded
   * through the same channel. The prompt on screen is a CLI-lifecycle dialog
   * whose answer belongs to the tool's own launch sequence, so the poller
   * withheld one. Listed here so `capture --json` / `cmate wait` can name it
   * instead of showing a session that has silently gone quiet.
   */
  | 'agent-launch-dialog'
  /**
   * Issue #1924 (§4 D1 decision 4): the generic estimator read a numbered list
   * on the frame and the tool's own dialog detector did not vouch for it, so
   * nothing was sent.
   *
   * Also not a policy verdict. It is the reason code for the one position that
   * can stop #1896 — an agent quoting a numbered list in its *answer* and
   * Auto-Yes replying `1` to the prose. `detectPrompt`'s generic estimate is
   * true on that frame and the tool-specific `detectDialog` is false, and this
   * names the gap instead of letting the session go quiet with no record.
   *
   * Declared in Phase 1 (Issue #1924) and recorded from Phase 3, when the
   * tool-specific detectors that can disagree with the estimator exist.
   */
  | 'unclassified-frame';
