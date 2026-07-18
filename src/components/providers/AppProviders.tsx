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
import { ThemeProvider } from 'next-themes';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { WorktreesCacheProvider } from '@/components/providers/WorktreesCacheProvider';
import { ViewTransitionsProvider } from '@/components/providers/ViewTransitionsProvider';
import { RealtimeProvider } from '@/hooks/useRealtimeConnection';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { ToastProvider } from '@/components/common/Toast';
import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

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
      {/* Issue #1400: single app-wide toast queue + one portaled ToastContainer.
          Sits inside NextIntlClientProvider so the toast close-button aria-label
          resolves, and wraps everything so any useToast() below shares it. */}
      <ToastProvider>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider authEnabled={authEnabled}>
            <PcDisplaySizeProvider>
              <SidebarProvider>
                {/* Issue #1120: single shared WebSocket connection wrapping the
                    worktrees cache so session-status / message / terminal pushes
                    feed the sidebar and terminal panes; polling remains the
                    fallback when disconnected. */}
                <RealtimeProvider>
                  <WorktreesCacheProvider>
                    <CommandPaletteProvider>
                      {/* Issue #1130: `?` keyboard-shortcuts help overlay open state. */}
                      <KeyboardShortcutsProvider>
                        <ConfirmProvider>
                          {/* Issue #1141: View Transitions wraps the routed content. */}
                          <ViewTransitionsProvider>
                            {children}
                          </ViewTransitionsProvider>
                          {/* Issue #1124: registers the Service Worker (prod only)
                              and shows the update-available prompt. */}
                          <ServiceWorkerRegistrar />
                        </ConfirmProvider>
                      </KeyboardShortcutsProvider>
                    </CommandPaletteProvider>
                  </WorktreesCacheProvider>
                </RealtimeProvider>
              </SidebarProvider>
            </PcDisplaySizeProvider>
          </AuthProvider>
        </ThemeProvider>
      </ToastProvider>
    </NextIntlClientProvider>
  );
}
