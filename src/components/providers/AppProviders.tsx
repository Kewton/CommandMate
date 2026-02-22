/**
 * AppProviders Component
 *
 * Client-side providers wrapper for the application.
 * This component wraps the app with all necessary context providers
 * so they persist across client-side navigation.
 *
 * [SF-S2-003] NextIntlClientProvider added for i18n support.
 */

'use client';

import { type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { AuthProvider } from '@/contexts/AuthContext';

interface AppProvidersProps {
  children: ReactNode;
  locale: string;
  messages: Record<string, unknown>;
  timeZone?: string;
  authEnabled?: boolean;
}

/**
 * AppProviders wraps the application with all necessary context providers
 *
 * @example
 * ```tsx
 * <AppProviders locale="en" messages={messages}>
 *   <App />
 * </AppProviders>
 * ```
 */
export function AppProviders({ children, locale, messages, timeZone, authEnabled = false }: AppProvidersProps) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      <AuthProvider authEnabled={authEnabled}>
        <SidebarProvider>
          <WorktreeSelectionProvider>
            {children}
          </WorktreeSelectionProvider>
        </SidebarProvider>
      </AuthProvider>
    </NextIntlClientProvider>
  );
}
