/**
 * TransitionLink (Issue #1122).
 *
 * Drop-in replacement for `next/link` in the persistent nav shell that routes
 * a plain left-click through the View Transitions crossfade. Modified clicks
 * (new tab / download / middle-click), non-`_self` targets, external hrefs, and
 * same-route clicks fall through to the browser / Next default, so keyboard and
 * accessibility behavior is unchanged.
 */

'use client';

import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useViewTransitionRouter } from '@/components/providers/ViewTransitionsProvider';

export type TransitionLinkProps = {
  href: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

function isModifiedEvent(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function isExternalHref(href: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(href) || /^(mailto:|tel:)/i.test(href);
}

export const TransitionLink = forwardRef<HTMLAnchorElement, TransitionLinkProps>(
  function TransitionLink({ href, onClick, target, ...rest }, ref) {
    const pathname = usePathname();
    const router = useViewTransitionRouter();

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        isModifiedEvent(event) ||
        (target !== undefined && target !== '_self') ||
        isExternalHref(href)
      ) {
        return;
      }
      event.preventDefault();
      if (href === pathname) return;
      router.push(href);
    };

    return <NextLink ref={ref} href={href} target={target} onClick={handleClick} {...rest} />;
  },
);
