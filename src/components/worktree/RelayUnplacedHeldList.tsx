'use client';

/**
 * Held relay deliveries whose requester has no roster row (Issue #4082).
 *
 * A held payload is shown on the requester's row (`relay.badgeHeld`), because
 * that is the pane it was going to. When that row is gone — the instance was
 * deleted from the roster after the hold — the hold would have nowhere to show,
 * and nothing settles it automatically. This list is where it still shows, in
 * both the PC roster pane and the phone's roster sheet, in the same wording and
 * the same colour as the row badge.
 *
 * Renders nothing when there is nothing to list, so an ordinary roster is
 * unchanged.
 *
 * @module components/worktree/RelayUnplacedHeldList
 */

import { useTranslations } from 'next-intl';
import { Forward } from 'lucide-react';
import type { SessionRelay } from '@/lib/relay/types';
import type { RelayAliasResolver } from '@/lib/relay/relay-badges';

export interface RelayUnplacedHeldListProps {
  /** Held relays whose requester instance is not in the roster. */
  relays: SessionRelay[];
  /** Names the worker end of each relay. */
  aliasOf: RelayAliasResolver;
  className?: string;
}

export function RelayUnplacedHeldList({ relays, aliasOf, className = '' }: RelayUnplacedHeldListProps) {
  const t = useTranslations('worktree');
  if (relays.length === 0) return null;
  return (
    <div
      data-testid="relay-unplaced-held"
      title={t('relay.heldTitle')}
      className={`text-xs text-warning ${className}`}
    >
      <p className="font-medium">{t('relay.unplacedHeldHeading')}</p>
      <ul>
        {relays.map((relay) => (
          <li
            key={relay.id}
            data-testid={`relay-unplaced-held-${relay.id}`}
            className="mt-0.5 flex items-center gap-1 truncate"
          >
            <Forward className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {t('relay.unplacedHeldLine', {
                requester: relay.from.instanceId,
                alias: aliasOf(relay.to),
                relayId: relay.id,
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
