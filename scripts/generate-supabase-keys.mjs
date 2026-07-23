#!/usr/bin/env node
/**
 * Generates the two long-lived JWTs the self-hosted stack needs:
 *   - anon key   (role: "anon")          -> NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   - service key (role: "service_role") -> keep server-side only, never
 *                                            ship to the browser; not
 *                                            currently used by this
 *                                            scaffold's Workers (they
 *                                            connect to Postgres directly
 *                                            via DATABASE_URL and don't go
 *                                            through GoTrue/PostgREST for
 *                                            data access) but generated
 *                                            here since GoTrue expects a
 *                                            service key to exist for its
 *                                            own admin operations.
 *
 * Both are just JWTs signed with the same shared secret GoTrue uses
 * (GOTRUE_JWT_SECRET / SUPABASE_JWT_SECRET) — this is the standard
 * self-hosted Supabase key scheme, not something specific to this
 * project. No dependencies beyond Node's built-in `crypto`, so this runs
 * with plain `node` before `pnpm install` has ever been run.
 *
 * Usage:
 *   node scripts/generate-supabase-keys.mjs "your-jwt-secret-here"
 *
 * Then copy the two printed values into your root .env as
 * SUPABASE_JWT_SECRET (the secret you passed in), NEXT_PUBLIC_SUPABASE_ANON_KEY,
 * and (if you end up needing it) SUPABASE_SERVICE_ROLE_KEY.
 */
import { createHmac } from "node:crypto";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const secret = process.argv[2];
if (!secret || secret.length < 32) {
  console.error("Usage: node generate-supabase-keys.mjs <jwt-secret, 32+ chars>");
  console.error("Generate a strong secret first, e.g.: openssl rand -base64 48");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const TEN_YEARS = 10 * 365 * 24 * 60 * 60;

const anonKey = signJwt({ role: "anon", iss: "supabase", iat: now, exp: now + TEN_YEARS }, secret);
const serviceKey = signJwt({ role: "service_role", iss: "supabase", iat: now, exp: now + TEN_YEARS }, secret);

console.log("SUPABASE_JWT_SECRET=" + secret);
console.log("NEXT_PUBLIC_SUPABASE_ANON_KEY=" + anonKey);
console.log("SUPABASE_SERVICE_ROLE_KEY=" + serviceKey);
