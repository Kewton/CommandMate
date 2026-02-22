'use client';

/**
 * AuthContext
 * Issue #331: Provides authEnabled status from server to client components
 * without requiring a client-side fetch (eliminates LogoutButton flicker).
 */

import { createContext, useContext, type ReactNode } from 'react';

const AuthContext = createContext<boolean>(false);

export function AuthProvider({
  children,
  authEnabled,
}: {
  children: ReactNode;
  authEnabled: boolean;
}) {
  return <AuthContext.Provider value={authEnabled}>{children}</AuthContext.Provider>;
}

export function useAuthEnabled(): boolean {
  return useContext(AuthContext);
}
