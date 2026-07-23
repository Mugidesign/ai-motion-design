"use client";

import { LogOut } from "lucide-react";
import { useAuth, useSignOut } from "@/lib/auth-context";

/** Replaces Clerk's <UserButton>. Deliberately minimal — just enough to
 *  show who's signed in and let them sign out. */
export function UserMenu() {
  const { userEmail } = useAuth();
  const signOut = useSignOut();

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-xs text-ink-muted" title={userEmail ?? undefined}>
        {userEmail ?? "unknown"}
      </span>
      <button
        onClick={signOut}
        className="rounded p-1.5 text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink-primary"
        title="サインアウト"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
