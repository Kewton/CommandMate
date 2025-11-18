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
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
}
