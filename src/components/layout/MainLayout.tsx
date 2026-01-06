/**
 * MainLayout Component
 * Main application layout wrapper with content area
 */

'use client';

import React from 'react';

export interface MainLayoutProps {
  children: React.ReactNode;
}

/**
 * Main application layout
 *
 * @example
 * ```tsx
 * <MainLayout>
 *   <YourPageContent />
 * </MainLayout>
 * ```
 */
export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <main className="flex-1 min-h-0 overflow-auto">
        {children}
      </main>
    </div>
  );
}
