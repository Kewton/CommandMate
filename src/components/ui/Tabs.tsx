/**
 * Tabs Component
 * Tabbed navigation built on @radix-ui/react-tabs (Issue #1046).
 * Two visual variants: `underline` (default) and `pill`.
 */

'use client';

import React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils/cn';

export type TabsVariant = 'underline' | 'pill';

const TabsVariantContext = React.createContext<TabsVariant>('underline');

export interface TabsProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant;
}

/**
 * Tabs root. Provides the visual variant to descendant list/triggers.
 *
 * @example
 * ```tsx
 * <Tabs defaultValue="a" variant="pill">
 *   <TabsList>
 *     <TabsTrigger value="a">A</TabsTrigger>
 *     <TabsTrigger value="b">B</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="a">Panel A</TabsContent>
 *   <TabsContent value="b">Panel B</TabsContent>
 * </Tabs>
 * ```
 */
export const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  TabsProps
>(({ variant = 'underline', ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.Root ref={ref} {...props} />
  </TabsVariantContext.Provider>
));
Tabs.displayName = 'Tabs';

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'inline-flex items-center',
        variant === 'pill'
          ? 'gap-1 rounded-lg bg-muted p-1'
          : 'gap-4 border-b border-border',
        className
      )}
      {...props}
    />
  );
});
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        variant === 'pill'
          ? 'rounded-md px-3 py-1.5 text-muted-foreground data-[state=active]:bg-surface data-[state=active]:text-surface-foreground data-[state=active]:shadow-sm'
          : '-mb-px border-b-2 border-transparent px-1 py-2 text-muted-foreground hover:text-foreground data-[state=active]:border-accent-500 data-[state=active]:text-accent-600',
        className
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';
