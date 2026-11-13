/**
 * Issue #4345 1c: the worktree page's registration holder for what it draws
 * (`@/lib/handoff/page-owner`). `WorktreeDetailRefactored` provides its controller's holder; a
 * surface drawn outside a worktree page (the sessions view, the settings screen) reads
 * {@link NO_HANDOFF_PAGE_OWNER} and reports nothing.
 *
 * The value is the holder itself (a stable ref), read when each request leaves — never the
 * registration of the render that made the callback.
 *
 * @module hooks/useHandoffPageOwner
 */
'use client';

import { createContext, useContext } from 'react';
import { NO_HANDOFF_PAGE_OWNER, type HandoffPageOwner } from '@/lib/handoff/page-owner';

export const HandoffPageOwnerContext = createContext<HandoffPageOwner>(NO_HANDOFF_PAGE_OWNER);

/** The page's registration holder, or {@link NO_HANDOFF_PAGE_OWNER} outside a worktree page. */
export function useHandoffPageOwner(): HandoffPageOwner {
  return useContext(HandoffPageOwnerContext);
}
