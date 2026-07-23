"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Points at self-hosted Supabase Auth (GoTrue) — docker-compose.yml runs
 * it locally on :9999 behind Kong on :8000 by default in the standard
 * self-hosted Supabase layout. NEXT_PUBLIC_SUPABASE_URL should be Kong's
 * public URL (e.g. https://auth.yourdomain.example), not GoTrue's raw
 * port, once deployed. The "anon key" is GoTrue's own concept (a JWT
 * signed with the same shared secret, role=anon) — generate one with the
 * project's standard self-hosted setup script, it is NOT a Supabase Cloud
 * API key. See docs/06-oss-free-stack.md.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
