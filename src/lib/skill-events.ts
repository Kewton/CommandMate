/**
 * Cross-component signal that a Skill was installed into a worktree (Issue #1477)
 *
 * The Skills install panel and the slash-command palette are mounted
 * independently — there is no shared React state or prop path between them. So a
 * fresh install left the palette showing stale commands until the next full
 * reload. A window-level CustomEvent bridges the two: the panel announces the
 * worktree it just wrote to, and the palette (useSlashCommands) refetches when
 * the announcement names the worktree it is currently showing.
 *
 * @module lib/skill-events
 */

/** Event name dispatched on `window` after a successful Skill install. */
export const SKILL_INSTALLED_EVENT = 'skill:installed';

/** Payload carried by {@link SKILL_INSTALLED_EVENT}. */
export interface SkillInstalledEventDetail {
  /** The worktree the Skill was installed into. */
  worktreeId: string;
}

/**
 * Announce a successful Skill install so any palette showing this worktree
 * refetches its commands. A no-op outside the browser (e.g. SSR), so callers
 * do not need to guard the environment themselves.
 */
export function dispatchSkillInstalled(worktreeId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SkillInstalledEventDetail>(SKILL_INSTALLED_EVENT, {
      detail: { worktreeId },
    })
  );
}
