"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { decodeJwtPayload } from "@/lib/supabase/decode-jwt";

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  tenantId: string | null;
  role: "owner" | "admin" | "member" | "viewer" | null;
  userEmail: string | null;
  getAccessToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Replaces Clerk's <ClerkProvider> — wraps the app once in the root
 * layout. tenant_id and role come from custom JWT claims injected by
 * infra/supabase/rls.sql's custom_access_token_hook, decoded client-side
 * for display/routing convenience only (see decode-jwt.ts's doc comment
 * on why that's safe here).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createSupabaseBrowserClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable across renders
  }, []);

  const claims = session ? decodeJwtPayload(session.access_token) : {};

  const value: AuthContextValue = {
    session,
    loading,
    tenantId: claims.tenant_id ?? null,
    role: claims.app_role ?? null,
    userEmail: session?.user.email ?? null,
    getAccessToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Replaces Clerk's useAuth(). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

/** Convenience redirect-on-sign-out, used by the UserMenu component. */
export function useSignOut() {
  const { signOut } = useAuth();
  const router = useRouter();
  return async () => {
    await signOut();
    router.push("/sign-in");
    router.refresh();
  };
}
