"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Minimal email/password sign-in against self-hosted GoTrue. Clerk used
 * to provide this screen (and sign-up, password reset, MFA, social
 * login, ...) out of the box — those are genuinely useful things a
 * managed auth product buys you, and re-implementing all of them is out
 * of scope for this scaffold. This covers the bare minimum to develop
 * against; consider GoTrue's built-in magic-link/OAuth support (still
 * free, self-hosted) before hand-rolling more auth UI yourself. See
 * docs/06-oss-free-stack.md.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push(searchParams.get("redirect_to") ?? "/control-room");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-void p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold text-ink-primary">AI Motion Design Factory</h1>
        <p className="mb-6 text-sm text-ink-muted">サインインしてください</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs text-ink-muted">
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border border-hairline bg-panel-raised px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs text-ink-muted">
              パスワード
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-hairline bg-panel-raised px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent"
            />
          </div>

          {error && <p className="text-xs text-signal-error">{error}</p>}

          <Button type="submit" disabled={loading} className="w-full justify-center">
            {loading ? "サインイン中…" : "サインイン"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
