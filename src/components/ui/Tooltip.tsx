/**
 * Tooltip Component
 * Hover/focus tooltip built on @radix-ui/react-tooltip (Issue #1046).
 * Portalled content is layered above modals via Z_INDEX.POPOVER.
 */

'use client';

import React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Z_INDEX } from '@/config/z-index';
import { cn } from '@/lib/utils/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      style={{ zIndex: Z_INDEX.POPOVER }}
      className={cn(
        'overflow-hidden rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md',
        // [Issue #1050] Enter applied unconditionally so both instant-open and
        // delayed-open animate; exit gated on data-[state=closed]. Matches the
        // shadcn/ui default (the Tooltip data-state is delayed-open/instant-open,
        // never plain "open").
        'animate-in fade-in-0 zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="fill-foreground" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';
