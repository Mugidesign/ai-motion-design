"use client";

import { useCallback } from "react";
import { useAuth } from "@/lib/auth-context";

const API_BASE = process.env.NEXT_PUBLIC_API_GATEWAY_URL ?? "http://localhost:8787";

/**
 * Thin fetch wrapper that attaches the Supabase session's access token as
 * a Bearer token, matching what
 * workers/api-gateway/src/middleware/auth.ts (supabaseAuth) verifies.
 * Deliberately not a heavier client (no React Query wired in here) so
 * this scaffold has no opinion on your caching strategy — swap in
 * @tanstack/react-query around this hook if you want it.
 */
export function useApiClient() {
  const { getAccessToken } = useAuth();

  const request = useCallback(
    async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/api/v1${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...init?.headers,
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API ${path} failed: ${res.status} ${body}`);
      }
      return res.json() as Promise<T>;
    },
    [getAccessToken]
  );

  return {
    get: <T = unknown>(path: string) => request<T>(path),
    post: <T = unknown>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
    patch: <T = unknown>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  };
}
